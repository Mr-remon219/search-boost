#!/usr/bin/env node
import './isolate-tests.mjs'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync, rmSync, cpSync, chmodSync, existsSync, realpathSync } from 'node:fs'
import { join, dirname, delimiter } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { PKG_ROOT, getVersion } from '../lib/pkg.mjs'
import { PATHS, dshProfilesWithSearchBoost } from '../lib/paths.mjs'
import { discoverIntegrations, refreshIntegration } from '../lib/upgrade/integrations.mjs'
import { runCommand } from '../lib/upgrade/process.mjs'
import { writeDshHostFixture } from './dsh-host-fixture.mjs'

const base = join(process.env.HOME, 'dsh-layer-regressions')
const write = (file, value) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value)) }
const json = file => JSON.parse(readFileSync(file, 'utf8'))
const copyPackage = (from, to) => {
  const pkg = json(join(from, 'package.json'))
  mkdirSync(to, { recursive: true })
  for (const file of ['package.json', ...pkg.files]) cpSync(join(from, file), join(to, file), { recursive: true })
}
const own = join(base, 'global', 'node_modules', 'search-boost'), registry = join(base, 'registry', 'search-boost')
copyPackage(PKG_ROOT, own)
copyPackage(PKG_ROOT, registry)
write(join(own, 'lib', 'payload-revision.mjs'), 'export default "local-new"\n')
write(join(registry, 'adapters/dsh/index.js'), '// registry OLD code, same version\n' + readFileSync(join(registry, 'adapters/dsh/index.js'), 'utf8'))
const bin = join(base, 'bin'), entry = join(bin, 'host.mjs'), capture = join(base, 'commands.jsonl')
writeDshHostFixture(entry)
write(entry, `
import { appendFileSync, readFileSync, writeFileSync, mkdirSync, rmSync, cpSync, symlinkSync } from 'node:fs';
import { join, dirname, isAbsolute } from 'node:path';
const raw = process.argv.slice(2);
const args = raw[0] === 'exec' ? raw.slice(raw.indexOf('--') + 2) : raw;
appendFileSync(process.env.DSH_TEST_CAPTURE, JSON.stringify(args) + '\\n');
const [, , profile, verb, source] = args;
const dir = join(process.env.DSH_HOME, 'profiles', profile), file = join(dir, 'package.json');
let pkg; try { pkg = JSON.parse(readFileSync(file)); } catch { pkg = { dependencies: {}, dsh: { profile: { bundles: [] } } }; }
if (process.env.DSH_TEST_NOOP) process.exit(0);
const fields = ['dependencies', 'devDependencies', 'optionalDependencies'];
if (verb === 'add') {
  const existed = fields.some(field => pkg[field]?.['search-boost']);
  const field = process.env.DSH_TEST_FIELD ?? 'dependencies';
  pkg[field] ??= {};
  const installed = join(dir, 'node_modules', 'search-boost');
  mkdirSync(dirname(installed), { recursive: true }); rmSync(installed, { recursive: true, force: true });
  const local = isAbsolute(source);
  pkg[field]['search-boost'] = local ? 'link:' + source : source.replace(/^search-boost@/, '');
  if (local && !process.env.DSH_TEST_STALE_PAYLOAD) symlinkSync(source, installed, process.platform === 'win32' ? 'junction' : 'dir');
  else cpSync(process.env.DSH_TEST_REGISTRY, installed, { recursive: true });
  if (!existed) pkg.dsh.profile.bundles.push('search-boost');
} else if (verb === 'remove') {
  for (const field of fields) delete pkg[field]?.[source];
  pkg.dsh.profile.bundles = pkg.dsh.profile.bundles.filter(name => name !== source);
  rmSync(join(dir, 'node_modules', source), { recursive: true, force: true });
} else throw Error('unexpected host operation');
writeFileSync(file, JSON.stringify(pkg));
`)
for (const name of ['dsh', 'pnpm']) {
  const file = join(bin, name + (process.platform === 'win32' ? '.cmd' : ''))
  write(file, process.platform === 'win32' ? `@"${process.execPath}" "${entry}" %*\r\n` : `#!/bin/sh\nexec "${process.execPath}" "${entry}" "$@"\n`)
  chmodSync(file, 0o700)
}
if (process.platform !== 'win32') { write(join(bin, 'which'), '#!/bin/sh\ncommand -v "$1"\n'); chmodSync(join(bin, 'which'), 0o700) }
const env = { ...process.env, PATH: [bin, ...(process.platform === 'win32' ? [join(process.env.SystemRoot, 'System32')] : [])].join(delimiter),
  DSH_TEST_CAPTURE: capture, DSH_TEST_REGISTRY: registry, DSH_HOME: PATHS.dsh.home }
