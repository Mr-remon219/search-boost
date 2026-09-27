#!/usr/bin/env node
// Exercise the actual DSH registry/SDK schema compiler, not a permissive mock.
import './isolate-install-tests.mjs'
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import {
  ToolRuntime, assertObjectJsonSchema, assertSupportedJsonSchema,
  jsonSchemaToTs, jsonSchemaToPy, validateJsonSchemaValue,
} from '@deepseek-ai/dsh-tools'
import { ADAPTIVE_INPUT_SCHEMA } from '../lib/search/adaptive/input.js'
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

const stats = await tools.get('search_stats').execute({}, {})
assert.deepEqual(validateJsonSchemaValue(tools.get('search_stats').output.schema, stats), [])
assert.equal(typeof stats.xOfficial, 'boolean')
assert.equal(typeof stats.xSource, 'string')
const adaptive = tools.get('adaptive_search')
const empty = await adaptive.execute({ questions: ['test'] }, {})
assert.equal(empty.stopReason, 'not_configured')
assert.equal(empty.nextCursor, null)
assert.deepEqual(validateJsonSchemaValue(adaptive.output.schema, empty), [])
assert.deepEqual(validateJsonSchemaValue(adaptive.output.schema, { ...empty, nextCursor: 'next-page' }), [])
assert.notEqual(validateJsonSchemaValue(adaptive.output.schema, { ...empty, nextCursor: 42 }).length, 0)
const fused = tools.get('fused_search')
const result = { query: 'fixture', effectiveWeights: { bing: 1 }, results: [{ title: 'Title', url: 'https://example.com', domain: 'example.com', published: null, engineRanks: { bing: 1 }, contributions: { bing: 0.5 } }] }
assert.deepEqual(validateJsonSchemaValue(fused.output.schema, result), [])
result.results[0].published = '2026-01-01'
assert.deepEqual(validateJsonSchemaValue(fused.output.schema, result), [])
console.log('ok: nullable dates/cursors, engine maps, and real stats/adaptive outputs pass DSH validation')

// Conversion must not mutate contracts shared with MCP/Pi. Property names that
// resemble keywords must remain property names, not be stripped recursively.
const before = structuredClone(ADAPTIVE_INPUT_SCHEMA)
toDshSchema(ADAPTIVE_INPUT_SCHEMA)
assert.deepEqual(ADAPTIVE_INPUT_SCHEMA, before)
const collision = toDshSchema({ type: 'object', properties: { minimum: { type: 'number', minimum: 0 } } })
assert.equal(collision.properties.minimum.type, 'number')
assert.match(collision.properties.minimum.description, /minimum: 0/)
assert.throws(() => toDshSchema({ type: ['number', 'integer'] }), /nullable scalar/)

// Every constraint omitted from the host schema must still be checked before
// dispatch; invalid input must not start a network request or native child.
for (const args of [{ query: 'x', engines: [] }, { query: 'x', engine_weights: { bing: -1 } }, { query: 'x', min_score: -1 }]) {
  await assert.rejects(() => fused.execute(args, {}), /invalid arguments/)
}
for (const args of [
  { questions: Array(7).fill('q') }, { questions: ['q'], page_size: 51 },
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
