import './isolate-tests.mjs'
// N_off adaptive flow: strict input migration, the fixed ranking/community
// strategy, zero-language behaviour, snapshot wiring, budget hook, persistence
// and pagination. Offline fixtures only; the shared fused/community core is
// injected through the documented dependency contract.
import assert from 'node:assert/strict'
import { runAdaptiveScreening, prepareMaterial, RANKING_PRESETS, SAVED_FORMAT_V1 } from '../lib/search/screening/run.js'
import { resultPages } from '../lib/search/screening/pages.js'
import { createScreeningBudget, SCREENING_BUDGET_VERSION, SCREENING_LIMITS } from '../lib/search/screening/limits.js'
import { forbiddenDeps, makeHarness, outputValidator, FIXTURE_SAVED_ID, fixtureRows } from './screening-run-fixture.mjs'

const validateOutput = outputValidator()
const NEW_INPUT = { questions: ['How does Node.js fetch support cancellation?'], intent: 'Find traceable implementation evidence', preferences: ['Implementation details'], max_results: 2, page_size: 2 }

let tests = 0
async function test(name, fn) { resultPages.clear(); await fn(); tests++; console.log(`ok: ${name}`) }

await test('strict input migration rejects legacy, malformed and mixed read inputs with zero dependency calls', async () => {
  const cases = [
    [{ questions: ['Q?'], intent: 'I', keywords: [] }, /Unsupported adaptive input field: keywords/],
    [{ questions: ['Q?'], intent: 'I', tasks: [] }, /Unsupported adaptive input field: tasks/],
    [{ questions: ['Q?'], intent: 'I', targets: [], facts: [], time_range: {} }, /Unsupported adaptive input field: targets/],
    [{ questions: ['Q?'] }, /intent is required/],
    [{ questions: ['Q?', 'Q2?'], intent: 'I' }, /exactly one nonblank question/],
    [{ questions: [], intent: 'I' }, /exactly one nonblank question/],
    [{ questions: ['Q?'], intent: 'I', max_results: 51 }, /max_results must be an integer from 1 to 50/],
    [{ questions: ['Q?'], intent: 'I', page_size: 0 }, /page_size must be an integer from 1 to 50/],
    [{ questions: ['Q?'], intent: 'I', community: 'auto' }, /community must be a boolean/],
    [{ questions: ['Q?'], intent: 'I', community: null }, /community must be a boolean/],
    [{ questions: ['Q?'], intent: 'I', community: 1 }, /community must be a boolean/],
    [{ questions: ['Q?'], intent: 'I', community: [0, 1] }, /community must be a boolean/],
    [{ questions: ['Q?'], intent: 'I', community: ['x', 'x'] }, /community must be a boolean/],
    [{ questions: ['Q?'], intent: 'I', save_results: 'yes' }, /save_results must be a strict boolean/],
    [{ questions: ['Q?'], intent: 'I', constraints: 'x' }, /constraints must contain 0-8 nonblank clauses/],
    [{ questions: ['Q?'], intent: 'I', constraints: [''] }, /constraints must contain 0-8 nonblank clauses/],
    [{ questions: ['Q?'], intent: 'I', constraints: ['Must be v22'] }, /adaptive_constraints_removed/],
    [{ questions: ['Q?'], intent: 'I', preferences: Array.from({ length: 9 }, (_, i) => `p${i}`) }, /preferences must contain 0-8/],
    [{ saved_result_id: 'nope', page_size: 5 }, /Invalid saved research result ID/],
    [{ cursor: 's6:x.0', saved_result_id: FIXTURE_SAVED_ID }, /cannot be combined/],
    [{ cursor: 's6:x.0', intent: 'I' }, /accepts page_size only/],
    [{ saved_result_id: FIXTURE_SAVED_ID, save_results: false }, /accepts page_size only/],
    [{ saved_result_id: FIXTURE_SAVED_ID, constraints: [] }, /accepts page_size only/],
    [{ saved_result_id: FIXTURE_SAVED_ID, community: false }, /accepts page_size only/],
  ]
  for (const [input, expected] of cases) {
    await assert.rejects(runAdaptiveScreening(input, { signal: new AbortController().signal }, forbiddenDeps), expected)
  }
  // Explicit false must be detected by presence, not by truthiness.
  const explicit = (await import('../lib/search/screening/input.js')).normalizeAdaptiveInput({ questions: ['Q?'], intent: 'I', community: false })
  assert.equal(explicit.communityExplicit, true)
  assert.equal(explicit.community, false)
  const omitted = (await import('../lib/search/screening/input.js')).normalizeAdaptiveInput({ questions: ['Q?'], intent: 'I' })
  assert.equal(omitted.communityExplicit, false)
  assert.equal(omitted.community, undefined)
  // constraints [] alone runs the same flow with a migration warning
  const h = makeHarness()
  const empty = await runAdaptiveScreening({ ...NEW_INPUT, constraints: [] }, {}, h.deps)
  assert.equal(h.calls.search.length, 1)
  assert.equal(empty.warnings.some((warning) => warning.startsWith('deprecated_constraints_empty')), true)
  assert.equal(validateOutput(empty), null)
  // Invalid input must not touch even the optional persistence seam.
  await assert.rejects(runAdaptiveScreening({ questions: ['Q?'] }, {}, forbiddenDeps), /intent is required/)
})

