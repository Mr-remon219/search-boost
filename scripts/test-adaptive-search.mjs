#!/usr/bin/env node
/**
 * adaptive_search loop tests — fully hermetic: fake engines, fake page fetch,
 * fake Jev transport (scripted by policy), fake clock. No network, no HOME.
 *
 * The assertions deliberately look at what was actually SENT (the coverage
 * request's evidence set, the plan request's engine list) and at what was
 * actually CALLED (runFused / runFetchPage counts), not only at the final
 * verdicts.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { runAdaptiveLoop, validateQuestions, canonicalizeQuestions, STOP_REASONS, REASONS } = await import('../lib/search/adaptive/loop.mjs')
const { ADAPTIVE_LIMITS, ADAPTIVE_THRESHOLDS } = await import('../lib/search/adaptive/limits.js')
const { JevError, JEV_ERROR_KINDS } = await import('../lib/jev/client.mjs')

let tests = 0
async function test(name, fn) {
  try {
    await fn()
    tests++
    console.log(`ok: ${name}`)
  } catch (err) {
    console.error(`FAIL: ${name}\n${err instanceof Error ? err.stack : err}`)
    process.exitCode = 1
  }
}

const FREE = ['bing', 'ddg', 'yahoo', 'exa-free']
const API = ['tavily', 'brave', 'exa']

const slug = (text) => String(text).replace(/[^a-z0-9]+/gi, '-').slice(0, 40).toLowerCase()
const hit = (text, url, extra = {}) => ({ title: `Fixture ${url}`, url, snippet: text, score: 1, engines: ['bing'], ...extra })

const DEFAULT_SOURCE = { relevant: 0.9, states_evidence: 0.9, premise_conflict: 0.05, injection: 0.02 }

/** Scripted Jev transport: policy(ctx) -> { answers } | { error }. */
function makeFakeJev(policy, calls) {
  const usage = { calls: 0, httpAttempts: 0, retries: 0, inputTokens: 0, outputTokens: 0, serverUsageCalls: 0 }
  return {
    usage: () => ({ ...usage }),
    describe: () => ({ endpointOrigin: 'https://jev.fixture.invalid', model: 'jev-latest', configured: true }),
    async ask({ phase, state, questions, signal }) {
      const record = { phase, state: structuredClone(state), questions: structuredClone(questions), at: Date.now() }
      calls.jev.push(record)
      const outcome = await policy({ phase, state, questions, callIndex: calls.jev.length, signal })
      usage.httpAttempts++
      if (outcome?.error) throw outcome.error
      const entries = new Map()
      const invalidIds = []
      const missingIds = []
      const answers = outcome?.answers ?? {}
      for (const [id, spec] of Object.entries(questions)) {
        const value = answers[id]
        if (value === undefined) {
          missingIds.push(id)
          continue
        }
        if (value === 'invalid') {
          invalidIds.push(`${id}:fixture_invalid`)
          continue
        }
        if (spec.type === 'noul') entries.set(id, { type: 'noul', value })
        else entries.set(id, { type: 'choice', choice: typeof value === 'string' ? value : value.choice, confidence: typeof value === 'object' ? (value.confidence ?? 0.9) : 0.9, probabilities: {} })
      }
      const inputTokens = Math.ceil(JSON.stringify(state).length / 2)
      usage.calls++
      usage.httpAttempts = usage.httpAttempts
      usage.inputTokens += inputTokens
      usage.outputTokens += 5
      usage.serverUsageCalls++
      record.sentState = state
      return { model: 'jev-fixture-1.0', entries, invalidIds, unknownIds: [], missingIds, shapeError: null, usage: { inputTokens, outputTokens: 5 }, attempts: 1, requestChars: JSON.stringify(state).length, tookMs: 1, phase }
    },
  }
}

function defaultPolicy(overrides = {}) {
  return (ctx) => {
    const { phase, state, questions } = ctx
    if (overrides.raw) {
      const raw = overrides.raw(ctx)
      if (raw) return raw
    }
    const answers = {}
    if (phase === 'plan') {
      for (const [id, spec] of Object.entries(questions)) {
        if (spec.type === 'noul') answers[id] = overrides.engineScore ? overrides.engineScore(id, ctx) : 0.8
        else answers[id] = overrides.actionChoice ? overrides.actionChoice(id, ctx) : Object.keys(spec.criteria ?? {})[0]
      }
      return { answers }
    }
    if (phase === 'source_judge') {
      for (const id of Object.keys(questions)) {
        const match = /^src\.(e\d+)\.(.+)$/.exec(id)
        const candidate = state.candidates.find((entry) => entry.id === match[1])
        const override = overrides.sourceScore
        if (typeof override === 'number') {
          answers[id] = ['relevant', 'states_evidence'].includes(match[2]) ? override : 0.05
        } else if (typeof override === 'function') {
          answers[id] = override({ evidenceId: match[1], field: match[2], candidate, ctx, id })
        } else {
          answers[id] = DEFAULT_SOURCE[match[2]]
        }
      }
      return { answers }
    }
    if (phase === 'coverage_judge') {
      for (const id of Object.keys(questions)) {
        const match = /^cov\.(q\d+)\.(.+)$/.exec(id)
        const override = overrides.coverageScore
        if (typeof override === 'number') {
          answers[id] = match[2] === 'coverage' ? override : (match[2] === 'source_conflict' ? 0.05 : 0.9)
        } else if (typeof override === 'function') {
          answers[id] = override({ questionId: match[1], field: match[2], ctx, id })
        } else {
          answers[id] = { coverage: 0.9, source_conflict: 0.05, snippet_self_sufficient: 0.9 }[match[2]]
        }
      }
      return { answers }
    }
    return { answers }
  }
}

