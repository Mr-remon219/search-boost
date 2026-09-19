/** Discover and refresh existing integrations only; upgrade never grants permissions. */
import { existsSync } from 'node:fs'
import { readFile, writeFile, mkdir, readdir, rename, unlink } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { packageIdentity, PI_PACKAGE_NAMES, DSH_PACKAGE_NAMES } from '../package-identity.mjs'
import { PKG_ROOT } from '../pkg.mjs'
import { PATHS, PI_SHIM_MARKER, PI_OWNED_MARKER, workspaceAgents, antigravityMcpPaths } from '../paths.mjs'
import { listAntigravityWorkspaces } from '../workspace-marker.mjs'
import { installSkillBundle, skillBundleFiles } from '../agent-skills.mjs'
import { installStartupHook, loadStartupSearchPolicy } from '../startup-hooks.mjs'
import { buildSessionStartCommand, isSearchBoostHook } from '../hooks-config.mjs'
import { injectAgentsFile, injectGeminiSnippetFile, injectAntigravityRule, loadAgentPrompt, loadCursorMergedPrompt, isOwnedSearchBoostSkill } from '../agents/shared.mjs'
import { piSubagentTemplatePaths, piWorkflowPromptPaths, RETIRED_SKILL_NAMES, hookScriptPath } from '../../agents/router.mjs'
import { renderResearchTemplate } from '../search/parallel-contract.mjs'
import { optionalText, strictJson, refreshJsonMcp, refreshTomlMcp } from './config.mjs'
import { backupFiles, recordedProjects, recordUpgradeProject } from './state.mjs'
import { verifyReplacement } from './packages.mjs'
import { checkedCommand, compareVersions } from './process.mjs'

const PACKAGE = 'search-boost'
const LEGACY_PI = 'pi-search-boost'
const hasServer = (text) => /\[mcp_servers\.(?:search-boost|"search-boost"|'search-boost')\]/.test(text)
const sourceOf = (entry) => typeof entry === 'string' ? entry : entry?.source

export { packageIdentity } from '../package-identity.mjs'

