#!/usr/bin/env node
import './isolate-tests.mjs'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync, cpSync, symlinkSync, realpathSync, existsSync, lstatSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, delimiter, win32, posix } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { PKG_ROOT } from '../lib/pkg.mjs'
import { PATHS } from '../lib/paths.mjs'
import { dshLaunchCommand, dshOperationProfiles, uninstallDshBundle, prunedPnpmSearchBoostTarget } from '../lib/agents/host-runtime.mjs'
import { writeDshHostFixture, writeDesktopProbeFixture } from './dsh-host-fixture.mjs'

// Exercise the production ownership predicate with real Windows path semantics
// even on Linux; the filesystem/junction cases below remain platform-native.
for (const [pathApi, profile] of [[win32, 'C:/Users/tester/.dsh/profiles/web'], [posix, '/home/tester/.dsh/profiles/web']]) {
  const canonical = pathApi.join(profile, 'node_modules', '.pnpm', 'search-boost@0.2.4-beta.5', 'node_modules', 'search-boost')
  assert.equal(prunedPnpmSearchBoostTarget(profile, canonical, pathApi), true, 'canonical pnpm dangling link is owned on both path platforms')
  assert.equal(prunedPnpmSearchBoostTarget(profile, pathApi.join(profile, 'user-content', 'search-boost'), pathApi), false)
  assert.equal(prunedPnpmSearchBoostTarget(profile, pathApi.join(profile, 'node_modules', '.pnpm', 'foreign@1.0.0', 'node_modules', 'search-boost'), pathApi), false)
  assert.equal(prunedPnpmSearchBoostTarget(profile, pathApi.join(profile, '..', 'other', 'node_modules', '.pnpm', 'search-boost@0.2.4-beta.5', 'node_modules', 'search-boost'), pathApi), false)
}
assert.equal(prunedPnpmSearchBoostTarget('C:/profile', 'D:/node_modules/.pnpm/search-boost@1.0.0/node_modules/search-boost', win32), false, 'a different drive cannot belong to this profile')
console.log('ok: pnpm ownership checks cover win32/posix separators, foreign packages, outside profiles and cross-drive targets')

const args = ['plugin', '--profile', 'profile with spaces', 'add', 'search-boost']
assert.deepEqual(dshLaunchCommand(args, { dshAvailable: true, pnpmAvailable: true, npmAvailable: false }), { command: 'dsh', args })
assert.deepEqual(dshLaunchCommand(args, { dshAvailable: false, pnpmAvailable: false, npmAvailable: true }), {
  command: 'npm', args: ['exec', '--yes', '--package', '@deepseek-ai/dsh', '--package', 'pnpm', '--', 'dsh', ...args],
})
assert.deepEqual(dshLaunchCommand(args, { dshAvailable: true, pnpmAvailable: false, npmAvailable: true }).args,
  ['exec', '--yes', '--package', 'pnpm', '--', 'dsh', ...args])
assert.deepEqual(dshLaunchCommand(args, { dshAvailable: false, pnpmAvailable: true, npmAvailable: true }).args,
  ['exec', '--yes', '--package', '@deepseek-ai/dsh', '--', 'dsh', ...args])
assert.throws(() => dshLaunchCommand(args, { dshAvailable: false, pnpmAvailable: false, npmAvailable: false }), /no DSH installation changed/)
console.log('ok: global DSH and npm-exec/npx launch selection, with and without global pnpm')