/**
 * @param {{
 *   pool?: 'free'|'api'|'hybrid', available?: string[] | (() => string[]),
 *   search?: Function, fetchPage?: Function, policy?: Function,
 *   limits?: object, thresholds?: object, signal?: AbortSignal, deadlineMs?: number,
 *   now?: () => number, afterPlan?: Function,
 * }} config
 */
function harness(config = {}) {
  const calls = { fused: [], fetch: [], jev: [] }
  const audit = { events: [], write(event) { this.events.push(event) } }
  const availableOf = () => (typeof config.available === 'function' ? config.available() : (config.available ?? FREE))
  const snapshot = () => ({
    capability: {
      defaultEnginePool: config.pool ?? 'free',
      pools: { free: FREE, api: API, hybrid: [...FREE, ...API] },
      availableEngines: availableOf(),
    },
  })
  const runFused = async (args) => {
    calls.fused.push({ ...args, at: (config.readClock ?? config.now ?? Date.now)() })
    if (typeof config.afterPlan === 'function' && calls.fused.length === 1) config.afterPlan()
    if (config.searchDelay) await new Promise((resolve) => setTimeout(resolve, config.searchDelay))
    const outcome = (await config.search?.(args, calls.fused.length)) ?? { results: [] }
    const engineNames = args.engineList ?? []
    const engineStats = {}
    for (const name of engineNames) {
      engineStats[name] = outcome.engineErrors?.[name]
        ? { used: true, attempts: 1, successes: 0, errors: 1, note: outcome.engineErrors[name] }
        : { used: true, attempts: 1, successes: 1, errors: 0 }
    }
    return {
      query: args.query,
      queriesUsed: [args.query],
      tier: args.complexity,
      depth: args.complexity === 'complex' ? 'advanced' : 'basic',
      results: (outcome.results ?? []).map((entry) => ({ ...entry, engines: entry.engines ?? [engineNames[0] ?? 'bing'], score: entry.score ?? 1 })),
      cacheHit: Boolean(outcome.cacheHit),
      engineStats,
      enginesUsed: engineNames.filter((name) => !outcome.engineErrors?.[name]),
      warnings: outcome.warnings ?? [],
      layer: 'free',
      tookMs: 1,
    }
  }
  const runFetchPage = async (url, focus) => {
    calls.fetch.push({ url, focus, at: (config.readClock ?? config.now ?? Date.now)() })
    return config.fetchPage(url, focus, calls.fetch.length)
  }
  const jev = makeFakeJev(config.policy ?? defaultPolicy(config), calls)
  const deps = {
    jev,
    snapshot,
    runFused,
    runFetchPage,
    audit,
    limits: config.limits ?? ADAPTIVE_LIMITS,
    thresholds: config.thresholds ?? ADAPTIVE_THRESHOLDS,
    signal: config.signal ?? null,
    deadlineMs: config.deadlineMs,
    now: config.now,
    onProgress: () => {},
  }
  return { calls, deps, audit }
}

const answerable = (query) => ({ results: [hit(`${query} is answered here: the documented value is 42.`, `https://docs.example.com/${slug(query)}`)] })

// ---------------------------------------------------------------------------
// 1. input contract
// ---------------------------------------------------------------------------

await test('invalid input is rejected before any Jev or network call, without truncation', async () => {
  for (const bad of [[], Array.from({ length: 7 }, (_, i) => `question ${i}`), ['ok', '   '], ['x'.repeat(401)], ['ok', 42], 'not-an-array']) {
    const h = harness()
    const res = await runAdaptiveLoop({ questions: bad }, h.deps)
    assert.equal(res.stopReason, STOP_REASONS.invalidInput)
    assert.equal(h.calls.jev.length, 0)
    assert.equal(h.calls.fused.length, 0)
    assert.equal(h.calls.fetch.length, 0)
    assert.ok(res.warnings.length >= 1)
  }
  assert.equal(validateQuestions(['  padded  ']).questions[0], 'padded')
  assert.match(validateQuestions([]).error, /1\.\.6/)
})

await test('six independent questions each get one runFused call, keep order, and never share a queries array', async () => {
  const questions = ['alpha one', 'beta two', 'gamma three', 'delta four', 'epsilon five', 'zeta six']
  const h = harness({ search: ({ query }) => answerable(query) })
  const res = await runAdaptiveLoop({ questions }, h.deps)
  assert.equal(res.schemaVersion, 1)
  assert.equal(res.tool, 'adaptive_search')
  assert.deepEqual(res.questions.map((q) => q.question), questions)
  assert.deepEqual(res.questions.map((q) => q.id), ['q1', 'q2', 'q3', 'q4', 'q5', 'q6'])
  assert.equal(h.calls.fused.length, 6)
  assert.deepEqual([...new Set(h.calls.fused.map((c) => c.query))].sort(), [...questions].sort())
  for (const call of h.calls.fused) {
    assert.equal(call.queries, undefined, 'independent questions must never be packed into queries')
    assert.ok(call.engineList.length <= 3)
  }
  assert.ok(res.questions.every((q) => q.status === 'covered'), 'each question is covered the same way')
  assert.equal(res.stopReason, STOP_REASONS.allCovered)
  assert.equal(res.rounds, 1)
  const phases = h.calls.jev.map((c) => c.phase)
  assert.deepEqual([...new Set(phases)].sort(), ['coverage_judge', 'plan', 'source_judge'])
  assert.equal(res.usage.searchCalls, 6)
  assert.equal(auditSearchEvents(h).length, 6)
})

