#!/usr/bin/env node
import './isolate-tests.mjs'
/**
 * P4 fault-injection suite: bounded recursion + safe stopping invariants.
 * Hermetic (fake Jev/engines/pages/clock). Scenarios assert the acceptance
 * rules directly: depth-2 recursion, branch cap, loop/duplicate detection,
 * and — critically — that "no new qualified items this round" never drops
 * pending/lead material and never forges a covered verdict.
 */
import assert from 'node:assert/strict'


const { runAdaptiveLoop, STOP_REASONS, REASONS } = await import('../lib/search/adaptive/loop.mjs')
const { ADAPTIVE_LIMITS: V2_LIMITS, ADAPTIVE_THRESHOLDS: V2_THRESHOLDS } = await import('../lib/search/adaptive/limits.js')
// Frozen V1 policy regression. V2/default behavior has its own test:keywords suite.
const ADAPTIVE_LIMITS = {...V2_LIMITS, keywordAccumulation:false, maxEnginesPerQuestionPerRound:3,
 round1EnginesPerQuestion:5,maxPoolRowsPerSearch:20,maxJevCalls:18,maxJevInputTokens:240000,
 maxSourceJudgeCandidatesPerQuestion:6,maxSourceJudgeCandidatesPerRequest:12,maxSourceJudgeMicroBatches:3}
const ADAPTIVE_THRESHOLDS = {...V2_THRESHOLDS,relevance:.55,statesEvidence:.55,coverage:.85}


const FREE = ['bing', 'ddg', 'yahoo', 'exa-free']
const API = ['tavily', 'brave', 'exa']
const hit = (text, url, extra = {}) => ({ title: `Fixture ${url}`, url, snippet: text, score: 1, engines: ['bing'], ...extra })

function makeFakeJev(policy, calls) {
  const usage = { calls: 0, httpAttempts: 0, retries: 0, inputTokens: 0, outputTokens: 0, serverUsageCalls: 0 }
  return {
    usage: () => ({ ...usage }),
    describe: () => ({ endpointOrigin: 'https://jev.fixture.invalid', model: 'jev-latest', configured: true }),
    async ask({ phase, state, questions }) {
      calls.push({ phase, questions })
      const outcome = await policy({ phase, state, questions })
      usage.httpAttempts++
      if (outcome?.error) throw outcome.error
      const entries = new Map()
      for (const [id, spec] of Object.entries(questions)) {
        const value = (outcome?.answers ?? {})[id]
        if (value === undefined) continue
        if (spec.type === 'noul') entries.set(id, { type: 'noul', value })
        else entries.set(id, { type: 'choice', choice: value, confidence: 0.9, probabilities: {} })
      }
      usage.calls++
      usage.inputTokens += Math.ceil(JSON.stringify(state).length / 2)
      return { model: 'jev-fixture-1.0', entries, invalidIds: [], unknownIds: [], missingIds: [], shapeError: null, usage: { inputTokens: 1, outputTokens: 1 }, attempts: 1, requestChars: 10, tookMs: 1, phase }
    },
  }
}

function harness(config = {}) {
  const calls = { fused: [], fetch: [], jev: [] }
  const available = () => FREE
  const snapshot = () => ({
    capability: {
      defaultEnginePool: 'free',
      pools: { free: FREE, api: API, hybrid: [...FREE, ...API] },
      availableEngines: available(),
    },
  })
  const runFused = async (args) => {
    calls.fused.push({ ...args })
    if (config.searchDelay) await new Promise((r) => setTimeout(r, config.searchDelay))
    const outcome = (await config.search?.(args, calls.fused.length)) ?? { results: [] }
    const engineNames = args.engineList ?? []
    const engineStats = {}
    for (const name of engineNames) engineStats[name] = { used: true, attempts: 1, successes: outcome.engineErrors?.[name] ? 0 : 1, errors: outcome.engineErrors?.[name] ? 1 : 0 }
    return {
      query: args.query, queriesUsed: [args.query], tier: args.complexity, depth: 'basic',
      results: (outcome.results ?? []).map((e) => ({ ...e, engines: e.engines ?? [engineNames[0] ?? 'bing'], score: e.score ?? 1 })),
      cacheHit: false, engineStats, enginesUsed: engineNames.filter((n) => !outcome.engineErrors?.[n]),
      warnings: [], layer: 'free', tookMs: 1,
    }
  }
  const runFetchPage = async (url, focus) => {
    calls.fetch.push({ url, focus })
    return config.fetchPage ? config.fetchPage(url, focus, calls.fetch.length) : { content: '', word_count: 0, via: null, cacheHit: false }
  }
  const jev = makeFakeJev(config.policy ?? (() => ({ answers: {} })), calls.jev)
  return {
    calls,
    deps: {
      jev, snapshot, runFused, runFetchPage,
      limits: config.limits ?? ADAPTIVE_LIMITS,
      thresholds: ADAPTIVE_THRESHOLDS,
      signal: config.signal ?? null,
      deadlineMs: config.deadlineMs ?? undefined,
    },
  }
}