if (process.platform === 'win32') for (const key of Object.keys(env)) if (key.toLowerCase() === 'path' && key !== 'PATH') delete env[key]
const hostUrl = new URL('../lib/agents/host-runtime.mjs', import.meta.url).href
const run = (body, extra = {}, moduleUrl = hostUrl) => spawnSync(process.execPath, ['--input-type=module', '-e', `const host = await import(${JSON.stringify(moduleUrl)}); ${body}`], { env: { ...env, ...extra }, encoding: 'utf8', timeout: 20_000 })
const failures = []
async function test(name, fn) {
  try { await fn(); console.log(`ok: ${name}`) } catch (error) { failures.push({ name, error }); console.error(`FAIL: ${name}: ${error.message}`) }
}
const profile = 'optional-only', dir = join(PATHS.dsh.profiles, profile), manifest = join(dir, 'package.json')
function reset(name = 'search-boost') {
  write(manifest, { dependencies: { 'user-plugin': '1.0.0' }, optionalDependencies: { [name]: getVersion() }, dsh: { profile: { bundles: ['user-plugin'], custom: 'keep' } } })
}
await test('optional-only disabled registration is discovered', async () => {
  reset()
  assert.ok(dshProfilesWithSearchBoost().includes(profile))
  assert.ok((await discoverIntegrations()).targets.some(target => target.profile === profile))
})
await test('optional-only removal runs the host and verifies no-op failures', async () => {
  reset(); rmSync(capture, { force: true })
  const noop = run(`await host.uninstallDshBundle({profile:${JSON.stringify(profile)}})`, { DSH_TEST_NOOP: '1' })
  assert.notEqual(noop.status, 0, 'retained optional dependency must not be reported removed')
  const removed = run(`await host.uninstallDshBundle({profile:${JSON.stringify(profile)}})`)
  assert.equal(removed.status, 0, removed.stderr)
  assert.equal(json(manifest).optionalDependencies['search-boost'], undefined)
  assert.equal(json(manifest).dependencies['user-plugin'], '1.0.0')
})
await test('optional-only reinstall is verified without re-enabling; explicit enable works', async () => {
  reset()
  for (const enable of [false, true]) {
    const result = run(`let status; await host.installDshBundle({profile:${JSON.stringify(profile)},enableDshBundle:${enable},onDshStatus:value=>{status=value}});console.log(JSON.stringify(status))`, { DSH_TEST_FIELD: 'optionalDependencies' })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(JSON.parse(result.stdout).enabled, enable)
    assert.equal(json(manifest).dsh.profile.custom, 'keep')
  }
})
await test('optional-only legacy upgrade is discovered, migrated and retained disabled', async () => {
  reset('dsh-search-boost')
  const target = (await discoverIntegrations()).targets.find(target => target.profile === profile)
  assert.ok(target?.legacy)
  await refreshIntegration(target, { packageRoot: own, run: (command, args, options = {}) => {
    const hostArgs = command === 'npm' && args[0] === 'exec' ? args.slice(args.indexOf('--') + 2) : args
    return runCommand(process.execPath, [entry, ...hostArgs], { ...options, env: { ...env, ...options.env, PATH: env.PATH, DSH_TEST_FIELD: 'optionalDependencies', DSH_TEST_CAPTURE: capture, DSH_TEST_REGISTRY: registry } })
  } })
  const pkg = json(manifest)
  assert.equal(pkg.optionalDependencies['dsh-search-boost'], undefined)
  assert.equal(typeof pkg.optionalDependencies['search-boost'], 'string')
  assert.deepEqual(pkg.dsh.profile, { bundles: ['user-plugin'], custom: 'keep' })
})
await test('a package under node_modules installs its own new code, not same-version npm code', async () => {
  const ownHost = pathToFileURL(join(own, 'lib/agents/host-runtime.mjs')).href
  const result = run(`await host.installDshBundle({profile:'local-new'})`, {}, ownHost)
  assert.equal(result.status, 0, result.stderr)
  const installed = join(PATHS.dsh.profiles, 'local-new', 'node_modules/search-boost')
  assert.equal(realpathSync(installed), realpathSync(own))
  assert.equal(readFileSync(join(installed, 'lib/payload-revision.mjs'), 'utf8'), 'export default "local-new"\n')
})
await test('npm-exec cache fallback checks content and never retains a cache link', async () => {
  const cache = join(base, '_npx', 'cache', 'node_modules', 'search-boost')
  copyPackage(own, cache)
  const cachedHost = pathToFileURL(join(cache, 'lib/agents/host-runtime.mjs')).href
  const stale = run(`await host.installDshBundle({profile:'cache-stale'})`, {}, cachedHost)
  assert.notEqual(stale.status, 0)
  assert.match(stale.stderr, /installed payload differs/)
  const exactRegistry = join(base, 'exact-registry')
  copyPackage(own, exactRegistry)
  const exact = run(`await host.installDshBundle({profile:'cache-exact'})`, { DSH_TEST_REGISTRY: exactRegistry }, cachedHost)
  assert.equal(exact.status, 0, exact.stderr)
  const installed = join(PATHS.dsh.profiles, 'cache-exact', 'node_modules', 'search-boost')
  assert.notEqual(realpathSync(installed), realpathSync(cache))
  rmSync(cache, { recursive: true })
  assert.equal(readFileSync(join(installed, 'lib/payload-revision.mjs'), 'utf8'), 'export default "local-new"\n')
})
await test('same-version stale payload is rejected even when the host resolver selects it', async () => {
  const ownHost = pathToFileURL(join(own, 'lib/agents/host-runtime.mjs')).href
  const result = run(`await host.installDshBundle({profile:'stale-payload'})`, { DSH_TEST_STALE_PAYLOAD: '1' }, ownHost)
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /source|payload|local installation/)
})

