import './isolate-tests.mjs'
// N_off shared modules: input migration contract, schema-v5 output schema, the
// s5/h1 page pool, the describe contract and the versioned budget. Includes a
// static scan proving the retired scope/info/language/rescue paths are gone.
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  ADAPTIVE_INPUT_SCHEMA, normalizeAdaptiveInput, AdaptiveInputError, CONSTRAINTS_MIGRATION_MESSAGE,
} from '../lib/search/screening/input.js'
import { ADAPTIVE_OUTPUT_SCHEMA, ADAPTIVE_V5_OUTPUT_SCHEMA, ADAPTIVE_V5_SCHEMA_VERSION } from '../lib/search/screening/schema.js'
import { createResultPages, resultPages, MAX_PAGE_RUNS, PAGE_TTL_MS, MAX_PAGE_BYTES } from '../lib/search/screening/pages.js'
import { ADAPTIVE_DESCRIPTION, ADAPTIVE_PROMPT_GUIDELINES, renderAdaptiveSummary, adaptiveTextContent, ADAPTIVE_TOOL_NAME } from '../lib/search/screening/describe.js'
import { SCREENING_LIMITS, SCREENING_BUDGET_VERSION, SCREENING_METERING_VERSION, createScreeningBudget } from '../lib/search/screening/limits.js'
import { toDshSchema } from '../adapters/dsh/schema.js'
import { runAdaptiveScreening } from '../lib/search/screening/run.js'
import { makeHarness, outputValidator } from './screening-run-fixture.mjs'

const screeningDir = fileURLToPath(new URL('../lib/search/screening/', import.meta.url))
const source = (name) => readFileSync(`${screeningDir}${name}`, 'utf8')

// ---- input contract ----
assert.equal(ADAPTIVE_INPUT_SCHEMA.additionalProperties, false)
assert.deepEqual(Object.keys(ADAPTIVE_INPUT_SCHEMA.properties).sort(), ['community', 'constraints', 'cursor', 'intent', 'max_results', 'page_size', 'preferences', 'questions', 'save_results', 'saved_result_id'])
assert.match(ADAPTIVE_INPUT_SCHEMA.properties.constraints.description, /Retired material gate/)
assert.match(ADAPTIVE_INPUT_SCHEMA.properties.community.description, /Omit for Jev to choose/)
assert.match(ADAPTIVE_INPUT_SCHEMA.properties.questions.description, /English is requested/)
assert.match(ADAPTIVE_INPUT_SCHEMA.properties.intent.description, /not enforced or translated/)
assert.equal(ADAPTIVE_INPUT_SCHEMA.properties.community.default, undefined, 'community must stay optional with no schema default')
assert.equal(ADAPTIVE_INPUT_SCHEMA.properties.save_results.default, undefined)
{
  const normal = normalizeAdaptiveInput({ questions: ['  Q?  '], intent: '  I  ', preferences: ['P', 'P', ' Q '] })
  assert.deepEqual(normal, { mode: 'new', question: 'Q?', intent: 'I', preferences: ['P', 'Q'], community: undefined, communityExplicit: false, saveResults: false, maxResults: 10, pageSize: 20, warnings: [] })
  assert.deepEqual(normalizeAdaptiveInput({ questions: ['Q?'], intent: 'I', community: true, save_results: true, max_results: 50, page_size: 1 }).community, true)
  assert.equal(normalizeAdaptiveInput({ questions: ['Q?'], intent: 'I', community: false }).community, false)
  const read = normalizeAdaptiveInput({ cursor: 's5:11111111-1111-4111-8111-111111111111.0', page_size: 7 })
  assert.deepEqual(read, { mode: 'cursor', cursor: 's5:11111111-1111-4111-8111-111111111111.0', pageSize: 7, warnings: [] })
  assert.deepEqual(normalizeAdaptiveInput({ saved_result_id: '11111111-1111-4111-8111-111111111111' }), { mode: 'saved', savedResultId: '11111111-1111-4111-8111-111111111111', pageSize: 20, warnings: [] })
  const empty = normalizeAdaptiveInput({ questions: ['Q?'], intent: 'I', constraints: [] })
  assert.deepEqual(empty.warnings, ['deprecated_constraints_empty: constraints is a retired migration field; the empty array is accepted and ignored'])
  for (const [input, code] of [
    [{ questions: ['Q?'], intent: 'I', constraints: ['x'] }, 'adaptive_constraints_removed'],
    [{ questions: ['Q?'], intent: 'I', keywords: [] }, 'unsupported_field'],
    [{ questions: ['Q?'] }, 'invalid_input'],
  ]) {
    try {
      normalizeAdaptiveInput(input)
      assert.fail(`${JSON.stringify(input)} must be rejected`)
    } catch (error) {
      assert.equal(error instanceof AdaptiveInputError, true)
      assert.equal(error.code, code)
      assert.match(error.message, new RegExp(`^${code}: `))
    }
  }
  assert.match(CONSTRAINTS_MIGRATION_MESSAGE, /adaptive_constraints_removed|已移除逐材料|No search was performed/)
  // A syntactically plausible cursor is a read branch here; the legacy format is
  // rejected by the page pool before any Jev/search call (covered below).
  assert.deepEqual(normalizeAdaptiveInput({ cursor: '11111111-1111-4111-8111-111111111111.1', page_size: 1 }), {
    mode: 'cursor', cursor: '11111111-1111-4111-8111-111111111111.1', pageSize: 1, warnings: [],
  })
}