await test('explicit community false asks only the ranking question and keeps the schema-v5 contract', async () => {
  const h = makeHarness()
  const result = await runAdaptiveScreening({ ...NEW_INPUT, community: false, page_size: 1 }, { host: 'mcp' }, h.deps)
  assert.equal(validateOutput(result), null)
  assert.equal(result.schemaVersion, 6)
  assert.equal(result.policyVersion, 'fused-screening-mix-v2-prototype')
  assert.equal(result.judgementPolicyVersion, 'screening-judgement-v4-no-scope-no-language')
  assert.equal(result.strategyPolicyVersion, 'screening-strategy-v2-community-no-language')
  assert.equal(result.admissionPolicyVersion, 'no-scope-v1')
  assert.deepEqual(Object.keys(h.calls.jev[0].request.questions), ['strategy.ranking'])
  assert.equal(h.calls.jev[0].request.state.question, NEW_INPUT.questions[0])
  assert.equal(h.calls.jev[0].request.state.intent, NEW_INPUT.intent)
  assert.deepEqual(Object.keys(h.calls.jev[0].request.state.presets), Object.keys(RANKING_PRESETS))
  const [search] = h.calls.search
  assert.equal(search.args.candidateSelection, 'snapshot')
  assert.equal(search.args.complexity, 'medium')
  assert.equal(search.args.maxResults, 32)
  assert.equal(search.args.maxResultsCap, 32)
  assert.equal(search.args.community, false)
  assert.equal(search.args.query, NEW_INPUT.questions[0])
  assert.deepEqual(result.run.community, { input: false, source: 'explicit', choice: null, requested: false, effective: false, outcome: 'not_requested', cacheHit: false, reason: null, usage: { logicalOperations: 0 } })
  assert.equal(result.run.ranking, 'research')
  assert.equal(result.selection.returned, 2)
  assert.equal(result.pageResults, 1)
  assert.equal(result.totalResults, 2)
  assert.match(result.nextCursor, /^s6:[a-f0-9-]{36}\.\d+$/)
  assert.equal(result.diagnostics.collected, h.rows.length)
  assert.equal(result.diagnostics.snapshotCandidates, h.rows.length)
  assert.equal(result.diagnostics.outsideReview, 0)
  assert.equal(result.diagnostics.safetyUnavailable, 0)
  assert.equal(result.usage.fusedCalls, 1)
  assert.equal(result.usage.engineRequests, 1)
  assert.equal(result.usage.fetchReads, 0)
  assert.equal(result.usage.fetchCalls, 0)
  assert.equal(result.usage.fetchCacheReads, 0)
  assert.equal(result.usage.fetchHttpRequests, 0)
  assert.equal(result.usage.jevCalls, 2)
  assert.equal(result.inputSummary.community, false)
  assert.deepEqual(result.valueGroups[5], ['r1', 'r2'], 'valueGroups indexes the whole selected set, not just this page')
  // pagination: identical decision, no new call, page_size never reorders
  const jevBefore = h.calls.jev.length
  const page = await runAdaptiveScreening({ cursor: result.nextCursor, page_size: 3 }, {}, h.deps)
  assert.equal(h.calls.jev.length, jevBefore)
  assert.equal(h.calls.search.length, 1)
  assert.deepEqual(page.selection, result.selection)
  assert.equal(page.totalResults, 2)
  assert.equal(page.results.length, 1)
  assert.equal(page.nextCursor, null)
  assert.equal(page.results[0].rank, 2)
})

await test('omitted community is decided by the same strategy request', async () => {
  const h = makeHarness({ answer: { community: 'enable' } })
  const result = await runAdaptiveScreening(NEW_INPUT, {}, h.deps)
  assert.deepEqual(Object.keys(h.calls.jev[0].request.questions).sort(), ['strategy.community', 'strategy.ranking'])
  assert.deepEqual(Object.keys(h.calls.jev[0].request.questions['strategy.community'].criteria).sort(), ['disable', 'enable', 'unknown'])
  assert.equal(Object.keys(h.calls.jev[0].request.questions).length, 2)
  assert.equal(h.calls.search[0].args.community, true)
  assert.deepEqual(result.run.strategy.community, { state: 'selected', choice: 'enable' })
  assert.deepEqual(result.run.community, {
    input: 'auto', source: 'judge', choice: 'enable', requested: true, effective: true,
    outcome: 'succeeded', cacheHit: false, reason: null, usage: { logicalOperations: 1, providerRequests: 2 },
  })
  assert.equal(result.selection.incomplete, false)
  assert.equal(result.usage.jevCalls, 2)
  assert.equal(validateOutput(result), null)
})

await test('unknown community answer falls back to no community branch and stays disclosed', async () => {
  const h = makeHarness({ answer: { community: 'unknown' } })
  const result = await runAdaptiveScreening(NEW_INPUT, {}, h.deps)
  assert.equal(h.calls.search[0].args.community, false)
  assert.deepEqual(result.run.strategy.community, { state: 'selected', choice: 'unknown' })
  assert.equal(result.run.community.choice, 'unknown')
  assert.equal(result.run.community.requested, false)
  assert.equal(result.run.community.outcome, 'not_requested')
  assert.equal(result.selection.incomplete, false)
  assert.equal(result.warnings.some((warning) => /community choice unknown/.test(warning)), true)
  assert.equal(validateOutput(result), null)
})

