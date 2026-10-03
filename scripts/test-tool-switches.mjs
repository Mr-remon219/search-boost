#!/usr/bin/env node
import './isolate-tests.mjs'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'sb-tools-'))
process.env.SEARCH_BOOST_HOME = home
process.env.PI_CODING_AGENT_DIR = join(home, 'pi')
const { toolStates, toolState, toolsFilePath, saveToolPreferences, guardedTool, watchToolStates } = await import('../lib/tool-config.mjs')
const { saveJevConfig, clearJevConfig } = await import('../lib/jev-config.mjs')
const { runToolsWizard } = await import('../lib/installer/tools-wizard.mjs')
const { runtimeSnapshot, formatRuntimeCapabilities } = await import('../lib/search/capability.js')
const { writeKeysFile } = await import('../lib/keys.mjs')
const { default: piExtension } = await import('../adapters/pi/index.js')
const { apply: dshExtension } = await import('../adapters/dsh/index.js')
const wait = (ms = 650) => new Promise((resolve) => setTimeout(resolve, ms))
let stop, shutdown
try {
  assert.ok(toolState('fused_search').enabled)
  assert.ok(toolState('adaptive_search').locked)
  assert.throws(() => saveToolPreferences({ adaptive_search: true }), /Jev not configured/)
  assert.ok(!existsSync(toolsFilePath()))
  assert.throws(() => saveToolPreferences({ unknown: false }), /Invalid tool/)
  assert.throws(() => saveToolPreferences({ x_search: 'false' }), /Invalid tool/)
  const initialFingerprint = runtimeSnapshot().fingerprint
  saveToolPreferences({ 'search-parallel-subagent': false, x_search: false })
  assert.equal(runtimeSnapshot().fingerprint, initialFingerprint, 'entry switches do not repartition engine caches')
  writeKeysFile({ baseUrls: { exa: 'https://gateway.example/prefix' } })
  assert.notEqual(runtimeSnapshot().fingerprint, initialFingerprint, 'custom bases still partition caches after switches integration')
  writeKeysFile({ baseUrls: { exa: null } })
  assert.equal(toolState('research_parallel').enabled, false)
  saveToolPreferences({ search_stats: false })
  assert.equal(toolState('x_search').enabled, false, 'patch preserves unrelated preferences')
  saveJevConfig({ apiKey: 'fixture-jev' })
  assert.equal(toolState('adaptive_search').enabled, true)
  assert.match(formatRuntimeCapabilities(), /adaptive_search is available/)
  assert.match(formatRuntimeCapabilities(), /Questions, intent and necessary evidence fragments are sent/)
  assert.doesNotMatch(formatRuntimeCapabilities(), /fixture-jev|32 candidates|request-count/, 'live status is readiness/privacy, not a duplicate screening manual')
  saveToolPreferences({ adaptive_search: false })
  assert.doesNotMatch(formatRuntimeCapabilities(), /adaptive_search is available/)
  clearJevConfig()
  saveJevConfig({ apiKey: 'fixture-new-jev' })
  assert.equal(toolState('adaptive_search').enabled, false, 'credential changes preserve explicit off')
  clearJevConfig()

  // Stale handles reject before running any implementation, including cached paths.
  let calls = 0, release
  const tool = guardedTool({ name: 'fetch_page', execute: () => { calls++; return new Promise((resolve) => { release = resolve }) } })
  const running = tool.execute()
  saveToolPreferences({ fetch_page: false })
  await assert.rejects(tool.execute(), /Disabled by user/)
  assert.equal(calls, 1)
  release('completed')
  assert.equal(await running, 'completed', 'already running requests finish')

  // Wizard cancellation / dry-run / no implicit Jev preference writes.
  const before = readFileSync(toolsFilePath(), 'utf8')
  const logs = [], cancel = Symbol('cancel')
  let selection, confirmed = true, menu
  const clack = {
    note: (text) => logs.push(text), isCancel: (value) => value === cancel,
    multiselect: async (options) => { menu = options; return selection },
    confirm: async () => confirmed,
    log: Object.fromEntries(['info', 'success', 'error'].map((name) => [name, (text) => logs.push(text)])),
  }
  selection = cancel
  await runToolsWizard(clack)
  assert.ok(!menu.options.some((row) => row.value === 'adaptive_search'))
  assert.ok(logs.some((text) => text.includes('\u001b[9madaptive_search\u001b[29m') && text.includes('[locked]')))
  assert.equal(menu.required, false)
  assert.equal(readFileSync(toolsFilePath(), 'utf8'), before)
  selection = []
  await runToolsWizard(clack, { dryRun: true })
  assert.equal(readFileSync(toolsFilePath(), 'utf8'), before)
  confirmed = false
  await runToolsWizard(clack)
  assert.equal(readFileSync(toolsFilePath(), 'utf8'), before)
  confirmed = true
  await runToolsWizard(clack)
  assert.ok(toolStates().every((row) => !row.enabled), 'all-off is valid')

  const observations = []
  stop = watchToolStates((states) => observations.push(states), { interval: 10 })
  writeFileSync(toolsFilePath(), '{broken')
  await wait(35)
  assert.ok(observations.at(-1).every((row) => !row.enabled))
  await assert.rejects(tool.execute(), /valid JSON/)
  assert.throws(() => saveToolPreferences({ fetch_page: true }), /valid JSON/)
  assert.equal(readFileSync(toolsFilePath(), 'utf8'), '{broken', 'never overwrite corrupt configuration')
  writeFileSync(toolsFilePath(), JSON.stringify({ tools: { x_search: false } }))
  await wait(35)
  assert.ok(observations.at(-1).find((row) => row.name === 'fetch_page').enabled)
  stop(); stop = undefined

  // Pi session watcher owns only tools it removed, never adds unrelated or
  // initially excluded tools, and cleans up on shutdown.
  const handlers = new Map(), tools = new Map()
  let active = ['read', 'fused_search', 'fetch_page', 'x_search', 'adaptive_search']
  piExtension({
    on: (event, handler) => handlers.set(event, handler),
    registerTool: (definition) => tools.set(definition.name, definition), registerCommand() {},
    getActiveTools: () => active, setActiveTools: (names) => { active = names },
  })
  shutdown = handlers.get('session_shutdown')
  await handlers.get('session_start')()
  assert.ok(active.includes('read') && !active.includes('x_search') && !active.includes('adaptive_search'))
  saveToolPreferences({ x_search: true, research_parallel: false })
  await wait()
  assert.ok(active.includes('x_search'))
  saveToolPreferences({ research_parallel: true, fused_search: false })
  await wait()
  assert.ok(!active.includes('search-parallel-subagent'), 'never grant an initially excluded tool')
  assert.ok(!active.includes('fused_search') && active.includes('read'))
  await assert.rejects(tools.get('fused_search').execute('id', {}), /Disabled by user/)
  saveJevConfig({ apiKey: 'fixture-jev' })
  await wait()
  assert.ok(active.includes('adaptive_search'))
  clearJevConfig()
  await wait()
  assert.ok(!active.includes('adaptive_search'))
  await shutdown(); shutdown = undefined
  saveToolPreferences({ fused_search: true })
  await wait()
  assert.ok(!active.includes('fused_search'), 'watcher stopped on shutdown')

  // DSH provider seam cannot bypass switches; unrelated commands remain usable.
  const dshTools = new Map(), providers = {}
  dshExtension({
    tools: { register: (definition) => dshTools.set(definition.name, definition) },
    web: { registerSearchProvider: (definition) => { providers.search = definition }, registerFetchProvider: (definition) => { providers.fetch = definition } },
    systemPrompt: { section() {} }, get: () => ({ register() {} }),
  })
  saveToolPreferences({ fused_search: false, fetch_page: false, research_parallel: false })
  assert.equal(providers.search.available(), false)
  assert.equal(providers.fetch.available(), false)
  await assert.rejects(providers.search.search({ query: 'unused' }), /Disabled by user/)
  await assert.rejects(providers.fetch.fetch({ url: 'https://example.com' }), /Disabled by user/)
  await assert.rejects(dshTools.get('research_parallel').execute({}), /Disabled by user/)
  assert.ok((await dshTools.get('search_stats').execute({}, {})).startedAt)
  console.log('ok: shared switches, Jev lock, stale calls, atomic/corrupt config, wizard, Pi lifecycle and DSH providers')
} finally {
  stop?.()
  await shutdown?.()
  rmSync(home, { recursive: true, force: true })
}