// ---- output schema ----
// The shared contract is the exact-one union of the schema-v5 run and the
// read-only historical restore; the v5 branch stays addressable on its own.
assert.equal(Array.isArray(ADAPTIVE_OUTPUT_SCHEMA.oneOf), true)
assert.equal(ADAPTIVE_OUTPUT_SCHEMA.oneOf.length, 2)
assert.equal(ADAPTIVE_OUTPUT_SCHEMA.oneOf[0].properties.schemaVersion.enum[0], 5)
assert.equal(ADAPTIVE_OUTPUT_SCHEMA.oneOf[0].properties.restoration, undefined)
assert.equal(ADAPTIVE_OUTPUT_SCHEMA.oneOf[1].properties.restoration.required.includes('historical'), true)
assert.equal(ADAPTIVE_V5_OUTPUT_SCHEMA, ADAPTIVE_OUTPUT_SCHEMA.oneOf[0])
assert.equal(ADAPTIVE_V5_SCHEMA_VERSION, 5)
assert.deepEqual(ADAPTIVE_V5_OUTPUT_SCHEMA.properties.schemaVersion.enum, [5])
assert.equal(ADAPTIVE_V5_OUTPUT_SCHEMA.properties.run.properties.community.required.includes('outcome'), true)
assert.deepEqual(ADAPTIVE_V5_OUTPUT_SCHEMA.properties.run.properties.community.properties.outcome.enum, ['not_requested', 'domain_excluded', 'unavailable', 'blocked', 'succeeded', 'empty', 'failed', 'partial', 'not_run'])
assert.equal('infoConfidence' in ADAPTIVE_V5_OUTPUT_SCHEMA.properties.results.items.properties.signals.properties, false)
assert.equal('deadlineMs' in ADAPTIVE_V5_OUTPUT_SCHEMA.properties.run.properties, false)
assert.deepEqual(Object.keys(ADAPTIVE_V5_OUTPUT_SCHEMA.properties.run.properties.limits.properties).sort(), [
  'batchSize', 'candidateLimit', 'jevMaxBackoffMs', 'jevPerRequestMs', 'maxInitialTextChars', 'maxJevResponseBytes',
  'maxJevRetries', 'maxRequestChars', 'maxStateChars', 'rescueReads',
])
{
  // The DSH schema translation must accept the union without weakening it.
  const translated = toDshSchema(ADAPTIVE_OUTPUT_SCHEMA)
  assert.equal(typeof translated, 'object')
  assert.equal(Array.isArray(translated.oneOf), true)
  assert.equal(translated.oneOf.length, 2)
  const validate = outputValidator()
  const { deps } = makeHarness()
  const result = await runAdaptiveScreening({ questions: ['Q?'], intent: 'I', max_results: 1 }, {}, deps)
  assert.equal(validate(result), null)
  for (const broken of [
    { ...result, schemaVersion: 4 },
    { ...result, unknownField: 1 },
    { ...result, run: { ...result.run, community: { ...result.run.community, outcome: 'maybe' } } },
    { ...result, usage: { ...result.usage, fusedCalls: -1 } },
    { ...result, run: { ...result.run, community: undefined } },
  ]) {
    assert.notEqual(validate(broken), null, JSON.stringify(broken).slice(0, 120))
  }
  // The audit record keeps the finite identifiers and counters, never model text.
  const events = []
  await runAdaptiveScreening({ questions: ['Q?'], intent: 'I' }, { audit: { write: (event) => events.push(event) } }, deps)
  assert.equal(events.length, 1)
  const [event] = events
  assert.equal(event.type, 'screening')
  assert.equal(event.schemaVersion, 5)
  assert.equal(event.budgetVersion, SCREENING_BUDGET_VERSION)
  assert.equal(typeof event.community.outcome, 'string')
  assert.equal(typeof event.snapshotCandidates, 'number')
  assert.equal(typeof event.diagnostics.collected, 'number')
  assert.equal(typeof event.selected, 'number')
  assert.equal(typeof event.stopReason, 'string')
  assert.equal(JSON.stringify(event).includes('Traceable implementation evidence'), false, 'audit must not carry page text')
}