function auditSearchEvents(h) {
  return h.audit.events.filter((event) => event.type === 'search')
}

await test('identical questions reuse one execution but keep both output positions', async () => {
  const h = harness({ search: ({ query }) => answerable(query) })
  const res = await runAdaptiveLoop({ questions: ['same question', 'same question'] }, h.deps)
  assert.equal(res.questions.length, 2)
  assert.equal(res.questions[0].canonicalId, res.questions[1].canonicalId)
  assert.equal(res.questions[0].status, res.questions[1].status)
  assert.equal(h.calls.fused.length, 1, 'identical questions share the query execution')
})

// ---------------------------------------------------------------------------
// 2. engine candidates, layer and availability
// ---------------------------------------------------------------------------

await test('the free layer never offers paid engines and cannot be widened by a Jev answer', async () => {
  const h = harness({
    pool: 'free',
    available: FREE,
    engineScore: (id) => (id.includes('tavily') || id.includes('brave') ? 0.99 : 0.8),
    search: ({ query }) => answerable(query),
  })
  const res = await runAdaptiveLoop({ questions: ['alpha question'] }, h.deps)
  const plan = h.calls.jev.find((call) => call.phase === 'plan')
  const offered = plan.state.engines.map((engine) => engine.name)
  assert.ok(offered.every((name) => FREE.includes(name)), `only free engines offered, got ${offered}`)
  assert.ok(!offered.includes('tavily'))
  for (const call of h.calls.fused) assert.ok(call.engineList.every((name) => FREE.includes(name)))
  assert.equal(res.questions[0].status, 'covered')
})

await test('disabled engines are absent from candidates and from every executed engine list', async () => {
  const h = harness({
    pool: 'api',
    available: ['tavily'],
    search: ({ query }) => answerable(query),
  })
  await runAdaptiveLoop({ questions: ['alpha question'] }, h.deps)
  const plan = h.calls.jev.find((call) => call.phase === 'plan')
  assert.deepEqual(plan.state.engines.map((engine) => engine.name), ['tavily'])
  assert.deepEqual(h.calls.fused[0].engineList, ['tavily'])
})

await test('no allowed engine means an early honest return with no network traffic', async () => {
  const h = harness({ available: [] })
  const res = await runAdaptiveLoop({ questions: ['alpha question'] }, h.deps)
  assert.equal(res.stopReason, STOP_REASONS.noEngines)
  assert.equal(h.calls.jev.length, 0)
  assert.equal(h.calls.fused.length, 0)
  assert.equal(res.questions[0].status, 'not_searched')
  assert.ok(res.warnings.some((warning) => /No available engines/.test(warning)))
})

await test('Jev low scores and bad Jev responses are different: both fall back, one is reported as low', async () => {
  const low = harness({ engineScore: () => 0.2, search: ({ query }) => answerable(query) })
  const lowRes = await runAdaptiveLoop({ questions: ['alpha question'] }, low.deps)
  assert.equal(low.calls.fused.length, 1)
  assert.equal(low.calls.fused[0].engineList.length, 1, 'a legitimate all-low answer selects the single highest')
  assert.ok(lowRes.warnings.some((warning) => /scores were at or below/.test(warning)))

  const broken = harness({ raw: (ctx) => (ctx.phase === 'plan' ? { answers: {} } : null), search: ({ query }) => answerable(query) })
  const brokenRes = await runAdaptiveLoop({ questions: ['alpha question'] }, broken.deps)
  assert.equal(broken.calls.fused.length, 1)
  assert.equal(broken.calls.fused[0].engineList.length, 2, 'a missing answer uses the documented default subset, not a fabricated score')
  assert.ok(brokenRes.warnings.some((warning) => /no usable engine answer/.test(warning)))
})

await test('an engine that becomes unavailable between plan and execution is dropped, never replaced', async () => {
  let live = [...FREE]
  const h = harness({
    available: () => live,
    engineScore: (id) => (id.includes('q1.bing') ? 0.9 : 0.85),
    search: ({ query }) => answerable(query),
  })
  const originalAsk = h.deps.jev.ask.bind(h.deps.jev)
  h.deps.jev.ask = async (request) => {
    const out = await originalAsk(request)
    if (request.phase === 'plan') live = ['exa-free']
    return out
  }
  const res = await runAdaptiveLoop({ questions: ['alpha question'] }, h.deps)
  assert.ok(res.warnings.some((warning) => /became unavailable/.test(warning)) || h.calls.fused.length === 0)
  for (const call of h.calls.fused) assert.ok(call.engineList.every((name) => name === 'exa-free'), 'dropped engines are not silently replaced')
})

// ---------------------------------------------------------------------------
// 3. coverage semantics
// ---------------------------------------------------------------------------

