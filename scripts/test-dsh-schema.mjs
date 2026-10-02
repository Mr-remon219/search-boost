#!/usr/bin/env node
import './isolate-tests.mjs'
// Exercise the actual DSH registry/SDK schema compiler, not a permissive mock.
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import {
  ToolRuntime, assertObjectJsonSchema, assertSupportedJsonSchema,
  jsonSchemaToTs, jsonSchemaToPy, validateJsonSchemaValue,
} from '@deepseek-ai/dsh-tools'
import { ADAPTIVE_INPUT_SCHEMA } from '../lib/search/screening/input.js'
import { ADAPTIVE_OUTPUT_SCHEMA } from '../lib/search/screening/schema.js'
import { runAdaptiveSearch } from '../lib/runtime.mjs'
import { resultPages } from '../lib/search/screening/pages.js'
import { saveJevConfig, clearJevConfig } from '../lib/jev-config.mjs'
import { saveToolPreferences } from '../lib/tool-config.mjs'
import { registerDshTool, toDshSchema } from '../adapters/dsh/schema.js'

// The packaging smoke can supply an installed adapter (npm global or npx cache).
const { apply } = await import(process.argv[2] ? pathToFileURL(process.argv[2]).href : '../adapters/dsh/index.js')
const ctx = new Context()
ctx.provide('systemPrompt')
ctx.set('systemPrompt', { tools() {}, section() {} })
ctx.provide('web')
ctx.set('web', { registerSearchProvider() {}, registerFetchProvider() {} })
ctx.provide('commands')
ctx.set('commands', { register() {} })
const tools = new ToolRuntime(ctx)
const errors = []
const logError = console.error
try {
  console.error = (...args) => errors.push(args.join(' '))
  apply(ctx)
} finally {
  console.error = logError
}
assert.deepEqual(errors, [], 'DSH startup must not silently swallow registration failures')
const names = ['fused_search', 'fetch_page', 'adaptive_search', 'x_search', 'research_parallel', 'search_stats']
assert.deepEqual([...tools.view().visible.keys()].sort(), names.toSorted())
for (const name of names) {
  const tool = tools.get(name)
  assertObjectJsonSchema(tool.parameters)
  assertSupportedJsonSchema(tool.output.schema)
  for (const schema of [tool.parameters, tool.output.schema]) {
    assert.equal(typeof jsonSchemaToTs(schema), 'string')
    assert.equal(typeof jsonSchemaToPy(schema), 'string')
  }
}
assert.equal(tools.schemas().length, names.length)
assert.equal(tools.sdkSchemas().length, names.length)
console.log('ok: all six tools register in real DSH and compile for native/TypeScript/Python presentation')
const cacheRuntime = process.argv[2] ? await import(new URL('../../lib/runtime.mjs', pathToFileURL(process.argv[2])).href) : await import('../lib/runtime.mjs')
cacheRuntime.PAGE_CACHE.set('page:https://example.test/legacy-cache', 'Historical cached document text. '.repeat(8))
const legacyPage = await tools.get('fetch_page').execute({ url: 'https://example.test/legacy-cache' }, {})
assert.equal(legacyPage.fetched_at, null)
assert.equal(legacyPage.cacheHit, true)
assert.deepEqual(validateJsonSchemaValue(tools.get('fetch_page').output.schema, legacyPage), [])
console.log('ok: legacy cache time is nullable in the actual DSH output validator; no fake fetch time or network request')