await test('missing community answer is unavailable, never a fabricated model disable', async () => {
  const h = makeHarness({ answer: (request) => (Object.keys(request.questions).includes('strategy.community') ? null : {}) })
  const result = await runAdaptiveScreening(NEW_INPUT, {}, h.deps)
  assert.deepEqual(result.run.strategy.community, { state: 'unavailable', choice: 'unavailable' })
  assert.deepEqual([result.run.community.choice, result.run.community.requested, result.run.community.reason], ['unavailable', false, 'community_answer_unavailable'])
  assert.equal(result.warnings.some((warning) => /community answer missing or invalid/.test(warning)), true)
  assert.equal(result.selection.incomplete, false)
  assert.equal(validateOutput(result), null)
})

await test('community execution states drive incomplete and stopReason honestly', async () => {
  for (const outcome of ['succeeded', 'empty', 'domain_excluded', 'not_requested']) {
    const h = makeHarness({ answer: { community: 'enable' }, searchResult: { communityExecution: { requested: true, effective: outcome !== 'domain_excluded', outcome, cacheHit: false, reason: outcome === 'domain_excluded' ? 'domain_filter' : null, usage: null } } })
    const result = await runAdaptiveScreening(NEW_INPUT, {}, h.deps)
    assert.equal(result.run.community.outcome, outcome)
    assert.equal(result.selection.incomplete, false, outcome)
    assert.equal(result.run.community.usage === null || typeof result.run.community.usage === 'object', true, outcome)
    assert.equal(validateOutput(result), null)
  }
  for (const outcome of ['unavailable', 'blocked', 'failed', 'partial']) {
    const h = makeHarness({ answer: { community: 'enable' }, searchResult: { communityExecution: { requested: true, effective: false, outcome, cacheHit: true, reason: 'provider_rejected', usage: { logicalOperations: 1, providerRequests: null } } } })
    const result = await runAdaptiveScreening(NEW_INPUT, {}, h.deps)
    assert.equal(result.run.community.outcome, outcome)
    assert.equal(result.selection.incomplete, true, outcome)
    assert.equal(result.stopReason, 'community_incomplete')
    assert.equal(result.results.length, 2, 'valid web results are still delivered')
    assert.equal(result.run.community.cacheHit, true)
    assert.deepEqual(result.run.community.usage, { logicalOperations: 1, providerRequests: null })
    assert.equal(result.warnings.some((warning) => /community branch did not complete/.test(warning)), true)
    assert.equal(validateOutput(result), null)
  }
  // A missing execution report never claims success, and never claims failure.
  const missing = makeHarness({ answer: { community: 'enable' }, searchResult: { communityExecution: undefined } })
  const result = await runAdaptiveScreening(NEW_INPUT, {}, missing.deps)
  assert.deepEqual([result.run.community.outcome, result.run.community.reason], ['not_run', 'community_status_unavailable'])
  assert.deepEqual(result.run.community.usage, {})
  assert.equal(result.selection.incomplete, false)
  assert.equal(result.warnings.some((warning) => /community execution status unavailable/.test(warning)), true)
  assert.equal(validateOutput(result), null)
})

await test('a non-English question and intent run the same strategy and original-text search', async () => {
  const input = { questions: ['Node.js 22 或 24 如何取消 fetch？排除实验性 API。'], intent: '查找可追溯的实现与限制，保留版本差异。', max_results: 1 }
  const h = makeHarness()
  const result = await runAdaptiveScreening(input, {}, h.deps)
  assert.equal(h.calls.jev[0].request.state.question, input.questions[0])
  assert.equal(h.calls.jev[0].request.state.intent, input.intent)
  assert.equal(h.calls.search[0].args.query, input.questions[0])
  assert.equal(Object.keys(h.calls.jev[0].request.questions).some((id) => /language/i.test(id)), false)
  assert.equal(result.results.length, 1)
  assert.equal(validateOutput(result), null)
})

await test('service failures stay honest: not_configured, no_engines, strategy and search failures', async () => {
  const unconfigured = makeHarness({ config: { apiKey: '', baseUrl: 'https://jev.fixture.invalid' } })
  const notConfigured = await runAdaptiveScreening(NEW_INPUT, {}, unconfigured.deps)
  assert.equal(notConfigured.stopReason, 'not_configured')
  assert.equal(notConfigured.selection.incomplete, true)
  assert.equal(notConfigured.error, 'not_configured')
  assert.equal(unconfigured.calls.jev.length, 0)
  assert.equal(unconfigured.calls.search.length, 0)
  assert.deepEqual([notConfigured.run.community.requested, notConfigured.run.community.outcome], [null, 'not_run'])
  assert.equal(validateOutput(notConfigured), null)

  const noEngines = makeHarness({ route: () => ({ engineNames: [] }) })
  const emptyRoute = await runAdaptiveScreening(NEW_INPUT, {}, noEngines.deps)
  assert.equal(emptyRoute.stopReason, 'no_engines')
  assert.equal(noEngines.calls.jev.length, 0)

  const strategyFailure = makeHarness({ failAt: 1, failKind: 'timeout' })
  const timedOut = await runAdaptiveScreening(NEW_INPUT, {}, strategyFailure.deps)
  assert.equal(timedOut.stopReason, 'timeout')
  assert.equal(strategyFailure.calls.search.length, 0)
  assert.deepEqual([timedOut.run.community.choice, timedOut.run.community.requested, timedOut.run.community.outcome], ['unavailable', null, 'not_run'])
  assert.equal(validateOutput(timedOut), null)

  const searchFailure = makeHarness({ searchError: Object.assign(new Error('engine outage'), { kind: 'network' }) })
  const failedSearch = await runAdaptiveScreening(NEW_INPUT, {}, searchFailure.deps)
  assert.equal(failedSearch.stopReason, 'network')
  assert.equal(failedSearch.selection.incomplete, true)
  assert.equal(failedSearch.results.length, 0)
  assert.equal(validateOutput(failedSearch), null)
})