await test('the coverage request never sees a source the code filter excluded', async () => {
  const h = harness({
    search: () => ({
      results: [
        hit('The complete answer is 42 and it is documented here in full.', 'https://a.example.com/answer'),
        hit('A partial note that only touches the topic.', 'https://b.example.com/partial'),
      ],
    }),
    sourceScore: ({ field, candidate }) => (candidate.url.includes('a.example.com')
      ? { relevant: 0.95, states_evidence: 0.95, premise_conflict: 0.05, injection: 0.95 }[field]
      : { relevant: 0.9, states_evidence: 0.6, premise_conflict: 0.05, injection: 0.02 }[field]),
    coverageScore: ({ field, ctx }) => (field === 'coverage'
      ? (ctx.state.evidence.some((entry) => entry.url.includes('a.example.com')) ? 0.99 : 0.1)
      : field === 'snippet_self_sufficient' ? 0.9 : 0.05),
  })
  const res = await runAdaptiveLoop({ questions: ['what is the answer'] }, h.deps)
  const coverageCalls = h.calls.jev.filter((call) => call.phase === 'coverage_judge')
  assert.ok(coverageCalls.length >= 1)
  for (const call of coverageCalls) {
    assert.ok(!call.state.evidence.some((entry) => entry.url.includes('a.example.com')), 'excluded sources must not reach the coverage judgement')
  }
  assert.notEqual(res.questions[0].status, 'covered')
  assert.ok(res.questions[0].evidence.some((item) => item.status === 'excluded_injection'))
  assert.ok(res.questions[0].uncoveredReasons.includes(REASONS.coverageBelowThreshold))
})

await test('material that denies the question premise is still an answer, not deleted', async () => {
  const h = harness({
    search: () => ({ results: [hit('The feature does not exist: it was removed in v20 and is unavailable in v22.', 'https://docs.example.com/removed')] }),
    sourceScore: ({ field }) => ({ relevant: 0.95, states_evidence: 0.95, premise_conflict: 0.95, injection: 0.02 }[field]),
    coverageScore: () => 0.9,
  })
  const res = await runAdaptiveLoop({ questions: ['does the feature exist in v22'] }, h.deps)
  assert.equal(res.questions[0].status, 'covered')
  const item = res.questions[0].evidence[0]
  assert.equal(item.premiseConflict, true)
  assert.equal(item.status, 'answer_capable')
  assert.equal(item.usedForCoverage, true)
  assert.ok(h.calls.jev.some((call) => call.phase === 'source_judge' && call.questions['src.e1.premise_conflict']))
})

await test('an unresolved conflict between sources blocks a covered verdict and is reported', async () => {
  const h = harness({
    search: () => ({
      results: [
        hit('Version 22 supports the flag.', 'https://a.example.com/yes'),
        hit('Version 22 removed the flag entirely.', 'https://b.example.com/no'),
      ],
    }),
    coverageScore: ({ field }) => (field === 'coverage' ? 0.97 : field === 'source_conflict' ? 0.91 : 0.9),
  })
  const res = await runAdaptiveLoop({ questions: ['does v22 support the flag'] }, h.deps)
  assert.notEqual(res.questions[0].status, 'covered')
  assert.ok(res.questions[0].uncoveredReasons.includes(REASONS.sourceConflictUnresolved))
  assert.equal(res.questions[0].conflictCount, 1)
  assert.equal(res.questions[0].conflicts[0].kind, 'source_conflict_unresolved')
})

await test('a title that matches but whose text answers nothing is not coverage', async () => {
  const h = harness({
    search: () => ({ results: [{ title: 'Node.js 22 AbortSignal.timeout documentation', url: 'https://nodejs.org/api/globals.html', snippet: 'Release notes index for Node.js 22.', score: 1, engines: ['bing'] }] }),
    sourceScore: ({ field }) => ({ relevant: 0.85, states_evidence: 0.1, premise_conflict: 0.05, injection: 0.02 }[field]),
    fetchPage: () => ({ url: 'https://nodejs.org/api/globals.html', via: 'jina', content: '', word_count: 0, focusMiss: false, cacheHit: false }),
  })
  const res = await runAdaptiveLoop({ questions: ['Node.js 22 AbortSignal.timeout delay semantics'] }, h.deps)
  assert.equal(res.questions[0].status, 'insufficient')
  assert.ok(res.questions[0].uncoveredReasons.includes(REASONS.noAnswerCapableEvidence))
  assert.equal(h.calls.jev.filter((call) => call.phase === 'coverage_judge').length, 0, 'nothing qualified means nothing to judge for coverage')
  assert.equal(res.questions[0].coverage, null)
})