const stats = await tools.get('search_stats').execute({}, {})
assert.deepEqual(validateJsonSchemaValue(tools.get('search_stats').output.schema, stats), [])
assert.equal(typeof stats.xOfficial, 'boolean')
assert.equal(typeof stats.xSource, 'string')
const adaptive = tools.get('adaptive_search')
// The registered output contract is the shared v5 ∪ historical union, translated.
assert.ok(ADAPTIVE_OUTPUT_SCHEMA.oneOf.length === 2, 'shared union keeps two explicit branches')
assert.notEqual(tools.get('adaptive_search').output.schema, undefined)
await assert.rejects(() => adaptive.execute({ questions: ['test'], intent: 'find references' }, {}), /Jev not configured/)
// Injected deps keep this a pure contract check: the entry gate is open, no Jev
// credential exists, so the core returns its structured not_configured result.
const empty = await runAdaptiveSearch({ questions: ['test'], intent: 'find references' }, {}, {
  toolState: () => ({ requested: true, enabled: true }),
  readConfig: () => ({}),
})
assert.equal(empty.stopReason, 'not_configured')
assert.equal(empty.nextCursor, null)
assert.deepEqual(validateJsonSchemaValue(adaptive.output.schema, empty), [])
assert.deepEqual(validateJsonSchemaValue(adaptive.output.schema, { ...empty, nextCursor: 'next-page' }), [])
assert.notEqual(validateJsonSchemaValue(adaptive.output.schema, { ...empty, nextCursor: 42 }).length, 0)
assert.notEqual(validateJsonSchemaValue(adaptive.output.schema, { ...empty, schemaVersion: 4 }).length, 0, 'a v5 run must declare schemaVersion 5')
assert.notEqual(validateJsonSchemaValue(adaptive.output.schema, { ...empty, unknownField: 1 }).length, 0, 'unknown fields are refused, not ignored')

// A read-only historical restore must validate through the same translated union
// and must never be forced to invent v5 fields.
const historical = resultPages.saveHistorical({
  results: [{ url: 'https://legacy.example/a', title: 'Legacy A', description: 'Stored v1 passage' }],
  metadata: {
    coverageComplete: false, stopReason: 'keyword_queue_empty', warnings: [],
    inputSummary: { question: 'Legacy question', intent: 'legacy intent', keywords: ['k'], constraints: [], constraintPolicy: 'explicit_per_material' },
  },
  originalFormat: 'search-boost-research-v1',
  originalSchemaVersion: 3,
  savedAt: '2026-10-01T00:00:00.000Z',
}, 2)
assert.equal(historical.restoration.historical, true)
assert.deepEqual(validateJsonSchemaValue(adaptive.output.schema, historical), [], JSON.stringify(validateJsonSchemaValue(adaptive.output.schema, historical)))
assert.notEqual(validateJsonSchemaValue(adaptive.output.schema, { ...historical, selection: { returned: 1 } }).length, 0, 'the historical branch cannot carry v5 execution fields')
assert.notEqual(validateJsonSchemaValue(adaptive.output.schema, { ...historical, restoration: undefined }).length, 0)
const fused = tools.get('fused_search')
const result = { query: 'fixture', effectiveWeights: { bing: 1 }, results: [{ title: 'Title', url: 'https://example.com', domain: 'example.com', published: null, engineRanks: { bing: 1 }, contributions: { bing: 0.5 } }] }
assert.deepEqual(validateJsonSchemaValue(fused.output.schema, result), [])
result.results[0].published = '2026-01-01'
assert.deepEqual(validateJsonSchemaValue(fused.output.schema, result), [])
console.log('ok: nullable dates/cursors, engine maps, v5 and historical adaptive outputs all pass the real DSH validator')

