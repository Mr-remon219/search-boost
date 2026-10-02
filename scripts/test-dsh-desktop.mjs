#!/usr/bin/env node
import './isolate-tests.mjs'
// Hermetic Desktop lifecycle: real subprocesses, fake app/CLI, no user hosts/network.
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync, existsSync, symlinkSync, readdirSync, linkSync, renameSync, lstatSync } from 'node:fs'
import { join, dirname, delimiter } from 'node:path'
import { spawnSync } from 'node:child_process'
import { PATHS, agentDetected, dshProfilesWithSearchBoost } from '../lib/paths.mjs'
import { PKG_ROOT, getVersion } from '../lib/pkg.mjs'
import { desktopCommandCandidates, dshDesktopStatus, desktopLaunchCommand, desktopPathLauncher, desktopRuntimeProbeCommand, DESKTOP_COMMAND_ENV } from '../lib/dsh-desktop.mjs'
import { dshOperationProfiles, dshDesktopPackageSpec, dshProfileLaunchCommand, dshLaunchCommand } from '../lib/agents/host-runtime.mjs'
import { executeAgentOps, runDshSurfaceStep, runInstallerWithOptions } from '../lib/installer/index.mjs'
import { parseFlags, installOpts } from '../lib/cli/args.mjs'
import { discoverIntegrations, refreshIntegration } from '../lib/upgrade/integrations.mjs'
import { runCommand } from '../lib/upgrade/process.mjs'
import { writeDshHostFixture, writeDesktopProbeFixture } from './dsh-host-fixture.mjs'
import { verifyDshRuntime } from '../lib/dsh-runtime.mjs'

const home = process.env.HOME, base = join(home, 'fake desktop'), bin = join(base, 'bin with spaces')
const capture = join(base, 'commands.jsonl'), entry = join(base, 'host.mjs')
const write = (file, value) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value)) }
const json = (file) => JSON.parse(readFileSync(file, 'utf8'))
const profileDir = (name) => join(PATHS.dsh.profiles, name)
const commands = () => existsSync(capture) ? readFileSync(capture, 'utf8').trim().split('\n').map(JSON.parse) : []
const clearCalls = () => rmSync(capture, { force: true })
const messages = []
const log = Object.fromEntries(['info', 'warn', 'error', 'success'].map((name) => [name, (value) => messages.push(String(value))]))
const clack = { log, isCancel: () => false }