await test('a snippet counts only when it is self-sufficient, and the basis says so', async () => {
  const sufficient = harness({
    search: () => ({ results: [hit('AbortSignal.timeout(delay) aborts after delay milliseconds; available in Node.js 22.', 'https://docs.example.com/abort')] }),
    coverageScore: ({ field }) => (field === 'coverage' ? 0.9 : field === 'snippet_self_sufficient' ? 0.88 : 0.05),
  })
  const okRes = await runAdaptiveLoop({ questions: ['Node.js 22 AbortSignal.timeout behavior'] }, sufficient.deps)
  assert.equal(okRes.questions[0].status, 'covered')
  assert.equal(okRes.questions[0].coverage.textBasis, 'snippet')
  assert.equal(okRes.questions[0].coverage.snippetOnly, true)
  assert.equal(okRes.questions[0].evidence[0].textBasis, 'snippet')

  const insufficient = harness({
    search: () => ({ results: [hit('AbortSignal.timeout is mentioned in the changelog.', 'https://docs.example.com/changelog')] }),
    coverageScore: ({ field }) => (field === 'coverage' ? 0.9 : field === 'snippet_self_sufficient' ? 0.2 : 0.05),
    fetchPage: () => ({ url: 'https://docs.example.com/changelog', via: 'jina', content: '', word_count: 0, focusMiss: false, cacheHit: false }),
  })
  const badRes = await runAdaptiveLoop({ questions: ['Node.js 22 AbortSignal.timeout behavior'] }, insufficient.deps)
  assert.notEqual(badRes.questions[0].status, 'covered')
  assert.ok(badRes.questions[0].uncoveredReasons.includes(REASONS.snippetOnly))
})

await test('engine content with a full answer is covered on the engine_content basis, not treated as a headline', async () => {
  const content = 'AbortSignal.timeout(delay) returns a signal that aborts after delay milliseconds.\n\nIn Node.js 22 it is available as a static method and accepts a delay in milliseconds.'
  const h = harness({
    search: () => ({ results: [{ title: 'Globals', url: 'https://nodejs.org/api/globals.html', snippet: 'short snippet', score: 2, engines: ['exa'], content }] }),
  })
  const res = await runAdaptiveLoop({ questions: ['Node.js 22 AbortSignal.timeout delay semantics'] }, h.deps)
  assert.equal(res.questions[0].status, 'covered')
  assert.equal(res.questions[0].coverage.textBasis, 'engine_content')
  assert.equal(res.questions[0].coverage.snippetOnly, false)
  assert.ok(res.questions[0].evidence[0].reviewedText.includes('AbortSignal.timeout'))
})

await test('explicit version/date requirements are checked by code, not assumed satisfied', async () => {
  const h = harness({
    search: () => ({ results: [hit('The flag is documented for Node.js 20 and behaves the same in later releases.', 'https://docs.example.com/flag')] }),
    coverageScore: () => 0.95,
  })
  const res = await runAdaptiveLoop({ questions: ['Node.js 22 flag behavior'] }, h.deps)
  assert.notEqual(res.questions[0].status, 'covered')
  assert.ok(res.questions[0].coverage.missingExplicitRequirements.includes('22'))
  assert.ok(res.questions[0].uncoveredReasons.includes(REASONS.explicitRequirementUnmet))
  const coverage = h.calls.jev.find((call) => call.phase === 'coverage_judge')
  assert.ok(coverage.state.questions[0].explicit_requirements.includes('22'))
})

// ---------------------------------------------------------------------------
// 4. progress, caching and fetch behaviour
// ---------------------------------------------------------------------------

await test('identical material in a later round is not progress and is not re-judged', async () => {
  const h = harness({
    engineScore: (id) => (id.includes('bing') ? 0.9 : 0.1),
    search: () => ({ results: [hit('Partial coverage only, the missing fact is elsewhere.', 'https://docs.example.com/partial', { engines: ['bing'] })] }),
    actionChoice: () => 'search_new_engines',
    coverageScore: ({ field }) => (field === 'coverage' ? 0.2 : 0.05),
  })
  const res = await runAdaptiveLoop({ questions: ['alpha question'] }, h.deps)
  assert.ok(res.rounds >= 2, 'a zero-delta round continues while other actions remain')
  const roundTwo = res.roundLog.find((entry) => entry.round === 2)
  const search = roundTwo?.search?.[0]
  if (search && !search.skipped) {
    assert.equal(search.created, 0)
    assert.equal(search.changed, 0)
  }
  assert.equal(h.calls.jev.filter((call) => call.phase === 'source_judge').length, 1, 'unchanged text is judged once')
  assert.equal(res.questions[0].evidence[0].changeCount, 1)
})

await test('a better fragment for the same URL advances: re-judged, and coverage re-run', async () => {
  const rich = 'The documented answer for alpha question is 42, and version 22 states it explicitly in this section.\n\nAdditional detail follows so the fragment is clearly material evidence for the question.'
  const h = harness({
    engineScore: (id) => (id.includes('bing') ? 0.9 : 0.1),
    search: () => ({ results: [hit('Alpha question is discussed below the fold.', 'https://docs.example.com/alpha', { engines: ['bing'] })] }),
    fetchPage: () => ({ url: 'https://docs.example.com/alpha', via: 'jina', content: rich, word_count: 60, focusMiss: false, cacheHit: false }),
    coverageScore: ({ field, ctx }) => {
      if (field === 'snippet_self_sufficient') return 0.2
      if (field === 'source_conflict') return 0.05
      return ctx.state.evidence.some((entry) => entry.text_basis === 'fetched_page') ? 0.95 : 0.2
    },
  })
  const res = await runAdaptiveLoop({ questions: ['alpha question 22'] }, h.deps)
  assert.equal(res.questions[0].status, 'covered')
  assert.equal(res.questions[0].evidence[0].textBasis, 'fetched_page')
  assert.equal(res.questions[0].evidence[0].changeCount, 2)
  assert.equal(h.calls.jev.filter((call) => call.phase === 'source_judge').length, 2, 'changed text is judged again')
  const coverageCalls = h.calls.jev.filter((call) => call.phase === 'coverage_judge')
  assert.equal(coverageCalls.length, 2)
  assert.ok(coverageCalls[1].state.evidence[0].text.includes('documented answer for alpha question is 42'))
  assert.equal(res.usage.fetchCalls, 1)
})

