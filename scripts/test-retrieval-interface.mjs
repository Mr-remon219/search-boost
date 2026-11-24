#!/usr/bin/env node
import './isolate-tests.mjs'
// Successor of the retired adaptive-interface suite: the ONE shared input/output
// contract every host translates. Strict objects refuse retired fields, the
// response is the exact-one union of a schema-v5 run and a read-only historical
// restore, and the private v2 write path validates the same v5 definition.
import assert from 'node:assert/strict'
import * as z from 'zod'
import Ajv from 'ajv'
import { ADAPTIVE_INPUT_SCHEMA, CONSTRAINTS_MIGRATION_MESSAGE, normalizeAdaptiveInput } from '../lib/search/screening/input.js'
import { ADAPTIVE_OUTPUT_SCHEMA, ADAPTIVE_V5_METADATA_SCHEMA, ADAPTIVE_V5_OUTPUT_SCHEMA } from '../lib/search/screening/schema.js'
import { LEGACY_HISTORICAL_OUTPUT_SCHEMA } from '../lib/search/screening/legacy-snapshot.js'
import { jsonSchemaToZod, projectObjectUnion } from '../lib/search/screening/zod-schema.js'
import { adaptiveSearchInput, adaptiveSearchOutput, validateAdaptiveSearchOutput } from '../adapters/mcp/schemas.mjs'
import { toDshSchema } from '../adapters/dsh/schema.js'
import { makeHarness } from './screening-run-fixture.mjs'
import { runAdaptiveScreening } from '../lib/search/screening/run.js'

let tests = 0
const test = async (name, fn) => { await fn(); tests++; console.log(`ok: ${name}`) }

await test('the shared input contract is one strict object with no schema default for community', () => {
  assert.equal(ADAPTIVE_INPUT_SCHEMA.additionalProperties, false)
  assert.deepEqual(Object.keys(ADAPTIVE_INPUT_SCHEMA.properties).sort(), [
    'community', 'constraints', 'cursor', 'intent', 'max_results', 'page_size', 'platform_options', 'preferences', 'questions', 'save_results', 'saved_result_id',
  ])
  assert.equal('keywords' in ADAPTIVE_INPUT_SCHEMA.properties, false)
  assert.equal(ADAPTIVE_INPUT_SCHEMA.properties.community.default, undefined)
  assert.equal(ADAPTIVE_INPUT_SCHEMA.properties.save_results.default, undefined)
  assert.equal(ADAPTIVE_INPUT_SCHEMA.properties.intent.maxLength, 2000)
  assert.equal(ADAPTIVE_INPUT_SCHEMA.properties.preferences.maxItems, 8)
  assert.equal(ADAPTIVE_INPUT_SCHEMA.properties.max_results.maximum, 50)
  assert.match(CONSTRAINTS_MIGRATION_MESSAGE, /adaptive_search 已移除逐材料 constraints 硬准入/)
})

await test('MCP translates the shared contracts instead of re-declaring them', () => {
  const input = z.object(adaptiveSearchInput.shape).strict()
  assert.equal(input.safeParse({ questions: ['Q?'], intent: 'I', preferences: ['P'], community: false }).success, true)
  for (const bad of [{ keywords: [] }, { tasks: [] }, { questions: ['a', 'b'] }, { questions: ['Q?'], intent: 'I', page_size: 51 }, { questions: ['Q?'], intent: 'I', community: 'auto' }]) {
    assert.equal(input.safeParse(bad).success, false, JSON.stringify(bad))
  }
  assert.equal(input.safeParse({ cursor: 's5:x.0' }).success, true)
  assert.equal(adaptiveSearchOutput.safeParse({ schemaVersion: 5, results: [], stopReason: 'target_met' }).success, false, 'a v5 run must satisfy its required fields')
  const projected = projectObjectUnion(ADAPTIVE_OUTPUT_SCHEMA)
  assert.equal(projected.additionalProperties, false)
  assert.deepEqual(Object.keys(projected.properties).sort(), [
    ...Object.keys(ADAPTIVE_V5_OUTPUT_SCHEMA.properties),
    ...Object.keys(LEGACY_HISTORICAL_OUTPUT_SCHEMA.properties).filter((key) => !(key in ADAPTIVE_V5_OUTPUT_SCHEMA.properties)),
  ].sort())
})

await test('the DSH translation accepts the union, the v5 branch and the v5 metadata shape', () => {
  const union = toDshSchema(ADAPTIVE_OUTPUT_SCHEMA)
  assert.equal(union.oneOf.length, 3)
  const v5 = toDshSchema(ADAPTIVE_V5_OUTPUT_SCHEMA)
  assert.equal(v5.type, 'object')
  const metadata = toDshSchema(ADAPTIVE_V5_METADATA_SCHEMA)
  assert.equal(metadata.type, 'object')
  assert.equal('results' in metadata.properties, false)
  assert.equal('nextCursor' in metadata.properties, false)
})