await test('usage is metered, never enforced: exceeding the retired 16/20/cumulative-token values still completes', async () => {
  const one = makeHarness()
  await runAdaptiveScreening(NEW_INPUT, {}, one.deps)
  assert.equal(typeof one.calls.clientConfig.beforeAttempt, 'function')
  // A meter counts every attempt and never refuses the next one.
  const meter = createScreeningBudget({})
  for (let index = 0; index < 25; index++) meter.attempt(1_000_000)
  for (let index = 0; index < 40; index++) { meter.logical(); meter.search() }
  assert.equal(meter.usage.jevHttpAttempts, 25, 'well past the retired 20-attempt cap')
  assert.equal(meter.usage.jevCalls, 40, 'well past the retired 16-logical-call cap')
  assert.equal(meter.usage.fusedCalls, 40)
  assert.ok(meter.usage.jevInputTokensEstimated > 180_000, 'past the retired input-token reservation value')
  assert.ok(meter.usage.jevTokensEstimatedReserved > 420_000, 'past the retired total-token reservation value')
  assert.equal('maxJevHttpAttempts' in meter.limits, false)
  assert.equal('maxJevCalls' in meter.limits, false)
  assert.equal('maxSearchCalls' in meter.limits, false)
  assert.equal('maxJevInputTokens' in meter.limits, false)
  assert.equal('maxJevTokensEstimated' in meter.limits, false)
  assert.equal('defaultDeadlineMs' in meter.limits, false)
  assert.equal(meter.usage.fetchReads, 0)
  assert.equal(meter.usage.fetchCalls, 0)
  assert.equal(meter.usage.fetchCacheReads, 0)
  assert.equal(meter.usage.fetchHttpRequests, 0)
  // Flow level: 3 HTTP attempts (2 retries) x 7 questions exceeds the retired
  // 20-attempt value, and every declared candidate is still reviewed.
  const retried = makeHarness({ attempts: 3, rows: fixtureRows(24) })
  const retriedRun = await runAdaptiveScreening(NEW_INPUT, {}, retried.deps)
  assert.equal(retriedRun.usage.jevHttpAttempts, 21)
  assert.ok(retriedRun.usage.jevRetries > 0)
  assert.equal(retriedRun.diagnostics.collected, 24)
  assert.equal(retriedRun.diagnostics.requestTooLarge, 0)
  assert.equal(retriedRun.selection.incomplete, false)
  assert.equal(retriedRun.stopReason, 'target_met')
  assert.equal(retriedRun.warnings.some((warning) => /budget/i.test(warning)), false)
  assert.equal(String(retriedRun.stopReason).startsWith('budget_'), false)
  assert.equal(String(retriedRun.run.halted ?? '').startsWith('budget_'), false)
  assert.equal(validateOutput(retriedRun), null)
  // The same holds when the community (X/fallback) branch is enabled: usage
  // growth never blocks the web + community review.
  const withCommunity = makeHarness({ attempts: 3, rows: fixtureRows(24), answer: { community: 'enable' } })
  const communityRun = await runAdaptiveScreening(NEW_INPUT, {}, withCommunity.deps)
  assert.equal(withCommunity.calls.search[0].args.community, true)
  assert.equal(communityRun.usage.jevHttpAttempts, 21)
  assert.equal(communityRun.run.community.outcome, 'succeeded')
  assert.equal(communityRun.diagnostics.collected, 24)
  assert.equal(communityRun.selection.incomplete, false)
  assert.equal(validateOutput(communityRun), null)
  // Past the retired token reservation values in a real run: the oversized
  // attempt sizes are metered, and the run still finishes.
  const huge = makeHarness({ attempts: 2, attemptChars: 400_000, rows: fixtureRows(4) })
  const hugeRun = await runAdaptiveScreening(NEW_INPUT, {}, huge.deps)
  assert.ok(hugeRun.usage.jevInputTokensEstimated > 180_000)
  assert.ok(hugeRun.usage.jevTokensEstimatedReserved > 420_000)
  assert.equal(hugeRun.results.length, 2)
  assert.equal(hugeRun.selection.incomplete, false)
  // More than the retired 16 logical Jev calls: one strategy plus 20 batches.
  const many = makeHarness({ rows: fixtureRows(20) })
  const manyRun = await runAdaptiveScreening(NEW_INPUT, { limits: { batchSize: 1 } }, many.deps)
  assert.equal(manyRun.usage.jevCalls, 21)
  assert.equal(many.calls.jev.length, 21)
  assert.equal(manyRun.diagnostics.collected, 20)
  assert.ok(manyRun.results.length > 0)
  assert.equal(validateOutput(manyRun), null)
  // The hook is invoked BEFORE each attempt and receives the request size.
  const seen = []
  const harness = makeHarness()
  const baseClient = harness.deps.createClient
  harness.deps.createClient = (config) => {
    const client = baseClient(config)
    return { ...client, ask: async (request) => { config.beforeAttempt(1234); seen.push(request.phase); return client.ask(request) } }
  }
  await runAdaptiveScreening(NEW_INPUT, {}, harness.deps)
  assert.deepEqual(seen, ['strategy', 'screening'])
  assert.equal(SCREENING_BUDGET_VERSION, 'screening-metering-v3-no-cumulative-cap')
})