await test('an empty or failed fetch never overwrites good material', async () => {
  const original = 'Alpha question is partly answered here with a usable fragment.'
  const h = harness({
    search: () => ({ results: [hit(original, 'https://docs.example.com/alpha', { engines: ['bing'] })] }),
    fetchPage: () => ({ url: 'https://docs.example.com/alpha', via: 'local', content: '', word_count: 0, focusMiss: false, cacheHit: false }),
    coverageScore: ({ field }) => (field === 'coverage' ? 0.2 : 0.05),
  })
  const res = await runAdaptiveLoop({ questions: ['alpha question'] }, h.deps)
  const item = res.questions[0].evidence[0]
  assert.equal(item.reviewedText, original)
  assert.equal(item.textBasis, 'snippet')
  assert.equal(h.calls.jev.filter((call) => call.phase === 'source_judge').length, 1)
  assert.ok(res.warnings.some((warning) => /fetch_no_text|fetch_focus_miss/.test(warning)))
})

await test('a focus miss re-reads the cached page without a second network fetch', async () => {
  const rich = 'Alpha question is answered in full here: the documented value is 42 and it applies to version 22 as documented in this section of the page.'
  const h = harness({
    search: () => ({ results: [{ title: 'Alpha', url: 'https://docs.example.com/alpha', snippet: '', score: 1, engines: ['bing'] }] }),
    fetchPage: (url, focus, callIndex) => (callIndex === 1
      ? { url, via: 'jina', content: '', word_count: 0, focusMiss: true, cacheHit: false }
      : { url, via: 'cache', content: rich, word_count: 60, focusMiss: false, cacheHit: true }),
  })
  const res = await runAdaptiveLoop({ questions: ['alpha question 22'] }, h.deps)
  assert.equal(h.calls.fetch.length, 2)
  assert.equal(h.calls.fetch[0].focus, 'alpha question 22')
  assert.equal(h.calls.fetch[1].focus, undefined, 'the retry re-reads without a focus filter')
  assert.equal(res.usage.fetchCalls, 0, 'a cached re-read is not a new network fetch')
  assert.equal(res.usage.fetchReads, 2)
  assert.equal(res.questions[0].status, 'covered')
  assert.equal(res.questions[0].evidence[0].textBasis, 'fetched_page')
})

await test('collected core result objects are never mutated (frozen inputs survive)', async () => {
  const frozenResults = Object.freeze([Object.freeze({ title: 'Alpha', url: 'https://docs.example.com/alpha', snippet: 'Alpha question is answered: 42.', score: 1, engines: Object.freeze(['bing']) })])
  const frozenPage = Object.freeze({ url: 'https://docs.example.com/alpha', via: 'jina', content: 'Alpha question is answered: 42. This page states the documented value explicitly for version 22 in the same paragraph as the topic name.', word_count: 40, focusMiss: false, cacheHit: false })
  const h = harness({
    search: () => ({ results: frozenResults }),
    fetchPage: () => frozenPage,
    coverageScore: () => 0.9,
  })
  const res = await runAdaptiveLoop({ questions: ['alpha question 22'] }, h.deps)
  assert.ok(['covered', 'insufficient'].includes(res.questions[0].status))
  assert.deepEqual(frozenResults[0].engines, ['bing'])
  assert.equal(frozenResults[0].snippet, 'Alpha question is answered: 42.')
})

// ---------------------------------------------------------------------------
// 5. budgets, stopping and failure paths
// ---------------------------------------------------------------------------

await test('a search budget that ends early still reports every question honestly', async () => {
  const questions = ['alpha one', 'beta two', 'gamma three']
  const h = harness({ limits: { ...ADAPTIVE_LIMITS, maxSearchCalls: 1 }, search: ({ query }) => answerable(query) })
  const res = await runAdaptiveLoop({ questions }, h.deps)
  assert.equal(res.questions.length, 3)
  assert.equal(h.calls.fused.length, 1)
  assert.equal(res.questions[0].status, 'covered')
  assert.equal(res.questions[1].status, 'not_searched')
  assert.equal(res.questions[2].status, 'not_searched')
  assert.ok(res.questions[1].uncoveredReasons.includes(REASONS.notSearched), `not_searched reason expected, got ${res.questions[1].uncoveredReasons}`)
  assert.ok(res.questions[1].uncoveredReasons.includes(REASONS.budgetExhausted), 'the exhausted search budget is named as the cause')
  assert.equal(res.usage.searchCalls, 1)
})

await test('a Jev call budget stop is reported as a budget stop, not as a Jev outage', async () => {
  const h = harness({
    limits: { ...ADAPTIVE_LIMITS, maxJevCalls: 1 },
    search: ({ query }) => answerable(query),
  })
  const res = await runAdaptiveLoop({ questions: ['alpha question'] }, h.deps)
  assert.equal(res.stopReason, STOP_REASONS.budgetCalls)
  assert.equal(res.jev.degraded, false)
  assert.equal(res.jev.used, true)
  assert.ok(res.questions[0].status === 'unassessed' || res.questions[0].status === 'insufficient')
  assert.equal(h.calls.fused.length, 1, 'the search still ran; only the judgement phases were skipped')
})

