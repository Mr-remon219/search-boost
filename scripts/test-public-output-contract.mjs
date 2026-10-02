#!/usr/bin/env node
import './isolate-tests.mjs'
/**
 * BUG-003 public output contract regression (x_search diagnostics + community
 * fused rows) against the REAL DSH entry and the advertised MCP schemas.
 *
 * No network, credential or user configuration: engines, the hosted xAI tool
 * and the fallback provider are injected fixtures, while runFused / runXSearch,
 * mergeCommunityResults, the DSH registration/validation gate and the MCP zod
 * schemas are the production code paths.
 */
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import {
  ToolRuntime, assertObjectJsonSchema, assertSupportedJsonSchema, validateJsonSchemaValue,
} from '@deepseek-ai/dsh-tools'
import * as z from 'zod'
import { ENGINE_POOLS } from '../lib/search/routing.js'
import {
  cleanJsonValue, fusedHitToJson, invalidateSearchCaches, runFused, runXSearch,
} from '../lib/runtime.mjs'
import { apply } from '../adapters/dsh/index.js'
import { registerDshTool } from '../adapters/dsh/schema.js'
import { xSearchStructured } from '../adapters/mcp/register.mjs'
import { fusedSearchOutput, xSearchOutput } from '../adapters/mcp/schemas.mjs'

// Recent enough for a recency=day community run to keep the fixture posts.
const CREATED_AT = new Date(Date.now() - 6 * 3600_000).toISOString()
const PUBLISHED = CREATED_AT.slice(0, 10)
const idAt = (seq = 0) => (((BigInt(Date.parse(CREATED_AT)) - 1288834974657n) << 22n) + BigInt(seq)).toString()
const post = (name, seq) => ({
  url: `https://x.com/${name}/status/${idAt(seq)}`,
  text: 'alpha beta developer community evidence',
  created_at: CREATED_AT,
})

let auth = true
let officialFailure = false
let officialEmpty = false
let fallbackFailure = false
let fallbackEmpty = false
let officialHold = null
let engineFailure = new Set()
const xPosts = [post('alice', 1), post('bob', 2)]
const officialPosts = [post('carol', 3)]

const engines = Object.fromEntries(ENGINE_POOLS.hybrid.map((name) => [name, {
  available: () => true,
  async search(query, count) {
    if (engineFailure.has(name)) throw new Error('fixture engine unavailable')
    if (query.startsWith('site:x.com')) {
      return xPosts.slice(0, count).map((p) => ({ url: p.url, title: 'Author on X: alpha beta community evidence', snippet: p.text, created_at: p.created_at }))
    }
    return Array.from({ length: Math.min(3, count) }, (_, i) => ({
      url: `https://${name.replace('-', '')}-docs.example/${i}`,
      title: 'alpha beta reference',
      snippet: 'alpha beta implementation evidence',
    }))
  },
}]))
const snapshot = () => ({
  engines,
  fingerprint: JSON.stringify([auth, officialFailure, officialEmpty, fallbackFailure, fallbackEmpty, [...engineFailure].sort()]),
  capability: { x: { official: { available: auth, source: auth ? 'fixture' : 'none' }, fallback: { available: true } } },
})
const fakeOfficial = async () => {
  if (officialFailure) throw new Error('hosted fixture unavailable')
  if (officialHold) await officialHold
  return { credential: 'fixture', data: officialEmpty ? [] : officialPosts }
}
const fakeFallback = async (args) => {
  if (fallbackFailure) {
    await args.webSearch(args.query, args.limit) // dispatch facts exist before the failure
    throw new Error('fallback fixture unavailable')
  }
  if (fallbackEmpty) {
    await args.webSearch(args.query, args.limit)
    return { type: 'keyword', data: [], via: 'engines' }
  }
  return { type: 'keyword', data: await args.webSearch(args.query, args.limit), via: 'engines' }
}
const injectedXSearch = (args, opts) => runXSearch(args, { ...opts, snapshot, officialSearch: fakeOfficial, fallbackSearch: fakeFallback })
const xRun = (args = {}) => runXSearch({ type: 'keyword', query: 'alpha beta', max_results: 10, ...args },
  { snapshot, officialSearch: fakeOfficial, fallbackSearch: fakeFallback })