await test('crossing the retired 120/150-second total durations still continues; only signal cancels', async () => {
  const realNow = Date.now
  let now = 1_000
  Date.now = () => now
  try {
    for (const host of ['mcp', 'pi', 'dsh']) {
      now = 1_000
      const h = makeHarness({ rows: fixtureRows(8) })
      const base = h.deps.createClient
      h.deps.createClient = (config) => {
        const client = base(config)
        return { ...client, ask: async (request) => { now += 90_000; return client.ask(request) } }
      }
      const result = await runAdaptiveScreening({ ...NEW_INPUT, max_results: 4, page_size: 4 }, { host }, h.deps)
      assert.ok(now - 1_000 > 150_000, `${host}: simulated wall clock must pass the retired 120/150s cap`)
      assert.equal(result.stopReason, 'target_met')
      assert.equal(result.selection.incomplete, false)
      assert.equal(result.results.length, 4)
      assert.equal('deadlineMs' in result.run, false)
      assert.equal(result.warnings.some((warning) => /deadline|budget/i.test(warning)), false)
      assert.equal(validateOutput(result), null)
    }
  } finally { Date.now = realNow }
  // Cancellation still stops the work through the external signal only.
  const abort = new AbortController()
  let calls = 0
  const h = makeHarness({
    rows: fixtureRows(8),
    answer: (request) => { if (request.phase === 'screening' && ++calls === 2) abort.abort(); return {} },
  })
  const cancelled = await runAdaptiveScreening({ ...NEW_INPUT, max_results: 8 }, { signal: abort.signal }, h.deps)
  assert.equal(cancelled.stopReason, 'cancelled')
  assert.equal(cancelled.selection.incomplete, true)
  assert.equal(cancelled.savedResultId, undefined)
})

await test('real per-request timeout and limited retries survive; other callers keep the generic hook', async () => {
  const { createJevClient } = await import('../lib/jev/client.mjs')
  const timeoutHarness = makeHarness()
  const base = timeoutHarness.deps.createClient
  timeoutHarness.deps.createClient = (config) => createJevClient({
    ...config,
    perRequestMs: 30,
    maxRetries: 0,
    sleep: async () => {},
    // The abort timer in AbortSignal.timeout is unref'ed, so the fixture keeps
    // one ref'ed timer alive the way a real socket would.
    fetchImpl: (_url, init) => new Promise((_resolve, reject) => {
      const keep = setTimeout(() => {}, 60_000)
      const fail = () => { clearTimeout(keep); reject(Object.assign(new Error('aborted'), { name: 'TimeoutError' })) }
      if (init.signal?.aborted) return fail()
      init.signal?.addEventListener('abort', fail, { once: true })
    }),
  })
  const timedOut = await runAdaptiveScreening(NEW_INPUT, {}, timeoutHarness.deps)
  assert.equal(timedOut.stopReason, 'timeout', 'the per-request timeout still protects a hung request')
  assert.equal(timedOut.selection.incomplete, true)
  assert.equal(timeoutHarness.calls.search.length, 0)
  assert.equal(validateOutput(timedOut), null)
  // The run hands the real retry/capacity configuration to the client.
  const configured = makeHarness()
  await runAdaptiveScreening(NEW_INPUT, {}, configured.deps)
  assert.equal(configured.calls.clientConfig.maxRetries, 1)
  assert.equal(configured.calls.clientConfig.perRequestMs, 20_000)
  assert.equal(configured.calls.clientConfig.maxRequestChars, 60_000)
  assert.equal(configured.calls.clientConfig.maxResponseBytes, 24_000)
  assert.equal(base.length, 1, 'the harness client factory is still the default one elsewhere')
})