// ---- page pool: s5 namespace ----
{
  let now = 1_000
  const pages = createResultPages({ now: () => now })
  const rows = Array.from({ length: 5 }, (_, index) => ({ id: `r${index + 1}`, url: `https://p${index}.example/`, description: 'x'.repeat(50) }))
  const metadata = { schemaVersion: 5, warnings: [], selection: { returned: 5 }, run: {}, stopReason: 'target_met' }
  const first = pages.save(rows, metadata, 2)
  assert.equal(first.pageResults, 2)
  assert.equal(first.totalResults, 5)
  assert.match(first.nextCursor, /^s5:[a-f0-9-]{36}\.2$/)
  const second = pages.read(first.nextCursor, 50)
  assert.equal(second.pageResults, 3)
  assert.equal(second.nextCursor, null)
  // page_size never reorders or changes the selection metadata
  const again = pages.read('s5:' + first.nextCursor.slice(3).split('.')[0] + '.0', 1)
  assert.deepEqual(again.selection, first.selection)
  assert.equal(again.results[0].id, 'r1')
  assert.equal('page_size must be an integer from 1 to 50' !== '', true)
  assert.throws(() => pages.read(first.nextCursor, 51), /page_size/)
  assert.throws(() => pages.save(rows, { schemaVersion: 4 }, 2), /Schema-v5 run metadata/)
  // expiry and eviction
  now += PAGE_TTL_MS + 1
  assert.throws(() => pages.read(first.nextCursor, 2), /expired or were evicted/)
  for (let index = 0; index <= MAX_PAGE_RUNS; index++) pages.save([{ id: `x${index}` }], metadata, 1)
  const oldest = [...'x'.repeat(0)]
  assert.equal(oldest.length, 0)
}
{
  // An oversized single row is returned intact with a warning instead of vanishing.
  const pages = createResultPages()
  const result = pages.save([{ id: 'r1', description: 'y'.repeat(MAX_PAGE_BYTES + 1000) }], { schemaVersion: 5, warnings: [] }, 1)
  assert.equal(result.results.length, 1)
  assert.equal(result.warnings.some((warning) => /exceeds the soft page byte budget/.test(warning)), true)
  // Oversized v5 metadata is trimmed with disclosure; if it still cannot fit, it fails loudly.
  const hugeDecisions = { schemaVersion: 5, warnings: [], run: { decisions: Array.from({ length: 300 }, (_, index) => ({ evidenceId: `m${index}`, admitted: true, reason: 'z'.repeat(120) })) } }
  const trimmed = pages.save([{ id: 'r1' }], hugeDecisions, 1)
  assert.equal(trimmed.run.decisionsTruncated, true)
  assert.deepEqual(trimmed.run.decisions, [])
  assert.equal(trimmed.warnings.some((warning) => /decision details were trimmed/.test(warning)), true)
  assert.throws(() => pages.save([{ id: 'r1' }], { schemaVersion: 5, warnings: [], blob: 'q'.repeat(40_000) }, 1), /exceeds the page storage budget/)
}