function resetFixture() {
  invalidateSearchCaches()
  auth = true
  officialFailure = false
  officialEmpty = false
  fallbackFailure = false
  fallbackEmpty = false
  officialHold = null
  engineFailure = new Set()
}

// ---------- real DSH entry: registration, schemas and the adapter Ajv gate ----------

function dshContext() {
  const ctx = new Context()
  ctx.provide('systemPrompt')
  ctx.set('systemPrompt', { tools() {}, section() {} })
  return ctx
}

const hostCtx = dshContext()
hostCtx.provide('web'); hostCtx.set('web', { registerSearchProvider() {}, registerFetchProvider() {} })
hostCtx.provide('commands'); hostCtx.set('commands', { register() {} })
const tools = new ToolRuntime(hostCtx)
const startupErrors = []
const originalError = console.error
try {
  console.error = (...args) => startupErrors.push(args.join(' '))
  apply(hostCtx)
} finally { console.error = originalError }
assert.deepEqual(startupErrors, [], 'DSH startup must not silently swallow registration failures')
for (const name of ['x_search', 'fused_search']) {
  assertObjectJsonSchema(tools.get(name).parameters)
  assertSupportedJsonSchema(tools.get(name).output.schema)
}
// The delegation is widened, not opened: unknown output fields and unknown row
// fields still fail both the host schema and the adapter's Ajv gate.
const xSearchSchema = tools.get('x_search').output.schema
assert.equal(xSearchSchema.additionalProperties, false)
for (const field of ['engineStats', 'enginesUsed', 'warnings']) {
  assert.ok(field in xSearchSchema.properties, `x_search output must declare ${field}`)
}
const fusedSchema = tools.get('fused_search').output.schema
assert.equal(fusedSchema.additionalProperties, false)
assert.equal(fusedSchema.properties.results.items.additionalProperties, false)
console.log('ok: real DSH entry registers x_search/fused_search with the widened, still-closed schema')

// The adapter's own Ajv output gate runs inside execute(). Capture the
// definitions it registered, then re-bind them with a stub payload so the real
// gate is exercised with real runtime payloads (no host/network call).
const captured = new Map()
const captureCtx = {
  tools: { register: (definition) => { captured.set(definition.name, definition); return definition } },
  web: { registerSearchProvider() {}, registerFetchProvider() {} },
  systemPrompt: { section() {} },
  get: () => ({ register() {} }),
}
apply(captureCtx)
const gateCtx = new Context()
gateCtx.provide('systemPrompt'); gateCtx.set('systemPrompt', { tools() {}, section() {} })
const gateTools = new ToolRuntime(gateCtx)
let submitted
for (const name of ['x_search', 'fused_search']) {
  registerDshTool(gateCtx, { ...captured.get(name), async execute() { return submitted } })
}
async function acceptThroughDsh(name, payload, args) {
  submitted = payload
  const returned = await gateTools.get(name).execute(args, {}) // throws `invalid output` on any undeclared field
  assert.deepEqual(returned, payload)
  assert.deepEqual(validateJsonSchemaValue(tools.get(name).output.schema, payload), [], `${name}: host validator must accept the payload`)
}
const X_ARGS = { type: 'keyword', query: 'alpha beta' }
const X_ROW_FIELDS = ['created_at', 'bestIndividual', 'groupEvidence', 'votingEngines']

function assertDiagnostics(payload) {
  assert.equal(typeof payload.engineStats, 'object')
  assert.ok(Array.isArray(payload.enginesUsed))
  assert.ok(Array.isArray(payload.warnings))
  for (const [engine, stat] of Object.entries(payload.engineStats)) {
    assert.ok(Object.keys(stat).every((key) => ['used', 'errors', 'attempts', 'successes', 'note'].includes(key)), `${engine}: undeclared stat field`)
    assert.equal(typeof stat.used, 'boolean')
    assert.equal(typeof stat.errors, 'number')
  }
}

let tests = 0
async function test(name, fn) {
  resetFixture()
  await fn()
  tests++
  console.log(`ok: ${name}`)
}