export async function discoverIntegrations({ workspace } = {}) {
  const targets = [], warnings = []
  const projects = new Set([process.cwd(), ...await recordedProjects(), ...await listAntigravityWorkspaces(), ...(workspace ? [resolve(workspace)] : [])])
  async function inspect(label, fn) {
    try { await fn() } catch (err) { warnings.push(`${label}: ${err.message}`) }
  }
  async function mcp(id, paths, root) {
    const config = paths.mcp ?? paths.config
    let configured = false
    if (existsSync(config)) {
      configured = ['codex', 'grok'].includes(id) ? hasServer(await readFile(config, 'utf8')) : !!(await strictJson(config)).mcpServers?.['search-boost']
    }
    const skill = await optionalText(paths.skill)
    const rule = await optionalText(paths.rule ?? paths.agents ?? paths.hookInject)
    if (configured || (skill && isOwnedSearchBoostSkill(skill)) || rule?.includes('SEARCH_BOOST_START') || rule?.includes('search-boost: startup-policy')) {
      targets.push({ kind: 'mcp', id, label: `${id}${root ? ` (${root})` : ''}`, paths, root })
    }
  }
  for (const id of ['cursor', 'codex', 'claude', 'grok']) await inspect(id, () => mcp(id, PATHS[id]))
  for (const config of antigravityMcpPaths()) {
    if (existsSync(config)) await inspect(`antigravity (${config})`, () => mcp('antigravity', { ...PATHS.antigravity, mcp: config }))
  }
  if (!antigravityMcpPaths().some(existsSync)) await inspect('antigravity', () => mcp('antigravity', PATHS.antigravity))
  for (const root of projects) {
    if (!existsSync(root)) { warnings.push(`Recorded project unavailable: ${root}`); continue }
    await inspect(`grok (${root})`, () => mcp('grok', {
      config: join(root, '.grok', 'config.toml'), rule: join(root, '.grok', 'rules', 'search-boost.md'), skill: join(root, '.grok', 'skills', 'search-boost', 'SKILL.md'),
    }, root))
    await inspect(`antigravity (${root})`, () => mcp('antigravity', workspaceAgents(root), root))
  }

  // Pi package installs, explicit extensions, and legacy manually copied extensions.
  for (const agentDir of new Set([PATHS.pi.agentDir, ...[...projects].map((p) => join(p, '.pi'))])) {
    await inspect(`pi (${agentDir})`, async () => {
      const settingsPath = join(agentDir, 'settings.json')
      const settings = await strictJson(settingsPath)
      const entries = []
      for (const field of ['packages', 'extensions']) {
        if (settings[field] !== undefined && !Array.isArray(settings[field])) throw new Error(`Invalid ${field} in ${settingsPath}`)
        for (const entry of settings[field] ?? []) {
          const identity = await packageIdentity(sourceOf(entry), agentDir)
          if (PI_PACKAGE_NAMES.includes(identity)) entries.push({ field, entry, identity })
        }
      }
      const legacyDirs = []
      for (const name of ['search-boost', LEGACY_PI]) {
        const dir = join(agentDir, 'extensions', name)
        for (const file of ['index.ts', 'index.js']) {
          if (['pi-search-boost', 'search-boost-mcp'].includes(await packageIdentity(join(dir, file), agentDir))) { legacyDirs.push(dir); break }
        }
      }
      const shim = join(agentDir, 'extensions', 'search-boost.js')
      if (entries.length || legacyDirs.length || (await optionalText(shim))?.includes(PI_SHIM_MARKER)) {
        targets.push({ kind: 'pi', id: 'pi', legacy: legacyDirs.length > 0 || entries.some((e) => e.identity !== PACKAGE), label: `pi (${agentDir})`, agentDir, settingsPath, entries, legacyDirs, shim })
      }
    })
  }
  if (existsSync(PATHS.dsh.profiles)) {
    for (const entry of await readdir(PATHS.dsh.profiles, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      await inspect(`dsh (${entry.name})`, async () => {
        const dir = join(PATHS.dsh.profiles, entry.name)
        const file = join(dir, 'package.json')
        const pkg = await strictJson(file)
        const deps = { ...pkg.dependencies, ...pkg.devDependencies }
        const bundles = pkg.dsh?.profile?.bundles ?? []
        if (DSH_PACKAGE_NAMES.some((name) => deps[name] || bundles.includes(name))) {
          targets.push({ kind: 'dsh', id: 'dsh', label: `dsh (${entry.name})`, profile: entry.name, dir, legacy: DSH_PACKAGE_NAMES.some((name) => name !== PACKAGE && (deps[name] || bundles.includes(name))) })
        }
      })
    }
  }
  return { targets, warnings, projects: [...projects] }
}

async function transactional(files, action) {
  const backup = await backupFiles(files)
  try { await action(backup); return backup.root } catch (err) {
    try { await backup.rollback() } catch { throw new Error(`Upgrade failed and rollback incomplete. Private backup: ${backup.root}`) }
    // Do not expose arbitrary subprocess errors/config contents.
    throw new Error(`${err.message}; restored managed files. Private backup: ${backup.root}`)
  }
}
function skillFiles(id, dest) {
  const root = dirname(dirname(dest))
  return [...skillBundleFiles(id, dest).map((f) => f.path), ...RETIRED_SKILL_NAMES.flatMap((name) => [join(root, name, 'SKILL.md'), ...(id === 'codex' ? [join(root, name, 'agents', 'openai.yaml')] : [])])]
}
async function validateMarked(path) {
  const body = await optionalText(path)
  if (!body) return
  for (const marker of ['SEARCH_BOOST', 'SEARCH_BOOST_GEMINI']) {
    if (body.includes(`<!-- ${marker}_START -->`) !== body.includes(`<!-- ${marker}_END -->`)) throw new Error(`Incomplete managed marker in ${path}; manual repair required`)
  }
}

async function refreshMcp(target, dryRun) {
  const { id, paths: p, root } = target
  const config = p.mcp ?? p.config
  const launch = { command: process.execPath, args: [join(PKG_ROOT, 'cli.mjs'), 'serve'] }
  const files = [...new Set([config, ...skillFiles(id, p.skill), p.hooks, p.hookScript, p.hookInject, p.agents, p.gemini, p.rule].filter(Boolean))]
  // Validate files before any writes. Broken configs must not be treated as empty defaults.
  for (const file of [p.hooks].filter(Boolean)) await strictJson(file)
  for (const file of [p.agents, p.gemini].filter(Boolean)) await validateMarked(file)
  let toml
  if (id === 'codex' || id === 'grok') toml = refreshTomlMcp(await optionalText(config) ?? '', launch)
  else await refreshJsonMcp(config, { ...(id === 'antigravity' ? {} : { type: 'stdio' }), ...launch }, true)
  await installSkillBundle(id, p.skill, { dryRun: true })
  if (dryRun) return null
  return transactional(files, async () => {
    await installSkillBundle(id, p.skill)
    if (toml !== undefined) { await mkdir(dirname(config), { recursive: true }); await writeFile(config, toml, { mode: 0o600 }) }
    else await refreshJsonMcp(config, { ...(id === 'antigravity' ? {} : { type: 'stdio' }), ...launch }, false)
    if (id === 'grok') {
      await mkdir(dirname(p.rule), { recursive: true })
      await writeFile(p.rule, `${await loadStartupSearchPolicy()}\n\n${await loadAgentPrompt('grok')}`)
    } else if (id === 'cursor') {
      const hooks = await strictJson(p.hooks, { version: 1 })
      hooks.hooks ??= {}
      const prior = hooks.hooks.sessionStart ?? []
      if (!Array.isArray(prior)) throw new Error(`Invalid Cursor sessionStart hooks: ${p.hooks}`)
      const command = buildSessionStartCommand(process.execPath, p.hookScript)
      let found = false
      hooks.hooks.sessionStart = prior.map((entry) => {
        if (!isSearchBoostHook(entry?.command, p.hookScript)) return entry
        found = true
        return { ...entry, command } // preserve disabled/timeout/custom flags
      })
      if (!found) hooks.hooks.sessionStart.push({ command, timeout: 10 })
      await mkdir(dirname(p.hookScript), { recursive: true })
      await writeFile(p.hookScript, await readFile(hookScriptPath('cursor-cli')))
      await writeFile(p.hookInject, `${await loadStartupSearchPolicy()}\n\n${await loadCursorMergedPrompt(true)}`)
      await writeFile(p.hooks, `${JSON.stringify(hooks, null, 2)}\n`)
    } else {
      await installStartupHook(p, { kind: id === 'antigravity' ? 'antigravity' : 'session', preserveExisting: true })
      if (root && id === 'antigravity') await injectAntigravityRule(p.rule)
      else {
        await injectAgentsFile(p.agents, id)
        if (id === 'antigravity') await injectGeminiSnippetFile(p.gemini, id)
      }
    }
    if (root) await recordUpgradeProject(root)
  })
}

async function assertNotDowngrade(file) {
  const installed = await strictJson(file)
  const current = await strictJson(join(PKG_ROOT, 'package.json'))
  if (installed.name === PACKAGE && typeof installed.version === 'string' && compareVersions(installed.version, current.version) > 0) {
    throw new Error(`Installed ${PACKAGE} ${installed.version} is newer than running ${current.version}; refusing downgrade`)
  }
}

async function refreshPi(target, dryRun, run) {
  const { agentDir, settingsPath, shim, legacyDirs } = target
  const settings = await strictJson(settingsPath)
  await assertNotDowngrade(join(agentDir, 'npm', 'node_modules', PACKAGE, 'package.json'))
  let packaged = false
  const adapter = join(PKG_ROOT, 'adapters', 'pi', 'index.js')
  for (const field of ['packages', 'extensions']) {
    if (!settings[field]) continue
    const next = []
    for (const entry of settings[field]) {
      const identity = await packageIdentity(sourceOf(entry), agentDir)
      if (!PI_PACKAGE_NAMES.includes(identity)) { next.push(entry); continue }
      packaged = true
      const source = field === 'packages' ? PKG_ROOT : adapter
      const updated = typeof entry === 'string' ? source : { ...entry, source }
      if (typeof updated === 'object' && identity === LEGACY_PI && Array.isArray(updated.extensions)) {
        updated.extensions = updated.extensions.map((x) => typeof x === 'string' ? x.replace(/^(\+|-|!)?(?:\.\/)?index\.ts$/, '$1adapters/pi/index.js') : x)
      }
      // Preserve filter/disabled choices; conflicting duplicate registrations need user resolution.
      if (next.some((x) => sourceOf(x) === source && JSON.stringify(x) !== JSON.stringify(updated))) throw new Error(`Conflicting Pi package filters in ${settingsPath}`)
      if (!next.some((x) => JSON.stringify(x) === JSON.stringify(updated))) next.push(updated)
    }
    settings[field] = next
  }
  const pairs = [...piSubagentTemplatePaths().map((src) => ({ src, dest: join(agentDir, 'agents', src.split(/[\\/]/).at(-1)) })), ...piWorkflowPromptPaths().map((src) => ({ src, dest: join(agentDir, 'prompts', src.split(/[\\/]/).at(-1)) }))]
  for (const { dest } of pairs) {
    const content = await optionalText(dest)
    if (content !== null && !content.includes(PI_OWNED_MARKER)) throw new Error(`User-owned Pi workflow at ${dest}; left unchanged`)
  }
  const hasPackage = settings.packages?.some((e) => packageIdentity(sourceOf(e), agentDir) === PACKAGE)
  const hasExtension = settings.extensions?.some((e) => packageIdentity(sourceOf(e), agentDir) === PACKAGE)
  if (hasPackage && hasExtension) throw new Error(`Pi registers search-boost through both packages and extensions in ${settingsPath}; resolve duplicate filters first`)
  const priorShim = await optionalText(shim)
  if (priorShim && !priorShim.includes(PI_SHIM_MARKER)) throw new Error(`User-owned Pi shim at ${shim}; left unchanged`)
  if (dryRun) return null
  const backup = await transactional([settingsPath, shim, ...pairs.map((p) => p.dest)], async (backup) => {
    const moved = []
    try {
      for (const { src, dest } of pairs) {
        await mkdir(dirname(dest), { recursive: true })
        await writeFile(dest, renderResearchTemplate(await readFile(src, 'utf8')))
      }
      if (packaged) {
        await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 })
        if (priorShim) await unlink(shim) // avoid loading the same extension twice
      } else {
        await mkdir(dirname(shim), { recursive: true })
        await writeFile(shim, `// ${PI_SHIM_MARKER}\nexport { default } from ${JSON.stringify(new URL('../../adapters/pi/index.js', import.meta.url).href)}\n`)
      }
      for (const dir of legacyDirs) {
        const dest = join(backup.root, `legacy-pi-${moved.length}`)
        await rename(dir, dest) // archive the full tree outside auto-discovery; never delete user additions
        moved.push({ dir, dest })
      }
      if (agentDir !== PATHS.pi.agentDir) await recordUpgradeProject(dirname(agentDir))
    } catch (err) {
      for (const { dir, dest } of moved.reverse()) await rename(dest, dir)
      throw err
    }
  })
  // Native npm cache dependencies are no longer registrations. Remove only known
  // legacy packages from this Pi scope, AFTER replacement settings are committed.
  const prefix = join(agentDir, 'npm')
  const deps = await strictJson(join(prefix, 'package.json'))
  const retired = PI_PACKAGE_NAMES.filter((name) => name !== PACKAGE && (deps.dependencies?.[name] || deps.devDependencies?.[name]))
  if (retired.length) {
    await backupFiles([join(prefix, 'package.json'), join(prefix, 'package-lock.json')])
    try {
      await checkedCommand(run, 'npm', ['uninstall', '--prefix', prefix, '--ignore-scripts', '--no-audit', '--no-fund', ...retired])
      const after = await strictJson(join(prefix, 'package.json'))
      if (retired.some((name) => after.dependencies?.[name] || after.devDependencies?.[name] || existsSync(join(prefix, 'node_modules', name)))) throw new Error('Legacy Pi npm package remains installed')
    } catch { throw new Error(`New Pi registration is active, but legacy npm cleanup failed; do not assume completion. Backup: ${backup}`) }
  }
  return backup
}