await test('save_results persists the complete selected set before page trimming and restores without Jev', async () => {
  const h = makeHarness({ rows: fixtureRows(6) })
  const result = await runAdaptiveScreening({ ...NEW_INPUT, max_results: 5, page_size: 2, save_results: true }, {}, h.deps)
  assert.equal(result.savedResultId, FIXTURE_SAVED_ID)
  assert.equal(h.calls.save.length, 1)
  const saved = h.calls.save[0]
  assert.equal(saved.results.length, 5, 'the full selected set is saved, not the first page')
  assert.equal(saved.metadata.schemaVersion, 6)
  assert.equal(saved.metadata.run.community.input, 'auto')
  assert.equal(Array.isArray(saved.metadata.run.decisions), true)
  assert.deepEqual(saved.metadata.inputSummary, { question: NEW_INPUT.questions[0], intent: NEW_INPUT.intent, preferences: NEW_INPUT.preferences, community: 'auto', maxResults: 5 })
  assert.equal(result.saveCalls, undefined)
  const jevBefore = h.calls.jev.length
  const restored = await runAdaptiveScreening({ saved_result_id: FIXTURE_SAVED_ID, page_size: 1 }, {}, h.deps)
  assert.deepEqual(h.calls.load, [FIXTURE_SAVED_ID])
  assert.equal(h.calls.jev.length, jevBefore, 'restoring never asks Jev again')
  assert.equal(h.calls.search.length, 1, 'restoring never searches again')
  assert.equal(restored.schemaVersion, 6)
  assert.equal(restored.savedResultId, FIXTURE_SAVED_ID)
  assert.deepEqual(restored.selection, result.selection)
  assert.deepEqual(restored.run.community, result.run.community, 'a v2 restore keeps the original community decision/execution state')
  assert.equal(restored.strategyPolicyVersion, result.strategyPolicyVersion)
  assert.equal(restored.inputSummary.community, 'auto')
  assert.equal(restored.totalResults, 5)
  assert.equal(restored.pageResults, 1)
  assert.match(restored.nextCursor, /^s6:/)
  assert.equal(restored.results[0].url, result.results[0].url)
  assert.equal(validateOutput(restored), null)
  // default: no save at all
  const quiet = makeHarness()
  const withoutSave = await runAdaptiveScreening(NEW_INPUT, {}, quiet.deps)
  assert.equal(quiet.calls.save.length, 0)
  assert.equal(withoutSave.savedResultId, undefined)
  // save failure keeps the computed results and adds a bounded warning
  const failing = makeHarness({ saveResults: () => { throw new Error('private store unavailable') } })
  const failedSave = await runAdaptiveScreening({ ...NEW_INPUT, save_results: true }, {}, failing.deps)
  assert.equal(failedSave.savedResultId, undefined)
  assert.equal(failedSave.results.length, 2)
  assert.equal(failedSave.warnings.some((warning) => /were NOT saved/.test(warning)), true)
  assert.equal(validateOutput(failedSave), null)
  const noPersistence = makeHarness({ persist: false })
  const unavailable = await runAdaptiveScreening({ ...NEW_INPUT, save_results: true }, {}, noPersistence.deps)
  assert.equal(unavailable.savedResultId, undefined)
  assert.equal(unavailable.warnings.some((warning) => /were NOT saved/.test(warning)), true)
})

await test('cancellation never returns a success ID', async () => {
  const abort = new AbortController()
  let screeningCalls = 0
  const h = makeHarness({
    rows: fixtureRows(8),
    answer: (request) => {
      if (request.phase === 'screening' && ++screeningCalls === 2) abort.abort()
      return {}
    },
  })
  const result = await runAdaptiveScreening({ ...NEW_INPUT, max_results: 8, save_results: true }, { signal: abort.signal }, h.deps)
  assert.equal(result.stopReason, 'cancelled')
  assert.equal(result.savedResultId, undefined)
  assert.equal(h.calls.save.length, 0)
  assert.equal(result.warnings.some((warning) => /NOT saved because this call was cancelled/.test(warning)), true)
  assert.equal(result.selection.incomplete, true)
  assert.equal(validateOutput(result), null)
})

await test('historical v1 snapshots restore read-only with an h1 page and no invented v5 fields', async () => {
  const historicalResults = Array.from({ length: 60 }, (_, index) => ({ url: `https://old${index}.example/p`, title: `Old ${index}`, description: `old excerpt ${index}`, valueScore: 0.5, tier: 'supporting' }))
  const metadata = {
    schemaVersion: 3, stopReason: 'not_configured', coverageComplete: false, retrievalSufficient: false,
    inputSummary: { question: 'Old question', intent: 'Old intent', keywords: ['old'], constraints: [], constraintPolicy: 'explicit_per_material' },
    keywordProgress: [{ keyword: 'old', score: 1, distinctEvidence: 2, finalStatus: 'continue' }],
    warnings: ['historical warning'],
  }
  const h = makeHarness({ loadResults: (id) => { h.calls.load.push(id); return { format: SAVED_FORMAT_V1, schemaVersion: 3, savedAt: '2026-01-01T00:00:00.000Z', results: historicalResults, metadata } } })
  const restored = await runAdaptiveScreening({ saved_result_id: FIXTURE_SAVED_ID, page_size: 50 }, {}, h.deps)
  assert.deepEqual(restored.restoration, { historical: true, originalFormat: SAVED_FORMAT_V1, originalSchemaVersion: 3 })
  assert.equal(restored.schemaVersion, 3)
  assert.equal(restored.stopReason, 'not_configured')
  assert.equal(restored.coverageComplete, false)
  assert.equal(restored.totalResults, 60)
  assert.equal(restored.pageResults, 50)
  assert.match(restored.nextCursor, /^h1:/)
  assert.equal(restored.selection, undefined, 'a historical restore must not invent a v5 selection')
  assert.equal(restored.run, undefined)
  assert.equal(restored.results[0].valueScore, 0.5)
  assert.equal(restored.results[0].valueLevel, undefined)
  assert.equal(restored.inputSummary.keywords.length, 1)
  assert.equal(h.calls.jev.length, 0)
  assert.equal(h.calls.search.length, 0)
  const second = await runAdaptiveScreening({ cursor: restored.nextCursor, page_size: 50 }, {}, h.deps)
  assert.equal(second.pageResults, 10)
  assert.equal(second.nextCursor, null)
  assert.equal(second.totalResults, 60)
  // a missing original version stays missing instead of being guessed
  const unversioned = makeHarness({ loadResults: () => ({ format: SAVED_FORMAT_V1, results: [], metadata: { stopReason: 'failed' } }) })
  const missing = await runAdaptiveScreening({ saved_result_id: FIXTURE_SAVED_ID }, {}, unversioned.deps)
  assert.deepEqual(missing.restoration, { historical: true, originalFormat: SAVED_FORMAT_V1, originalSchemaVersion: null })
  assert.equal('schemaVersion' in missing, false)
  // a v2 file that is not schema 5, and an unknown format, fail closed
  const brokenV2 = makeHarness({ loadResults: () => ({ format: 'search-boost-research-v2', schemaVersion: 4, results: [], metadata: {} }) })
  await assert.rejects(runAdaptiveScreening({ saved_result_id: FIXTURE_SAVED_ID }, {}, brokenV2.deps), /format and schema version do not match/)
  const unknownFormat = makeHarness({ loadResults: () => ({ format: 'search-boost-research-v9', results: [], metadata: {} }) })
  await assert.rejects(runAdaptiveScreening({ saved_result_id: FIXTURE_SAVED_ID }, {}, unknownFormat.deps), /unsupported saved research format/)
})