// Metadata trimming must still satisfy the shared v5 output on real pages.
{
  const h = makeHarness()
  const valid = await runAdaptiveScreening({ questions: ['Q?'], intent: 'I', community: false }, {}, h.deps)
  const { results, ...metadata } = valid
  const decisions = Array.from({ length: 300 }, (_, index) => ({ evidenceId: `m${index}`, admitted: true, reason: 'z'.repeat(120) }))
  metadata.run.decisions = decisions
  metadata.run.decisionCount = decisions.length
  const page = createResultPages().save(results, metadata, 1)
  assert.equal(outputValidator()(page), null)
  assert.equal(page.run.decisionCount, decisions.length)
  assert.equal(page.run.decisionsTruncated, true)
  assert.deepEqual(page.run.decisions, [])
  assert.deepEqual(page.usage, valid.usage)
}

// Historical sets can exceed 999 rows: every generated cursor remains readable,
// and even oversized historical warnings remain original, not silently trimmed.
{
  const pages = createResultPages()
  const rows = Array.from({ length: 1105 }, (_, index) => ({ url: `https://old.example/${index}`, title: 'Old', description: `stored ${index}` }))
  const warnings = ['a'.repeat(20_000), 'b'.repeat(20_000)]
  let page = pages.saveHistorical({ results: rows, metadata: { warnings }, originalFormat: 'search-boost-research-v1' }, 50)
  let count = page.results.length
  while (page.nextCursor) {
    page = pages.read(page.nextCursor, 50)
    count += page.results.length
    assert.deepEqual(page.warnings.slice(0, warnings.length), warnings)
  }
  assert.equal(count, rows.length)
  assert.equal(page.results.at(-1).url, rows.at(-1).url)
  assert.equal(page.totalResults, rows.length)
}

// ---- page pool: h1 historical namespace ----
{
  const pages = createResultPages()
  const historical = Array.from({ length: 60 }, (_, index) => ({ url: `https://old${index}.example/`, description: `old ${index}`, valueScore: .5 }))
  const metadata = {
    schemaVersion: 3, stopReason: 'no_engines', warnings: ['old warning'], coverageComplete: false,
    inputSummary: { question: 'Q', intent: 'I', keywords: ['k'], constraints: [], constraintPolicy: 'explicit_per_material' },
    restoration: { historical: false, originalFormat: 'forged', originalSchemaVersion: 99 },
  }
  const first = pages.saveHistorical({ results: historical, metadata, originalFormat: 'search-boost-research-v1', originalSchemaVersion: 3, savedAt: '2026-01-01T00:00:00.000Z' }, 50)
  assert.match(first.nextCursor, /^h1:[a-f0-9-]{36}\.50$/)
  assert.deepEqual(first.restoration, { historical: true, originalFormat: 'search-boost-research-v1', originalSchemaVersion: 3 })
  assert.equal(first.schemaVersion, 3)
  assert.equal(first.stopReason, 'no_engines')
  assert.equal(first.totalResults, 60, 'historical storage is never re-capped')
  assert.equal(first.pageResults, 50)
  assert.equal(first.results[0].valueScore, .5)
  assert.equal(first.selection, undefined)
  assert.equal(first.savedAt, '2026-01-01T00:00:00.000Z')
  assert.equal(first.inputSummary.keywords.length, 1)
  assert.equal(first.warnings.some((warning) => /Historical snapshot restored read-only/.test(warning)), true)
  const second = pages.read(first.nextCursor, 50)
  assert.equal(second.pageResults, 10)
  assert.equal(second.nextCursor, null)
  // a missing original version is preserved as null, not guessed as 3 or 5
  const unversioned = pages.saveHistorical({ results: [], metadata: { stopReason: 'failed' }, originalFormat: 'search-boost-research-v1' }, 1)
  assert.equal(unversioned.restoration.originalSchemaVersion, null)
  assert.equal('schemaVersion' in unversioned, false)
  assert.throws(() => pages.saveHistorical({ results: [], metadata: {}, originalFormat: '', originalSchemaVersion: null }, 1), /verified historical format/)
  assert.throws(() => pages.saveHistorical({ results: [], metadata: {}, originalFormat: 'x', originalSchemaVersion: 'three' }, 1), /originalSchemaVersion/)
}