const layer = join(base, 'layer.json'), workerUrl = new URL('../lib/layer-config.mjs', import.meta.url).href
async function until(file) {
  const deadline = Date.now() + 10_000
  while (!existsSync(file)) { if (Date.now() > deadline) throw Error('worker barrier timeout: ' + file); await delay(10) }
}
await test('two processes serialize search-layer writes and both save successfully', async () => {
  write(layer, { layer: 'free' })
  const workers = []
  function start(id, value) {
    const child = spawn(process.execPath, ['--input-type=module', '-e', `
      import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module';
      const target=${JSON.stringify(layer)}, prefix=${JSON.stringify(join(base, 'writer-'))}+${id};
      const before=fs.renameSync;
      fs.renameSync=(from,to)=>{
        if(to===target){fs.writeFileSync(prefix+'.temp',from);fs.writeFileSync(prefix+'.ready','ready');const deadline=Date.now()+10000;while(!fs.existsSync(prefix+'.release')){if(Date.now()>deadline)throw Error('release timeout');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10)}}
        return before(from,to);
      };
      syncBuiltinESMExports(); const {setLayer}=await import(${JSON.stringify(workerUrl)});
      fs.writeFileSync(prefix+'.started','started'); setLayer(${JSON.stringify(value)});
    `], { env: { ...process.env, SEARCH_BOOST_LAYER_FILE: layer }, stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', chunk => { stderr += chunk })
    const done = new Promise(resolve => child.on('exit', code => resolve({ code, stderr })))
    workers.push({ child, done }); return done
  }
  try {
    const first = start(1, 'free')
    await until(join(base, 'writer-1.ready'))
    const second = start(2, 'api')
    await until(join(base, 'writer-2.started'))
    await delay(150)
    assert.equal(existsSync(join(base, 'writer-2.ready')), false, 'second process must wait for the layer write lock')
    write(join(base, 'writer-1.release'), 'release')
    const a = await first; assert.equal(a.code, 0, a.stderr)
    await until(join(base, 'writer-2.ready'))
    write(join(base, 'writer-2.release'), 'release')
    const b = await second; assert.equal(b.code, 0, b.stderr)
    assert.notEqual(readFileSync(join(base, 'writer-1.temp'), 'utf8'), readFileSync(join(base, 'writer-2.temp'), 'utf8'), 'each write owns a unique temporary file')
    assert.deepEqual(json(layer), { layer: 'api' })
    assert.equal(existsSync(layer + '.lock'), false)
    assert.equal(existsSync(layer + '.tmp'), false)
  } finally {
    for (const id of [1, 2]) write(join(base, `writer-${id}.release`), 'release')
    await Promise.all(workers.map(worker => worker.done))
  }
})
await test('failed atomic layer replacement retains old data and cleans its temp/lock', async () => {
  const before = readFileSync(layer, 'utf8')
  const failed = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module';
    const rename=fs.renameSync; fs.renameSync=(from,to)=>{if(to===${JSON.stringify(layer)})throw Error('injected rename failure');return rename(from,to)};
    syncBuiltinESMExports(); const {setLayer}=await import(${JSON.stringify(workerUrl)});setLayer('free');
  `], { env: { ...process.env, SEARCH_BOOST_LAYER_FILE: layer }, encoding: 'utf8', timeout: 10_000 })
  assert.notEqual(failed.status, 0)
  assert.equal(readFileSync(layer, 'utf8'), before)
  assert.equal(existsSync(layer + '.lock'), false)
  const { readdirSync } = await import('node:fs')
  assert.ok(!readdirSync(base).some(file => file.startsWith('.layer.json.') && file.endsWith('.tmp')))
})
if (failures.length) {
  console.error(`${failures.length} regression(s) failed`)
  process.exitCode = 1
}