await test('page cursors are process-local, namespace-bound and rejected without any call', async () => {
  const h = makeHarness()
  const result = await runAdaptiveScreening({ ...NEW_INPUT, page_size: 1 }, {}, h.deps)
  const cursorId = result.nextCursor.slice('s6:'.length).split('.')[0]
  const jevBefore = h.calls.jev.length
  await assert.rejects(runAdaptiveScreening({ cursor: `${FIXTURE_SAVED_ID}.1` }, {}, h.deps), /Invalid or incompatible adaptive cursor/)
  await assert.rejects(runAdaptiveScreening({ cursor: `s4:${FIXTURE_SAVED_ID}.0` }, {}, h.deps), /Invalid or incompatible adaptive cursor/)
  await assert.rejects(runAdaptiveScreening({ cursor: 's6:99999999-9999-4999-8999-999999999999.0' }, {}, h.deps), /expired or were evicted/)
  await assert.rejects(runAdaptiveScreening({ cursor: `s6:${cursorId}.9`, page_size: 1 }, {}, h.deps), /offset is out of range/)
  assert.equal(h.calls.jev.length, jevBefore)
  assert.equal(h.calls.search.length, 1)
  // an h1 cursor cannot read a v5 record even with a valid uuid
  await assert.rejects(runAdaptiveScreening({ cursor: `h1:${cursorId}.0` }, {}, h.deps), /namespace h1 does not match/)
})

await test('the public entry gate blocks new calls and reads alike', async () => {
  const disabled = makeHarness({ toolState: { requested: false, enabled: false, locked: false, reason: 'Disabled by user' } })
  await assert.rejects(runAdaptiveScreening(NEW_INPUT, {}, disabled.deps), /Disabled by user/)
  await assert.rejects(runAdaptiveScreening({ cursor: 's6:00000000-0000-4000-8000-000000000000.0' }, {}, disabled.deps), /Disabled by user/)
  await assert.rejects(runAdaptiveScreening({ saved_result_id: FIXTURE_SAVED_ID }, {}, disabled.deps), /Disabled by user/)
  assert.equal(disabled.calls.load.length, 0)
  const locked = makeHarness({ toolState: { requested: true, enabled: false, locked: true, reason: 'Jev not configured — configure Jev credentials first' } })
  await assert.rejects(runAdaptiveScreening({ saved_result_id: FIXTURE_SAVED_ID }, {}, locked.deps), /Jev not configured/)
  assert.equal(locked.calls.load.length, 0)
  // the 21f-style requested-only shape still works
  const legacyShape = makeHarness({ toolState: { requested: true } })
  const result = await runAdaptiveScreening(NEW_INPUT, {}, legacyShape.deps)
  assert.equal(result.results.length, 2)
})

await test('the declared snapshot is reviewed whole, and outsideReview is disclosed not hidden', async () => {
  const h = makeHarness({ rows: fixtureRows(32), searchResult: { funnel: { fusionRows: 50 } } })
  const result = await runAdaptiveScreening({ ...NEW_INPUT, max_results: 40 }, { limits: { candidateLimit: 32 } }, h.deps)
  assert.equal(h.calls.jev.length, 1 + Math.ceil(32 / 4), 'every declared candidate batch is dispatched')
  assert.equal(result.diagnostics.snapshotCandidates, 32)
  assert.equal(result.diagnostics.collected, 32)
  assert.equal(result.diagnostics.outsideReview, 18)
  assert.equal(result.diagnostics.unreviewed, 18)
  assert.equal(result.selection.returned, 32)
  assert.equal(result.selection.targetMet, false, 'max_results above the review cap is never promised')
  assert.equal(result.stopReason, 'review_cap_reached')
  assert.equal(result.run.targetExceedsReviewCap, true)
  assert.equal(result.warnings.some((warning) => /outside the declared review cap/.test(warning)), true)
  assert.equal(result.warnings.some((warning) => /exceeds the declared review cap/.test(warning)), true)
  assert.equal(validateOutput(result), null)
  const capped = makeHarness()
  const over = await runAdaptiveScreening({ ...NEW_INPUT, max_results: 50 }, { limits: { candidateLimit: 32 } }, capped.deps)
  assert.equal(over.run.targetExceedsReviewCap, true)
  assert.equal(over.selection.targetMet, false)
  assert.equal(over.stopReason, 'candidate_pool_exhausted')
  assert.equal(over.warnings.some((warning) => /exceeds the declared review cap/.test(warning)), true)
  // no early stop: a later batch proves the whole snapshot was reviewed
  const late = makeHarness({ rows: fixtureRows(8), answer: (request) => (request.state?.candidates?.some((ref) => ref.id === 'm8') ? { value: '5' } : { value: '2' }) })
  const high = await runAdaptiveScreening({ ...NEW_INPUT, max_results: 4, page_size: 4 }, {}, late.deps)
  assert.equal(late.calls.jev.length, 3, 'strategy plus both declared batches')
  assert.equal(high.selection.returned, 4, 'the last batch was reviewed and admitted, no early K-stop')
  assert.equal(high.results.some((row) => row.evidenceId === 'm8'), true)
})