// The single-question contract must compile for DSH without weakening the
// shared MCP/Pi schema, and the switch gate must survive schema translation.
for (const intent of ['Find useful pointers']) {
  const input = { questions: ['a?'], intent, preferences: ['Implementation details'], community: false }
  assert.deepEqual(validateJsonSchemaValue(adaptive.parameters, input), [])
  await assert.rejects(() => adaptive.execute(input, {}), /Jev not configured/)
}
for (const input of [
  { questions: [], intent: 'x' }, { questions: ['a?', 'b?'], intent: 'x' }, { questions: ['a?'], page_size: 51 },
  { questions: ['a?'], keywords: ['alpha'], intent: 'x' }, { questions: ['a?'], tasks: [], intent: 'x' },
  { questions: ['a?'], community: 'auto', intent: 'x' }, { saved_result_id: 'x'.repeat(36) },
]) {
  await assert.rejects(() => adaptive.execute(input, {}), /invalid arguments/)
}
saveJevConfig({ apiKey: 'fixture-no-network' })
try {
  // With the entry unlocked, structural migration errors surface before any network:
  // retired non-empty constraints, missing intent and unknown fields.
  await assert.rejects(() => adaptive.execute({ questions: ['a?'], intent: 'x', constraints: ['Only official sources'] }, {}), /adaptive_constraints_removed/)
  await assert.rejects(() => adaptive.execute({ questions: ['a?'] }, {}), /intent is required/)
  const emptyConstraints = await adaptive.execute({ questions: ['a?'], intent: 'x', constraints: [] }, {})
  assert(emptyConstraints.warnings.some((warning) => warning.startsWith('deprecated_constraints_empty')))
  saveToolPreferences({ adaptive_search: false })
  await assert.rejects(() => adaptive.execute({ questions: ['a?'], intent: 'x' }, {}), /Disabled by user/)
  saveToolPreferences({ adaptive_search: true })
} finally { clearJevConfig() }
console.log('ok: single-question contract, retired-field refusal, intent requirement and live switches survive real DSH registration')

// Conversion must not mutate contracts shared with MCP/Pi. Property names that
// resemble keywords must remain property names, not be stripped recursively.
const before = structuredClone(ADAPTIVE_INPUT_SCHEMA)
toDshSchema(ADAPTIVE_INPUT_SCHEMA)
assert.deepEqual(ADAPTIVE_INPUT_SCHEMA, before)
const collision = toDshSchema({ type: 'object', properties: { minimum: { type: 'number', minimum: 0 } } })
assert.equal(collision.properties.minimum.type, 'number')
assert.match(collision.properties.minimum.description, /minimum: 0/)
assert.throws(() => toDshSchema({ type: ['number', 'integer'] }), /nullable scalar/)
assert.throws(() => toDshSchema({ anyOf: [{ type: 'number' }, { type: 'integer' }] }), /disjoint/)
assert.throws(() => toDshSchema({ anyOf: [{ type: 'array', items: { type: 'string' } }, { type: 'array', items: { type: 'array' } }] }), /nonempty/)

// Every constraint omitted from the host schema must still be checked before
// dispatch; invalid input must not start a network request or native child.
for (const args of [{ query: 'x', engines: [] }, { query: 'x', engine_weights: { bing: -1 } }, { query: 'x', min_score: -1 }]) {
  await assert.rejects(() => fused.execute(args, {}), /invalid arguments/)
}
for (const args of [
  { questions: Array(7).fill('q'), intent: 'x' }, { questions: ['q'], intent: 'x', page_size: 51 },
  { tasks: [{ context: 'test', targets: [{ id: 'bad id', keywords: ['test'], question: 'q' }] }] },
]) await assert.rejects(() => adaptive.execute(args, {}), /invalid arguments/)
for (const args of [{ agent: 'searcher', task: '' }, { tasks: [] }, { max_seconds: 301 }, { max_sources: 0 }]) {
  await assert.rejects(() => tools.get('research_parallel').execute(args, {}), /invalid arguments/)
}
let calls = 0
let output = { engine: 1 }
const definition = {
  name: 'schema_fixture', parameters: { type: 'object', properties: { count: { type: 'integer', minimum: 1, maximum: 2 } }, required: ['count'], additionalProperties: false },
  output: { schema: { type: 'object', additionalProperties: { type: 'number' } }, render: () => [] },
  async execute() { calls++; return output },
}
registerDshTool(ctx, definition)
const fixture = tools.get('schema_fixture')
await assert.rejects(() => fixture.execute({ count: 0 }), /invalid arguments/)
assert.equal(calls, 0)
assert.deepEqual(await fixture.execute({ count: 1 }), output)
output = { engine: 'not-a-number' }
await assert.rejects(() => fixture.execute({ count: 1 }), /invalid output/)
assert.deepEqual(definition.output.schema.additionalProperties, { type: 'number' })
console.log('ok: translated constraints remain enforced, output dictionaries stay typed, shared schemas stay unchanged')
