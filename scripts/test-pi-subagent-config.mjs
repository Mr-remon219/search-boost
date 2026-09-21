#!/usr/bin/env node
/** Hermetic reproduction of the stale child extension + retired-tool failure. */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, relative } from 'node:path'
import { pathToFileURL } from 'node:url'

const home = mkdtempSync(join(tmpdir(), 'sb-child-config-'))
process.env.HOME = process.env.USERPROFILE = home
process.env.PI_CODING_AGENT_DIR = join(home, '.pi', 'agent')
process.env.SEARCH_BOOST_HOME = join(home, '.search-boost')
const { migratePiSubagentSettings, inspectPiSubagentSettings, piSearchExtension } = await import('../lib/pi-subagent-config.mjs')
const { installPiExtension, piAdapterEntry } = await import('../lib/agents/host-runtime.mjs')
const { checkPiSubagentTools } = await import('../lib/doctor/checks/pi.mjs')
const dir = process.env.PI_CODING_AGENT_DIR
const file = join(dir, 'settings.json')
const old = join(dir, 'npm', 'node_modules', 'pi-search-boost', 'index.ts')
const adapter = piAdapterEntry()
const write = (path, value) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value, null, 2)) }
const bytes = (path) => readFileSync(path, 'utf8')
let count = 0
async function test(name, fn) { await fn(); console.log(`ok: ${name}`); count++ }
try {
  const original = {
    packages: [join(adapter, '..', '..', '..')], other: { untouched: true },
    subagents: {
      defaultModel: 'unchanged', defaultThinking: 'max', defaultExtensions: ['foreign.ts', old],
      agentOverrides: {
        reviewer: { tools: ['read', 'fused_search', 'fetch_page', 'deep_research', 'x_search'], model: 'unchanged' },
        isolated: { extensions: [], tools: [], disabled: true },
        cleared: { extensions: false, subagentOnlyExtensions: false, tools: false },
        custom: { extensions: [old], subagentOnlyExtensions: [old, old], tools: ['deep_research', old, 'foreign_tool'], excludeTools: ['adaptive_search'] },
      },
      agentOverridesByProvider: { provider: { reviewer: { extensions: [old], tools: ['read', 'deep_research'] } } },
    },
  }
  await test('missing exact legacy npm path is recognized without claiming foreign lookalikes', () => {
    assert(piSearchExtension(old, dir))
    assert(piSearchExtension(pathToFileURL(old).href, dir))
    assert(piSearchExtension(relative(dir, old), dir))
    assert(!piSearchExtension(join(home, 'user', 'pi-search-boost', 'index.ts'), dir))
    write(join(dirname(old), 'package.json'), { name: 'foreign' })
    assert(!piSearchExtension(old, dir))
    rmSync(join(dirname(old), 'package.json'))
    write(old, 'export default () => {}')
    assert(!piSearchExtension(old, dir), 'existing unowned file must not be overwritten')
    rmSync(old)
  })
  await test('pure migration repairs defaults and overrides without new tool grants or model changes', () => {
    const before = JSON.stringify(original)
    const { settings: next, changes } = migratePiSubagentSettings(original, dir, adapter)
    assert(changes.length > 0)
    assert.equal(JSON.stringify(original), before)
    assert.deepEqual(next.subagents.defaultExtensions, ['foreign.ts', adapter])
    assert.deepEqual(next.subagents.agentOverrides.reviewer.tools, ['read', 'fused_search', 'fetch_page', 'x_search'])
    assert.deepEqual(next.subagents.agentOverrides.isolated, original.subagents.agentOverrides.isolated)
    assert.deepEqual(next.subagents.agentOverrides.cleared, original.subagents.agentOverrides.cleared)
    assert.deepEqual(next.subagents.agentOverrides.custom.tools, [adapter, 'foreign_tool'])
    assert.deepEqual(next.subagents.agentOverrides.custom.subagentOnlyExtensions, [adapter])
    assert.deepEqual(next.subagents.agentOverrides.custom.excludeTools, ['adaptive_search'])
    assert.deepEqual(next.subagents.agentOverridesByProvider.provider.reviewer.tools, ['read'])
    assert.equal(next.subagents.defaultModel, 'unchanged')
    assert.equal(next.subagents.defaultThinking, 'max')
    assert.deepEqual(next.other, original.other)
    assert.deepEqual(migratePiSubagentSettings(next, dir, adapter).changes, [])
  })
  await test('absent/empty extensions and unrelated tools are not auto-enabled or reinterpreted', () => {
    for (const value of [{}, { subagents: { defaultExtensions: [] } }, { subagents: { agentOverrides: { custom: { tools: ['deep_research'], extensions: ['foreign.ts'] } } } }]) {
      assert.deepEqual(migratePiSubagentSettings(value, dir, adapter), { settings: value, changes: [] })
    }
    for (const bad of [null, [], { defaultExtensions: 'bad' }, { agentOverrides: { reviewer: { tools: 'read,deep_research' } } }]) {
      assert.throws(() => migratePiSubagentSettings({ subagents: bad }, dir, adapter), /Invalid/)
    }
  })
  await test('doctor identifies the exact reported failure and stays read-only', () => {
    write(file, original)
    const before = bytes(file)
    const check = checkPiSubagentTools({ homeDir: home })
    assert.equal(check.status, 'warn')
    assert(check.details.issues.some((issue) => issue.problem === 'missing_extension'))
    assert(check.details.issues.some((issue) => issue.problem === 'retired_tool'))
    assert.equal(bytes(file), before)
    assert(inspectPiSubagentSettings({ subagents: { defaultExtensions: [], agentOverrides: { reviewer: { tools: ['fused_search'] } } } }, dir).some((i) => i.problem === 'explicit_extensions_without_search_boost'))
  })
  await test('install dry-run is byte-preserving; real install repairs child references and repeats safely', async () => {
    const before = bytes(file)
    await installPiExtension({ dryRun: true })
    assert.equal(bytes(file), before)
    await installPiExtension({})
    const after = bytes(file)
    assert.deepEqual(JSON.parse(after), migratePiSubagentSettings(original, dir, adapter).settings)
    assert.equal(checkPiSubagentTools({ homeDir: home }).status, 'pass')
    await installPiExtension({})
    assert.equal(bytes(file), after)
  })
  await test('invalid settings do not get rewritten on install', async () => {
    write(file, { subagents: { defaultExtensions: 'bad' } })
    const before = bytes(file)
    await assert.rejects(installPiExtension({}), /Invalid/)
    assert.equal(bytes(file), before)
  })
} finally {
  rmSync(home, { recursive: true, force: true })
}
console.log(`All ${count} Pi subagent configuration tests passed.`)
