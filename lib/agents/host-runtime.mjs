/**
 * Install helpers for host-runtime agents (pi, dsh) — agents whose search
 * tools run in the host process through adapters/pi and adapters/dsh instead
 * of the MCP server.
 *
 *  pi  → write ~/.pi/agent/extensions/search-boost.js, a one-line shim that
 *        re-exports adapters/pi/index.js from this package (pi auto-discovers
 *        extensions/*.js), plus owned searcher/summarizer and slash-prompt
 *        copies under ~/.pi/agent/{agents,prompts}. Uninstall removes only
 *        files we wrote.
 *  dsh → forward to `dsh plugin --profile <name> add|remove` (pnpm in the
 *        profile dir); DSH wires the bundle via package.json `dsh.bundle`.
 */
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { piSubagentTemplatePaths, piWorkflowPromptPaths } from '../../agents/router.mjs'
import { packageIdentity } from '../package-identity.mjs'
import { migratePiSubagentSettings } from '../pi-subagent-config.mjs'
import { strictJson } from '../upgrade/config.mjs'
import { runCommand } from '../upgrade/process.mjs'
import { renderResearchTemplate } from '../search/parallel-contract.mjs'
import { commandExists } from '../mcp-entry.mjs'
import { readTextFile, writeTextFile } from '../json-config.mjs'
import { shellArgs } from '../shell-args.mjs'
import { DSH_PACKAGE_NAME, PATHS, PI_OWNED_MARKER, PI_SHIM_MARKER, dshProfilesWithSearchBoost, piRegistersLegacyPackage } from '../paths.mjs'
import { PKG_ROOT, getVersion } from '../pkg.mjs'
import { removeEmptyDirIfExists, removeFileIfExists } from './shared.mjs'

export const DEFAULT_DSH_PROFILE = 'web'

/** Absolute pi adapter entry inside this package. */
export function piAdapterEntry() {
  return join(PKG_ROOT, 'adapters', 'pi', 'index.js')
}

/** Contents of the pi extension shim (pi loads extensions/*.js via jiti). */
export function piShimSource() {
  const url = pathToFileURL(piAdapterEntry()).href
  return [
    `// ${PI_SHIM_MARKER} — written by \`search-boost install -t pi\`; safe to delete.`,
    '// Loads the SearchBoost pi host adapter from the installed search-boost package.',
    `export { default } from '${url}'`,
    '',
  ].join('\n')
}

/** True when the legacy pi-search-boost extension copy is still present (double registration). */
export function piLegacyExtensionPresent() {
  const dir = PATHS.pi.legacyExtensionDir
  if (existsSync(join(dir, 'index.ts')) || existsSync(join(dir, 'index.js'))) return true
  // A legacy *package* (npm:pi-search-boost@0.1.3) registers the same tools, so the
  // duplicate-tools warning must fire for it too, not only for a hand-copied dir.
  return piRegistersLegacyPackage()
}

/** Source template → injected dest under ~/.pi/agent/{agents,prompts}. */
export function piInjectPairs() {
  /** @type {{ src: string, dest: string }[]} */
  const pairs = []
  for (const src of piSubagentTemplatePaths()) {
    pairs.push({ src, dest: join(PATHS.pi.agentsDir, basename(src)) })
  }
  for (const src of piWorkflowPromptPaths()) {
    pairs.push({ src, dest: join(PATHS.pi.promptsDir, basename(src)) })
  }
  return pairs
}

/**
 * Write a package template to dest when dest is missing or already ours.
 * Never overwrite a user-owned file that lacks PI_OWNED_MARKER.
 * @param {string} src
 * @param {string} dest
 * @param {boolean} dryRun
 */
async function injectOwnedMarkdown(src, dest, dryRun) {
  const body = renderResearchTemplate(await readTextFile(src))
  if (!body.includes(PI_OWNED_MARKER)) {
    throw new Error(`pi template missing ownership marker: ${src}`)
  }
  if (existsSync(dest)) {
    const current = await readTextFile(dest)
    if (!current.includes(PI_OWNED_MARKER)) return false
    if (current === body) return true
  }
  if (!dryRun) await writeTextFile(dest, body)
  return true
}