const scenarioResults = []
async function scenario(name, fn) {
  try {
    const detail = (await fn()) ?? {}
    scenarioResults.push({ scenario: name, passed: true, ...detail })
    console.log(`ok: ${name}`)
  } catch (err) {
    scenarioResults.push({ scenario: name, passed: false, error: String(err?.message ?? err).slice(0, 300) })
    console.error(`FAIL: ${name}\n${err instanceof Error ? err.stack : err}`)
    process.exitCode = 1
  }
}

// Policy helpers: answer plan questions with fallbacks, steer actions by prefix.
const steer = (actionKey) => ({ phase, questions }) => {
  const answers = {}
  for (const id of Object.keys(questions)) {
    if (id.startsWith('plan.')) answers[id] = 0.9 // engine noul scores
    else if (id.startsWith('action.')) answers[id] = actionKey
    else if (id.startsWith('src.')) {
      if (id.endsWith('.injection')) answers[id] = 0.02
      else if (id.endsWith('.premise_conflict')) answers[id] = 0.05
      else answers[id] = 0.95
    } else if (id.endsWith('.coverage')) answers[id] = 0.1 // never covered: keeps questions unfinished
    else if (id.endsWith('.gap')) answers[id] = 'fact'
  }
  return { answers }
}

await scenario('T1 Jev failure mid-deepening keeps earlier verdicts and never forges covered', async () => {
  const calls = []
  let round2 = false
  const h = harness({
    limits: { ...ADAPTIVE_LIMITS, maxRounds: 2, maxSearchCalls: 4 },
    search: ({ query }) => ({ results: [hit(`${query} states the documented value 42 in detail.`, 'https://docs.example.com/a')] }),
    policy: ({ phase, questions }) => {
      if (round2 && (phase === 'plan' || phase === 'source_judge')) {
        const err = new Error('network down')
        err.name = 'TypeError'
        throw err
      }
      const answers = {}
      for (const id of Object.keys(questions)) {
        if (id.startsWith('plan.')) answers[id] = 0.9
        else if (id.startsWith('action.')) answers[id] = 'deepen'
        else if (id.startsWith('src.')) answers[id] = id.endsWith('.injection') ? 0.02 : 0.95
        else if (id.endsWith('.coverage')) answers[id] = 0.1
        else if (id.endsWith('.gap')) answers[id] = 'fact'
      }
      return { answers }
    },
  })
  // After round 1 completes, subsequent Jev calls fail.
  const original = h.deps.jev.ask.bind(h.deps.jev)
  let planCalls = 0
  h.deps.jev.ask = async (req) => {
    if (req.phase === 'plan') planCalls++
    if (planCalls >= 2) round2 = true
    return original(req)
  }
  const res = await runAdaptiveLoop({ questions: ['alpha question'] }, h.deps)
  assert.notEqual(res.questions[0].status, 'covered', 'a Jev outage can never produce covered')
  assert.ok(res.jev.degraded || res.jev.failures.length > 0, 'the outage is reported')
  const evidence = res.questions[0].evidence
  assert.ok(evidence.length > 0, 'earlier collected material is retained')
  assert.ok(evidence.every((item) => item.status !== 'answer_capable' || item.assessed), 'surviving verdicts stay bound to their text')
  return { stop_reason: res.stopReason, status: res.questions[0].status, retained: evidence.length }
})

await scenario('T2 total fetch failure keeps the pool and reports honestly', async () => {
  const h = harness({
    limits: { ...ADAPTIVE_LIMITS, maxRounds: 2, maxSearchCalls: 4, maxFetchCalls: 4 },
    search: () => ({ results: [hit('Alpha question is mentioned here.', 'https://docs.example.com/a'), hit('Alpha question is mentioned there.', 'https://docs.example.com/b')] }),
    fetchPage: () => { throw new Error('fetch exploded') },
    policy: steer('fetch_pages'),
  })
  const res = await runAdaptiveLoop({ questions: ['alpha question'] }, h.deps)
  assert.notEqual(res.questions[0].status, 'covered')
  assert.ok(res.questions[0].evidence.length > 0, 'failed fetches never delete collected material')
  const fetchUrls = h.calls.fetch.map((c) => c.url)
  assert.equal(new Set(fetchUrls).size, fetchUrls.length, 'a failed page is never retried in a loop')
  assert.ok(res.questions[0].uncoveredReasons.length > 0, 'the miss is reported with reasons')
  return { status: res.questions[0].status, fetch_attempts: fetchUrls.length, evidence: res.questions[0].evidence.length }
})