await test('both branches validate as a real union, and neither can fake the other', async () => {
  const validate = new Ajv({ strict: true, allowUnionTypes: true }).compile(ADAPTIVE_OUTPUT_SCHEMA)
  const { deps } = makeHarness()
  const run = await runAdaptiveScreening({ questions: ['Q?'], intent: 'I', community: false }, {}, deps)
  assert.equal(validate(run), true, JSON.stringify(validate.errors))
  assert.equal(validateAdaptiveSearchOutput(run), run)
  for (const key of ['schemaVersion', 'selection', 'run']) {
    const incomplete = { ...run }; delete incomplete[key]
    assert.throws(() => validateAdaptiveSearchOutput(incomplete), /^TypeError: adaptive_search: invalid response contract$/)
  }
  assert.equal(validate({ ...run, restoration: { historical: true, originalFormat: 'search-boost-research-v1', originalSchemaVersion: 3 } }), false, 'a v5 run cannot also claim to be historical')
  const historical = {
    results: [{ url: 'https://legacy.example/a', title: 'Legacy', description: 'stored' }],
    totalResults: 1, pageResults: 1, nextCursor: null, expiresAt: new Date().toISOString(),
    stopReason: 'keyword_queue_empty', warnings: [], coverageComplete: false,
    inputSummary: { question: 'Legacy question', intent: 'legacy intent', keywords: ['k'], constraints: [], constraintPolicy: 'explicit_per_material' },
    restoration: { historical: true, originalFormat: 'search-boost-research-v1', originalSchemaVersion: 3 },
  }
  assert.equal(validate(historical), true, JSON.stringify(validate.errors))
  assert.equal(validateAdaptiveSearchOutput(historical), historical)
  assert.throws(() => validateAdaptiveSearchOutput({ ...run, restoration: historical.restoration }), /invalid response contract/)
  assert.throws(() => validateAdaptiveSearchOutput({ ...historical, selection: run.selection }), /invalid response contract/)
  const invalidHistory = { ...historical }; delete invalidHistory.restoration
  assert.throws(() => validateAdaptiveSearchOutput(invalidHistory), /invalid response contract/)
  assert.equal(validate({ ...historical, selection: { requested: 1, returned: 1, targetMet: true, stopReason: 'target_met', incomplete: false } }), false, 'the historical branch must not carry v5 execution fields')
  assert.equal(validate({ ...historical, unknownField: 1 }), false)
  assert.equal(validate({}), false, 'the union is not an arbitrary object')
})

await test('nullability, enums and nested maps survive the host translation', () => {
  const zod = z.object(adaptiveSearchOutput.shape).strict()
  const { deps } = makeHarness()
  return runAdaptiveScreening({ questions: ['Q?'], intent: 'I', community: false }, {}, deps).then((run) => {
    assert.equal(zod.safeParse(run).success, true)
    assert.equal(zod.safeParse({ ...run, nextCursor: 42 }).success, false)
    assert.equal(zod.safeParse({ ...run, selection: { ...run.selection, returned: -1 } }).success, false)
    assert.equal(zod.safeParse({ ...run, run: { ...run.run, community: { ...run.run.community, outcome: 'maybe' } } }).success, false)
    assert.equal(zod.safeParse({ ...run, usage: { ...run.usage, fusedCalls: 'one' } }).success, false)
    const translated = jsonSchemaToZod(ADAPTIVE_V5_METADATA_SCHEMA)
    assert.equal(translated.safeParse({ ...run, results: undefined, nextCursor: undefined }).success, false, 'page fields are not part of the stored metadata contract')
  })
})

await test('read-only inputs stay distinguishable and migration errors are explicit', () => {
  assert.throws(() => normalizeAdaptiveInput({ questions: ['Q?'], intent: 'I', constraints: ['Only official sources'] }), /adaptive_constraints_removed/)
  assert.throws(() => normalizeAdaptiveInput({ questions: ['Q?'], intent: 'I', keywords: ['k'] }), /Unsupported adaptive input field: keywords/)
  assert.throws(() => normalizeAdaptiveInput({ cursor: 's5:a.0', saved_result_id: '11111111-1111-4111-8111-111111111111' }), /cannot be combined/)
  assert.equal(normalizeAdaptiveInput({ questions: ['Q?'], intent: 'I', constraints: [] }).mode, 'new')
  assert.equal(normalizeAdaptiveInput({ saved_result_id: '11111111-1111-4111-8111-111111111111', page_size: 3 }).mode, 'saved')
})
console.log(`screening interface contract: ${tests} groups passed (shared input/output union, MCP + DSH translation)`)
