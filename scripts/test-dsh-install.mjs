#!/usr/bin/env node
import './isolate-install-tests.mjs'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, delimiter } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { dshLaunchCommand } from '../lib/agents/host-runtime.mjs'

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
  for (const mode of ['global', 'npx', 'global-no-pnpm']) {
    const bin = join(temp, mode, 'bin with spaces')
    mkdirSync(bin, { recursive: true })
    const capture = join(temp, mode, 'argv.json')
    const entry = join(bin, 'capture.mjs')
    writeFileSync(entry, `
import { writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
const args = process.argv.slice(2);
writeFileSync(process.env.DSH_TEST_CAPTURE, JSON.stringify(args));
if (process.env.DSH_TEST_EXIT !== '0') process.exit(Number(process.env.DSH_TEST_EXIT));
if (args.includes('add') && !process.env.DSH_TEST_NO_REGISTER) {
  const profile = args[args.indexOf('--profile') + 1];
  const dir = join(process.env.DSH_HOME, 'profiles', profile);
  const installed = join(dir, 'node_modules', 'search-boost');
  mkdirSync(join(installed, 'adapters', 'dsh'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies: { 'search-boost': args.at(-1) }, dsh: { profile: { bundles: ['search-boost'] } } }));
  for (const file of ['package.json', 'adapters/dsh/index.js', 'adapters/dsh/schema.js', 'adapters/dsh/cordis.patch.yml']) copyFileSync(join(process.env.DSH_TEST_ROOT, file), join(installed, file));
}
`)
    const launcher = (name) => {
      const file = join(bin, name + (process.platform === 'win32' ? '.cmd' : ''))
      writeFileSync(file, process.platform === 'win32'
        ? `@"${process.execPath}" "${entry}" %*\r\n`
        : `#!/bin/sh\nexec "${process.execPath}" "${entry}" "$@"\n`)
      chmodSync(file, 0o755)
    }
    launcher('npm')
    if (mode !== 'npx') launcher('dsh')
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
    const result = run(`await host.installDshBundle({ profile: 'profile with spaces' });`)
    assert.equal(result.status, 0, result.stderr)
    const actual = JSON.parse(readFileSync(capture, 'utf8'))
    const prefix = mode === 'global' ? [] : ['exec', '--yes', ...(mode === 'npx' ? ['--package', '@deepseek-ai/dsh'] : []), '--package', 'pnpm', '--', 'dsh']
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
    const manifest = join(env.DSH_HOME, 'profiles', 'profile with spaces', 'node_modules', 'search-boost', 'package.json')
    const pkg = JSON.parse(readFileSync(manifest, 'utf8'))
    writeFileSync(manifest, JSON.stringify({ ...pkg, version: '0.0.0' }))
    const wrongVersion = run(`await host.verifyDshBundle(${JSON.stringify(join(env.DSH_HOME, 'profiles', 'profile with spaces'))});`)
    assert.notEqual(wrongVersion.status, 0)
    assert.match(wrongVersion.stderr, /version mismatch/)
    rmSync(capture)
    assert.equal(run(`await host.installDshBundle({ dryRun: true });`).status, 0)
    assert.throws(() => readFileSync(capture), /ENOENT/)
    console.log(`ok: ${mode} launcher preserves spaced paths/arguments, remove, failure, and dry-run (${process.platform})`)
  }
} finally {
  rmSync(temp, { recursive: true, force: true })
}