await scenario('T3 budget exhaustion mid-deepening returns partial with stop reason', async () => {
  const h = harness({
    limits: { ...ADAPTIVE_LIMITS, maxRounds: 4, maxSearchCalls: 2 },
    search: ({ query }) => ({ results: [hit(`${query} has partial information only.`, 'https://docs.example.com/a')] }),
    policy: steer('deepen'),
  })
  const res = await runAdaptiveLoop({ questions: ['alpha question'] }, h.deps)
  assert.notEqual(res.questions[0].status, 'covered')
  assert.ok([STOP_REASONS.budgetCalls, STOP_REASONS.budgetRounds, STOP_REASONS.noAction, STOP_REASONS.budgetTokens].includes(res.stopReason), `stop reason is a budget/stop category, got ${res.stopReason}`)
  assert.equal(h.calls.fused.length <= 2, true, 'search budget is never exceeded')
  return { stop_reason: res.stopReason, searches: h.calls.fused.length }
})

await scenario('T4 deadline during deepening returns partial, not a verdict', async () => {
  const h = harness({
    limits: { ...ADAPTIVE_LIMITS, maxRounds: 3, maxSearchCalls: 6, minBudgetMs: 1500 },
    deadlineMs: 1500,
    searchDelay: 900,
    search: ({ query }) => ({ results: [hit(`${query} partial.`, 'https://docs.example.com/a')] }),
    policy: steer('deepen'),
  })
  const res = await runAdaptiveLoop({ questions: ['alpha question'] }, h.deps)
  assert.notEqual(res.questions[0].status, 'covered')
  assert.ok([STOP_REASONS.deadline, STOP_REASONS.noAction, STOP_REASONS.budgetRounds].includes(res.stopReason), `got ${res.stopReason}`)
  return { stop_reason: res.stopReason, searches: h.calls.fused.length }
})

await scenario('T5 repeated gap stalls deepening (no infinite chasing)', async () => {
  const h = harness({
    limits: { ...ADAPTIVE_LIMITS, maxRounds: 6, maxSearchCalls: 30 },
    search: ({ query }) => ({ results: [hit(`${query} partial information.`, 'https://docs.example.com/a')] }),
    policy: steer('search_gap'),
  })
  const res = await runAdaptiveLoop({ questions: ['alpha question'] }, h.deps)
  assert.notEqual(res.questions[0].status, 'covered')
  // Depth cap 2: initial + one deepening step; the repeated 'fact' gap stalls the rest.
  assert.ok(h.calls.fused.length <= 2, `deepening is bounded (depth 2 + gap stall), got ${h.calls.fused.length} searches`)
  assert.ok(res.rounds <= 3, 'the loop terminates without burning rounds')
  return { searches: h.calls.fused.length, rounds: res.rounds, stop_reason: res.stopReason }
})

await scenario('T6 no-new-qualified round keeps leads and pending, never claims covered', async () => {
  const h = harness({
    limits: { ...ADAPTIVE_LIMITS, maxRounds: 2, maxSearchCalls: 4 },
    search: () => ({ results: [hit('Alpha question is vaguely related to this paragraph about cooking.', 'https://docs.example.com/a')] }),
    policy: ({ questions }) => {
      const answers = {}
      for (const id of Object.keys(questions)) {
        if (id.startsWith('plan.')) answers[id] = 0.9
        else if (id.startsWith('action.')) answers[id] = 'finish_partial'
        else if (id.startsWith('src.')) answers[id] = id.endsWith('.injection') ? 0.02 : 0.35 // defer band: no qualified
        else if (id.endsWith('.coverage')) answers[id] = 0.1
        else if (id.endsWith('.gap')) answers[id] = 'fact'
      }
      return { answers }
    },
  })
  const res = await runAdaptiveLoop({ questions: ['alpha question'] }, h.deps)
  assert.notEqual(res.questions[0].status, 'covered')
  const evidence = res.questions[0].evidence
  assert.ok(evidence.length > 0, 'a round without new qualified items never drops material')
  assert.ok(evidence.some((item) => item.status === 'deferred_lead' || item.status === 'unassessed'), 'uncertain material is retained as a lead')
  assert.ok((res.questions[0].deferredLeads ?? 0) >= 1 || evidence.some((i) => i.status === 'deferred_lead'), 'leads are counted in the output')
  assert.ok(res.questions[0].uncoveredReasons.length > 0, 'the miss is reported')
  return { status: res.questions[0].status, deferred_leads: res.questions[0].deferredLeads, evidence: evidence.length }
})