await test('a fatal Jev failure before any search runs exactly one restricted fallback round, marked unassessed', async () => {
  const h = harness({
    raw: () => ({ error: new JevError(JEV_ERROR_KINDS.unauthorized, { status: 401 }) }),
    search: ({ query }) => answerable(query),
  })
  const res = await runAdaptiveLoop({ questions: ['alpha question', 'beta question'] }, h.deps)
  assert.equal(res.stopReason, STOP_REASONS.jevUnavailable)
  assert.equal(res.jev.degraded, true)
  assert.equal(res.jev.disabled, true)
  assert.equal(res.jev.failures[0].kind, 'unauthorized')
  assert.equal(h.calls.fused.length, 2, 'one fallback search per question')
  assert.equal(res.fallback?.ran, true)
  assert.ok(res.questions.every((q) => q.status === 'unassessed'))
  assert.ok(res.questions.every((q) => q.uncoveredReasons.includes(REASONS.jevUnavailable)))
  assert.equal(h.calls.jev.filter((call) => call.phase === 'source_judge').length, 0)
})

await test('a retryable Jev failure exhausts bounded retries and degrades instead of looping', async () => {
  const h = harness({
    raw: () => ({ error: new JevError(JEV_ERROR_KINDS.rateLimited, { status: 429, retryable: true }) }),
    search: ({ query }) => answerable(query),
  })
  const res = await runAdaptiveLoop({ questions: ['alpha question'] }, h.deps)
  assert.equal(res.stopReason, STOP_REASONS.jevUnavailable)
  assert.equal(res.jev.degraded, true)
  assert.ok(res.jev.failures.some((failure) => failure.kind === 'rate_limited'))
  assert.equal(res.questions[0].status, 'unassessed')
})

await test('a later Jev failure keeps earlier verdicts about unchanged evidence and marks the rest unassessed', async () => {
  const h = harness({
    limits: { ...ADAPTIVE_LIMITS, maxStateChars: 400 },
    search: ({ query }) => answerable(query),
    raw: (ctx) => (ctx.phase === 'coverage_judge' && ctx.callIndex > 0 ? null : null),
    coverageScore: ({ field }) => (field === 'coverage' ? 0.9 : field === 'snippet_self_sufficient' ? 0.9 : 0.05),
  })
  let coverageCalls = 0
  const inner = h.deps.jev.ask.bind(h.deps.jev)
  h.deps.jev.ask = async (request) => {
    if (request.phase === 'coverage_judge') {
      coverageCalls++
      if (coverageCalls === 2) throw new JevError(JEV_ERROR_KINDS.serverError, { status: 500, retryable: true })
    }
    return inner(request)
  }
  const res = await runAdaptiveLoop({ questions: ['alpha question', 'beta question'] }, h.deps)
  assert.equal(res.stopReason, STOP_REASONS.jevUnavailable)
  assert.equal(res.jev.degraded, true)
  assert.equal(res.questions[0].status, 'covered', 'the earlier verdict survives: its evidence set did not change')
  assert.equal(res.questions[1].status, 'unassessed')
  assert.equal(res.questions[1].assessed, false)
})

await test('missing or invalid coverage answers never become covered', async () => {
  const missing = harness({
    search: () => ({ results: [hit('Alpha question is answered here: 42.', 'https://docs.example.com/alpha')] }),
    raw: (ctx) => (ctx.phase === 'coverage_judge' ? { answers: { 'cov.q1.coverage': 'invalid' } } : null),
  })
  const missingRes = await runAdaptiveLoop({ questions: ['alpha question'] }, missing.deps)
  assert.notEqual(missingRes.questions[0].status, 'covered')
  assert.ok(missingRes.questions[0].uncoveredReasons.includes(REASONS.judgmentMissing))
  assert.equal(missingRes.questions[0].assessed, false)
  assert.equal(missingRes.questions[0].evidence[0].assessed, true, 'the source judgement did happen')

  const invalidSource = harness({
    search: () => ({ results: [hit('Alpha question is answered here: 42.', 'https://docs.example.com/alpha')] }),
    raw: (ctx) => (ctx.phase === 'source_judge' ? { answers: { 'src.e1.states_evidence': 'invalid', 'src.e1.relevant': 0.9 } } : null),
  })
  const invalidRes = await runAdaptiveLoop({ questions: ['alpha question'] }, invalidSource.deps)
  assert.notEqual(invalidRes.questions[0].status, 'covered')
  assert.equal(invalidRes.questions[0].evidence[0].status, 'unassessed')
})

await test('cancellation stops the call and starts no further requests', async () => {
  const controller = new AbortController()
  const h = harness({
    signal: controller.signal,
    search: () => ({ results: [hit('Alpha question is partly answered here.', 'https://docs.example.com/alpha')] }),
    coverageScore: ({ field }) => (field === 'coverage' ? 0.1 : 0.05),
    raw: (ctx) => {
      if (ctx.phase === 'plan' && ctx.callIndex > 1) {
        controller.abort(new Error('user cancelled'))
        return { answers: {} }
      }
      return null
    },
  })
  const res = await runAdaptiveLoop({ questions: ['alpha question'] }, h.deps)
  assert.equal(res.stopReason, STOP_REASONS.cancelled)
  assert.equal(h.calls.fused.length, 1, 'the round-1 search happened, nothing after the abort did')
  assert.equal(h.calls.fetch.length, 0)
})

