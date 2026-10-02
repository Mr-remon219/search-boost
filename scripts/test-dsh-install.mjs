#!/usr/bin/env node
import './isolate-tests.mjs'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync, cpSync, symlinkSync, realpathSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, delimiter } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { dshLaunchCommand } from '../lib/agents/host-runtime.mjs'
import { writeDshHostFixture, writeDesktopProbeFixture } from './dsh-host-fixture.mjs'

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
    assert.deepEqual(actual.slice(0, -1), [...prefix, 'plugin', '--profile', 'profile with spaces', 'add'])
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
} finally {
  rmSync(temp, { recursive: true, force: true })
}