const temp = mkdtempSync(join(tmpdir(), 'sb dsh install '))
const moduleUrl = new URL('../lib/agents/host-runtime.mjs', import.meta.url).href
try {
  for (const mode of ['global', 'npx', 'global-no-pnpm', 'desktop-path']) {
    const bin = mode === 'desktop-path' ? join(temp, mode, 'resources', 'runtime', 'cli', 'bin') : join(temp, mode, 'bin with spaces')
    mkdirSync(bin, { recursive: true })
    const capture = join(temp, mode, 'argv.json')
    const entry = join(bin, 'capture.mjs')
    writeDshHostFixture(entry, { desktopHost: mode === 'desktop-path' })
    writeFileSync(entry, `
import { writeFileSync, mkdirSync, cpSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
const args = process.argv.slice(2);
if (process.env.DSH_TEST_ASSERT_ENV) {
  for (const key of ['TAVILY_API_KEY', 'AWS_SECRET_ACCESS_KEY', 'DSH_INTERNAL_IDENTITY', 'NODE_OPTIONS']) {
    if (process.env[key] !== undefined) throw Error('service child received forbidden environment name: ' + key);
  }
  if (Object.keys(process.env).some(key => key.startsWith('SEARCH_BOOST_DSH_PROBE_'))) throw Error('service child received probe markers');
  if (process.env.DSH_TEST_EXPECT_DESKTOP && process.env.ELECTRON_RUN_AS_NODE !== '1') throw Error('Desktop runtime requirements were lost');
}
writeFileSync(process.env.DSH_TEST_CAPTURE, JSON.stringify(args));
if (process.env.DSH_TEST_EXIT !== '0') process.exit(Number(process.env.DSH_TEST_EXIT));
if (args.includes('add') && !process.env.DSH_TEST_NO_REGISTER) {
  const profile = args[args.indexOf('--profile') + 1];
  const dir = join(process.env.DSH_HOME, 'profiles', profile);
  const installed = join(dir, 'node_modules', 'search-boost');
  mkdirSync(join(installed, 'adapters', 'dsh'), { recursive: true });
  let pkg; try { pkg = JSON.parse(readFileSync(join(dir, 'package.json'))); } catch { pkg = { dependencies: {}, dsh: { profile: { bundles: [] } } }; }
  const existed = !!pkg.dependencies['search-boost'];
  pkg.dependencies['search-boost'] = args.at(-1);
  if (!existed) pkg.dsh.profile.bundles.push('search-boost');
  writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg));
  const sourcePkg = JSON.parse(readFileSync(join(process.env.DSH_TEST_ROOT, 'package.json')));
  for (const file of ['package.json', ...sourcePkg.files]) cpSync(join(process.env.DSH_TEST_ROOT, file), join(installed, file), { recursive: true });
  if (process.env.DSH_TEST_BAD_PATCH) writeFileSync(join(installed, 'adapters/dsh/cordis.patch.yml'), '[');
}
if (args.includes('remove')) {
  const file = join(process.env.DSH_HOME, 'profiles', args[args.indexOf('--profile') + 1], 'package.json');
  const pkg = JSON.parse(readFileSync(file));
  delete pkg.dependencies['search-boost'];
  pkg.dsh.profile.bundles = pkg.dsh.profile.bundles.filter(name => name !== 'search-boost');
  writeFileSync(file, JSON.stringify(pkg));
}
`)
    const launcher = (name) => {
      const file = join(bin, name + (process.platform === 'win32' ? '.cmd' : ''))
      writeFileSync(file, process.platform === 'win32'
        ? `@"${process.execPath}" "${entry}" %*\r\n`
        : `#!/bin/sh\nexec "${process.execPath}" "${entry}" "$@"\n`)
      chmodSync(file, 0o755)
    }
    if (mode !== 'desktop-path') launcher('npm')
    if (mode !== 'npx') launcher('dsh')
    if (mode === 'desktop-path') writeDesktopProbeFixture(join(bin, process.platform === 'win32' ? 'dsh.cmd' : 'dsh'), entry)
    if (mode === 'global') launcher('pnpm')
    // Keep command discovery hermetic instead of inheriting globally installed
    // dsh/pnpm. Windows needs where.exe/cmd.exe, POSIX only a shell builtin.
    if (process.platform !== 'win32') {
      writeFileSync(join(bin, 'which'), '#!/bin/sh\ncommand -v "$1"\n')
      chmodSync(join(bin, 'which'), 0o755)
    }
    const env = { ...process.env, PATH: [bin, ...(process.platform === 'win32' ? [join(process.env.SystemRoot, 'System32')] : [])].join(delimiter),
      npm_execpath: entry, DSH_TEST_CAPTURE: capture, DSH_HOME: join(temp, mode, 'home'), DSH_TEST_EXIT: '0', DSH_TEST_ROOT: fileURLToPath(new URL('..', import.meta.url)) }
    if (process.platform === 'win32') for (const key of Object.keys(env)) if (key.toLowerCase() === 'path' && key !== 'PATH') delete env[key]
    const run = (body, extra = {}) => spawnSync(process.execPath, ['--input-type=module', '-e', `const host = await import(${JSON.stringify(moduleUrl)}); ${body}`], { env: { ...env, ...extra }, encoding: 'utf8', timeout: 20000 })
    const result = run(`await host.installDshBundle({ profile: 'profile with spaces' });`, {
      TAVILY_API_KEY: 'fixture-provider-key', AWS_SECRET_ACCESS_KEY: 'fixture-cloud-key',
      DSH_INTERNAL_IDENTITY: 'fixture-parent-identity', NODE_OPTIONS: '--no-warnings',
      SEARCH_BOOST_DSH_PROBE_EXTRA: 'fixture-marker', DSH_TEST_ASSERT_ENV: '1',
      ...(mode === 'desktop-path' ? { DSH_TEST_EXPECT_DESKTOP: '1' } : {}),
    })
    assert.equal(result.status, 0, result.stderr)
    const actual = JSON.parse(readFileSync(capture, 'utf8'))
    const prefix = ['global', 'desktop-path'].includes(mode) ? [] : ['exec', '--yes', ...(mode === 'npx' ? ['--package', '@deepseek-ai/dsh'] : []), '--package', 'pnpm', '--', 'dsh']
    assert.deepEqual(actual.slice(0, -1), [...prefix, 'plugin', '--profile', 'profile with spaces', 'add', '--save-prod', '--save-dev=false', '--save-peer=false', '--save-optional=false'])
    assert.equal(actual.at(-1), fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]$/, ''))
    const removal = run(`await host.uninstallDshBundle({ profile: 'profile with spaces' });`)
    assert.equal(removal.status, 0, removal.stderr)
    assert.deepEqual(JSON.parse(readFileSync(capture, 'utf8')), [...prefix, 'plugin', '--profile', 'profile with spaces', 'remove', 'search-boost'])
    const failure = run(`await host.installDshBundle({});`, { DSH_TEST_EXIT: '7' })
    assert.notEqual(failure.status, 0)
    assert.match(failure.stderr, /exit 7/)
    const inert = run(`await host.installDshBundle({ profile: 'unregistered' });`, { DSH_TEST_NO_REGISTER: '1' })
    assert.notEqual(inert.status, 0)
    assert.match(inert.stderr, /installation was not verified/)
    // Removal now really updates the profile; restore an enabled fixture before
    // testing payload-version verification independently.
    assert.equal(run(`await host.installDshBundle({ profile: 'profile with spaces' });`).status, 0)
    const manifest = join(env.DSH_HOME, 'profiles', 'profile with spaces', 'node_modules', 'search-boost', 'package.json')
    const pkg = JSON.parse(readFileSync(manifest, 'utf8'))
    writeFileSync(manifest, JSON.stringify({ ...pkg, version: '0.0.0' }))
    const wrongVersion = run(`await host.verifyDshBundle(${JSON.stringify(join(env.DSH_HOME, 'profiles', 'profile with spaces'))});`)
    assert.notEqual(wrongVersion.status, 0)
    assert.match(wrongVersion.stderr, /version mismatch/)
    const dir = join(env.DSH_HOME, 'profiles', 'profile with spaces')
    const profileFile = join(dir, 'package.json')
    const disabled = JSON.parse(readFileSync(profileFile, 'utf8'))
    disabled.dependencies['user-plugin'] = '1.0.0'
    disabled.dsh.profile = { bundles: ['user-plugin'], custom: 'retain' }
    writeFileSync(profileFile, JSON.stringify(disabled))
    const statusBody = (enable = false) => `let status; await host.installDshBundle({ profile: 'profile with spaces', enableDshBundle: ${enable}, onDshStatus: value => { status = value } }); console.log(JSON.stringify(status));`
    const retained = run(statusBody())
    assert.equal(retained.status, 0, retained.stderr)
    const status = JSON.parse(retained.stdout)
    assert.equal(status.enabled, false)
    assert.equal(status.root, realpathSync(join(dir, 'node_modules/search-boost')))
    assert.equal(status.version, pkg.version)
    assert.equal(status.hostVersion, '0.2.0-rc.2')
    assert.deepEqual(JSON.parse(readFileSync(profileFile)).dsh.profile, disabled.dsh.profile)
    const warning = run(`await host.installDshBundle({ profile: 'profile with spaces' });`)
    assert.equal(warning.status, 0, warning.stderr)
    assert.match(warning.stderr, /installed and verified, but disabled/)
    const badPatch = run(statusBody(true), { DSH_TEST_BAD_PATCH: '1' })
    assert.notEqual(badPatch.status, 0, 'explicit activation must validate the actual patch first')
    assert.deepEqual(JSON.parse(readFileSync(profileFile)).dsh.profile, disabled.dsh.profile)
    writeFileSync(profileFile + '.lock', 'fixture manifest locked')
    const lockedEnable = run(statusBody(true))
    assert.notEqual(lockedEnable.status, 0)
    assert.deepEqual(JSON.parse(readFileSync(profileFile)).dsh.profile, disabled.dsh.profile)
    rmSync(profileFile + '.lock')
    const enabled = run(statusBody(true))
    assert.equal(enabled.status, 0, enabled.stderr)
    assert.equal(JSON.parse(enabled.stdout).enabled, true)
    assert.deepEqual(JSON.parse(readFileSync(profileFile)).dsh.profile, { bundles: ['user-plugin', 'search-boost'], custom: 'retain' })
    assert.equal(run(statusBody(true)).status, 0, 'explicit enable is idempotent')

    // A profile copy can be correct while the official installation-first
    // resolver selects another payload. Reject even same-version shadow copies.
    const shadow = join(bin, 'node_modules', 'search-boost')
    cpSync(join(dir, 'node_modules/search-boost'), shadow, { recursive: true })
    const shadowManifest = join(shadow, 'package.json')
    const shadowPkg = JSON.parse(readFileSync(shadowManifest))
    for (const version of ['0.0.0', shadowPkg.version]) {
      writeFileSync(shadowManifest, JSON.stringify({ ...shadowPkg, version }))
      const shadowed = run(statusBody())
      assert.notEqual(shadowed.status, 0)
      assert.match(shadowed.stderr, /runtime bundle source\/version mismatch/)
      assert.equal(JSON.parse(readFileSync(manifest)).version, pkg.version, 'profile is new, but cannot be reported as the loaded source')
      assert.equal(JSON.parse(readFileSync(shadowManifest)).version, version, 'never overwrite host-owned shadow package')
    }
    rmSync(shadow, { recursive: true })
    symlinkSync(join(dir, 'node_modules/search-boost'), shadow, process.platform === 'win32' ? 'junction' : 'dir')
    assert.equal(run(statusBody()).status, 0, 'different aliases of the SAME payload are valid')
    rmSync(shadow, { recursive: true })

    const carrierFile = join(bin, 'package.json')
    const carrier = readFileSync(carrierFile, 'utf8')
    writeFileSync(carrierFile, JSON.stringify({ name: 'foreign-wrapper', type: 'module' }))
    const unsupported = run(statusBody())
    assert.notEqual(unsupported.status, 0, 'zero exit without an owning-runtime probe is not verification')
    assert.match(unsupported.stderr, /verification unavailable/)
    writeFileSync(carrierFile, carrier)
    const bootFile = join(bin, 'node_modules/@deepseek-ai/dsh-app-boot/index.mjs')
    const boot = readFileSync(bootFile, 'utf8')
    writeFileSync(bootFile, `throw Error('fixture-secret-do-not-log')`)
    const badResolver = run(statusBody())
    assert.notEqual(badResolver.status, 0)
    assert.ok(!(badResolver.stdout + badResolver.stderr).includes('fixture-secret-do-not-log'))
    writeFileSync(bootFile, boot)
    const operationsFile = join(bin, 'node_modules/@deepseek-ai/dsh-plugin-manager/index.mjs')
    const operations = readFileSync(operationsFile, 'utf8')
    rmSync(operationsFile)
    const beforeProfile = readFileSync(profileFile), beforeCapture = readFileSync(capture)
    const oldHost = run(statusBody())
    assert.notEqual(oldHost.status, 0)
    assert.match(oldHost.stderr, /requires the owning host.*dsh-plugin-manager\/operations/)
    assert.match(oldHost.stderr, /no package operation was started/)
    assert.ok(beforeProfile.equals(readFileSync(profileFile)))
    assert.ok(beforeCapture.equals(readFileSync(capture)))
    assert.equal(existsSync(join(dir, '.search-boost-install-pending.json')), false)
    writeFileSync(operationsFile, operations)
    console.log(`ok: ${mode} service environment scrub and explicit unsupported-host diagnostic before mutation`)
    console.log(`ok: ${mode} actual host source, old/same-version shadow, disabled/explicit enable, locks, unavailable resolver and safe diagnostics`)
    rmSync(capture)
    assert.equal(run(`await host.installDshBundle({ dryRun: true, enableDshBundle: true });`).status, 0)
    assert.throws(() => readFileSync(capture), /ENOENT/)
    console.log(`ok: ${mode} launcher preserves spaced paths/arguments, remove, failure, and dry-run (${process.platform})`)
  }

  // P2-04: a native DSH unregister removes the dependency and bundle but can
  // leave the profile's node_modules/search-boost link behind. Only a link this
  // package owns may be removed, and a repeated uninstall must still clean it.
  {
    const bin = join(temp, 'residue', 'bin')
    mkdirSync(bin, { recursive: true })
    const entry = join(bin, 'host.mjs')
    writeFileSync(entry, `
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const args = process.argv.slice(2);
const profile = args[args.indexOf('--profile') + 1];
const file = join(process.env.DSH_HOME, 'profiles', profile, 'package.json');
if (args.includes('remove')) {
  const pkg = JSON.parse(readFileSync(file, 'utf8'));
  delete pkg.dependencies?.['search-boost'];
  pkg.dsh.profile.bundles = (pkg.dsh.profile.bundles ?? []).filter(name => name !== 'search-boost');
  writeFileSync(file, JSON.stringify(pkg));
}
`)
    for (const command of ['dsh', 'pnpm']) {
      const file = join(bin, command + (process.platform === 'win32' ? '.cmd' : ''))
      writeFileSync(file, process.platform === 'win32'
        ? `@"${process.execPath}" "${entry}" %*\r\n`
        : `#!/bin/sh\nexec "${process.execPath}" "${entry}" "$@"\n`)
      chmodSync(file, 0o755)
    }
    if (process.platform !== 'win32') {
      writeFileSync(join(bin, 'which'), '#!/bin/sh\ncommand -v "$1"\n')
      chmodSync(join(bin, 'which'), 0o755)
    }
    const savedPath = process.env.PATH
    const savedDshHome = process.env.DSH_HOME
    process.env.PATH = [bin, savedPath].join(delimiter)
    // The fixture host and the spawned CLI resolve $DSH_HOME, while PATHS bound it
    // from HOME at import; both must name the same profiles directory.
    process.env.DSH_HOME = PATHS.dsh.home
    const profileDir = (name) => join(PATHS.dsh.profiles, name)
    const linkOf = (name) => join(profileDir(name), 'node_modules', 'search-boost')
    const linkPresent = (name) => { try { lstatSync(linkOf(name)); return true } catch { return false } }
    const writeManifest = (name, registered) => {
      mkdirSync(profileDir(name), { recursive: true })
      writeFileSync(join(profileDir(name), 'package.json'), JSON.stringify({
        name: `dsh-profile-${name}`, private: true,
        dependencies: { 'user-plugin': '1.0.0', ...(registered ? { 'search-boost': `link:${PKG_ROOT}` } : {}) },
        dsh: { profile: { custom: 'retain', bundles: ['user-plugin', ...(registered ? ['search-boost'] : [])] } },
      }))
    }
    const linkTo = (name, target) => {
      mkdirSync(join(profileDir(name), 'node_modules'), { recursive: true })
      symlinkSync(target, linkOf(name), process.platform === 'win32' ? 'junction' : 'dir')
    }
    try {
      // The native runner deletes both registrations and leaves an active link.
      writeManifest('residue-native', true)
      linkTo('residue-native', PKG_ROOT)
      await uninstallDshBundle({ profile: 'residue-native' })
      assert.equal(linkPresent('residue-native'), false, 'leftover dependency link must be removed')
      assert.ok(existsSync(join(PKG_ROOT, 'package.json')), 'the link target is never deleted')
      assert.ok(!readFileSync(join(profileDir('residue-native'), 'package.json'), 'utf8').includes('search-boost'))

      // Repeated uninstall with both the dependency and the bundle already absent.
      writeManifest('residue-repeat', false)
      linkTo('residue-repeat', PKG_ROOT)
      for (const official of ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']) {
        mkdirSync(join(profileDir('residue-repeat'), 'node_modules', ...official.split('/')), { recursive: true })
        writeFileSync(join(profileDir('residue-repeat'), 'node_modules', ...official.split('/'), 'package.json'), JSON.stringify({ name: official }))
      }
      await uninstallDshBundle({ profile: 'residue-repeat' })
      assert.equal(linkPresent('residue-repeat'), false, 'repeat uninstall must clean the active link')
      for (const official of ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']) {
        assert.ok(existsSync(join(profileDir('residue-repeat'), 'node_modules', ...official.split('/'), 'package.json')), `${official} must be preserved`)
      }
      await uninstallDshBundle({ profile: 'residue-repeat' })
      assert.equal(linkPresent('residue-repeat'), false)

      // Owned dangling link: a pruned search-boost entry inside the same profile.
      writeManifest('residue-dangling', false)
      linkTo('residue-dangling', join(profileDir('residue-dangling'), 'node_modules', '.pnpm', 'search-boost@0.0.0', 'node_modules', 'search-boost'))
      await uninstallDshBundle({ profile: 'residue-dangling' })
      assert.equal(linkPresent('residue-dangling'), false, 'owned dangling link must be removed')

      // A foreign target is reported, never deleted.
      const foreign = join(temp, 'residue', 'foreign-package')
      mkdirSync(foreign, { recursive: true })
      writeFileSync(join(foreign, 'package.json'), JSON.stringify({ name: 'not-search-boost', version: '1.0.0' }))
      writeManifest('residue-foreign', false)
      linkTo('residue-foreign', foreign)
      const warnings = []
      const warn = console.warn
      console.warn = (message) => warnings.push(String(message))
      try { await uninstallDshBundle({ profile: 'residue-foreign' }) } finally { console.warn = warn }
      assert.equal(linkPresent('residue-foreign'), true, 'a foreign link must stay in place')
      assert.ok(existsSync(join(foreign, 'package.json')), 'a foreign link target must stay intact')
      assert.ok(warnings.some((message) => message.includes('left in place')), `foreign link must be reported: ${warnings.join(' | ')}`)

      // A registration name alone must not authorize deleting an unrelated
      // dangling target after native unregister removes the manifest entries.
      writeManifest('residue-foreign-dangling', true)
      linkTo('residue-foreign-dangling', join(temp, 'missing-foreign-target'))
      await uninstallDshBundle({ profile: 'residue-foreign-dangling' })
      assert.equal(linkPresent('residue-foreign-dangling'), true, 'registration does not prove a foreign dangling link belongs to us')
      // A user path inside the profile with the right basename is not a pnpm
      // managed SearchBoost package; do not infer ownership from the name.
      writeManifest('residue-named-dangling', false)
      linkTo('residue-named-dangling', join(profileDir('residue-named-dangling'), 'user-content', 'search-boost'))
      await uninstallDshBundle({ profile: 'residue-named-dangling' })
      assert.equal(linkPresent('residue-named-dangling'), true, 'a matching basename does not prove ownership')
      // A same-name/version package without the bundle identity is ambiguous.
      const ambiguous = join(temp, 'residue', 'ambiguous-package')
      mkdirSync(ambiguous, { recursive: true })
      writeFileSync(join(ambiguous, 'package.json'), JSON.stringify({ name: 'search-boost', version: JSON.parse(readFileSync(join(PKG_ROOT, 'package.json'), 'utf8')).version }))
      writeManifest('residue-ambiguous', false)
      linkTo('residue-ambiguous', ambiguous)
      await uninstallDshBundle({ profile: 'residue-ambiguous' })
      assert.equal(linkPresent('residue-ambiguous'), true, 'version equality is not an ownership receipt')

      // An ordinary user directory at the package path is not ours to delete.
      writeManifest('residue-user-dir', false)
      const userDir = linkOf('residue-user-dir')
      mkdirSync(userDir, { recursive: true })
      writeFileSync(join(userDir, 'notes.txt'), 'user content')
      await uninstallDshBundle({ profile: 'residue-user-dir' })
      assert.equal(readFileSync(join(userDir, 'notes.txt'), 'utf8'), 'user content')
      assert.ok(lstatSync(userDir).isDirectory() && !lstatSync(userDir).isSymbolicLink())

      // Dry-run reports the plan and touches nothing.
      writeManifest('residue-dry-run', false)
      linkTo('residue-dry-run', PKG_ROOT)
      const stdout = []
      const log = console.log
      console.log = (message) => stdout.push(String(message))
      try { await uninstallDshBundle({ profile: 'residue-dry-run', dryRun: true }) } finally { console.log = log }
      assert.equal(linkPresent('residue-dry-run'), true, 'dry-run must not remove the link')
      assert.ok(stdout.some((line) => line.includes('(dry-run)') && line.includes('search-boost')), `dry-run must report the cleanup: ${stdout.join(' | ')}`)

      // An unrestricted sweep reaches residue-only profiles, and the real CLI
      // uninstall path (the reported repro) removes the link end to end.
      assert.ok(dshOperationProfiles({ uninstall: true }).includes('residue-dry-run'))
      assert.ok(dshOperationProfiles({ uninstall: true }).includes('residue-foreign'))
      const cli = fileURLToPath(new URL('../cli.mjs', import.meta.url))
      const endToEnd = spawnSync(process.execPath, [cli, 'uninstall', '-t', 'dsh', '-y'], {
        env: { ...process.env, DSH_HOME: PATHS.dsh.home }, encoding: 'utf8', timeout: 60000,
      })
      assert.equal(endToEnd.status, 0, endToEnd.stderr)
      assert.equal(linkPresent('residue-dry-run'), false, 'the CLI uninstall must clean the leftover link')
      assert.ok(existsSync(join(PKG_ROOT, 'package.json')))
      assert.equal(linkPresent('residue-foreign'), true, 'the CLI sweep must keep the foreign link')
      assert.equal(readFileSync(join(linkOf('residue-user-dir'), 'notes.txt'), 'utf8'), 'user content')
      console.log(`ok: DSH uninstall cleans owned active/dangling links, keeps foreign entries, and repeats safely (${process.platform})`)
    } finally {
      process.env.PATH = savedPath
      if (savedDshHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = savedDshHome
      rmSync(join(temp, 'residue', 'foreign-package'), { recursive: true, force: true })
    }
  }
} finally {
  rmSync(temp, { recursive: true, force: true })
}
