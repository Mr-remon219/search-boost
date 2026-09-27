#!/usr/bin/env node
/**
 * Evidence-funnel instrumentation tests — hermetic (scripted Jev, fake engines,
 * fake page fetch). They assert that every funnel stage is counted separately
 * and that the counts move with the actual pipeline behaviour:
 *   engine rows → merged candidates → pool associations → reviewed →
 *   qualified → coverage input → returned output.
 * Funnel numbers are observability only and never affect verdicts.
 */
import assert from 'node:assert/strict'

// HISTORICAL COMPARISON: the V2 keyword/fact controller is frozen here with
// retrievalMode:false. The default V3 reading-value controller is covered by
// scripts/test-retrieval*.mjs; this file is not evidence that V3 works.
const { runAdaptiveLoop } = await import('../lib/search/adaptive/loop.mjs')
const { fusedSearch } = await import('../lib/search/fusion.js')

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

const hit = (text, url, extra = {}) => ({ title: `Fixture ${url}`, url, snippet: text, score: 1, engines: ['bing'], ...extra })
const FREE = ['bing', 'ddg', 'yahoo', 'exa-free']
const API = ['tavily', 'brave', 'exa']
const DEFAULT_SOURCE = { relevant: 0.9, states_evidence: 0.9, premise_conflict: 0.05, injection: 0.02 }
const snapshot = () => ({
  capability: {
    defaultEnginePool: 'free',
    pools: { free: FREE, api: API, hybrid: [...FREE, ...API] },
    availableEngines: FREE,
  },
})

function makeFakeJev(policy, calls) {
  return {
    usage: () => ({ calls: 0, httpAttempts: 0, retries: 0, inputTokens: 0, outputTokens: 0, serverUsageCalls: 0 }),
    describe: () => ({ endpointOrigin: 'https://jev.fixture.invalid', model: 'jev-latest', configured: true }),
    async ask({ phase, state, questions }) {
      const outcome = await policy({ phase, state, questions, callIndex: calls.jev.length })
      calls.jev.push({ phase })
      if (outcome?.error) throw outcome.error
      const entries = new Map()
      const answers = outcome?.answers ?? {}
      for (const [id, spec] of Object.entries(questions)) {
        const value = answers[id]
        if (value === undefined) continue
        if (spec.type === 'noul') entries.set(id, { type: 'noul', value })
        else entries.set(id, { type: 'choice', choice: value, confidence: 0.9, probabilities: {} })
      }
      return { model: 'jev-fixture-1.0', entries, invalidIds: [], unknownIds: [], missingIds: [], shapeError: null, usage: { inputTokens: 1, outputTokens: 1 }, attempts: 1, requestChars: 10, tookMs: 1, phase }
    },
  }
}

const ANSWERS = (n) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`d${i}`, DEFAULT_SOURCE]).flatMap(([, s]) =>
  Object.entries(s).map(([k, v]) => [`d0.${k}`, v])))

await test('fusedSearch exposes additive funnel stage counts', async () => {
  const result = await fusedSearch({
    query: 'funnel probe', engines: ['bing', 'ddg'], maxResults: 2,
    runOne: async (engine, query, count) => {
      const rows = []
      for (let i = 0; i < 3; i++) rows.push(hit(`row ${engine} ${i}`, `https://fixture.test/${engine}/${i}`))
      return rows
    },
  })
  assert.ok(result.funnel, 'funnel block present')
  assert.equal(result.funnel.engineRowsRaw, 6, 'two engines x three rows counted before merge')
  assert.ok(result.funnel.uniqueCandidates <= 6, 'merge cannot create rows')
  assert.ok(result.funnel.selectedRows <= 2, 'selection respects maxResults')
  assert.ok(result.funnel.rankedRows >= result.funnel.selectedRows, 'ranked pool is at least the selected set')
})

