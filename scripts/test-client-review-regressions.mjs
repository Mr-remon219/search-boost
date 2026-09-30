#!/usr/bin/env node
import './isolate-tests.mjs'
import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const originalCwd = process.cwd()
const base = mkdtempSync(join(tmpdir(), 'sb-client-review-'))
const home = join(base, 'home'), project = join(base, 'project')
mkdirSync(home); mkdirSync(project)
process.env.HOME = home
process.env.USERPROFILE = home
process.env.GROK_HOME = join(home, '.grok')
process.env.SEARCH_BOOST_HOME = join(home, '.search-boost')
process.chdir(project)
const { PATHS, preferredAntigravityMcpPath } = await import('../lib/paths.mjs')
const { AGENTS } = await import('../lib/agents/index.mjs')
const { refreshGrokPlugin, refreshIntegration, discoverIntegrations } = await import('../lib/upgrade/integrations.mjs')
const { refreshAntigravityMcp } = await import('../lib/antigravity-mcp.mjs')
const { PKG_ROOT } = await import('../lib/pkg.mjs')
const pluginDir = join(PKG_ROOT, 'grok-plugin')
const write = (file, value) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value)) }
const json = file => JSON.parse(readFileSync(file, 'utf8'))
const failures = []
async function test(name, fn) {
  try { await fn(); console.log(`ok: ${name}`) } catch (err) { failures.push(name); console.error(`FAIL: ${name}\n${err.stack}`) }
}
try {
  await test('fresh Antigravity install writes the modern client path and round-trips', async () => {
    assert.equal(preferredAntigravityMcpPath(), PATHS.antigravity.mcp)
    await AGENTS.antigravity.install({ autoAllow: false, dryRun: false })
    assert.ok(json(PATHS.antigravity.mcp).mcpServers['search-boost'])
    assert.equal(existsSync(PATHS.antigravity.legacyMcp), false)
    const body = json(PATHS.antigravity.mcp)
    body.custom = 'keep'; body.mcpServers.other = { command: 'user-server' }
    write(PATHS.antigravity.mcp, body)
    await AGENTS.antigravity.uninstall({ dryRun: false })
    assert.equal(json(PATHS.antigravity.mcp).custom, 'keep')
    assert.deepEqual(json(PATHS.antigravity.mcp).mcpServers, { other: { command: 'user-server' } })
    await AGENTS.antigravity.install({ autoAllow: false, dryRun: false })
    assert.equal(json(PATHS.antigravity.mcp).custom, 'keep')
    assert.equal(json(PATHS.antigravity.mcp).mcpServers.other.command, 'user-server')
  })
  await test('old mistaken Antigravity legacy entry migrates on reinstall without losing preferences', async () => {
    rmSync(PATHS.antigravity.mcp, { force: true })
    write(PATHS.antigravity.legacyMcp, { preference: 'keep', mcpServers: { other: { command: 'other' }, 'search-boost': { command: 'old-node', args: ['old-cli'], env: { SYNTHETIC_TOKEN: 'preserve' }, disabled: true } } })
    assert.equal(preferredAntigravityMcpPath(), PATHS.antigravity.mcp)
    await AGENTS.antigravity.install({ autoAllow: false, dryRun: false })
    assert.equal(json(PATHS.antigravity.legacyMcp).preference, 'keep')
    assert.equal(json(PATHS.antigravity.legacyMcp).mcpServers.other.command, 'other')
    assert.equal(json(PATHS.antigravity.legacyMcp).mcpServers['search-boost'], undefined)
    assert.equal(json(PATHS.antigravity.mcp).mcpServers['search-boost'].env.SYNTHETIC_TOKEN, 'preserve')
    assert.equal(json(PATHS.antigravity.mcp).mcpServers['search-boost'].disabled, true)
  })
  await test('official refresh of an old legacy target migrates to the modern client path', async () => {
    rmSync(PATHS.antigravity.mcp, { force: true })
    write(PATHS.antigravity.legacyMcp, { preference: 'keep', mcpServers: { other: { command: 'other' }, 'search-boost': { command: 'old-node', env: { SYNTHETIC_TOKEN: 'upgrade-preserve' }, enabled: false } } })
    const target = (await discoverIntegrations()).targets.find(t => t.id === 'antigravity' && t.paths.mcp === PATHS.antigravity.legacyMcp)
    assert.ok(target)
    const before = readFileSync(PATHS.antigravity.legacyMcp)
    await refreshIntegration(target, { dryRun: true })
    assert.ok(before.equals(readFileSync(PATHS.antigravity.legacyMcp)))
    assert.equal(existsSync(PATHS.antigravity.mcp), false)
    await refreshIntegration(target)
    assert.equal(json(PATHS.antigravity.mcp).mcpServers['search-boost'].enabled, false)
    assert.equal(json(PATHS.antigravity.mcp).mcpServers['search-boost'].env.SYNTHETIC_TOKEN, 'upgrade-preserve')
    assert.equal(json(PATHS.antigravity.legacyMcp).mcpServers['search-boost'], undefined)
    assert.equal(json(PATHS.antigravity.legacyMcp).mcpServers.other.command, 'other')
  })
  await test('genuine old Antigravity hosts use explicit persistent legacy compatibility', async () => {
    await AGENTS.antigravity.install({ antigravityConfig: 'legacy', autoAllow: false, dryRun: false })
    assert.equal(preferredAntigravityMcpPath(), PATHS.antigravity.legacyMcp)
    assert.ok(json(PATHS.antigravity.legacyMcp).mcpServers['search-boost'])
    write(PATHS.antigravity.migratedMarker, '')
    assert.equal(preferredAntigravityMcpPath(), PATHS.antigravity.legacyMcp, 'explicit user selection wins over heuristic markers')
    await AGENTS.antigravity.install({ antigravityConfig: 'modern', autoAllow: false, dryRun: false })
    assert.equal(preferredAntigravityMcpPath(), PATHS.antigravity.mcp)
    assert.equal(json(PATHS.antigravity.legacyMcp).mcpServers['search-boost'], undefined)
  })
  await test('failed second Antigravity migration write restores both exact configuration bytes', async () => {
    write(PATHS.antigravity.legacyMcp, { preference: 'keep', mcpServers: { other: { command: 'other' }, 'search-boost': { command: 'old-node' } } })
    const beforeModern = readFileSync(PATHS.antigravity.mcp), beforeLegacy = readFileSync(PATHS.antigravity.legacyMcp)
    const { writeJsonFile } = await import('../lib/json-config.mjs')
    let calls = 0
    await assert.rejects(() => refreshAntigravityMcp({ command: 'new-node' }, { write: async (file, value) => {
      if (++calls === 2) throw new Error('synthetic write failure')
      await writeJsonFile(file, value)
    } }), /previous configurations restored/)
    assert.ok(beforeModern.equals(readFileSync(PATHS.antigravity.mcp)))
    assert.ok(beforeLegacy.equals(readFileSync(PATHS.antigravity.legacyMcp)))
  })
  await test('bundled Grok manifest satisfies the object author contract', () => {
    const manifest = json(join(pluginDir, 'plugin.json'))
    assert.equal(typeof manifest.author, 'object')
    assert.equal(manifest.author.name, 'search-boost')
  })

  const old = join(base, 'old-package', 'grok-plugin')
  const installed = join(home, '.grok', 'installed-plugins', 'grok-plugin-deadbeef')
  const brokenManifest = { name: 'search-boost', version: '0.2.3', author: 'search-boost' }
  write(join(old, 'plugin.json'), brokenManifest)
  write(join(installed, 'plugin.json'), brokenManifest)
  const broken = { name: 'grok-plugin-deadbeef', repo_key: 'grok-plugin-deadbeef', source: old, path: installed }
  await test('upgrade discovers an old invalid-author slug and a wrapped plugin list', async () => {
    for (const wrap of [v => v, v => ({ plugins: v })]) {
      const calls = []
      const result = await refreshGrokPlugin({ dryRun: true, run: async (_command, args) => {
        calls.push(args); return { code: 0, stdout: JSON.stringify(wrap([broken])) }
      } })
      assert.equal(result.status, 'planned')
      assert.equal(calls.length, 1)
    }
  })
  await test('upgrade recognizes missing old source from the installed manifest and preserves disabled state', async () => {
    rmSync(old, { recursive: true })
    const result = await refreshGrokPlugin({ dryRun: false, run: async (_command, args) => {
      assert.equal(args[1], 'list', 'disabled plugins must not be installed or enabled')
      return { code: 0, stdout: JSON.stringify([{ ...broken, disabled: true }]) }
    } })
    assert.equal(result.status, 'disabled')
  })
  await test('upgrade uses native update for the same durable source, without granting trust', async () => {
    const calls = []
    const result = await refreshGrokPlugin({ dryRun: false, run: async (_command, args) => {
      calls.push(args)
      return { code: 0, stdout: JSON.stringify([{ name: 'search-boost', repo_key: 'local-key', source: pluginDir, path: pluginDir }]) }
    } })
    assert.equal(result.status, 'updated')
    assert.deepEqual(calls[1], ['plugin', 'update', 'search-boost'])
    assert.ok(calls.every(args => !args.includes('--trust')))
  })
  await test('Grok successful local update cannot hide a stale same-version cache or grant trust', async () => {
    const cache = join(base, 'stale-cache')
    cpSync(pluginDir, cache, { recursive: true })
    write(join(cache, 'skills', 'search-boost', 'SKILL.md'), 'old same-version skill payload')
    const listing = [{ name: 'search-boost', source: pluginDir, path: cache }]
    const before = readFileSync(join(cache, 'skills/search-boost/SKILL.md'))
    const calls = []
    await assert.rejects(() => refreshGrokPlugin({ dryRun: false, run: async (_command, args) => {
      calls.push(args); return { code: 0, stdout: JSON.stringify(listing) }
    } }), /cache payload was not updated/)
    assert.ok(before.equals(readFileSync(join(cache, 'skills/search-boost/SKILL.md'))))
    assert.ok(calls.every(args => !args.includes('--trust') && args[1] !== 'uninstall'))
    assert.deepEqual(calls[1], ['plugin', 'update', 'search-boost'])
    const { grokPluginPayloadMatches } = await import('../lib/grok-payload.mjs')
    cpSync(pluginDir, cache, { recursive: true })
    assert.equal(grokPluginPayloadMatches(listing[0], pluginDir), true)
    write(join(cache, 'hooks', 'hooks.json'), '{}')
    assert.equal(grokPluginPayloadMatches(listing[0], pluginDir), false, 'retired executable files cannot remain in a verified cache')
    assert.equal(grokPluginPayloadMatches({ source: pluginDir }, pluginDir), false, 'source equality is not installed-cache evidence')
  })
  await test('an old invalid-author registration is not silently skipped or falsely verified', async () => {
    const calls = []
    await assert.rejects(() => refreshGrokPlugin({ dryRun: false, run: async (_command, args) => {
      calls.push(args)
      return { code: 0, stdout: JSON.stringify([broken]) }
    } }), /Cannot verify the updated Grok plugin source/)
    assert.deepEqual(calls[1], ['plugin', 'install', pluginDir])
    assert.ok(calls.every(args => !args.includes('--trust')))
  })
  await test('unrelated plugins are not upgraded and malformed listings do not prove absence', async () => {
    const foreign = join(base, 'foreign')
    write(join(foreign, 'plugin.json'), { name: 'other' })
    let calls = 0
    const result = await refreshGrokPlugin({ dryRun: false, run: async () => {
      calls++; return { code: 0, stdout: JSON.stringify([{ name: 'other', source: foreign }]) }
    } })
    assert.equal(result.status, 'absent'); assert.equal(calls, 1)
    const malformed = await refreshGrokPlugin({ dryRun: true, run: async () => ({ code: 0, stdout: '[null]' }) })
    assert.equal(malformed.status, 'failed')
  })

  const bin = join(base, 'bin'), host = join(bin, 'grok-host.mjs'), state = join(base, 'plugin-list.json'), capture = join(base, 'calls.jsonl')
  write(host, `import fs from 'node:fs';
const args=process.argv.slice(2); fs.appendFileSync(process.env.GROK_TEST_CAPTURE,JSON.stringify(args)+'\\n');
if(args[1]==='list'){const count=fs.readFileSync(process.env.GROK_TEST_CAPTURE,'utf8').trim().split('\\n').length;
console.log(process.env.GROK_TEST_BAD_POST&&count>1?'invalid-json':fs.readFileSync(process.env.GROK_TEST_STATE,'utf8'));process.exit(0)}
if(args[1]==='install')process.exit(0);
if(args[1]==='uninstall'){const value=JSON.parse(fs.readFileSync(process.env.GROK_TEST_STATE));const list=Array.isArray(value)?value:value.plugins;
if(!list.some(p=>p.name===args[2]))process.exit(5);
if(!process.env.GROK_TEST_NOOP)fs.writeFileSync(process.env.GROK_TEST_STATE,JSON.stringify(list.filter(p=>p.name!==args[2])));process.exit(0)}process.exit(9);`)
  if (process.platform === 'win32') write(join(bin, 'grok.cmd'), `@echo off\r\n"${process.execPath}" "${host}" %*\r\n`)
  else { write(join(bin, 'grok'), `#!/bin/sh\nexec "${process.execPath}" "${host}" "$@"\n`); const { chmodSync } = await import('node:fs'); chmodSync(join(bin, 'grok'), 0o755) }
  const module = pathToFileURL(join(PKG_ROOT, 'lib/grok-plugin.mjs')).href
  const runPlugin = (listing, extra = {}, operation = 'uninstallGrokPlugin') => {
    write(state, listing); write(capture, '')
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `const {${operation}}=await import(${JSON.stringify(module)});const result=await ${operation}();console.log(JSON.stringify(result));if(!result.ok)process.exitCode=1`], {
      cwd: project, env: { ...process.env, PATH: bin + (process.platform === 'win32' ? ';' : ':') + process.env.PATH,
        GROK_TEST_STATE: state, GROK_TEST_CAPTURE: capture, ...extra }, encoding: 'utf8', timeout: 20_000,
    })
    return { ...child, calls: readFileSync(capture, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) }
  }
  await test('native install checks actual manifest-name/source registration, not only exit zero', () => {
    const success = runPlugin([{ name: 'search-boost', repo_key: 'local-key', source: pluginDir }], {}, 'installGrokPlugin')
    assert.equal(success.status, 0, success.stderr)
    const invalidAuthor = runPlugin([{ name: 'grok-plugin-deadbeef', repo_key: 'grok-plugin-deadbeef', source: pluginDir }], {}, 'installGrokPlugin')
    assert.notEqual(invalidAuthor.status, 0)
    assert.match(invalidAuthor.stderr, /host did not verify/)
  })
  await test('Grok native uninstall uses the listed name, never the repository key', () => {
    const foreign = { name: 'other', repo_key: 'foreign-key', source: '/foreign' }
    const result = runPlugin({ plugins: [{ name: 'search-boost', repo_key: 'local-key', source: pluginDir }, foreign] })
    assert.equal(result.status, 0, result.stderr)
    assert.ok(result.calls.some(args => args[1] === 'uninstall' && args[2] === 'search-boost'))
    assert.deepEqual(json(state), [foreign])
  })
  await test('old invalid-author installation can be uninstalled by its registered slug name', () => {
    const result = runPlugin([broken])
    assert.equal(result.status, 0, result.stderr)
    assert.ok(result.calls.some(args => args[1] === 'uninstall' && args[2] === broken.name))
    assert.deepEqual(json(state), [])
  })
  await test('valid absent Grok listing skips uninstall; invalid post-removal listing fails closed', () => {
    const absent = runPlugin([{ name: 'other', repo_key: 'foreign-key' }])
    assert.equal(absent.status, 0, absent.stderr)
    assert.ok(absent.calls.every(args => args[1] === 'list'))
    const unverifiable = runPlugin([{ name: 'search-boost', repo_key: 'local-key', source: pluginDir }], { GROK_TEST_BAD_POST: '1' })
    assert.notEqual(unverifiable.status, 0)
    assert.deepEqual(json(state), [])
    assert.match(unverifiable.stderr, /removal was not verified/)
  })
  await test('Grok no-op uninstall cannot be reported as successful', () => {
    const result = runPlugin([{ name: 'search-boost', repo_key: 'search-boost', source: pluginDir }], { GROK_TEST_NOOP: '1' })
    assert.notEqual(result.status, 0)
    assert.equal(json(state).length, 1)
  })
} finally {
  process.chdir(originalCwd)
  rmSync(base, { recursive: true, force: true })
}
if (failures.length) { console.error(`${failures.length} client review regressions failed`); process.exitCode = 1 }