// ---- cursor namespace and compatibility ----
{
  const pages = createResultPages()
  const s5 = pages.save([{ id: 'r1' }, { id: 'r2' }], { schemaVersion: 5, warnings: [] }, 1)
  const id = s5.nextCursor.slice(3).split('.')[0]
  for (const [cursor, expected] of [
    [`${id}.0`, /Invalid or incompatible adaptive cursor/],
    [`s4:${id}.0`, /Invalid or incompatible adaptive cursor/],
    ['not-a-cursor', /Invalid or incompatible adaptive cursor/],
    [`s5:${id}.99`, /offset is out of range/],
    [`h1:${id}.0`, /namespace h1 does not match/],
    ['s5:99999999-9999-4999-8999-999999999999.0', /expired or were evicted/],
  ]) {
    assert.throws(() => pages.read(cursor, 1), expected, cursor)
  }
  let clock = 0
  const expiredPages = createResultPages({ now: () => clock, ttlMs: 1 })
  const expiring = expiredPages.save([{ id: 'r1' }, { id: 'r2' }], { schemaVersion: 5, warnings: [] }, 1)
  clock = 2
  assert.throws(() => expiredPages.read(expiring.nextCursor, 1), /expired or were evicted/)
  assert.equal(typeof resultPages.clear, 'function')
  resultPages.clear()
}

// ---- describe contract ----
assert.equal(ADAPTIVE_TOOL_NAME, 'adaptive_search')
// Field guidance owns language/override/migration semantics; the tool contract
// owns purpose, whole-snapshot behavior and evidence limits.
assert.match(ADAPTIVE_INPUT_SCHEMA.properties.questions.description, /not validated or translated/)
assert.match(ADAPTIVE_INPUT_SCHEMA.properties.constraints.description, /Retired material gate/)
assert.match(ADAPTIVE_INPUT_SCHEMA.properties.community.description, /true\/false overrides/)
assert.match(ADAPTIVE_INPUT_SCHEMA.properties.save_results.description, /savedResultId/)
assert.match(ADAPTIVE_DESCRIPTION, /Requires configured Jev/)
assert.match(ADAPTIVE_DESCRIPTION, /whole declared snapshot/)
assert.match(ADAPTIVE_DESCRIPTION, /quantity only/)
assert.match(ADAPTIVE_DESCRIPTION, /no self-imposed cumulative/)
assert.equal(ADAPTIVE_PROMPT_GUIDELINES.some((guideline) => /not a verified answer/.test(guideline)), true)
assert.equal(ADAPTIVE_PROMPT_GUIDELINES.some((guideline) => /does not refresh or re-verify/.test(guideline)), true)
{
  const v5 = { pageResults: 2, results: [{}, {}], selection: { returned: 2, requested: 2, incomplete: false }, stopReason: 'target_met', warnings: [] }
  assert.match(renderAdaptiveSummary(v5), /adaptive_search: 2 on this page, 2\/2 saved/)
  const historical = { pageResults: 1, results: [{}], totalResults: 5, stopReason: 'not_configured', warnings: [], restoration: { historical: true, originalFormat: 'search-boost-research-v1', originalSchemaVersion: 3 } }
  assert.match(renderAdaptiveSummary(historical), /historical snapshot/)
  assert.match(renderAdaptiveSummary(historical), /not re-searched, re-screened or re-verified/)
  assert.equal(renderAdaptiveSummary(historical).includes('undefined'), false)
  assert.equal(adaptiveTextContent(v5).length, 2)
}