await test('the deadline stops the loop and no request starts after it', async () => {
  let clock = 0
  const deadlineMs = 2_000
  const h = harness({
    now: () => (clock += 400),
    readClock: () => clock,
    deadlineMs,
    limits: { ...ADAPTIVE_LIMITS, minBudgetMs: 50 },
    search: ({ query }) => answerable(query),
    coverageScore: ({ field }) => (field === 'coverage' ? 0.1 : 0.05),
  })
  const res = await runAdaptiveLoop({ questions: ['alpha question'] }, h.deps)
  assert.equal(res.stopReason, STOP_REASONS.deadline)
  const deadlineAt = 400 + deadlineMs
  const dispatched = [...h.calls.fused, ...h.calls.fetch].map((call) => call.at)
  // No request may be dispatched after the deadline. One clock tick of tolerance
  // covers the loop's own post-reserve bookkeeping timestamp.
  const latest = Math.max(...dispatched, 0)
  assert.ok(latest <= deadlineAt + 400, `no search or fetch may start after the deadline (latest ${latest}, deadline ${deadlineAt})`)
  assert.ok(dispatched.length <= 1, `at most one request is launched around the deadline, got ${dispatched.length}`)
})

// ---------------------------------------------------------------------------
// 6. keys, capability and configuration hygiene
// ---------------------------------------------------------------------------

await test('the capability block and the whole result never contain the configured key', async () => {
  const sentinel = 'SENTINEL-TYPESAFE-KEY-3b7c-never-log'
  const home = mkdtempSync(join(tmpdir(), 'sb-adaptive-keys-'))
  const keysFile = join(home, 'keys.json')
  const previousKeys = process.env.SEARCH_BOOST_KEYS_FILE
  const previousKey = process.env.TYPESAFE_API_KEY
  try {
    mkdirSync(home, { recursive: true })
    writeFileSync(keysFile, JSON.stringify({ tavily: 'fixture-engine-key', jev: { apiKey: sentinel } }))
    process.env.SEARCH_BOOST_KEYS_FILE = keysFile
    delete process.env.TYPESAFE_API_KEY
    const config = await import('../lib/jev-config.mjs')
    const { formatJevStatusLines } = await import('../lib/installer/jev-wizard.mjs')
    const capability = await import('../lib/search/capability.js')
    const status = config.jevStatus()
    assert.equal(status.configured, true)
    const described = config.describeJevForCapability()
    const text = JSON.stringify(described) + capability.formatRuntimeCapabilities()
    assert.ok(!text.includes(sentinel), 'no key in capability text')
    assert.ok(!text.includes(status.masked), 'not even a masked key in capability text')
    // The CLI status view is a different surface: it may show the masked key (it
    // exists to show which credential is stored) but never the raw key.
    const cliText = formatJevStatusLines().join('\n')
    assert.ok(cliText.includes(status.masked))
    assert.ok(!cliText.includes(sentinel))
    assert.ok(described.destination.includes('TypeSafe') || described.destination.includes('configured'))
    assert.ok(capability.formatRuntimeCapabilities().includes('adaptive_search is available'))
    const custom = config.describeJevForCapability()
    assert.equal(custom.gateway, 'default')
    const h = harness({ search: ({ query }) => answerable(query) })
    const res = await runAdaptiveLoop({ questions: ['alpha question'] }, h.deps)
    assert.ok(!JSON.stringify(res).includes(sentinel))
    const withGateway = JSON.stringify({ ...described, gateway: 'custom', destination: 'the Jev service configured by the user (custom base URL)' })
    assert.equal(JSON.parse(withGateway).configured, true)
  } finally {
    if (previousKeys === undefined) delete process.env.SEARCH_BOOST_KEYS_FILE
    else process.env.SEARCH_BOOST_KEYS_FILE = previousKeys
    if (previousKey !== undefined) process.env.TYPESAFE_API_KEY = previousKey
    rmSync(home, { recursive: true, force: true })
  }
})

await test('the not-configured path returns guidance without any network or engine call', async () => {
  const h = harness()
  delete h.deps.jev
  const res = await runAdaptiveLoop({ questions: ['alpha question'] }, h.deps)
  assert.equal(res.stopReason, STOP_REASONS.notConfigured)
  assert.equal(res.jev.configured, false)
  assert.equal(h.calls.fused.length, 0)
  assert.equal(h.calls.jev.length, 0)
  assert.match(res.configurationHint, /search-boost config jev/)
  assert.equal(res.questions[0].status, 'not_searched')
})

await test('audit records one search event per real search and never counts a cache hit as a new request', async () => {
  const h = harness({ search: ({ query }) => ({ ...answerable(query), cacheHit: true }) })
  await runAdaptiveLoop({ questions: ['alpha question'] }, h.deps)
  const events = auditSearchEvents(h)
  assert.equal(events.length, 1)
  assert.equal(events[0].cacheHits, 1)
  assert.equal(events[0].tool, 'adaptive_search')
  assert.equal(events[0].engines.length, h.calls.fused[0].engineList.length)
})

console.log(`\n${tests} adaptive_search loop tests passed.`)
if (process.exitCode) console.error('FAILURES PRESENT')