await test('prepareMaterial binds exact text/provenance, keeps violations and never clears by itself', async () => {
  const base = { evidenceId: 'm1', url: 'https://x.example/p', title: 'X', text: 'plain readable text', basis: 'engine_snippet', published: '2025-01-01', domain: 'x.example', engines: ['bing'], engineRanks: { bing: 1 }, safetyState: undefined }
  const prepared = prepareMaterial(base)
  assert.equal(prepared.safetyState, 'pending')
  assert.match(prepared.textVersion, /^[a-f0-9]{64}$/)
  assert.equal(prepareMaterial({ ...base, text: 'other readable text' }).textVersion === prepared.textVersion, false)
  assert.equal(prepareMaterial({ ...base, engineRanks: { bing: 2 } }).textVersion === prepared.textVersion, false)
  assert.equal(prepareMaterial({ ...base, text: 'plain readable text' }).textVersion, prepared.textVersion)
  assert.equal(prepareMaterial({ ...base, safetyState: 'violation' }).safetyState, 'violation')
  assert.equal(prepareMaterial({ ...base, url: 'javascript:alert(1)' }).safetyState, 'unavailable')
  assert.equal(prepareMaterial({ ...base, text: 'bad\u0000text' }).safetyState, 'unavailable')
  assert.equal(prepareMaterial({ ...base, text: '' }).safetyState, 'unavailable')
})

await test('specific review reasons survive incomplete community execution', async () => {
  const partial = { communityExecution: { requested: true, effective: true, outcome: 'partial', cacheHit: false, reason: 'engine_failures', usage: null } }
  for (const [options, expected] of [
    [{ rows: fixtureRows(1) }, 'candidate_pool_exhausted'],
    [{ answer: { value: null } }, 'unassessable_material'],
    [{ searchResult: { ...partial, funnel: { fusionRows: 40 } }, rows: fixtureRows(1) }, 'review_cap_reached'],
  ]) {
    const h = makeHarness({ ...options, searchResult: options.searchResult ?? partial })
    const result = await runAdaptiveScreening({ ...NEW_INPUT, community: true, max_results: 10 }, {}, h.deps)
    assert.equal(result.selection.incomplete, true)
    assert.equal(result.stopReason, expected)
    assert.equal(result.selection.stopReason, expected)
    assert.equal(result.run.community.outcome, 'partial')
    assert.equal(validateOutput(result), null)
  }
})

await test('missing contribution weights never invent positive source provenance', async () => {
  const h = makeHarness({ searchResult: { contributionWeights: undefined } })
  const result = await runAdaptiveScreening({ ...NEW_INPUT, community: false }, {}, h.deps)
  assert.ok(result.results.length > 0, 'unknown provenance is neutral, not a value or safety rejection')
  assert.ok(result.results.every(row => row.engines.length === 0 && Object.keys(row.engineRanks).length === 0))
  assert.ok(result.results.every(row => row.sourceDiscount === 'unknown' && row.sourceDiscountFactor === 1))
  assert.ok(result.warnings.some(warning => warning.includes('positive source contributions are unknown')))
  assert.equal(validateOutput(result), null)
})

await test('community dispatch and reuse flags are typed and retained without free-form payloads', async () => {
  const h = makeHarness({ searchResult: { communityExecution: {
    requested: true, effective: true, outcome: 'succeeded', cacheHit: false, inFlight: true, reason: null,
    usage: { logicCalls: 0, officialAttempted: false, fallbackAttempted: false, dispatchedNow: false,
      engineRequests: 0, httpAttempts: 0, tokens: 0, arbitraryFlag: true, providerRaw: { secret: 'never expose' } },
  } } })
  const result = await runAdaptiveScreening({ ...NEW_INPUT, community: true, save_results: true }, {}, h.deps)
  assert.deepEqual(result.run.community.usage, {
    logicCalls: 0, officialAttempted: false, fallbackAttempted: false, dispatchedNow: false,
    engineRequests: 0, httpAttempts: 0, tokens: 0, inFlight: true,
  })
  assert.deepEqual(h.calls.save[0].metadata.run.community.usage, result.run.community.usage)
  const restored = await runAdaptiveScreening({ saved_result_id: result.savedResultId }, {}, h.deps)
  assert.deepEqual(restored.run.community.usage, result.run.community.usage)
  assert.equal(validateOutput(restored), null)
})

console.log(`ok: N_off adaptive flow contracts, community states, language-free strategy, budget hook and dual-format restore (${tests} groups)`)