await test('loop funnel separates every pipeline stage on a happy path', async () => {
  const calls = { jev: [] }
  const jev = makeFakeJev(({ phase, state, questions }) => {
    const answers = {}
    for (const id of Object.keys(questions)) {
      // Question ids are namespaced (src.<evidenceId>.<field>, cov.<qid>.<field>);
      // the field name is the last dot segment.
      const field = id.split('.').pop()
      answers[id] = DEFAULT_SOURCE[field] ?? 0.9
    }
    return { answers }
  }, calls)
  const fetched = []
  const result = await runAdaptiveLoop({ questions: ['What is the RiverDB 2.4 retry count and total request timeout?'] }, {
    jev,
    snapshot,
    runFused: async () => ({
      results: [
        hit('RiverDB version 2.4 retries temporary failures at most three times.', 'https://fixture.test/a'),
        hit('The total request timeout of RiverDB version 2.4 is 20 seconds.', 'https://fixture.test/b'),
        hit('An unrelated lemon cake recipe with a list of dessert ingredients.', 'https://fixture.test/c'),
      ],
      engineStats: { bing: { used: true, attempts: 1, successes: 1, errors: 0 } },
      funnel: { engineRowsRaw: 8, uniqueCandidates: 5, fusionRows: 4, selectedRows: 3, truncated: true },
      queriesUsed: ['q'], tier: 'medium', warnings: [], tookMs: 1,
    }),
    runFetchPage: async (url) => {
      fetched.push(url)
      return { content: `Full text for ${url} about retry count and timeout.`, word_count: 10, via: 'origin', cacheHit: false }
    },
    limits: { ...(await import('../lib/search/adaptive/limits.js')).ADAPTIVE_LIMITS, retrievalMode: false, maxRounds: 1, maxSearchCalls: 2, maxJevCalls: 6 },
  })
  const f = result.funnel
  assert.ok(f, 'funnel present in loop result')
  assert.equal(f.engine_returned_rows, 8, 'raw engine rows pass through')
  assert.equal(f.unique_candidates_after_merge, 5, 'post-merge count kept separately')
  assert.equal(f.fusion_truncated_calls, 1, 'truncation counted per search')
  assert.equal(f.search_calls, 1, 'search dispatch counted')
  assert.equal(f.associations_created, 3, 'three pool associations with text')
  assert.ok(f.reviewed_associations > 0, 'reviewed associations counted')
  assert.ok(f.qualified_associations > 0, 'qualified associations counted')
  assert.ok(f.returned_evidence > 0 && f.returned_evidence <= 6, 'output capped by the output limit, not by review volume')
  assert.equal(typeof f.pending_associations, 'number', 'unreviewed remainder is reported, not hidden')
  assert.equal(f.fetched_pages, fetched.length, 'page fetches are counted, never hidden')
  assert.equal(typeof result.evidence.answerCapable, 'number', 'verdict pipeline untouched by funnel instrumentation')
})

await test('funnel counts a stage as zero instead of guessing when fusion omits it', async () => {
  const calls = { jev: [] }
  const jev = makeFakeJev(() => ({ answers: {} }), calls)
  const result = await runAdaptiveLoop({ questions: ['Anything about retries?'] }, {
    jev,
    snapshot,
    runFused: async () => ({
      results: [hit('A retry fact.', 'https://fixture.test/x')],
      engineStats: { bing: { used: true, attempts: 1, successes: 1, errors: 0 } },
      queriesUsed: ['q'], tier: 'medium', warnings: [], tookMs: 1,
    }),
    runFetchPage: async () => ({ content: '', word_count: 0, via: null, cacheHit: true }),
    limits: { ...(await import('../lib/search/adaptive/limits.js')).ADAPTIVE_LIMITS, retrievalMode: false, maxRounds: 1, maxSearchCalls: 1, maxJevCalls: 2 },
  })
  assert.equal(result.funnel.engine_returned_rows, null, 'no fusion funnel -> unknown (null), never a fabricated zero')
  assert.equal(result.funnel.search_calls, 1)
})

console.log(`\n${tests} funnel tests passed`)