/** @param {{ dryRun?: boolean }} opts */
export async function installPiExtension(opts) {
  const dryRun = !!opts.dryRun
  const file = PATHS.pi.extension
  const settingsPath = join(PATHS.pi.agentDir, 'settings.json')
  const settings = await strictJson(settingsPath)
  const childMigration = migratePiSubagentSettings(settings, PATHS.pi.agentDir, piAdapterEntry())
  const packageRegistered = ['packages', 'extensions'].some((field) => Array.isArray(settings[field]) && settings[field].some((entry) =>
    packageIdentity(typeof entry === 'string' ? entry : entry?.source, PATHS.pi.agentDir) === DSH_PACKAGE_NAME))
  const priorShim = existsSync(file) ? await readTextFile(file) : null
  if (!packageRegistered && priorShim !== null && !priorShim.includes(PI_SHIM_MARKER)) {
    throw new Error(`User-owned Pi extension at ${file}; left unchanged. Move it explicitly before installing SearchBoost.`)
  }
  // A package registration already loads this adapter. Retain custom files, but
  // remove our old shim so pi install + CLI install cannot double-register tools.
  if (packageRegistered && priorShim?.includes(PI_SHIM_MARKER) && !dryRun) await removeFileIfExists(file)
  const written = packageRegistered ? [] : [file]
  if (!dryRun && !packageRegistered) {
    const current = existsSync(file) ? await readTextFile(file) : ''
    const next = piShimSource()
    if (current !== next) await writeTextFile(file, next)
  }
  for (const { src, dest } of piInjectPairs()) {
    const ok = await injectOwnedMarkdown(src, dest, dryRun)
    if (ok) written.push(dest)
  }
  if (childMigration.changes.length) {
    if (!dryRun) await writeTextFile(settingsPath, `${JSON.stringify(childMigration.settings, null, 2)}\n`)
    written.push(settingsPath)
  }
  if (piLegacyExtensionPresent()) {
    console.warn(
      `Note: legacy pi-search-boost copy found at ${PATHS.pi.legacyExtensionDir} — remove it (and \`pi remove pi-search-boost\` if installed as a package) to avoid duplicate tools.`,
    )
  }
  return written
}

/** @param {{ dryRun?: boolean }} opts */
export async function uninstallPiExtension(opts) {
  const settingsPath = join(PATHS.pi.agentDir, 'settings.json')
  const settings = await strictJson(settingsPath)
  let settingsChanged = false
  for (const field of ['packages', 'extensions']) {
    if (!Array.isArray(settings[field])) continue
    const next = settings[field].filter((entry) => packageIdentity(typeof entry === 'string' ? entry : entry?.source, PATHS.pi.agentDir) !== DSH_PACKAGE_NAME)
    if (next.length !== settings[field].length) { settings[field] = next; settingsChanged = true }
  }
  if (settingsChanged && !opts.dryRun) await writeTextFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`)

  const file = PATHS.pi.extension
  if (existsSync(file)) {
    let content = ''
    try {
      content = await readFile(file, 'utf8')
    } catch {
      content = ''
    }
    if (content.includes(PI_SHIM_MARKER) && !opts.dryRun) {
      await removeFileIfExists(file)
      await removeEmptyDirIfExists(dirname(file))
    }
  }
  for (const { dest } of piInjectPairs()) {
    if (!existsSync(dest)) continue
    const content = await readTextFile(dest)
    if (!content.includes(PI_OWNED_MARKER)) continue
    if (!opts.dryRun) await removeFileIfExists(dest)
  }
  if (!opts.dryRun) {
    await removeEmptyDirIfExists(PATHS.pi.agentsDir)
    await removeEmptyDirIfExists(PATHS.pi.promptsDir)
  }
}

/** Snippet for `search-boost print pi`. */
export function formatPiPrintConfig() {
  return [
    `# pi loads extensions from ${PATHS.pi.agentDir}/extensions/*.js — write this shim:`,
    `# ${PATHS.pi.extension}`,
    '',
    piShimSource().trim(),
    '',
    `# Injected subagents: ${piSubagentTemplatePaths().map((p) => basename(p)).join(', ')} → ${PATHS.pi.agentsDir}`,
    `# Slash prompts:      ${piWorkflowPromptPaths().map((p) => `/${basename(p, '.md')}`).join(' ')} → ${PATHS.pi.promptsDir}`,
    '',
    '# Or install as a pi package instead (no shim / no injected prompts):',
    `#   pi install npm:${DSH_PACKAGE_NAME}`,
    `#   pi -e ${piAdapterEntry()}   # one-off`,
  ].join('\n')
}

export function dshCliAvailable() {
  return commandExists('dsh')
}

/**
 * Package spec `dsh plugin add` receives. A checkout / npm-linked install
 * points at PKG_ROOT (pnpm links it); a published install pins its own version
 * instead of silently installing a different release from the latest tag.
 */
export function dshPackageSpec() {
  const inNodeModules = /[\\/]node_modules[\\/]/.test(PKG_ROOT)
  return inNodeModules ? `${DSH_PACKAGE_NAME}@${getVersion()}` : PKG_ROOT
}

/** @param {'add'|'remove'} verb @param {string} profile */
export function dshPluginArgs(verb, profile = DEFAULT_DSH_PROFILE) {
  const spec = verb === 'add' ? dshPackageSpec() : DSH_PACKAGE_NAME
  return ['plugin', '--profile', profile, verb, spec]
}