async function refreshDsh(target, dryRun, run) {
  await assertNotDowngrade(join(target.dir, 'node_modules', PACKAGE, 'package.json'))
  if (dryRun) return null
  const files = ['package.json', 'pnpm-lock.yaml', 'cordis.yml', 'cordis.yaml', 'cordis.patch.yml'].map((f) => join(target.dir, f))
  const original = await strictJson(files[0])
  const originalBundles = original.dsh?.profile?.bundles ?? []
  const retired = DSH_PACKAGE_NAMES.filter((name) => name !== PACKAGE && (original.dependencies?.[name] || original.devDependencies?.[name] || originalBundles.includes(name)))
  const bundles = [...new Set(originalBundles.map((name) => retired.includes(name) ? PACKAGE : name))]
  const backup = await transactional(files, async () => {
    await checkedCommand(run, 'dsh', ['plugin', '--profile', target.profile, 'add', PKG_ROOT])
    const pkg = await strictJson(files[0])
    if (!pkg.dependencies?.[PACKAGE] || !pkg.dsh?.profile?.bundles?.includes(PACKAGE)) throw new Error('DSH did not register the new bundle; keeping the old registration')
    const current = await strictJson(join(PKG_ROOT, 'package.json'))
    await verifyReplacement(join(target.dir, 'node_modules', PACKAGE), current.version)
    // Switch the active bundle list before retiring packages, so old/new adapters
    // cannot remain simultaneously registered. Disabled bundles remain disabled.
    pkg.dsh = { ...original.dsh, profile: { ...original.dsh?.profile, bundles } }
    await writeFile(files[0], `${JSON.stringify(pkg, null, 2)}\n`, { mode: 0o600 })
  })
  try {
    for (const name of retired) await checkedCommand(run, 'dsh', ['plugin', '--profile', target.profile, 'remove', name])
    const pkg = await strictJson(files[0])
    if (retired.some((name) => pkg.dependencies?.[name] || pkg.devDependencies?.[name] || pkg.dsh?.profile?.bundles?.includes(name))) throw new Error('Legacy bundle remains registered')
    if (JSON.stringify(pkg.dsh?.profile?.bundles) !== JSON.stringify(bundles)) throw new Error('DSH cleanup changed bundle preferences')
  } catch {
    // Package-manager side effects are not filesystem-transactional. Never restore
    // a registration pointing at a legacy dependency that may already be deleted.
    throw new Error(`New DSH bundle is registered, but legacy cleanup failed; inspect this profile before restarting. Backup: ${backup}`)
  }
  return backup
}