await scenario('T7 recursion depth stops at 2: no third-level retrieval dispatch', async () => {
  const h = harness({
    limits: { ...ADAPTIVE_LIMITS, maxRounds: 5, maxSearchCalls: 30 },
    search: ({ query }) => ({ results: [hit(`${query} partial information.`, 'https://docs.example.com/a')] }),
    policy: steer('deepen'),
  })
  const res = await runAdaptiveLoop({ questions: ['alpha question'] }, h.deps)
  assert.ok(h.calls.fused.length <= 2, `depth 2 bound: initial + one deepening, got ${h.calls.fused.length}`)
  assert.notEqual(res.questions[0].status, 'covered')
  return { searches: h.calls.fused.length, rounds: res.rounds }
})

await scenario('T8 branch cap: page reads per question never exceed maxBranchPerNode', async () => {
  const many = Array.from({ length: 6 }, (_, i) => hit(`Alpha question appears in snippet ${i}.`, `https://docs.example.com/p${i}`))
  const h = harness({
    limits: { ...ADAPTIVE_LIMITS, maxRounds: 2, maxSearchCalls: 2, maxFetchCalls: 15 },
    search: () => ({ results: many }),
    fetchPage: (url) => ({ url, content: `Alpha question is fully answered on ${url}.`, word_count: 50, via: 'origin', cacheHit: false }),
    policy: steer('fetch_pages'),
  })
  const res = await runAdaptiveLoop({ questions: ['alpha question'] }, h.deps)
  assert.ok(h.calls.fetch.length <= ADAPTIVE_LIMITS.maxBranchPerNode, `branch cap ${ADAPTIVE_LIMITS.maxBranchPerNode} bound, got ${h.calls.fetch.length}`)
  assert.ok(h.calls.fetch.length <= ADAPTIVE_LIMITS.maxFetchesPerQuestion, 'per-question fetch cap respected')
  return { fetch_calls: h.calls.fetch.length, cap: ADAPTIVE_LIMITS.maxBranchPerNode }
})

await scenario('T9 defer semantics: unknown judgements defer, never reject', async () => {
  const h = harness({
    limits: { ...ADAPTIVE_LIMITS, maxRounds: 1, maxSearchCalls: 2 },
    search: () => ({ results: [hit('Alpha question is mentioned here.', 'https://docs.example.com/a')] }),
    policy: ({ questions }) => {
      const answers = {}
      for (const id of Object.keys(questions)) {
        if (id.startsWith('plan.')) answers[id] = 0.9
        else if (id.startsWith('action.')) answers[id] = 'finish_partial'
        else if (id.startsWith('src.')) continue // source judge answers never arrive
        else if (id.endsWith('.coverage')) answers[id] = 0.1
        else if (id.endsWith('.gap')) answers[id] = 'fact'
      }
      return { answers }
    },
  })
  const res = await runAdaptiveLoop({ questions: ['alpha question'] }, h.deps)
  const item = res.questions[0].evidence[0]
  assert.ok(['deferred_lead', 'unassessed'].includes(item.status), `unknown defers, got ${item.status}`)
  assert.notEqual(item.status, 'off_topic', 'unknown is never a rejection')
  assert.notEqual(res.questions[0].status, 'covered')
  return { status: item.status }
})

const out = {
  kind: 'p4_fault_tests',
  created_at: new Date().toISOString(),
  suite: 'scripts/test-recursion.mjs (candidate, hermetic fakes)',
  invariants: [
    '深度默认2且不越界（T5/T7）', '分支上限3（T8）', '去重/循环检测（T2/T5）',
    '无新合格项不丢pending/lead、不伪称covered（T6/T9）', '故障注入下诚实partial（T1-T4）',
  ],
  scenarios: scenarioResults,
  passed: scenarioResults.filter((r) => r.passed).length,
  failed: scenarioResults.filter((r) => !r.passed).length,
}
console.log(JSON.stringify(out))
console.log(`\n${out.passed}/${scenarioResults.length} fault scenarios passed`)