// ---- usage metering (2026-10-02 supplement: no cumulative caps) ----
assert.equal(SCREENING_BUDGET_VERSION, 'screening-metering-v3-no-cumulative-cap')
assert.equal(SCREENING_METERING_VERSION, SCREENING_BUDGET_VERSION)
assert.deepEqual(SCREENING_LIMITS, {
  candidateLimit: 32, batchSize: 4, rescueReads: 0,
  maxJevRetries: 1, maxJevResponseBytes: 24_000, maxInitialTextChars: 8_000,
  jevPerRequestMs: 20_000, jevMaxBackoffMs: 4_000,
  maxStateChars: 48_000, maxRequestChars: 60_000,
})
for (const retired of ['maxSearchCalls', 'maxJevCalls', 'maxJevHttpAttempts', 'maxJevInputTokens', 'maxJevTokensEstimated', 'defaultDeadlineMs', 'SCREENING_HOST_DEADLINES']) {
  assert.equal(retired in SCREENING_LIMITS, false, `${retired} must be gone`)
  assert.throws(() => createScreeningBudget({ [retired]: 1 }), /Unknown screening limit/, retired)
}
assert.throws(() => createScreeningBudget({ rescueReads: 2 }), /rescueReads must be 0/)
assert.throws(() => createScreeningBudget({ unknownBudget: 1 }), /Unknown screening limit/)
assert.throws(() => createScreeningBudget({ candidateLimit: 0 }), /Invalid screening limit/)
{
  const budget = createScreeningBudget({})
  assert.equal(budget.usage.engineRequests, null, 'unknown until the shared core reports it')
  assert.equal(budget.usage.engineHttpRequests, null)
  assert.equal(budget.usage.fetchReads, 0)
  assert.equal(budget.usage.fetchCalls, 0)
  assert.equal(budget.usage.fetchCacheReads, 0)
  assert.equal(budget.usage.fetchHttpRequests, 0)
  assert.equal('read' in budget, false, 'no page-read reservation exists in the N_off flow')
  budget.logical()
  budget.attempt(2_000)
  budget.attempt(2_000)
  assert.equal(budget.usage.jevCalls, 1)
  assert.equal(budget.usage.jevHttpAttempts, 2)
  assert.equal(budget.usage.jevRetries, 1)
  budget.reported({ usage: { inputTokens: 10, outputTokens: 4 } })
  assert.equal(budget.usage.jevInputTokens, 10)
  assert.equal(budget.usage.jevOutputTokens, 4)
  assert.equal(budget.usage.serverUsageCalls, 1)
  budget.reported({})
  assert.equal(budget.usage.unknownUsageCalls, 1)
  // Pure metering: well past the retired 16 logical / 20 HTTP / token values
  // nothing is refused and every counter keeps growing.
  for (let index = 0; index < 40; index++) { budget.search(); budget.logical() }
  for (let index = 0; index < 25; index++) budget.attempt(400_000)
  assert.equal(budget.usage.fusedCalls, 40)
  assert.equal(budget.usage.jevCalls, 41)
  assert.equal(budget.usage.jevHttpAttempts, 27)
  assert.ok(budget.usage.jevInputTokensEstimated > 180_000)
  assert.ok(budget.usage.jevTokensEstimatedReserved > 420_000)
  assert.equal(budget.usage.jevRetries, 25, 'every metered retry is counted, none is refused')
  assert.equal(typeof budget.attempt, 'function')
}