export async function refreshIntegration(target, { dryRun = false, run } = {}) {
  if (target.kind === 'mcp') return refreshMcp(target, dryRun)
  if (target.kind === 'pi') return refreshPi(target, dryRun, run)
  if (target.kind === 'dsh') return refreshDsh(target, dryRun, run)
  throw new Error('Unknown upgrade target')
}

/** Plugins are managed by their host, separately from user/project MCP files. */
export async function refreshGrokPlugin({ dryRun, run }) {
  let result
  try { result = await run('grok', ['plugin', 'list', '--json']) } catch { return { status: 'unavailable', message: 'Grok CLI unavailable; plugin installation could not be inspected.' } }
  if (result.code !== 0) return { status: 'failed', message: 'Grok plugin discovery failed; no success assumed.' }
  let list
  try { list = JSON.parse(result.stdout) } catch { return { status: 'failed', message: 'Grok plugin list returned invalid JSON.' } }
  if (!Array.isArray(list)) return { status: 'failed', message: 'Unsupported Grok plugin list format.' }
  const existing = list.find((p) => p.name === 'search-boost')
  if (!existing) return { status: 'absent', message: 'No existing Grok plugin; not installing a new one.' }
  if (existing.enabled === false || existing.disabled === true) return { status: 'disabled', message: 'Grok plugin is disabled; registration left unchanged, not re-enabled.' }
  if (dryRun) return { status: 'planned', message: 'Would refresh the existing Grok plugin without changing trust.' }
  // Do not add --trust during upgrade: previously disabled/untrusted plugins stay subject to host controls.
  await checkedCommand(run, 'grok', ['plugin', 'install', join(PKG_ROOT, 'grok-plugin')])
  const verifiedRaw = await checkedCommand(run, 'grok', ['plugin', 'list', '--json'])
  let verified
  try { verified = JSON.parse(verifiedRaw) } catch { throw new Error('Grok plugin verification returned invalid JSON') }
  if (!Array.isArray(verified) || !verified.some((p) => p.name === 'search-boost' && typeof p.source === 'string' && resolve(p.source) === resolve(PKG_ROOT, 'grok-plugin'))) throw new Error('Cannot verify the updated Grok plugin source; inspect the host plugin list')
  return { status: 'updated', message: 'Grok plugin source verified; restart the host to reload.' }
}