try {
  await test('x_search success payload keeps engineStats/enginesUsed/warnings through the DSH gate', async () => {
    const payload = cleanJsonValue(await xRun())
    assert.equal(payload.results, 3)
    assert.ok(payload.enginesUsed.length > 0)
    assertDiagnostics(payload)
    await acceptThroughDsh('x_search', payload, X_ARGS)
  })

  await test('x_search empty payload stays valid and does not invent diagnostics', async () => {
    officialEmpty = true
    fallbackEmpty = true
    invalidateSearchCaches()
    const payload = cleanJsonValue(await xRun())
    assert.equal(payload.results, 0)
    assert.equal(payload.via, 'parallel')
    assert.ok(payload.enginesUsed.length > 0, 'the fallback dispatched engines even though it kept no rows')
    assertDiagnostics(payload)
    await acceptThroughDsh('x_search', payload, X_ARGS)
  })

  await test('x_search failure payload carries diagnostics on the error branch', async () => {
    officialFailure = true
    fallbackFailure = true
    const payload = cleanJsonValue(await xRun())
    assert.equal(payload.via, 'error')
    assert.equal(typeof payload.error, 'string')
    assertDiagnostics(payload)
    await acceptThroughDsh('x_search', payload, X_ARGS)
  })

  await test('x_search degraded engines keep their failure notes in warnings', async () => {
    engineFailure = new Set(['yahoo'])
    const payload = cleanJsonValue(await xRun())
    assert.ok(payload.engineStats.yahoo.errors > 0)
    assert.ok(payload.warnings.some((warning) => warning.startsWith('yahoo:')), JSON.stringify(payload.warnings))
    assertDiagnostics(payload)
    await acceptThroughDsh('x_search', payload, X_ARGS)
  })

  await test('x_search cached payload keeps the recorded diagnostics', async () => {
    const first = cleanJsonValue(await xRun())
    const second = cleanJsonValue(await xRun())
    assert.equal(second.cacheHit, true)
    assertDiagnostics(first)
    assertDiagnostics(second)
    await acceptThroughDsh('x_search', first, X_ARGS)
    await acceptThroughDsh('x_search', second, X_ARGS)
  })

  await test('x_search single-flight join payload carries diagnostics and marks inFlight', async () => {
    let release
    officialHold = new Promise((resolve) => { release = resolve })
    const first = xRun()
    const shared = xRun()
    release()
    const [a, b] = (await Promise.all([first, shared])).map(cleanJsonValue)
    assert.equal(a.inFlight, undefined)
    assert.equal(b.inFlight, true)
    assertDiagnostics(a)
    assertDiagnostics(b)
    await acceptThroughDsh('x_search', a, X_ARGS)
    await acceptThroughDsh('x_search', b, X_ARGS)
  })

  await test('community fused rows project public fields only and keep scoring/date/provenance', async () => {
    const payload = cleanJsonValue(await runFused(
      { query: 'alpha beta', complexity: 'medium', engineList: ['bing', 'ddg'], maxResults: 6, community: true, recency: 'day' },
      { snapshot, xSearch: injectedXSearch },
    ))
    const xRows = payload.results.filter((row) => row.kind === 'x')
    assert.ok(xRows.length > 0 && xRows.length < payload.results.length, 'fixture must mix web and X rows')
    for (const row of payload.results) {
      for (const field of X_ROW_FIELDS) assert.ok(!(field in row), `${field} must not reach a public row`)
    }
    for (const row of xRows) {
      assert.equal(row.published, PUBLISHED)
      assert.equal(row.dateStatus, 'known')
      assert.ok(Object.keys(row.engineRanks).length > 0)
      assert.ok(Object.keys(row.contributions).length > 0)
      assert.ok(row.provenance.length > 0)
      for (const field of ['score', 'scoreVersion', 'rankScore', 'evidenceScore', 'consensusBoost', 'metadataDelta', 'engines', 'id', 'username']) {
        assert.ok(row[field] !== undefined, `X row must keep public ${field}`)
      }
    }
    assertDiagnostics(payload)
    await acceptThroughDsh('fused_search', payload, { query: 'alpha beta' })
  })

  await test('community:false rows are unchanged and the adjacency proof covers the snapshot path', async () => {
    const off = cleanJsonValue(await runFused(
      { query: 'alpha beta', complexity: 'medium', engineList: ['bing', 'ddg'], maxResults: 6, community: false },
      { snapshot, xSearch: injectedXSearch },
    ))
    for (const row of off.results) for (const field of X_ROW_FIELDS) assert.ok(!(field in row))
    await acceptThroughDsh('fused_search', off, { query: 'alpha beta' })

    resetFixture()
    const snapshotRun = cleanJsonValue(await runFused(
      { query: 'alpha beta', complexity: 'medium', engineList: ['bing', 'ddg'], maxResults: 32, maxResultsCap: 32, community: true, candidateSelection: 'snapshot' },
      { snapshot, xSearch: injectedXSearch },
    ))
    assert.ok(snapshotRun.results.some((row) => row.kind === 'x'), 'the snapshot must still carry community rows')
    for (const row of snapshotRun.results) for (const field of X_ROW_FIELDS) assert.ok(!(field in row), `snapshot row leaked ${field}`)
  })

  await test('unknown fields are still refused: no blanket additionalProperties', async () => {
    const payload = cleanJsonValue(await xRun())
    await assert.rejects(() => acceptThroughDsh('x_search', { ...payload, surprise: 1 }, X_ARGS), /invalid output/)

    resetFixture()
    const fused = cleanJsonValue(await runFused(
      { query: 'alpha beta', complexity: 'medium', engineList: ['bing'], maxResults: 6, community: true },
      { snapshot, xSearch: injectedXSearch },
    ))
    const xRow = fused.results.find((row) => row.kind === 'x')
    assert.ok(xRow)
    const leaked = { ...fused, results: fused.results.map((row) => (row === xRow ? { ...row, created_at: CREATED_AT } : row)) }
    await assert.rejects(() => acceptThroughDsh('fused_search', leaked, { query: 'alpha beta' }), /invalid output/)
  })

  await test('MCP x_search structured content keeps the diagnostics the schema advertises', async () => {
    const payload = cleanJsonValue(await xRun())
    assertDiagnostics(payload)
    const structured = xSearchStructured(payload)
    const parsed = z.object(xSearchOutput).safeParse(structured)
    assert.equal(parsed.success, true, JSON.stringify(parsed.error?.issues))
    assert.deepEqual(parsed.data.engineStats, payload.engineStats)
    assert.deepEqual(parsed.data.enginesUsed, payload.enginesUsed)
    assert.deepEqual(parsed.data.warnings, payload.warnings)
    assert.equal(parsed.data.engineStats.bing.used, true)
    // A failed branch is returned as an MCP tool error, but the advertised
    // diagnostics still describe the payload shape the core produced.
    officialFailure = true
    fallbackFailure = true
    invalidateSearchCaches()
    const failed = cleanJsonValue(await xRun())
    assertDiagnostics(failed)
    assert.equal(z.object(xSearchOutput).safeParse({ ...failed, items: [] }).success, true)
  })

  await test('MCP fused schema accepts the projected community rows and strips nothing public', async () => {
    resetFixture()
    const payload = cleanJsonValue(await runFused(
      { query: 'alpha beta', complexity: 'medium', engineList: ['bing', 'ddg'], maxResults: 6, community: true },
      { snapshot, xSearch: injectedXSearch },
    ))
    const rows = payload.results.map(fusedHitToJson)
    const parsed = z.object(fusedSearchOutput).parse({ ...payload, resultCount: rows.length, results: rows })
    assert.equal(parsed.results.length, payload.results.length)
    const xRow = parsed.results.find((row) => row.kind === 'x')
    assert.ok(xRow)
    assert.equal(xRow.published, PUBLISHED)
    assert.ok(parsed.engineStats.bing && parsed.engineStats.ddg, 'MCP keeps the engine diagnostics')
    for (const row of rows) for (const field of X_ROW_FIELDS) assert.ok(!(field in row))
  })
} finally {
  invalidateSearchCaches()
}

console.log(`ok: ${tests} public output contract scenarios passed`)
