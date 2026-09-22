#!/usr/bin/env node
/** New TUI/CLI manages OLD Pi/DSH/MCP installations. No real package-manager/host mutations. */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, rmSync, statSync, symlinkSync, readlinkSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'

const temp = mkdtempSync(join(tmpdir(), 'sb upgrade '))
const home = join(temp, 'home'), project = join(temp, 'project')
mkdirSync(home); mkdirSync(project)
process.env.HOME = home
process.env.USERPROFILE = home
process.env.SEARCH_BOOST_HOME = join(home, '.search-boost')
process.env.PI_CODING_AGENT_DIR = join(home, '.pi', 'agent')
process.env.DSH_HOME = join(home, '.dsh')
for (const key of ['SEARCH_BOOST_KEYS_FILE', 'SEARCH_BOOST_LAYER_FILE', 'SEARCH_BOOST_XAUTH_FILE', 'SEARCH_BOOST_XGUEST_FILE', 'SEARCH_BOOST_WORKSPACES_FILE', 'SEARCH_BOOST_UPGRADE_HANDOFF', 'TAVILY_API_KEY', 'BRAVE_API_KEY', 'EXA_API_KEY', 'ANYSEARCH_API_KEY', 'PI_SEARCH_TAVILY_KEY', 'PI_SEARCH_BRAVE_KEY', 'PI_SEARCH_EXA_KEY']) delete process.env[key]
const cwd = process.cwd()
process.chdir(project)
const write = (path, value) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value, null, 2)) }
const json = (path) => JSON.parse(readFileSync(path, 'utf8'))
const bytes = (path) => readFileSync(path, 'utf8')
function snapshot(dir = home) {
  return Object.fromEntries(readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    return entry.isSymbolicLink() ? [[path, `symlink:${readlinkSync(path)}`]] : entry.isDirectory() ? Object.entries(snapshot(path)) : [[path, bytes(path)]]
  }))
}
const fixtureSecret = 'fixture-value-not-a-real-credential'
const { runUpgrade } = await import('../lib/upgrade/index.mjs')
const { compareVersions } = await import('../lib/upgrade/process.mjs')
const { refreshTomlMcp } = await import('../lib/upgrade/config.mjs')
const { discoverIntegrations, refreshIntegration } = await import('../lib/upgrade/integrations.mjs')
const { PATHS, workspaceAgents } = await import('../lib/paths.mjs')
const { PKG_ROOT, getVersion } = await import('../lib/pkg.mjs')
const version = getVersion()
const globalRoot = join(temp, 'global node_modules')
mkdirSync(globalRoot)
const logs = [], calls = []
const log = (message) => logs.push(message)
let npmVersion = version, failDshRemove = false, failNpm = false
async function run(command, args) {
  calls.push({ command, args })
  if (command === 'npm' && args[0] === 'root') return { code: 0, stdout: globalRoot }
  if (command === 'npm' && args[0] === 'uninstall' && args[1] === '--prefix') {
    const prefix = args[2]
    const pkg = json(join(prefix, 'package.json'))
    for (const name of args.filter((a) => ['pi-search-boost', 'search-boost-mcp'].includes(a))) {
      assert.equal(json(join(PATHS.pi.agentDir, 'settings.json')).packages[1].source, PKG_ROOT, 'commit replacement before removing old packages')
      delete pkg.dependencies[name]
      rmSync(join(prefix, 'node_modules', name), { recursive: true, force: true })
    }
    write(join(prefix, 'package.json'), pkg)
    return { code: 0, stdout: '' }
  }
  if (command === 'npm' && args[0] === 'view') return { code: failNpm ? 1 : 0, stdout: JSON.stringify(npmVersion), stderr: fixtureSecret }
  if (command === 'grok' && args[0] === 'plugin' && args[1] === 'list') return { code: 0, stdout: '[]' }
  if (command === 'dsh') {
    const profile = args[2], verb = args[3]
    const file = join(PATHS.dsh.profiles, profile, 'package.json')
    const pkg = json(file)
    if (verb === 'add') {
      assert.equal(args[4], PKG_ROOT)
      pkg.dependencies['search-boost'] = `link:${PKG_ROOT}`
      pkg.dsh.profile.bundles = [...new Set([...pkg.dsh.profile.bundles, 'search-boost'])]
      write(file, pkg)
      const installed = join(dirname(file), 'node_modules', 'search-boost')
      mkdirSync(dirname(installed), { recursive: true })
      rmSync(installed, { recursive: true, force: true })
      symlinkSync(PKG_ROOT, installed, process.platform === 'win32' ? 'junction' : 'dir')
      return { code: 0, stdout: '' }
    }
    if (verb === 'remove') {
      assert(['dsh-search-boost', 'search-boost-mcp'].includes(args[4]))
      assert(existsSync(join(dirname(file), 'node_modules', 'search-boost', 'package.json')), 'new package must be installed before removing legacy')
      if (failDshRemove) return { code: 1, stdout: '', stderr: fixtureSecret }
      delete pkg.dependencies[args[4]]
      pkg.dsh.profile.bundles = pkg.dsh.profile.bundles.filter((p) => p !== args[4])
      write(file, pkg)
      return { code: 0, stdout: '' }
    }
  }
  throw new Error(`Unexpected command in hermetic test: ${command} ${args[0]}`)
}
try {
  assert(compareVersions('1.10.0', '1.9.9') > 0)
  assert(compareVersions('1.0.0', '1.0.0-beta.9') > 0)
  assert(compareVersions('1.0.0-beta.10', '1.0.0-beta.2') > 0)
  assert.equal(compareVersions('1.0.0+build1', '1.0.0+build2'), 0)
  for (const value of ['latest', '1.2', '1.02.0', '1.0.0-a.01', '1.0.0;evil']) assert.throws(() => compareVersions(value, '1.0.0'))
  const toml = '[other]\nvalue = "keep"\n\n[mcp_servers."search-boost"]\ncommand="npx"\nargs = [\n  "-y", # comment\n  "search-boost",\n]\nenabled = false\ndefault_tools_approval_mode="ask"\n[mcp_servers."search-boost".env]\nTOKEN="unchanged"\n'
  const updated = refreshTomlMcp(toml, { command: 'node', args: ['/new/cli.mjs', 'serve'] })
  assert(updated.includes('TOKEN="unchanged"') && updated.includes('enabled = false') && updated.includes('approval_mode="ask"'))
  assert.equal((updated.match(/^args\s*=/gm) ?? []).length, 1)
  console.log('ok: strict version ordering and launch-only TOML edits preserve env/permissions/disabled state')

  // Legacy credentials are deliberately outside package roots. Upgrade must not copy,
  // refresh, serialize, delete, or print them.
  const protectedFiles = [
    join(home, '.dsh-search-boost-keys.json'), join(home, '.dsh-search-boost-layer.json'),
    join(home, '.dsh-search-boost-xauth.json'), join(PATHS.pi.agentDir, 'xsearch-auth.json'),
    join(PATHS.pi.agentDir, 'search-boost-layer.json'), join(home, '.grok', 'auth.json'),
    join(home, '.codex', 'auth.json'), join(PATHS.pi.agentDir, 'auth.json'),
  ]
  for (const file of protectedFiles) write(file, { key: fixtureSecret, refresh_token: fixtureSecret, tavily: fixtureSecret, layer: 'api' })
  const credentialBytes = Object.fromEntries(protectedFiles.map((f) => [f, bytes(f)]))
  process.env.PI_SEARCH_BRAVE_KEY = fixtureSecret
  const keys = await import('../lib/keys.mjs')
  assert.equal(keys.readKeys().brave, fixtureSecret)
  process.env.BRAVE_API_KEY = 'modern-env-wins'
  assert.equal(keys.readKeys().brave, 'modern-env-wins')
  delete process.env.BRAVE_API_KEY

  // Legacy DSH is present in TWO profiles; preserve all other packages and profile config.
  for (const profile of ['web', 'headless', 'paused', 'old-mcp']) {
    const dir = join(PATHS.dsh.profiles, profile)
    const oldName = profile === 'old-mcp' ? 'search-boost-mcp' : 'dsh-search-boost'
    write(join(dir, 'package.json'), { name: `profile-${profile}`, dependencies: { [oldName]: '^0.1.3', 'user-plugin': '1.0.0' }, dsh: { profile: { bundles: profile === 'paused' ? ['user-plugin'] : ['user-plugin', oldName], custom: 'keep' } } })
    write(join(dir, 'cordis.yml'), `disabled: true\ncustom_token: ${fixtureSecret}\n`)
  }
  // Legacy Pi package registration, with explicit tool filtering and user preferences.
  write(join(PATHS.pi.agentDir, 'settings.json'), { packages: ['npm:user-tools', { source: 'npm:pi-search-boost@0.1.3', extensions: [] }, { source: 'npm:search-boost-mcp@0.1.7', extensions: [] }], defaultModel: 'user-model', customToken: fixtureSecret })
  write(join(PATHS.pi.agentDir, 'npm', 'package.json'), { dependencies: { 'pi-search-boost': '0.1.3', 'search-boost-mcp': '0.1.7', 'user-package': '1.0.0' } })
  for (const name of ['pi-search-boost', 'search-boost-mcp']) write(join(PATHS.pi.agentDir, 'npm', 'node_modules', name, 'package.json'), { name, version: '0.1.3' })
  // A second old Pi manual installation in the project; no metadata file was copied by old install.sh.
  const manual = join(project, '.pi', 'extensions', 'search-boost')
  write(join(manual, 'index.ts'), 'export default function searchBoostExtension() {}\n// PI_SEARCH_TAVILY_KEY <search_balance>\n')
  write(join(manual, 'lib', 'engines.ts'), '// old engine')
  write(join(manual, 'user-note.txt'), 'must survive archive')

  // Existing MCP installs: arbitrary env/token fields and disabled hooks must survive.
  write(PATHS.claude.config, { mcpServers: { 'search-boost': { command: 'old', args: [], env: { TOKEN: fixtureSecret }, disabled: true }, 'user-server': { command: 'mine' } } })
  write(PATHS.claude.settings, { permissions: { allow: ['Read'], deny: ['WebSearch'], ask: ['mcp__search-boost__*'] }, disableAllHooks: true })
  write(PATHS.claude.agents, '# User rules\n\n<!-- SEARCH_BOOST_START -->\nold\n<!-- SEARCH_BOOST_END -->\n')
  write(PATHS.codex.config, `web_search = "live"\n[mcp_servers.search-boost]\ncommand="old"\nargs=[]\ndefault_tools_approval_mode="ask"\nenabled=false\n[mcp_servers.search-boost.env]\nTOKEN="${fixtureSecret}"\n`)
  write(PATHS.cursor.mcp, { mcpServers: { 'search-boost': { command: 'old', args: [], env: { KEY: fixtureSecret }, disabled: true } } })
  write(PATHS.cursor.hooks, { version: 1, enabled: false, hooks: { sessionStart: [{ command: `node "${PATHS.cursor.hookScript}"`, enabled: false, timeout: 99 }] } })
  const ws = workspaceAgents(project)
  write(ws.mcp, { mcpServers: { 'search-boost': { command: 'old', args: [], env: { AUTH: fixtureSecret } } } })
  write(ws.hooks, { 'search-boost-reminder': { enabled: false, PreInvocation: [{ type: 'command', command: 'node ./hooks/search-boost-pre-invocation.mjs', timeout: 77 }] } })
  write(join(project, '.grok', 'config.toml'), `[mcp_servers.search-boost]\ncommand="old"\nargs=[]\n[permission]\nallow=["Read"]\n`)

  const beforeDry = snapshot()
  const projectBeforeDry = snapshot(project)
  const dry = await runUpgrade({ dryRun: true, run, log })
  assert(dry.ok)
  assert.deepEqual(snapshot(), beforeDry)
  assert.deepEqual(snapshot(project), projectBeforeDry)
  assert(!calls.some((c) => c.command === 'dsh'))
  console.log('ok: dry-run discovers legacy Pi/DSH and MCP without filesystem or host mutations')

  const result = await runUpgrade({ run, log })
  assert(result.ok, logs.join('\n'))
  assert(!calls.some((c) => c.command === 'npm' && c.args[0] === 'install'), 'equal package versions still migrate assets, without npm reinstall')
  assert.equal(calls.filter((c) => c.command === 'dsh' && c.args[3] === 'add').length, 4)
  for (const profile of ['web', 'headless', 'paused', 'old-mcp']) {
    const pkg = json(join(PATHS.dsh.profiles, profile, 'package.json'))
    assert(!pkg.dependencies['dsh-search-boost'])
    assert(pkg.dependencies['search-boost'])
    assert.equal(pkg.dependencies['user-plugin'], '1.0.0')
    assert.equal(pkg.dsh.profile.custom, 'keep')
    assert.deepEqual(pkg.dsh.profile.bundles, profile === 'paused' ? ['user-plugin'] : ['user-plugin', 'search-boost'])
    assert(bytes(join(PATHS.dsh.profiles, profile, 'cordis.yml')).includes(fixtureSecret))
  }
  const settings = json(join(PATHS.pi.agentDir, 'settings.json'))
  assert.equal(settings.packages[1].source, PKG_ROOT)
  assert.deepEqual(settings.packages[1].extensions, [])
  assert.equal(settings.defaultModel, 'user-model')
  assert.equal(settings.customToken, fixtureSecret)
  assert(!existsSync(PATHS.pi.extension), 'filtered package must not gain an unrestricted shim')
  assert(!existsSync(manual))
  const manualBackup = result.results.find((r) => r.target.includes(join(project, '.pi'))).backup
  assert.equal(bytes(join(manualBackup, 'legacy-pi-0', 'user-note.txt')), 'must survive archive')
  assert(existsSync(join(project, '.pi', 'extensions', 'search-boost.js')))
  assert(!bytes(join(PATHS.pi.agentDir, 'agents', 'searcher.md')).includes('{{'))
  assert.deepEqual(json(PATHS.claude.settings).permissions, { allow: ['Read'], deny: ['WebSearch'], ask: ['mcp__search-boost__*'] })
  assert.equal(json(PATHS.claude.settings).disableAllHooks, true)
  assert.deepEqual(json(PATHS.claude.config).mcpServers['search-boost'].env, { TOKEN: fixtureSecret })
  assert.equal(json(PATHS.claude.config).mcpServers['search-boost'].disabled, true)
  assert.equal(json(PATHS.claude.config).mcpServers['user-server'].command, 'mine')
  assert(bytes(PATHS.codex.config).includes('web_search = "live"'))
  assert(bytes(PATHS.codex.config).includes('approval_mode="ask"'))
  assert(bytes(PATHS.codex.config).includes(fixtureSecret))
  assert.equal(json(PATHS.cursor.hooks).enabled, false)
  assert.equal(json(PATHS.cursor.hooks).hooks.sessionStart[0].enabled, false)
  assert.equal(json(PATHS.cursor.hooks).hooks.sessionStart[0].timeout, 99)
  assert.equal(json(ws.hooks)['search-boost-reminder'].enabled, false)
  for (const path of [PATHS.claude.skill, PATHS.codex.skill, PATHS.cursor.skill, ws.skill]) {
    assert(bytes(path).includes('search-boost-parallel-research'))
    assert(existsSync(join(dirname(dirname(path)), 'search-boost-parallel-research', 'SKILL.md')))
  }
  for (const file of protectedFiles) assert.equal(bytes(file), credentialBytes[file])
  assert(!logs.join('\n').includes(fixtureSecret))
  if (process.platform !== 'win32') assert.equal(statSync(manualBackup).mode & 0o777, 0o700)
  console.log('ok: new package migrates both old DSH profiles, old Pi package/manual copies and MCP assets; tokens/preferences unchanged')

  // npm-updated users can synchronize even offline, and the operation remains idempotent.
  calls.length = 0
  const stableClaude = bytes(PATHS.claude.settings)
  const again = await runUpgrade({ syncOnly: true, run, log })
  assert(again.ok)
  assert(!calls.some((c) => c.command === 'npm' && ['view', 'install'].includes(c.args[0])))
  assert.equal(bytes(PATHS.claude.settings), stableClaude)
  assert.equal(json(join(PATHS.pi.agentDir, 'settings.json')).packages.length, 2)
  for (const file of protectedFiles) assert.equal(bytes(file), credentialBytes[file])
  console.log('ok: offline sync after npm update is idempotent and does not touch credentials')

  // Package manager reports success but installs no payload: never remove the old registration.
  const plan = await discoverIntegrations()
  const dshTarget = plan.targets.find((t) => t.kind === 'dsh')
  const dshFile = join(dshTarget.dir, 'package.json')
  const savedDsh = bytes(dshFile)
  write(dshFile, { dependencies: { 'dsh-search-boost': '0.1.3' }, dsh: { profile: { bundles: ['dsh-search-boost'] } } })
  let removed = false
  await assert.rejects(refreshIntegration({ ...dshTarget, legacy: true }, { run: async (_c, args) => { removed ||= args[3] === 'remove'; return { code: 0, stdout: '' } } }), /did not register/)
  assert(!removed)
  assert(json(dshFile).dependencies['dsh-search-boost'])
  write(dshFile, savedDsh)

  // Failure/foreign ownership is partial, not a falsely successful install; other targets continue.
  write(PATHS.claude.skill, '---\nname: search-boost\ndescription: user replacement\n---\n# User-owned\n')
  const foreignConfig = bytes(PATHS.claude.config)
  const partial = await runUpgrade({ syncOnly: true, run, log })
  assert(!partial.ok)
  assert(partial.results.some((r) => r.target === 'claude' && !r.ok))
  assert.equal(bytes(PATHS.claude.config), foreignConfig)
  assert(bytes(PATHS.claude.skill).includes('User-owned'))
  assert(!logs.join('\n').includes(fixtureSecret))
  console.log('ok: failed verification and foreign files block only affected targets; no false success')

  // Latest check failures must not be swallowed; no credential/host mutations.
  const beforeFailure = snapshot()
  failNpm = true
  await assert.rejects(runUpgrade({ run, log }), /failed/)
  failNpm = false
  assert.deepEqual(snapshot(), beforeFailure)
  assert(!existsSync(join(process.env.SEARCH_BOOST_HOME, 'state', 'upgrade.lock')))

  // A timeout must not release a lock while a handed-off worker is still alive.
  const { acquireLock } = await import('../lib/upgrade/lock.mjs')
  const lease = await acquireLock()
  const lockFile = join(process.env.SEARCH_BOOST_HOME, 'state', 'upgrade.lock')
  write(lockFile, { pid: process.ppid, token: lease.token })
  await lease.release()
  assert(existsSync(lockFile), 'a live handoff owner retains the lock')
  write(lockFile, { pid: process.pid, token: lease.token })
  await lease.release()
  assert(!existsSync(lockFile))
  console.log('ok: handed-off live workers retain the lock after parent timeout')

  // A newer release runs from the npx cache, never overwritten imported files.
  const latest = '99.0.0'
  let handoff = false
  const update = await runUpgrade({ log, run: async (command, args, opts) => {
    assert.equal(command, 'npm')
    if (args[0] === 'view') return { code: 0, stdout: JSON.stringify(latest) }
    assert.equal(args[0], 'exec')
    assert(args.includes(`--package=search-boost@${latest}`))
    assert.deepEqual(args.slice(args.indexOf('--') + 1), ['search-boost', 'upgrade', '--yes'])
    assert(opts.env.SEARCH_BOOST_UPGRADE_HANDOFF)
    assert.equal(opts.env.SEARCH_BOOST_UPGRADE_CWD, project)
    assert.notEqual(opts.cwd, project, 'project package must not shadow the cached updater')
    handoff = true
    return { code: 0, stdout: 'cached updater completed' }
  } })
  assert(update.ok && update.reloaded && handoff)
  for (const file of protectedFiles) assert.equal(bytes(file), credentialBytes[file])
  console.log('ok: npm check failures stop cleanly; newer releases hand off to an exact npx cache worker')

  const cliHelp = execFileSync(process.execPath, [join(PKG_ROOT, 'cli.mjs'), 'upgrade', '--help'], { encoding: 'utf8', env: process.env })
  assert(cliHelp.includes('--sync-only') && cliHelp.includes('--workspace'))
  assert(bytes(join(PKG_ROOT, 'lib', 'installer', 'tui.mjs')).includes("case 'upgrade':"))
  const cliHome = join(temp, 'cli-home'), cliCwd = join(temp, 'cli-cwd')
  mkdirSync(cliHome); mkdirSync(cliCwd)
  write(join(cliHome, '.claude.json'), { mcpServers: { 'search-boost': { command: 'old', args: [], env: { TOKEN: fixtureSecret } } } })
  write(join(cliHome, '.search-boost-xauth.json'), { token: fixtureSecret })
  const cliEnv = { ...process.env, HOME: cliHome, USERPROFILE: cliHome, SEARCH_BOOST_HOME: join(cliHome, '.search-boost'), PI_CODING_AGENT_DIR: join(cliHome, '.pi', 'agent'), DSH_HOME: join(cliHome, '.dsh'), npm_config_prefix: join(temp, 'cli npm prefix') }
  const cliOutput = execFileSync(process.execPath, [join(PKG_ROOT, 'cli.mjs'), 'upgrade', '--sync-only', '--yes'], { encoding: 'utf8', env: cliEnv, cwd: cliCwd })
  assert(cliOutput.includes('Upgrade complete'))
  assert(!cliOutput.includes(fixtureSecret))
  assert(existsSync(join(cliHome, '.claude', 'skills', 'search-boost-parallel-research', 'SKILL.md')))
  assert.equal(json(join(cliHome, '.claude.json')).mcpServers['search-boost'].env.TOKEN, fixtureSecret)
  assert.equal(json(join(cliHome, '.search-boost-xauth.json')).token, fixtureSecret)
  console.log('ok: real CLI offline migration updates MCP assets without changing tokens; TUI exposes the same workflow')

  const { agentConfigured } = await import('../lib/paths.mjs')
  assert(agentConfigured('pi'), 'migrated package registrations must appear configured')
  const { installPiExtension, uninstallPiExtension } = await import('../lib/agents/host-runtime.mjs')
  await installPiExtension({ dryRun: false })
  assert(!existsSync(PATHS.pi.extension), 'normal install must not bypass existing package filters')
  await uninstallPiExtension({ dryRun: false })
  const afterUninstall = json(join(PATHS.pi.agentDir, 'settings.json'))
  assert.deepEqual(afterUninstall.packages, ['npm:user-tools'])
  assert.equal(afterUninstall.customToken, fixtureSecret)
  assert(!agentConfigured('pi'))
  console.log('ok: migrated Pi registrations remain visible/manageable; install preserves filters and uninstall preserves other settings')
} finally {
  process.chdir(cwd)
  rmSync(temp, { recursive: true, force: true })
}
console.log('All upgrade/migration tests passed.')