/** npm exec is npx's portable equivalent; no global DSH/pnpm install is needed. */
export function dshLaunchCommand(args, {
  dshAvailable = dshCliAvailable(),
  pnpmAvailable = commandExists('pnpm'),
  npmAvailable = commandExists('npm'),
} = {}) {
  if (dshAvailable && pnpmAvailable) return { command: 'dsh', args }
  if (!npmAvailable) {
    throw new Error('DSH requires dsh and pnpm on PATH, or npm for npx-style execution — no DSH installation changed.')
  }
  return {
    command: 'npm',
    args: ['exec', '--yes',
      ...(!dshAvailable ? ['--package', '@deepseek-ai/dsh'] : []),
      ...(!pnpmAvailable ? ['--package', 'pnpm'] : []),
      '--', 'dsh', ...args],
  }
}

async function runDsh(args, dryRun) {
  // npm exec also reaches cmd.exe on Windows, even when npm itself is launched
  // through node. Apply the same guard as the direct DSH launcher path.
  if (process.platform === 'win32' && args.some((arg) => /["%!^&|<>\r\n]/.test(arg))) {
    throw new Error('Unsupported Windows command path characters; use a path without shell metacharacters.')
  }
  const launch = dshLaunchCommand(args, dryRun ? { npmAvailable: true } : {})
  const shown = `${launch.command} ${shellArgs(launch.args)}`
  if (dryRun) {
    console.log(`  (dry-run) ${shown}`)
    return true
  }
  // The shared execution layer handles npm's JS entry and DSH .cmd launchers
  // on Windows; no raw npx.cmd spawn or interpolated user arguments.
  const result = await runCommand(launch.command, launch.args, { timeoutMs: 300_000 })
  if (result.stdout) process.stdout.write(result.stdout)
  if (result.stderr) process.stderr.write(result.stderr)
  if (result.code !== 0) {
    throw new Error(`${shown} failed (exit ${result.code ?? '?'}) — inspect the DSH/package-manager diagnostics above; installation was not verified.`)
  }
  return true
}

/** @param {{ dryRun?: boolean, profile?: string }} opts */
export async function installDshBundle(opts) {
  const profile = opts.profile || DEFAULT_DSH_PROFILE
  await runDsh(dshPluginArgs('add', profile), !!opts.dryRun)
  const dir = join(PATHS.dsh.profiles, profile)
  const manifest = join(dir, 'package.json')
  if (!opts.dryRun) await verifyDshBundle(dir)
  return [manifest]
}

/** Do not report success solely because a launcher exited zero. */
export async function verifyDshBundle(dir) {
  const profile = await strictJson(join(dir, 'package.json'))
  const spec = profile.dependencies?.[DSH_PACKAGE_NAME] ?? profile.devDependencies?.[DSH_PACKAGE_NAME]
  if (typeof spec !== 'string' || !Array.isArray(profile.dsh?.profile?.bundles) || !profile.dsh.profile.bundles.includes(DSH_PACKAGE_NAME)) {
    throw new Error('DSH profile did not register/enable search-boost; installation was not verified.')
  }
  const root = join(dir, 'node_modules', DSH_PACKAGE_NAME)
  const pkg = await strictJson(join(root, 'package.json'))
  if (pkg.name !== DSH_PACKAGE_NAME || pkg.version !== getVersion() || pkg.dsh?.bundle?.patch !== './adapters/dsh/cordis.patch.yml') {
    throw new Error('DSH installed bundle identity/version mismatch; installation was not verified.')
  }
  for (const file of ['adapters/dsh/index.js', 'adapters/dsh/schema.js', 'adapters/dsh/cordis.patch.yml']) {
    if (!existsSync(join(root, file))) throw new Error(`DSH installed bundle is missing ${file}; installation was not verified.`)
  }
}

/** @param {{ dryRun?: boolean, profile?: string }} opts */
export async function uninstallDshBundle(opts) {
  const profiles = opts.profile ? [opts.profile] : dshProfilesWithSearchBoost()
  for (const profile of profiles) {
    await runDsh(dshPluginArgs('remove', profile), !!opts.dryRun)
  }
}

/** Snippet for `search-boost print dsh`. */
export function formatDshPrintConfig(profile = DEFAULT_DSH_PROFILE) {
  return [
    `# DSH bundle plugin — installs into ${join(PATHS.dsh.profiles, profile)} via pnpm:`,
    `dsh ${shellArgs(dshPluginArgs('add', profile))}`,
    '',
    '# or from npm without a global dsh:',
    `npx --yes --package @deepseek-ai/dsh --package pnpm -- dsh ${shellArgs(['plugin', '--profile', profile, 'add', `${DSH_PACKAGE_NAME}@${getVersion()}`])}`,
    '',
    '# verify: web.searchProvider / fetchProvider → search-boost',
    `dsh --profile ${shellArgs([profile])} --dump-config`,
    '',
    `# remove: dsh ${shellArgs(dshPluginArgs('remove', profile))}`,
  ].join('\n')
}
