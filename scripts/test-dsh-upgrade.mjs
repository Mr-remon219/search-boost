#!/usr/bin/env node
import './isolate-tests.mjs'
// Real subprocess launch/verification without network, global hosts or user state.
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync, realpathSync, cpSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, delimiter } from 'node:path'
import { spawnSync } from 'node:child_process'
import { writeDshHostFixture, writeDesktopProbeFixture } from './dsh-host-fixture.mjs'

const temp = realpathSync(mkdtempSync(join(tmpdir(), 'sb dsh upgrade ')))
const integrations = new URL('../lib/upgrade/integrations.mjs', import.meta.url).href
const processModule = new URL('../lib/upgrade/process.mjs', import.meta.url).href
const write = (file, value) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value)) }
const json = (file) => JSON.parse(readFileSync(file, 'utf8'))
try {
  for (const mode of ['global', 'npm-only', 'dsh-only', 'pnpm-only', 'desktop-path']) {
    for (const source of ['checkout', 'published', 'npm-cache']) {
      const base = join(temp, mode, source), bin = mode === 'desktop-path' ? join(base, 'resources/runtime/cli/bin') : join(base, 'bin with spaces')
      const root = source === 'published' ? join(base, 'global', 'node_modules', 'search-boost')
        : source === 'npm-cache' ? join(base, '_npx', 'cache', 'node_modules', 'search-boost') : join(base, 'checkout')
      write(join(root, 'package.json'), { name: 'search-boost', version: '2.0.0', dsh: { bundle: { patch: './adapters/dsh/cordis.patch.yml' } } })
      for (const file of ['cli.mjs', 'adapters/pi/index.js', 'adapters/dsh/index.js', 'adapters/dsh/schema.js', 'adapters/dsh/cordis.patch.yml']) write(join(root, file), '// fixture 2.0.0')
      const capture = join(base, 'commands.jsonl'), entry = join(bin, 'host.mjs')
      writeDshHostFixture(entry, { desktopHost: mode === 'desktop-path' })
      write(entry, `
import { appendFileSync, readFileSync, writeFileSync, mkdirSync, rmSync, cpSync, symlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
const raw = process.argv.slice(2);
appendFileSync(process.env.DSH_TEST_CAPTURE, JSON.stringify(raw) + '\\n');
const args = raw[0] === 'exec' ? raw.slice(raw.indexOf('--') + 2) : raw;
const [, , profile, verb, source] = args;
const dir = join(process.env.DSH_HOME, 'profiles', profile), file = join(dir, 'package.json');
const pkg = JSON.parse(readFileSync(file));
if (process.env.DSH_TEST_NOOP) process.exit(0);
if (verb === 'add') {
  const published = source === 'search-boost@2.0.0';
  pkg.dependencies['search-boost'] = process.env.DSH_TEST_STALE_SOURCE ? '1.0.0' : published ? '^2.0.0' : 'link:' + source;
  pkg.dsh.profile.bundles.push('search-boost');
  const installed = join(dir, 'node_modules', 'search-boost');
  mkdirSync(dirname(installed), { recursive: true });
  rmSync(installed, { recursive: true, force: true });
  if (published) cpSync(process.env.DSH_TEST_ROOT, installed, { recursive: true });
  else symlinkSync(source, installed, process.platform === 'win32' ? 'junction' : 'dir');
  if (process.env.DSH_TEST_WRONG_VERSION) {
    const manifest = JSON.parse(readFileSync(join(installed, 'package.json')));
    manifest.version = '1.0.0';
    writeFileSync(join(installed, 'package.json'), JSON.stringify(manifest));
  }
  if (process.env.DSH_TEST_MISSING_FILE) rmSync(join(installed, process.env.DSH_TEST_MISSING_FILE));
  writeFileSync(join(dir, 'pnpm-lock.yaml'), 'modified lock');
  writeFileSync(join(dir, 'pnpm-workspace.yaml'), 'modified workspace');
} else if (verb === 'remove') {
  delete pkg.dependencies[source];
  pkg.dsh.profile.bundles = pkg.dsh.profile.bundles.filter(name => name !== source);
} else throw new Error('Unexpected verb');
writeFileSync(file, JSON.stringify(pkg));
if (process.env.DSH_TEST_FAIL) process.exit(7);
`)
      function launcher(name) {
        const file = join(bin, name + (process.platform === 'win32' ? '.cmd' : ''))
        write(file, process.platform === 'win32' ? `@"${process.execPath}" "${entry}" %*\r\n` : `#!/bin/sh\nexec "${process.execPath}" "${entry}" "$@"\n`)
        chmodSync(file, 0o755)
      }
      if (mode !== 'desktop-path') launcher('npm')
      if (['global', 'dsh-only', 'desktop-path'].includes(mode)) launcher('dsh')
      if (mode === 'desktop-path') writeDesktopProbeFixture(join(bin, process.platform === 'win32' ? 'dsh.cmd' : 'dsh'), entry)
      if (['global', 'pnpm-only'].includes(mode)) launcher('pnpm')
      if (process.platform !== 'win32') { write(join(bin, 'which'), '#!/bin/sh\ncommand -v "$1"\n'); chmodSync(join(bin, 'which'), 0o755) }
      const env = { ...process.env, HOME: join(base, 'home'), USERPROFILE: join(base, 'home'), DSH_HOME: join(base, 'home', '.dsh'), SEARCH_BOOST_HOME: join(base, 'state'),
        PATH: [bin, ...(process.platform === 'win32' ? [join(process.env.SystemRoot, 'System32')] : [])].join(delimiter),
        npm_execpath: entry, DSH_TEST_ROOT: root, DSH_TEST_CAPTURE: capture }
      if (process.platform === 'win32') for (const key of Object.keys(env)) if (key.toLowerCase() === 'path' && key !== 'PATH') delete env[key]
      const profile = 'profile with spaces', dir = join(env.DSH_HOME, 'profiles', profile), manifest = join(dir, 'package.json')
      const original = { dependencies: { 'dsh-search-boost': '0.1.3', 'user-plugin': '1.0.0' }, dsh: { profile: { bundles: ['user-plugin', 'dsh-search-boost'], custom: 'keep' } } }
      const files = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'cordis.yml']
      const reset = (disabled = false) => {
        rmSync(capture, { force: true })
        rmSync(join(dir, 'node_modules'), { recursive: true, force: true })
        write(manifest, disabled ? { ...original, dsh: { profile: { ...original.dsh.profile, bundles: ['user-plugin'] } } } : original)
        for (const file of files.slice(1)) write(join(dir, file), `original ${file}`)
      }
      const run = (extra = {}, dryRun = false, name = profile) => spawnSync(process.execPath, ['--input-type=module', '-e', `
        const { refreshIntegration } = await import(${JSON.stringify(integrations)});
        const { runCommand } = await import(${JSON.stringify(processModule)});
        await refreshIntegration({ kind: 'dsh', profile: ${JSON.stringify(name)}, dir: ${JSON.stringify(dir)} }, { packageRoot: ${JSON.stringify(root)}, run: runCommand, dryRun: ${dryRun} });
      `], { env: { ...env, ...extra }, encoding: 'utf8', timeout: 20_000 })
      const prefix = ['global', 'desktop-path'].includes(mode) ? [] : ['exec', '--yes', ...(['npm-only', 'pnpm-only'].includes(mode) ? ['--package', '@deepseek-ai/dsh'] : []), ...(['npm-only', 'dsh-only'].includes(mode) ? ['--package', 'pnpm'] : []), '--', 'dsh']
      for (const disabled of [false, true]) {
        reset(disabled)
        const result = run()
        assert.equal(result.status, 0, result.stderr)
        const commands = readFileSync(capture, 'utf8').trim().split('\n').map(JSON.parse)
        assert.deepEqual(commands, [
          [...prefix, 'plugin', '--profile', profile, 'add', source === 'npm-cache' ? 'search-boost@2.0.0' : root],
          [...prefix, 'plugin', '--profile', profile, 'remove', 'dsh-search-boost'],
        ])
        const pkg = json(manifest)
        assert.equal(pkg.dependencies['search-boost'], source === 'npm-cache' ? '^2.0.0' : `link:${root}`)
        assert.equal(pkg.dependencies['user-plugin'], '1.0.0')
        assert.equal(pkg.dependencies['dsh-search-boost'], undefined)
        assert.deepEqual(pkg.dsh.profile, { custom: 'keep', bundles: disabled ? ['user-plugin'] : ['user-plugin', 'search-boost'] })
        assert.equal(json(join(dir, 'node_modules/search-boost/package.json')).version, '2.0.0')
        if (source === 'npm-cache') assert.notEqual(realpathSync(join(dir, 'node_modules/search-boost')), root)
        else assert.equal(realpathSync(join(dir, 'node_modules/search-boost')), root)
        assert.equal(readFileSync(join(dir, 'cordis.yml'), 'utf8'), 'original cordis.yml')
        // Same-version refresh is allowed, including disabled bundles.
        assert.equal(run().status, 0)
        assert.deepEqual(json(manifest).dsh.profile, pkg.dsh.profile)
      }
      reset()
      const before = files.map(file => readFileSync(join(dir, file), 'utf8'))
      assert.equal(run({}, true).status, 0)
      assert.throws(() => readFileSync(capture), /ENOENT/)
      for (const [extra, message] of [
        [{ DSH_TEST_NOOP: '1' }, /did not register/],
        [{ DSH_TEST_FAIL: '1' }, /exit 7/],
        ...(source === 'npm-cache' ? [
          [{ DSH_TEST_WRONG_VERSION: '1' }, /version mismatch/],
          [{ DSH_TEST_STALE_SOURCE: '1' }, /dependency source/],
          [{ DSH_TEST_MISSING_FILE: 'adapters/dsh/schema.js' }, /metadata\/schema/],
          [{ DSH_TEST_MISSING_FILE: 'adapters/dsh/index.js' }, /required adapter/],
          [{ DSH_TEST_MISSING_FILE: 'adapters/dsh/cordis.patch.yml' }, /required adapter/],
        ] : []),
      ]) {
        reset()
        const result = run(extra)
        assert.notEqual(result.status, 0)
        assert.match(result.stderr, message)
        assert.deepEqual(files.map(file => readFileSync(join(dir, file), 'utf8')), before, 'restore managed profile files on failure')
        assert.equal(readFileSync(capture, 'utf8').trim().split('\n').length, 1, 'do not remove legacy before verification')
      }
      const shadow = join(bin, 'node_modules/search-boost')
      cpSync(root, shadow, { recursive: true })
      for (const version of ['1.0.0', '2.0.0']) {
        reset()
        write(join(shadow, 'package.json'), { ...json(join(root, 'package.json')), version })
        const result = run()
        assert.notEqual(result.status, 0)
        assert.match(result.stderr, /runtime bundle source\/version mismatch/)
        assert.deepEqual(files.map(file => readFileSync(join(dir, file), 'utf8')), before, 'runtime mismatch rolls back profile files')
        assert.equal(json(manifest).dependencies['dsh-search-boost'], '0.1.3', 'do not retire legacy registration before runtime verification')
        assert.equal(readFileSync(capture, 'utf8').trim().split('\n').length, 1)
        assert.equal(json(join(shadow, 'package.json')).version, version, 'never change the host-owned conflicting copy')
      }
      rmSync(shadow, { recursive: true })
      if (process.platform === 'win32') {
        reset()
        assert.match(run({}, false, 'unsafe&profile').stderr, /Unsupported Windows command path characters/)
        assert.throws(() => readFileSync(capture), /ENOENT/)
      }
      console.log(`ok: DSH upgrade ${mode}/${source}: actual launch, migration, disabled state, repeat, dry-run and rollback`)
    }
  }
} finally {
  rmSync(temp, { recursive: true, force: true })
}