assert.equal(dshDesktopStatus().command, null, 'bootstrap blocks absolute real Desktop discovery')
assert.ok(process.env[DESKTOP_COMMAND_ENV].startsWith(home.replace(/[\\/]home$/, '')), 'guard belongs to test sandbox')
assert.deepEqual(desktopCommandCandidates({ platform: 'win32', home, env: { LOCALAPPDATA: join(home, 'Local') } }),
  [join(home, 'Local', 'Programs', 'DeepSeek Harness', 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd')])
assert.deepEqual(desktopCommandCandidates({ platform: 'darwin', home, env: {} }), [
  join('/Applications', 'DeepSeek Harness.app', 'Contents', 'Resources', 'runtime', 'cli', 'bin', 'dsh'),
  join(home, 'Applications', 'DeepSeek Harness.app', 'Contents', 'Resources', 'runtime', 'cli', 'bin', 'dsh'),
])
assert.deepEqual(desktopCommandCandidates({ env: { [DESKTOP_COMMAND_ENV]: join(home, 'missing'), PATH: bin } }), [join(home, 'missing')])
assert.deepEqual(dshOperationProfiles({}), ['web'])
assert.deepEqual(dshOperationProfiles({ dshSurface: 'all', profile: 'custom' }), ['custom', 'desktop'])
assert.deepEqual(dshOperationProfiles({ profile: 'desktop' }), ['desktop'])
for (const opts of [{ dshSurface: 'cli', profile: 'desktop' }, { dshSurface: 'all', profile: 'desktop' }, { dshSurface: 'desktop', profile: 'web' }, ...['../escaped', 'a/b', 'a\\b', 'Desktop', 'desktop.', 'desktop ', '--profile', 'C:escaped'].map(profile => ({ profile }))]) assert.throws(() => dshOperationProfiles(opts))
assert.equal(dshDesktopPackageSpec(join(home, '_npx', 'cache', 'node_modules', 'search-boost'), '1.2.3'), 'search-boost@1.2.3')
assert.equal(dshDesktopPackageSpec(join(home, 'node_modules', 'search-boost'), '1.2.3'), join(home, 'node_modules', 'search-boost'))
assert.equal(installOpts(parseFlags(['--dsh-surface', 'all'])).dshSurface, 'all')
assert.equal(installOpts(parseFlags(['--enable-dsh-bundle'])).enableDshBundle, true)
assert.equal(installOpts(parseFlags([])).enableDshBundle, false)
assert.throws(() => parseFlags(['--dsh-surface', 'invalid']))
console.log('ok: Desktop native discovery, authoritative overrides, surfaces and durable package sources')

writeDshHostFixture(entry, { desktopHost: true, ownerArgument: true })
write(entry, `
import { appendFileSync, readFileSync, writeFileSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
const [owner, ...args] = process.argv.slice(2);
appendFileSync(process.env.DSH_TEST_CAPTURE, JSON.stringify({ owner, args }) + '\\n');
const profile = args[args.indexOf('--profile') + 1], verb = args[args.indexOf('--profile') + 2], source = args.at(-1);
if (profile === 'desktop' && owner !== 'desktop') throw Error('WRONG HOST');
// A package manager might echo a token on either a successful or failed run.
console.log('fixture-secret-do-not-log'); console.error('fixture-secret-do-not-log');
if (process.env.DSH_TEST_FAIL) process.exit(7);
if (process.env.DSH_TEST_NOOP) process.exit(0);
const dir = join(process.env.DSH_HOME, 'profiles', profile), file = join(dir, 'package.json');
mkdirSync(dir, { recursive: true });
let pkg; try { pkg = JSON.parse(readFileSync(file)); } catch { pkg = { dependencies: {}, dsh: { profile: { bundles: [] } } }; }
pkg.dependencies ??= {}; pkg.dsh ??= {}; pkg.dsh.profile ??= { bundles: [] };
if (verb === 'add') {
  const existed = !!pkg.dependencies['search-boost'];
  pkg.dependencies['search-boost'] = 'link:' + source;
  if (!existed) pkg.dsh.profile.bundles.push('search-boost');
  if (process.env.DSH_TEST_HOST_METADATA) { pkg.dsh.hostAdded = 'keep'; pkg.dsh.profile.hostAdded = 'keep'; }
  const dest = join(dir, 'node_modules', 'search-boost');
  mkdirSync(dirname(dest), { recursive: true }); rmSync(dest, { recursive: true, force: true });
  symlinkSync(source, dest, process.platform === 'win32' ? 'junction' : 'dir');
  writeFileSync(join(dir, 'pnpm-lock.yaml'), 'fixture modified lock');
} else if (verb === 'remove') {
  delete pkg.dependencies[source]; delete pkg.devDependencies?.[source];
  pkg.dsh.profile.bundles = pkg.dsh.profile.bundles.filter(name => name !== source);
  if (!process.env.DSH_TEST_LEAVE_LINK) rmSync(join(dir, 'node_modules', source), { recursive: true, force: true });
} else throw Error('unexpected operation');
writeFileSync(file, process.env.DSH_TEST_CORRUPT_REMOVE && verb === 'remove' ? '{invalid' : JSON.stringify(pkg));
`)
function launcher(file, owner) {
  write(file, process.platform === 'win32'
    ? `@"${process.execPath}" "${entry}" "${owner}" %*\r\n`
    : `#!/bin/sh\nexec "${process.execPath}" "${entry}" "${owner}" "$@"\n`)
  chmodSync(file, 0o700)
}
const desktop = join(base, 'resources', 'runtime', 'cli', 'bin', process.platform === 'win32' ? 'dsh.cmd' : 'dsh')
launcher(desktop, 'desktop')
const desktopRuntime = writeDesktopProbeFixture(desktop, entry)
assert.deepEqual(desktopRuntimeProbeCommand(desktop, 'file:///probe.mjs'), { command: desktopRuntime.executable, args: ['--expose-internals', '--import=file:///probe.mjs', desktopRuntime.entry, '--version'] })
assert.throws(() => desktopRuntimeProbeCommand(entry, 'file:///probe.mjs', { required: true }), /Unsupported Desktop launcher layout/)
launcher(join(bin, process.platform === 'win32' ? 'dsh.cmd' : 'dsh'), 'cli')
launcher(join(bin, process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'), 'cli')
if (process.platform !== 'win32') { write(join(bin, 'which'), '#!/bin/sh\ncommand -v "$1"\n'); chmodSync(join(bin, 'which'), 0o700) }
process.env.PATH = [bin, process.env.PATH].join(delimiter)
process.env.DSH_HOME = PATHS.dsh.home
process.env.DSH_TEST_CAPTURE = capture
process.env[DESKTOP_COMMAND_ENV] = desktop

assert.equal(desktopPathLauncher({ env: { PATH: join(desktop, '..') } }), desktop)
assert.equal(desktopPathLauncher({ env: { PATH: [bin, join(desktop, '..')].join(delimiter) } }), null, 'a detected Desktop must not replace the CLI selected first on PATH')
assert.equal(agentDetected('dsh'), true, 'app detection before first launch')
assert.throws(() => desktopLaunchCommand(['plugin']), /initialize/)
assert.ok(!existsSync(profileDir('desktop')), 'preflight must not initialize Desktop')
function resetProfile(name, { installed = false, disabled = false, legacy = false } = {}) {
  const dir = profileDir(name)
  rmSync(dir, { recursive: true, force: true })
  const pkg = { name: `dsh-profile-${name}`, private: true, dependencies: { 'user-plugin': '1.0.0', ...(installed ? { 'search-boost': `link:${PKG_ROOT}` } : {}), ...(legacy ? { 'dsh-search-boost': '0.1.3' } : {}) }, dsh: { profile: { custom: 'retain', bundles: ['user-plugin', ...(!disabled && installed ? ['search-boost'] : []), ...(!disabled && legacy ? ['dsh-search-boost'] : [])] } } }
  write(join(dir, 'package.json'), pkg)
  write(join(dir, 'cordis.patch.yml'), '# keep user patch\n')
  write(join(dir, 'pnpm-lock.yaml'), 'original lock')
  if (installed) {
    mkdirSync(join(dir, 'node_modules'), { recursive: true })
    symlinkSync(PKG_ROOT, join(dir, 'node_modules', 'search-boost'), process.platform === 'win32' ? 'junction' : 'dir')
  }
  return pkg
}
resetProfile('desktop')
clearCalls()
assert.throws(() => dshLaunchCommand(['plugin', '--profile', 'desktop', 'add', PKG_ROOT]), /bundled command/)
symlinkSync(profileDir('desktop'), profileDir('desktop-alias'), process.platform === 'win32' ? 'junction' : 'dir')
assert.throws(() => dshProfileLaunchCommand(['plugin', '--profile', 'desktop-alias', 'add', PKG_ROOT]), /aliases Desktop/)
rmSync(profileDir('desktop-alias'))
assert.deepEqual(dshProfileLaunchCommand(['plugin', '--profile', 'desktop', 'add', PKG_ROOT]), { command: desktop, args: ['plugin', '--profile', 'desktop', 'add', PKG_ROOT] })
for (const surface of ['desktop', 'cli', 'all']) {
  let selects = 0
  const ui = { ...clack, select: async ({ options }) => { selects++; assert.deepEqual(options.map(o => o.value), ['desktop', 'cli', 'all']); return surface } }
  assert.equal(await runDshSurfaceStep(ui, ['dsh'], {}), surface)
  assert.equal(selects, 1)
  await runDshSurfaceStep(ui, ['pi'], {})
  await runDshSurfaceStep(ui, ['dsh'], { yes: true })
  await runDshSurfaceStep(ui, ['dsh'], { profile: 'custom' })
  await runDshSurfaceStep(ui, ['dsh'], {}, { desktopStatus: () => ({ detected: false }) })
  assert.equal(selects, 1, 'do not prompt for unrelated, explicit or undetected hosts')
}
// Exercise the actual installer wiring, not just the select helper.
const tui = { ...clack, multiselect: async () => ['dsh'], select: async () => 'desktop', spinner: () => ({ start() {}, stop() {} }), note() {} }
await runInstallerWithOptions({ clack: tui, skipKeys: true, skipLayer: true, skipXAuth: true, dryRun: true })
assert.equal(commands().length, 0)
const result = await executeAgentOps(['dsh'], { dshSurface: 'all' }, clack)
assert.deepEqual(result.map(({ profile, ok }) => [profile, ok]), [['web', true], ['desktop', true]])
assert.deepEqual(commands().map(({ owner }) => owner), ['cli', 'desktop'])
assert.equal(commands()[1].args.at(-1), PKG_ROOT, 'reuse local source')
assert.ok(dshProfilesWithSearchBoost().includes('desktop'))
assert.deepEqual(json(join(profileDir('desktop'), 'package.json')).dsh.profile.bundles, ['user-plugin', 'search-boost'])
assert.equal(readFileSync(join(profileDir('desktop'), 'cordis.patch.yml'), 'utf8'), '# keep user patch\n')
assert.ok(!messages.join('\n').includes('fixture-secret-do-not-log'))
console.log('ok: TUI selection and Desktop + CLI install use separate owners and preserve user configuration')

resetProfile('desktop', { installed: true, disabled: true })
clearCalls()
const disabledInstall = await executeAgentOps(['dsh'], { dshSurface: 'desktop' }, clack)
assert.equal(disabledInstall[0].ok, true, 'retained disabled dependency is a successful installation')
assert.equal(disabledInstall[0].dsh.enabled, false)
assert.ok(messages.some(message => /installed and verified, but disabled/.test(message)))
assert.deepEqual(json(join(profileDir('desktop'), 'package.json')).dsh.profile.bundles, ['user-plugin'])
const enableInstall = await executeAgentOps(['dsh'], { dshSurface: 'desktop', enableDshBundle: true }, clack)
assert.equal(enableInstall[0].ok, true)
assert.equal(enableInstall[0].dsh.enabled, true)
assert.deepEqual(json(join(profileDir('desktop'), 'package.json')).dsh.profile.bundles, ['user-plugin', 'search-boost'])
resetProfile('desktop', { installed: true, disabled: true })
const plain = spawnSync(process.execPath, [join(PKG_ROOT, 'cli.mjs'), 'install', '-t', 'dsh', '--profile', 'desktop', '--enable-dsh-bundle', '-y'], { env: process.env, encoding: 'utf8', timeout: process.platform === 'win32' ? 120_000 : 20_000 })
assert.equal(plain.status, 0, `${plain.error?.message ?? ''}; signal=${plain.signal}; ${plain.stderr}`)
assert.deepEqual(json(join(profileDir('desktop'), 'package.json')).dsh.profile.bundles, ['user-plugin', 'search-boost'], 'non-interactive CLI forwards the explicit enable flag')
await verifyDshRuntime(profileDir('desktop'), { command: desktop, args: ['plugin', '--profile', 'desktop', 'add', PKG_ROOT] }, {
  root: PKG_ROOT, version: getVersion(), desktop: true,
  run: (command, args, options) => {
    assert.equal(command, desktopRuntime.executable)
    assert.equal(options.env.ELECTRON_RUN_AS_NODE, '1')
    assert.equal(options.env.NODE_OPTIONS, process.env.NODE_OPTIONS, 'Desktop must not inject NODE_OPTIONS')
    return runCommand(command, args, { ...options, env: { ...options.env, NODE_OPTIONS: '' } })
  },
})
console.log('ok: Desktop disabled status, TUI/plain CLI explicit enable, and owning-runtime probe without NODE_OPTIONS')

// A normal directory can share only its manifest with Desktop, by hardlink
// (portable on Windows) or symlink. This must also fail before host/backup writes.
for (const type of ['hardlink', ...(process.platform === 'win32' ? [] : ['symlink'])]) {
  const name = `manifest-${type}`, dir = profileDir(name)
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'package.json'), desktopManifest = join(profileDir('desktop'), 'package.json')
  if (type === 'hardlink') linkSync(desktopManifest, file)
  else symlinkSync(desktopManifest, file)
  clearCalls()
  const bytes = readFileSync(desktopManifest, 'utf8')
  assert.ok(dshProfilesWithSearchBoost().includes(name))
  assert.ok((await discoverIntegrations()).targets.some(target => target.profile === name))
  assert.equal((await executeAgentOps(['dsh'], { profile: name }, clack))[0].ok, false)
  assert.equal((await executeAgentOps(['dsh'], { profile: name, uninstall: true }, clack))[0].ok, false)
  await assert.rejects(() => refreshIntegration({ kind: 'dsh', profile: name, dir }, { packageRoot: PKG_ROOT, run: runCommand }), /aliases Desktop/)
  assert.equal(commands().length, 0)
  assert.equal(readFileSync(desktopManifest, 'utf8'), bytes)
  assert.deepEqual(readdirSync(dir), ['package.json'], 'blocked alias must not write backup/config files')
  rmSync(dir, { recursive: true })
}
console.log('ok: directory/junction, symlinked manifest and hardlinked manifest aliases cannot reach the CLI owner')

clearCalls()
write(join(profileDir('desktop'), 'lock'), 'fixture desktop running')
const before = readFileSync(join(profileDir('desktop'), 'package.json'), 'utf8')
const blocked = await executeAgentOps(['dsh'], { dshSurface: 'all', uninstall: true }, clack)
assert.deepEqual(blocked.map(({ profile, ok }) => [profile, ok]), [['web', true], ['desktop', false]])
assert.equal(commands().length, 1, 'Desktop lock must block its host invocation without blocking CLI removal')
assert.equal(readFileSync(join(profileDir('desktop'), 'package.json'), 'utf8'), before)
rmSync(join(profileDir('desktop'), 'lock'))
clearCalls()
const removed = await executeAgentOps(['dsh'], { dshSurface: 'desktop', uninstall: true }, clack)
assert.equal(removed[0].ok, true)
assert.equal(commands()[0].owner, 'desktop')
assert.deepEqual(json(join(profileDir('desktop'), 'package.json')).dsh.profile.bundles, ['user-plugin'])
assert.equal(json(join(profileDir('desktop'), 'package.json')).dependencies['user-plugin'], '1.0.0')
assert.ok(existsSync(join(profileDir('desktop'), 'cordis.patch.yml')))
resetProfile('desktop', { installed: true })
process.env.DSH_TEST_NOOP = '1'
assert.equal((await executeAgentOps(['dsh'], { dshSurface: 'desktop', uninstall: true }, clack))[0].ok, false, 'zero exit is not proof of removal')
delete process.env.DSH_TEST_NOOP
process.env.DSH_TEST_CORRUPT_REMOVE = '1'
assert.equal((await executeAgentOps(['dsh'], { dshSurface: 'desktop', uninstall: true }, clack))[0].ok, false, 'corrupt manifest is not successful removal')
delete process.env.DSH_TEST_CORRUPT_REMOVE
clearCalls()
const missing = profileDir('never-installed')
assert.equal((await executeAgentOps(['dsh'], { profile: 'never-installed', uninstall: true }, clack))[0].ok, true)
assert.ok(!existsSync(missing), 'uninstall must not initialize a missing CLI profile')
assert.equal(commands().length, 0)
console.log('ok: locked Desktop is untouched, CLI removal continues, Desktop removal is verified without deleting profiles')

// Package source under node_modules must still be linked locally for Desktop.
const replacement = join(base, 'global', 'node_modules', 'search-boost')
const pkg = json(join(PKG_ROOT, 'package.json'))
write(join(replacement, 'package.json'), { ...pkg, version: '9.0.0' })
for (const file of ['cli.mjs', 'adapters/pi/index.js', 'adapters/dsh/index.js', 'adapters/dsh/schema.js', 'adapters/dsh/cordis.patch.yml']) write(join(replacement, file), '// fixture replacement\n')
process.env.DSH_TEST_HOST_METADATA = '1'
for (const disabled of [false, true]) {
  const original = resetProfile('desktop', { legacy: true, disabled })
  clearCalls()
  const target = (await discoverIntegrations()).targets.find(target => target.profile === 'desktop')
  assert.ok(target)
  await refreshIntegration(target, { run: runCommand, packageRoot: replacement })
  assert.deepEqual(commands().map(({ owner, args }) => [owner, args.at(-2), args.at(-1)]), [['desktop', 'add', replacement], ['desktop', 'remove', 'dsh-search-boost']])
  const after = json(join(target.dir, 'package.json'))
  assert.deepEqual(after.dsh.profile, { ...original.dsh.profile, hostAdded: 'keep', bundles: disabled ? ['user-plugin'] : ['user-plugin', 'search-boost'] })
  assert.equal(after.dsh.hostAdded, 'keep', 'preserve metadata the host added during installation')
  assert.equal(after.dependencies['user-plugin'], '1.0.0')
  assert.equal(after.dependencies['search-boost'], `link:${replacement}`)
  assert.equal(json(join(target.dir, 'node_modules', 'search-boost', 'package.json')).version, '9.0.0')
}
delete process.env.DSH_TEST_HOST_METADATA
console.log('ok: Desktop upgrade migrates legacy names through its own launcher and preserves disabled state')

resetProfile('desktop', { installed: true })
const target = { kind: 'dsh', profile: 'desktop', dir: profileDir('desktop') }
for (const mode of ['dry-run', 'missing-command', 'lock', 'failure', 'noop']) {
  resetProfile('desktop', { installed: true })
  clearCalls()
  const files = ['package.json', 'cordis.patch.yml', 'pnpm-lock.yaml']
  const before = files.map(file => readFileSync(join(target.dir, file), 'utf8'))
  if (mode === 'missing-command') process.env[DESKTOP_COMMAND_ENV] = join(home, 'missing-command')
  if (mode === 'lock') write(join(target.dir, 'lock'), 'running')
  if (mode === 'failure') process.env.DSH_TEST_FAIL = '1'
  if (mode === 'noop') process.env.DSH_TEST_NOOP = '1'
  if (mode === 'dry-run') await refreshIntegration(target, { run: runCommand, packageRoot: replacement, dryRun: true })
  else await assert.rejects(() => refreshIntegration(target, { run: runCommand, packageRoot: replacement }))
  assert.deepEqual(files.map(file => readFileSync(join(target.dir, file), 'utf8')), before, mode)
  if (['dry-run', 'missing-command', 'lock'].includes(mode)) assert.equal(commands().length, 0, 'no npm/CLI fallback')
  if (['missing-command', 'lock'].includes(mode)) assert.ok(!readdirSync(target.dir).some(name => name.includes('backup')), 'blocked operations must not write backups')
  process.env[DESKTOP_COMMAND_ENV] = desktop
  delete process.env.DSH_TEST_FAIL; delete process.env.DSH_TEST_NOOP
}
console.log('ok: Desktop update dry-run, missing launcher, lock, host failure and no-op preserve profile files')

// Verify actual subprocess output cannot leak host diagnostic credentials.
resetProfile('desktop', { installed: true })
const moduleUrl = new URL('../lib/agents/host-runtime.mjs', import.meta.url).href
for (const fail of [false, true]) {
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `const host = await import(${JSON.stringify(moduleUrl)}); await host.installDshBundle({profile:'desktop'});`], { env: { ...process.env, ...(fail ? { DSH_TEST_FAIL: '1' } : {}) }, cwd: process.cwd(), encoding: 'utf8', timeout: process.platform === 'win32' ? 120_000 : 20_000 })
  assert.equal(child.status, fail ? 1 : 0, `${child.error?.message ?? ''}; signal=${child.signal}; ${child.stderr}`)
  assert.ok(!(child.stdout + child.stderr).includes('fixture-secret-do-not-log'), 'host output must be suppressed on success and failure')
}
// The canonical Desktop directory may itself be a symlink/junction. Discovery
// and unrestricted uninstall must not silently skip that installed profile.
resetProfile('desktop', { installed: true })
const relocated = join(base, 'relocated desktop profile')
renameSync(profileDir('desktop'), relocated)
symlinkSync(relocated, profileDir('desktop'), process.platform === 'win32' ? 'junction' : 'dir')
assert.ok(dshProfilesWithSearchBoost().includes('desktop'))
assert.ok((await discoverIntegrations()).targets.some(target => target.profile === 'desktop'))
clearCalls()
const linkedRemoval = await executeAgentOps(['dsh'], { uninstall: true }, clack)
assert.ok(linkedRemoval.some(result => result.profile === 'desktop' && result.ok))
assert.equal(commands().at(-1).owner, 'desktop')
assert.ok(existsSync(join(relocated, 'package.json')))
assert.ok(!dshProfilesWithSearchBoost().includes('desktop'))
console.log('ok: linked Desktop profiles remain discoverable and removable via their Desktop owner')
assert.equal(json(join(PKG_ROOT, 'package.json')).version, getVersion(), 'fixtures never modify package source')
console.log('ok: success/failure host output is not echoed into test/TUI logs; all artifacts are sandbox-owned')

// P2-04: Desktop's native unregister can delete both registrations while the
// profile keeps an active node_modules/search-boost link. Cleanup must remove
// that owned link (and nothing else), also on a repeated uninstall.
const desktopLink = () => join(profileDir('desktop'), 'node_modules', 'search-boost')
const desktopLinkPresent = () => { try { lstatSync(desktopLink()); return true } catch { return false } }
resetProfile('desktop', { installed: true })
process.env.DSH_TEST_LEAVE_LINK = '1'
clearCalls()
const linkResidue = await executeAgentOps(['dsh'], { dshSurface: 'desktop', uninstall: true }, clack)
assert.deepEqual(linkResidue.map(({ profile, ok }) => [profile, ok]), [['desktop', true]])
assert.equal(commands().at(-1).owner, 'desktop')
assert.equal(desktopLinkPresent(), false, 'Desktop leftover link must be removed')
assert.ok(existsSync(join(PKG_ROOT, 'package.json')), 'the link target is never deleted')
assert.ok(!dshProfilesWithSearchBoost().includes('desktop'))
delete process.env.DSH_TEST_LEAVE_LINK
// Repeated uninstall: both registrations are already gone, only the link remains.
resetProfile('desktop')
mkdirSync(join(profileDir('desktop'), 'node_modules'), { recursive: true })
symlinkSync(PKG_ROOT, desktopLink(), process.platform === 'win32' ? 'junction' : 'dir')
clearCalls()
assert.equal((await executeAgentOps(['dsh'], { dshSurface: 'desktop', uninstall: true }, clack))[0].ok, true)
assert.equal(commands().length, 0, 'a residue-only profile needs no host invocation')
assert.equal(desktopLinkPresent(), false, 'repeat uninstall must clean the Desktop link')
// A running Desktop still owns its profile: the lock blocks the removal.
resetProfile('desktop')
mkdirSync(join(profileDir('desktop'), 'node_modules'), { recursive: true })
symlinkSync(PKG_ROOT, desktopLink(), process.platform === 'win32' ? 'junction' : 'dir')
write(join(profileDir('desktop'), 'lock'), 'fixture desktop running')
clearCalls()
assert.equal((await executeAgentOps(['dsh'], { dshSurface: 'desktop', uninstall: true }, clack))[0].ok, false, 'a running Desktop must block the residue cleanup')
assert.equal(desktopLinkPresent(), true, 'the blocked link stays for a later uninstall')
rmSync(join(profileDir('desktop'), 'lock'))
assert.equal((await executeAgentOps(['dsh'], { dshSurface: 'desktop', uninstall: true }, clack))[0].ok, true)
assert.equal(desktopLinkPresent(), false)
console.log('ok: Desktop uninstall cleans owned active links, repeats, and honors the application lock')