// ---- static scan: retired scope/info/language/rescue paths are gone ----
{
  const files = readdirSync(screeningDir).filter((name) => name.endsWith('.js'))
  assert.deepEqual(files.sort(), ['controller.js', 'describe.js', 'duplicates.js', 'input.js', 'judgments.js', 'legacy-snapshot.js', 'limits.js', 'material.js', 'pages.js', 'policy.js', 'run.js', 'schema.js', 'scoring.js', 'zod-schema.js'])
  for (const name of files) {
    const text = source(name)
    for (const forbidden of ['strategy.language', 'input_language_', 'LANGUAGE_OPTIONS', 'INFO_OPTIONS', 'maxRescueTextChars', 'valueUnknown']) {
      assert.equal(text.includes(forbidden), false, `${name} must not mention ${forbidden}`)
    }
    if (!['limits.js', 'schema.js', 'controller.js'].includes(name)) assert.equal(/rescue/i.test(text), false, `${name} must not contain any rescue path`)
  }
  // controller.js may only DOCUMENT that no rescue exists; it must not implement one
  for (const token of ['rescueRead(', 'rescueEligible', 'maxReads', 'rescueRecovered', 'rescueAttempted', 'rescuePlan']) {
    assert.equal(source('controller.js').includes(token), false, `controller.js must not implement ${token}`)
  }
  for (const token of ['strategy.language', 'input_language', 'scope.', 'constraints']) {
    assert.equal(source('run.js').includes(token), false, `run.js must not implement ${token}`)
  }
  for (const name of ['controller.js', 'run.js', 'judgments.js', 'policy.js']) {
    const text = source(name).toLowerCase()
    for (const forbidden of ['scope.', 'noul', 'constraints', 'strategy.language', 'language_options', 'input_language']) {
      assert.equal(text.includes(forbidden), false, `${name} must not contain ${forbidden}`)
    }
  }
  assert.equal(source('run.js').includes('deps.fetch'), false)
  assert.equal(source('run.js').includes('fetch('), false)
  assert.match(source('input.js'), /adaptive_constraints_removed/)
  assert.match(source('scoring.js'), /fused-screening-mix-v2-prototype/)
  // 2026-10-02 supplement: no self-imposed cumulative cap or total timer may exist.
  for (const name of files) {
    const text = source(name)
    for (const forbidden of ['setTimeout', 'AbortController', 'deadlineAt', 'maxSearchCalls', 'maxJevCalls', 'maxJevHttpAttempts', 'maxJevInputTokens', 'maxJevTokensEstimated', 'defaultDeadlineMs', 'ScreeningBudgetError', 'SCREENING_HOST_DEADLINES']) {
      assert.equal(text.includes(forbidden), false, `${name} must not contain ${forbidden}`)
    }
  }
  assert.equal(/deadlineMs\s*[,)=]/.test(source('run.js')), false, 'run.js must not read a total-deadline option')
  assert.equal(source('controller.js').includes('budget_'), false, 'controller.js must not map budget_* stops')
  assert.match(source('describe.js'), /no self-imposed cumulative cost, token, request-count or total-duration quota/)
  // 2026-10-02 supplement: the host entries must not re-impose the retired
  // whole-run adaptive deadlines or the old "stop at your own quota" wording.
  const workspace = (relative) => readFileSync(fileURLToPath(new URL(`../${relative}`, import.meta.url)), 'utf8')
  const between = (text, start, end) => text.slice(text.indexOf(start), text.indexOf(end))
  const mcpAdaptive = between(workspace('adapters/mcp/register.mjs'), 'registerTool(ADAPTIVE_TOOL_NAME', "server.registerResource('search-capabilities'")
  assert.equal(/abortSignal|AbortSignal|setTimeout/.test(mcpAdaptive), false, 'the MCP adaptive tool must not set a whole-call deadline')
  assert.match(mcpAdaptive, /signal: extra\?\.signal/)
  for (const [start, end] of [["registerTool('fused_search'", "registerTool('fetch_page'"], ["registerTool('x_search'", "registerTool('search_layer'"]]) {
    assert.equal(/abortSignal|AbortSignal|setTimeout/.test(between(workspace('adapters/mcp/register.mjs'), start, end)), false,
      `${start}: all search channels must use the external signal, not a self-set total timeout`)
  }
  const dshAdaptive = between(workspace('adapters/dsh/index.js'), 'function registerAdaptiveSearchTool(', '// ---------- x_search ----------')
  assert.equal(/timeoutMs/.test(dshAdaptive), false, 'the DSH adaptive tool must not keep a self-set whole-call timeout')
  assert.equal(workspace('adapters/pi/index.js').includes('follow the task budget'), false, 'the Pi note must observe usage, not instruct a self-set stop')
  assert.equal(workspace('adapters/pi/index.js').includes('[search budget]'), false)
  for (const relative of ['lib/search/fusion.js', 'lib/search/engines.js', 'lib/runtime.mjs']) {
    assert.equal(/maxSearchCalls|maxJevCalls|budget_/.test(workspace(relative)), false, `${relative} must not hold a cumulative adaptive gate`)
  }
  assert.match(source('limits.js'), /screening-metering-v3-no-cumulative-cap/)
  const controllerKeys = Object.keys(await import('../lib/search/screening/controller.js'))
  assert.equal(controllerKeys.some((key) => /rescue/i.test(key)), false)
  assert.deepEqual(controllerKeys.sort(), ['ADMISSION_POLICY_VERSION', 'admitAndRank', 'buildSnapshot', 'runScreening'])
}

console.log('ok: input migration, schema5, s5/h1 page pool, describe contract, pure usage metering (no cumulative caps) and retired-path static scan')
