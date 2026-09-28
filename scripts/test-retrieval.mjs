#!/usr/bin/env node
import './isolate-tests.mjs'
/**
 * Default adaptive_search retrieval mode — hermetic contract tests.
 *
 * Fake engines, fake page fetch, scripted Jev transport, fake clock: no network,
 * no real Jev. These check the reading-value controller's invariants (pointer
 * selection, keyword queue honesty, validation ordering, bounded batches and
 * pending disclosure). They are NOT web-quality or accuracy experiments, and no
 * test here claims live retrieval improvement.
 */
import assert from 'node:assert/strict'

const { runAdaptiveLoop, STOP_REASONS, REASONS, ADAPTIVE_RETRIEVAL_SCHEMA_VERSION } = await import('../lib/search/adaptive/loop.mjs')
const { ADAPTIVE_LIMITS, ADAPTIVE_THRESHOLDS } = await import('../lib/search/adaptive/limits.js')
const { normalizeAdaptiveInput, canonicalTargets } = await import('../lib/search/adaptive/input.js')
const { requestFits } = await import('../lib/search/adaptive/material.js')

let passed = 0
async function test(name, fn) {
  try {
    await fn()
    passed++
    console.log('ok', name)
  } catch (err) {
    console.error('FAIL', name, err)
    process.exitCode = 1
  }
}

const ENGINES = ['bing', 'ddg', 'yahoo']
const hit = (i, extra = {}) => ({
  url: `https://s${i}.test/a`,
  title: `Evidence ${i}`,
  snippet: `Useful pointer ${i}: the changelog and migration notes are worth opening for the requested behavior.`,
  score: 1,
  engines: ['bing'],
  ...extra,
})
const distinctHit = (i) => hit(i, { url: `https://source${i}.test/article`, snippet: `Pointer ${i}: page ${i} documents the release and includes the concrete recovery window.` })

const DEFAULT_SOURCE = {
  // retrieval-mode fields
  relevance: 0.9, reading_value: 0.8, injection: 0.02, direction_match: 0.9,
  // frozen legacy comparison fields
  relevant: 0.9, states_evidence: 0.9, premise_conflict: 0.02, support: 0.9, independent: 0.9, time_match: 0.9,
}
const DEFAULT_COVERAGE = { coverage: 0.9, gap: 'none', source_conflict: 0.02, snippet_self_sufficient: 0.9 }

/** Resolve `src.<evidenceId>.<field>` to its candidate reference and source. */
function candidateOf(state, id) {
  const evidenceId = id.split('.')[1]
  const ref = state.candidates.find((entry) => entry.id === evidenceId)
  if (!ref) return null
  return { ref, source: state.sources[ref.source_index], fragment: state.sources[ref.source_index].fragments[ref.fragment_index] }
}

function harness(options = {}) {
  const calls = { search: [], jev: [], fetch: [] }
  let count = 0
  const limits = { ...ADAPTIVE_LIMITS, ...(options.limits ?? {}) }
  const thresholds = { ...ADAPTIVE_THRESHOLDS, ...(options.thresholds ?? {}) }
  const available = options.available ?? ENGINES
  const deps = {
    limits,
    thresholds,
    signal: options.signal ?? null,
    onComplete: ({ evidence }) => { calls.evidence = evidence },
    snapshot: () => ({ capability: { defaultEnginePool: 'free', pools: { free: ENGINES }, availableEngines: available } }),
    runFused: async (args) => {
      calls.search.push(args)
      if (options.searchError) throw options.searchError
      const results = await (options.search?.(args, calls.search.length) ?? [hit(1)])
      return {
        results,
        enginesUsed: args.engineList,
        engineStats: options.engineStats ?? Object.fromEntries(args.engineList.map((engine) => [engine, { used: true, attempts: 1, successes: 1, errors: 0 }])),
      }
    },
    runFetchPage: async (url, focus) => {
      calls.fetch.push({ url, focus })
      return options.fetchPage ? options.fetchPage(url, focus, calls.fetch.length) : { content: '', word_count: 0 }
    },
    jev: {
      usage: () => ({ calls: count, httpAttempts: count, inputTokens: 0 }),
      ask: async ({ phase, state, questions }) => {
        count++
        calls.jev.push({ phase, state, questions, call: count })
        if (options.fail?.(phase, count)) throw new Error('injected failure')
        const entries = new Map()
        for (const [id, spec] of Object.entries(questions)) {
          let value = options.judge?.({ phase, id, spec, state, questions, call: count })
          if (value === 'omit') continue
          if (value === undefined) {
            if (phase === 'plan') value = spec.type === 'noul' ? 0.9 : Object.keys(spec.criteria)[0]
            else if (phase === 'source_judge') {
              if (/\.(kw|topic)\d+\.match$/.test(id)) value = 0.9
              else if (id.endsWith('.stance')) value = 'support'
              else if (id.endsWith('.kind')) value = 'lead'
              else value = DEFAULT_SOURCE[id.split('.').pop()]
            } else if (phase === 'keyword_judge') value = 'satisfied'
            else if (phase === 'coverage_judge') value = id.endsWith('.gap') ? DEFAULT_COVERAGE.gap : DEFAULT_COVERAGE[id.split('.').pop()]
            else value = undefined
          }
          if (value === undefined) continue
          entries.set(id, spec.type === 'noul' ? { type: 'noul', value } : { type: 'choice', choice: value, confidence: 0.9, probabilities: {} })
        }
        return { entries, model: 'hermetic', usage: { inputTokens: 0 }, attempts: 1, requestChars: JSON.stringify({ state, questions }).length }
      },
    },
  }
  return { calls, limits, thresholds, run: (input) => runAdaptiveLoop(input, deps) }
}

const TASK_INPUT = { tasks: [{ context: 'Testing pointer retrieval', targets: [{ id: 'a', keywords: ['alpha'], question: 'What is alpha about?' }] }] }

await test('default mode returns pointers as useful results with the v3 contract', async () => {
  const h = harness({ search: () => [distinctHit(1), distinctHit(2)] })
  const r = await h.run(TASK_INPUT)
  assert.equal(r.schemaVersion, ADAPTIVE_RETRIEVAL_SCHEMA_VERSION)
  assert.equal(r.tool, 'adaptive_search')
  assert.equal(r.retrievalSufficient, true)
  assert.equal(r.stopReason, STOP_REASONS.keywordQueueEmpty)
  assert.equal(r.questions[0].status, 'satisfied')
  const [progress] = r.questions[0].keywordProgress
  assert.equal(progress.keyword, 'alpha')
  assert.equal(progress.status, 'satisfied')
  assert.equal(progress.reason, REASONS.keywordSatisfied)
  for (const field of ['score', 'A', 'F', 'R', 'distinct']) assert.equal(typeof progress[field], 'number', `keywordProgress.${field}`)
  assert.equal(r.questions[0].id, 'q1')
  assert.equal(r.questions[0].canonicalId, 'q1')
  assert.equal(r.questions[0].taskId, 't1')
  assert.equal(r.questions[0].targetId, 'a')
  assert.equal(r.questions[0].question, 'Testing pointer retrieval\nWhat is alpha about?')
  // The default mode must not expose fact/coverage completion gates.
  assert.ok(!h.calls.jev.some((call) => call.phase === 'fact_bundle'))
  assert.ok(!h.calls.jev.some((call) => call.phase === 'coverage_judge'))
  assert.ok(!('ready' in progress) && !('missingFacts' in progress) && !('factProgress' in progress))
  assert.ok(!JSON.stringify(r).includes('missingFacts'))
  assert.ok(!JSON.stringify(r).includes('"covered"'))
  // onComplete receives the full approved pool with the reading-value fields.
  const eligible = h.calls.evidence.filter((item) => item.status === 'useful_result')
  assert.equal(eligible.length, 2)
  for (const item of eligible) {
    assert.equal(item.assessed, true)
    assert.ok(item.reviewedText.length > 20, 'reviewedText is the exact reviewed extract')
    assert.equal(typeof item.valueScore, 'number')
    assert.equal(item.kind, 'lead')
    assert.equal(item.judgment.kind, 'lead')
    assert.equal(typeof item.judgment.relevance, 'number')
    assert.equal(typeof item.judgment.reading_value, 'number')
    assert.equal(item.canonicalId, 'q1')
    assert.equal(item.taskId, 't1')
    assert.equal(item.targetId, 'a')
    assert.ok(Array.isArray(item.judgment.keywords) && item.judgment.keywords[0].keyword === 'alpha')
  }
  // A pointer without any answer fact is enough: no acceptance fact was ever supplied.
  assert.equal(h.calls.search.length, 1)
  assert.equal(h.calls.search[0].maxResults, ADAPTIVE_LIMITS.maxPoolRowsPerRound)
  // No default fetching / citation chasing in the reading-value controller.
  assert.equal(r.usage.fetchCalls, 0)
  assert.equal(r.usage.fetchReads, 0)
  assert.equal(h.calls.fetch.length, 0)
})

await test('intent adds a direction bonus, is judged (never queried) and separates canonical keys', async () => {
  const INTENT = 'Prefer official migration guides over forum speculation about beta'
  const h = harness({ search: () => [distinctHit(1)] })
  const r = await h.run({ intent: INTENT, questions: ['What does alpha do?'] })
  const sourceCalls = h.calls.jev.filter((call) => call.phase === 'source_judge')
  assert.ok(sourceCalls.length > 0)
  assert.ok(sourceCalls.every((call) => call.state.questions[0].intent === INTENT))
  assert.ok(Object.keys(sourceCalls[0].questions).some((id) => id.endsWith('.direction_match')))
  // Intent is judgement context only: it is never concatenated into an engine query.
  assert.ok(h.calls.search.every((args) => !args.query.includes('forum speculation')))
  const [progress] = r.questions[0].keywordProgress
  const q = progress.match ?? null
  assert.equal(q, null, 'keywordProgress does not publish a raw match field')
  assert.ok(progress.score > 0)
  // d = .9 with intent: u = .8 * (1 - .2 + .2*.9) = .784, A = .784 * .9
  assert.ok(Math.abs(progress.A - 0.784 * 0.9) < 1e-9, `A=${progress.A}`)
  const row = h.calls.evidence.find((item) => item.status === 'useful_result')
  assert.equal(row.judgment.direction_match, 0.9)
  assert.ok(Math.abs(row.valueScore - 0.784) < 1e-9)
  // Same question, different intent: different execution identity.
  const both = harness({ search: () => [distinctHit(1)] })
  const two = await both.run({ questions: ['Same question?', 'Same question?'], keywords: [['alpha'], ['beta']] })
  assert.notEqual(two.questions[0].canonicalId, two.questions[1].canonicalId)
  const intents = canonicalTargets(normalizeAdaptiveInput({ questions: ['same'], keywords: ['k'], intent: 'one' }).targets.concat(normalizeAdaptiveInput({ questions: ['same'], keywords: ['k'], intent: 'two' }).targets))
  assert.equal(intents.length, 2)
  assert.equal(intents[0].intent, 'one')
  assert.equal(intents[1].intent, 'two')
  // Root and target intent combine for judgements (and for the canonical key).
  const combined = harness({ search: () => [distinctHit(1)] })
  await combined.run({ intent: 'root preference', tasks: [{ context: 'Testing', targets: [{ id: 'a', keywords: ['alpha'], question: 'Alpha?', intent: 'target preference' }] }] })
  const combinedIntent = combined.calls.jev.find((call) => call.phase === 'source_judge').state.questions[0].intent
  assert.equal(combinedIntent, 'root preference\ntarget preference')
})

await test('missing intent is neutral: u = min(r,v) and no direction question is asked', async () => {
  const h = harness({ search: () => [distinctHit(1)] })
  const r = await h.run({ questions: ['What does alpha do?'] })
  assert.ok(h.calls.jev.filter((call) => call.phase === 'source_judge').every((call) => !Object.keys(call.questions).some((id) => id.endsWith('.direction_match'))))
  assert.equal(r.retrievalSufficient, true)
  const [progress] = r.questions[0].keywordProgress
  assert.ok(Math.abs(progress.A - 0.8 * 0.9) < 1e-9, `A=${progress.A}`)
  const row = h.calls.evidence.find((item) => item.status === 'useful_result')
  assert.equal(row.judgment.direction_match, null)
  assert.ok(Math.abs(row.valueScore - 0.8) < 1e-9)
})

await test('counterevidence is kept (d is usefulness for the intent, not agreement) and low reading value is dropped', async () => {
  const counter = { ...distinctHit(1), url: 'https://critical.test/analysis', snippet: 'The claim that alpha shipped is contradicted by the archived release notes and their explicit rollback notice.' }
  const fluff = { ...distinctHit(2), url: 'https://fluff.test/page', snippet: 'Alpha alpha alpha alpha alpha alpha alpha alpha alpha alpha alpha alpha alpha alpha.' }
  const h = harness({
    search: () => [counter, fluff],
    judge: ({ phase, id, state }) => {
      if (phase !== 'source_judge') return undefined
      const found = candidateOf(state, id)
      const url = found?.source?.url ?? ''
      if (url.includes('critical.test')) {
        if (id.endsWith('.kind')) return 'counterevidence'
        if (id.endsWith('.direction_match')) return 0.95
        if (id.endsWith('.relevance')) return 0.92
        if (id.endsWith('.reading_value')) return 0.8
        if (id.endsWith('.injection')) return 0.02
        if (/\.kw\d+\.match$/.test(id)) return 0.9
      }
      if (url.includes('fluff.test')) {
        if (id.endsWith('.kind')) return 'context'
        if (id.endsWith('.direction_match')) return 0.1
        if (id.endsWith('.relevance')) return 0.7
        if (id.endsWith('.reading_value')) return 0.2
        if (id.endsWith('.injection')) return 0.02
        if (/\.kw\d+\.match$/.test(id)) return 0.9
      }
      return undefined
    },
  })
  const r = await h.run({ intent: 'Decide whether alpha really shipped', questions: ['Did alpha ship?'] })
  assert.equal(r.retrievalSufficient, true)
  const beneficial = h.calls.evidence.filter((item) => item.status === 'useful_result')
  assert.equal(beneficial.length, 1)
  assert.equal(beneficial[0].kind, 'counterevidence')
  assert.equal(beneficial[0].judgment.relevance, 0.92)
  assert.equal(beneficial[0].judgment.direction_match, 0.95)
  const dropped = h.calls.evidence.find((item) => item.url.includes('fluff.test'))
  assert.equal(dropped.status, 'off_topic')
  assert.equal(dropped.valueScore, null)
})

await test('d = 0 keeps an otherwise useful result; it only loses the direction bonus', async () => {
  const h = harness({
    search: () => [distinctHit(1)],
    judge: ({ phase, id }) => {
      if (phase !== 'source_judge') return undefined
      if (id.endsWith('.direction_match')) return 0
      return undefined
    },
  })
  const r = await h.run({ intent: 'Something the page does not help with', questions: ['What does alpha do?'] })
  assert.equal(r.retrievalSufficient, true)
  const row = h.calls.evidence.find((item) => item.status === 'useful_result')
  assert.equal(row.judgment.direction_match, 0)
  assert.ok(Math.abs(row.valueScore - 0.8 * 0.8) < 1e-9, `valueScore=${row.valueScore}`)
})

await test('unknown mandatory values fail closed instead of reading as a low score', async () => {
  for (const field of ['relevance', 'reading_value', 'injection']) {
    const h = harness({
      search: () => [distinctHit(1)],
      // 'omit' removes the answer entirely, which is exactly an unknown judgement.
      judge: ({ phase, id }) => (phase === 'source_judge' && id.endsWith(`.${field}`) ? 'omit' : undefined),
    })
    const r = await h.run({ questions: ['What does alpha do?'] })
    const row = h.calls.evidence.find((item) => item.textBasis)
    assert.notEqual(row.status, 'useful_result', `unknown ${field} must not be useful`)
    assert.equal(row.valueScore, null)
    assert.notEqual(r.questions[0].status, 'satisfied')
    assert.equal(r.retrievalSufficient, false)
    assert.ok(r.questions[0].keywordProgress[0].A === 0, 'an unknown mandatory value earns no credit')
    assert.ok(r.warnings.some((warning) => warning.includes('without a current qualified useful result')))
  }
  // A known injection above the gate is excluded, not read as a low score.
  const h = harness({ search: () => [distinctHit(1)], judge: ({ phase, id }) => (phase === 'source_judge' && id.endsWith('.injection') ? 0.95 : undefined) })
  const r = await h.run({ questions: ['What does alpha do?'] })
  const excluded = h.calls.evidence.find((item) => item.status === 'excluded_injection')
  assert.ok(excluded, 'an injection above the gate is excluded, not useful')
  assert.equal(r.retrievalSufficient, false)
})

await test('a satisfied answer without current qualified material cannot close a keyword', async () => {
  const h = harness({
    search: () => [distinctHit(1)],
    judge: ({ phase, id }) => {
      if (phase === 'source_judge' && /\.kw\d+\.match$/.test(id)) return 0.2
      if (phase === 'keyword_judge') return 'satisfied'
      return undefined
    },
    limits: { maxRounds: 2 },
  })
  const r = await h.run(TASK_INPUT)
  assert.equal(r.retrievalSufficient, false)
  assert.notEqual(r.questions[0].status, 'satisfied')
  assert.equal(r.questions[0].keywordProgress[0].status, 'continue')
  assert.equal(r.questions[0].keywordProgress[0].reason, REASONS.keywordDecisionUnqualified)
  assert.ok(r.questions[0].keywordProgress[0].history.some((entry) => entry.reason === REASONS.keywordDecisionUnqualified))
  assert.ok(r.warnings.some((warning) => warning.includes('without a current qualified useful result')))
  assert.notEqual(r.stopReason, STOP_REASONS.keywordQueueEmpty)
  assert.ok([STOP_REASONS.noAction, STOP_REASONS.budgetRounds].includes(r.stopReason), r.stopReason)
})

await test('exhausted is a typed answer only, and a mixed queue stops without claiming sufficiency', async () => {
  const h = harness({
    search: () => [distinctHit(1)],
    judge: ({ phase, id }) => (phase === 'keyword_judge' ? (id.endsWith('.0') ? 'satisfied' : 'exhausted') : undefined),
  })
  const r = await h.run({ tasks: [{ context: 'Testing', targets: [{ id: 'a', keywords: ['alpha', 'beta'], question: 'Alpha or beta?' }] }] })
  const progress = r.questions[0].keywordProgress
  assert.deepEqual(progress.map((entry) => entry.status), ['satisfied', 'exhausted'])
  assert.equal(r.stopReason, STOP_REASONS.keywordQueueEmpty)
  assert.equal(r.retrievalSufficient, false, 'a mixed satisfied+exhausted queue is not sufficient')
  assert.equal(r.questions[0].status, 'partial')
  assert.ok(r.stopDetail.includes('not proof of absence'))
})

await test('provider failure never manufactures exhaustion, and budget/Jev failures stay pending', async () => {
  const failedSearch = harness({ searchError: new Error('all engines down') })
  const failed = await failedSearch.run(TASK_INPUT)
  assert.notEqual(failed.stopReason, STOP_REASONS.keywordQueueEmpty)
  assert.ok(failed.questions[0].keywordProgress.every((entry) => entry.status !== 'exhausted'))
  assert.equal(failed.retrievalSufficient, false)

  const budget = harness({
    search: () => [distinctHit(1)],
    limits: { maxJevCalls: 2, maxRounds: 2 },
  })
  const stopped = await budget.run(TASK_INPUT)
  assert.ok(stopped.usage.jevCalls <= 2)
  assert.ok(stopped.questions[0].keywordProgress.every((entry) => entry.status !== 'exhausted'), 'a budget stop is not exhaustion')
  assert.equal(stopped.retrievalSufficient, false)
  assert.ok(stopped.questions[0].keywordProgress.some((entry) => ['pending', 'continue'].includes(entry.status)))

  const jevFailed = harness({ search: () => [distinctHit(1)], fail: (phase) => phase === 'keyword_judge' })
  const crashed = await jevFailed.run(TASK_INPUT)
  assert.equal(crashed.stopReason, STOP_REASONS.jevUnavailable)
  assert.equal(crashed.questions[0].keywordProgress[0].status, 'pending')
  assert.equal(crashed.questions[0].status, 'pending')
  assert.equal(crashed.retrievalSufficient, false)
  assert.ok(crashed.questions[0].pendingKeywords > 0)
})

await test('two keywords: one satisfied does not finish the other, and the next round targets the open one', async () => {
  const h = harness({
    search: (args, n) => (n === 1 ? [distinctHit(1)] : [distinctHit(5)]),
    judge: ({ phase, id, state }) => {
      if (phase === 'source_judge' && /\.kw\d+\.match$/.test(id)) {
        const index = Number(/\.kw(\d+)\./.exec(id)[1])
        if (index === 0) return 0.9
        // beta earns a match only on material added by the second round.
        const found = candidateOf(state, id)
        return (found?.source?.url ?? '').includes('source5.test') ? 0.9 : 0.1
      }
      if (phase === 'keyword_judge') {
        const index = Number(/\.(\d+)$/.exec(id)[1])
        if (index === 0) return 'satisfied'
        const betaAsks = h.calls.jev.filter((call) => call.phase === 'keyword_judge' && call.state.keyword_states.some((entry) => entry.keyword === 'beta'))
        return betaAsks.length >= 2 ? 'satisfied' : 'continue'
      }
      return undefined
    },
    limits: { maxRounds: 3 },
  })
  const r = await h.run({ tasks: [{ context: 'Testing', targets: [{ id: 'a', keywords: ['alpha', 'beta'], question: 'Alpha or beta?' }] }] })
  assert.ok(r.rounds >= 2, `rounds=${r.rounds}`)
  assert.equal(r.questions[0].status, 'satisfied')
  assert.equal(r.retrievalSufficient, true)
  // Round 2 adds beta material only after the still-open keyword was searched.
  const secondSearch = h.calls.search[1]
  assert.ok(secondSearch && secondSearch.query.includes('beta'), secondSearch?.query)
  assert.ok(h.calls.jev.filter((call) => call.phase === 'keyword_judge').length >= 2)
})

await test('changed text invalidates a prior satisfied; unchanged material never reopens it', async () => {
  const twoKeywords = { tasks: [{ context: 'Testing', targets: [{ id: 'a', keywords: ['alpha', 'beta'], question: 'Alpha and beta?' }] }] }
  const build = (mutate) => {
    const ref = {}
    ref.h = harness({
      search: (args, n) => (n === 1
        ? [distinctHit(1)]
        : [mutate ? { ...distinctHit(1), content: `${distinctHit(1).snippet}\n\nA newly reviewed paragraph changes the stored text version for this source.` } : distinctHit(1), distinctHit(2)]),
      judge: ({ phase, id, state }) => {
        if (phase === 'source_judge') {
          if (/\.kw\d+\.match$/.test(id)) {
            const index = Number(/\.kw(\d+)\./.exec(id)[1])
            if (index === 0) return 0.9
            // beta earns a match only after the second round adds its own material.
            const found = candidateOf(state, id)
            return (found?.source?.url ?? '').includes('source2.test') ? 0.9 : 0.1
          }
          return undefined
        }
        if (phase === 'keyword_judge') {
          const index = Number(/\.(\d+)$/.exec(id)[1])
          if (index === 1) return 'satisfied'
          const alphaAsks = ref.h.calls.jev.filter((entry) => entry.phase === 'keyword_judge' && entry.state.keyword_states.some((s) => s.keyword === 'alpha'))
          return alphaAsks.length >= 2 ? 'continue' : 'satisfied'
        }
        return undefined
      },
      limits: { maxRounds: 3, maxNoProgressRounds: 3 },
    })
    return ref.h
  }
  const stable = build(false)
  const stableResult = await stable.run(twoKeywords)
  // alpha was satisfied once and never re-asked while its material stayed identical.
  const stableAsks = stable.calls.jev.filter((call) => call.phase === 'keyword_judge' && call.state.keyword_states.some((state) => state.keyword === 'alpha'))
  assert.equal(stableAsks.length, 1)
  assert.equal(stableResult.retrievalSufficient, true)

  const changed = build(true)
  const changedResult = await changed.run(twoKeywords)
  const changedAsks = changed.calls.jev.filter((call) => call.phase === 'keyword_judge' && call.state.keyword_states.some((state) => state.keyword === 'alpha'))
  assert.ok(changedAsks.length >= 2, 'changed text reopens the keyword for a new decision')
  assert.equal(changedResult.retrievalSufficient, false)
  assert.equal(changedResult.questions[0].keywordProgress[0].status, 'continue')
  assert.ok(changedResult.questions[0].keywordProgress[0].history.length >= 2)
})

await test('root keywords and intents are validated before any I/O', async () => {
  const limits = ADAPTIVE_LIMITS
  assert.equal(normalizeAdaptiveInput({ questions: ['one'], keywords: ['k1', 'k2'] }, limits).targets[0].keywords.length, 2)
  assert.deepEqual(normalizeAdaptiveInput({ questions: ['one'] }, limits).targets[0].keywords, [])
  assert.match(normalizeAdaptiveInput({ questions: ['one', 'two'], keywords: ['k1'] }, limits).error, /flat keywords/)
  assert.match(normalizeAdaptiveInput({ questions: ['one', 'two'], keywords: [['k1']] }, limits).error, /aligned/)
  assert.match(normalizeAdaptiveInput({ questions: ['one'], keywords: ['k'.repeat(101)] }, limits).error, /1-4 nonblank/)
  assert.match(normalizeAdaptiveInput({ questions: ['one'], keywords: [] }, limits).error, /non-empty/)
  assert.match(normalizeAdaptiveInput({ questions: ['one'], keywords: Array(5).fill('k') }, limits).error, /1-4 nonblank/)
  assert.match(normalizeAdaptiveInput({ tasks: [{ context: 'c', targets: [{ id: 'a', keywords: ['k'], question: 'q' }] }], keywords: ['k'] }, limits).error, /never with tasks/)
  assert.match(normalizeAdaptiveInput({ questions: ['one'], intent: 'x'.repeat(2001) }, limits).error, /intent/)
  assert.match(normalizeAdaptiveInput({ questions: ['one'], intent: '   ' }, limits).error, /intent/)
  assert.match(normalizeAdaptiveInput({ tasks: [{ context: 'c', targets: [{ id: 'a', keywords: ['k'], question: 'q', intent: 'x'.repeat(1001) }] }] }, limits).error, /intent in target/)
  assert.match(normalizeAdaptiveInput({ questions: ['one'], unknown: true }, limits).error, /Unknown/)
  // The strategy switch is never a tool parameter.
  assert.match(normalizeAdaptiveInput({ questions: ['one'], retrievalMode: false }, limits).error, /Unknown/)
  assert.match(normalizeAdaptiveInput({ questions: ['one'], keywordAccumulation: false }, limits).error, /Unknown/)
  const aligned = normalizeAdaptiveInput({ questions: ['one', 'two'], keywords: [['k1'], ['k2', 'k3']] }, limits)
  assert.deepEqual(aligned.targets.map((target) => target.keywords), [['k1'], ['k2', 'k3']])
  // Omitted keywords mean the question itself is the retrieval unit.
  const h = harness({ search: () => [distinctHit(1)] })
  const r = await h.run({ questions: ['What is the alpha rollout schedule?'] })
  assert.deepEqual(r.questions[0].keywordProgress.map((entry) => entry.keyword), ['What is the alpha rollout schedule?'])
  assert.equal(r.retrievalSufficient, true)
  // Validation errors are honest and make no request at all.
  const invalid = harness({})
  const early = await invalid.run({ questions: ['one', 'two'], keywords: ['flat'] })
  assert.equal(early.schemaVersion, ADAPTIVE_RETRIEVAL_SCHEMA_VERSION)
  assert.equal(early.retrievalSufficient, false)
  assert.equal(early.stopReason, STOP_REASONS.invalidInput)
  assert.equal(invalid.calls.search.length, 0)
  assert.equal(invalid.calls.jev.length, 0)
  const noJev = await (async () => {
    const { runAdaptiveLoop: runNoJev } = await import('../lib/search/adaptive/loop.mjs')
    return runNoJev({ questions: ['alpha?'] }, { jev: null })
  })()
  assert.equal(noJev.retrievalSufficient, false)
  assert.equal(noJev.stopReason, STOP_REASONS.notConfigured)
})

await test('caller facts are optional topics, never completion gates', async () => {
  const h = harness({
    search: () => [distinctHit(1)],
    judge: ({ phase, id }) => {
      if (phase === 'source_judge' && /\.topic\d+\.match$/.test(id)) return 0.2
      return undefined
    },
  })
  const r = await h.run({ tasks: [{ context: 'Testing', targets: [{ id: 'a', keywords: ['alpha'], question: 'Describe alpha behavior', facts: [{ id: 'cancel', question: 'Is the task cancelled?' }] }] }] })
  const sourceCalls = h.calls.jev.filter((call) => call.phase === 'source_judge')
  assert.ok(sourceCalls.length > 0)
  assert.ok(Object.keys(sourceCalls[0].questions).some((id) => /\.topic0\.match$/.test(id)))
  assert.ok(!Object.keys(sourceCalls[0].questions).some((id) => /\.(support|stance|independent)$/.test(id)), 'facts never become support/stance/provenance triples')
  assert.ok(sourceCalls[0].state.questions[0].topics.length === 1)
  assert.ok(!('facts' in sourceCalls[0].state.questions[0]), 'no generated acceptance facts in retrieval mode')
  assert.ok(!h.calls.jev.some((call) => call.phase === 'fact_bundle'))
  assert.ok(!h.calls.jev.some((call) => call.phase === 'coverage_judge'))
  // An unmatched optional topic adds no F, but the keyword is still satisfied by
  // its own qualified material: facts are not a required acceptance gate.
  assert.equal(r.questions[0].keywordProgress[0].F, 0)
  assert.ok(r.questions[0].keywordProgress[0].A > 0)
  assert.equal(r.retrievalSufficient, true)
})

await test('keyword continuation is one typed choice per open keyword, never an emptiness question', async () => {
  const h = harness({ search: () => [distinctHit(1), distinctHit(2)] })
  await h.run({ tasks: [{ context: 'Testing', targets: [{ id: 'a', keywords: ['alpha', 'beta'], question: 'Alpha and beta?' }] }] })
  const calls = h.calls.jev.filter((call) => call.phase === 'keyword_judge')
  assert.equal(calls.length, 1)
  const [call] = calls
  assert.ok(call.state.keyword_states.length >= 1, 'code never asks about an empty keyword list')
  for (const entry of Object.entries(call.questions)) {
    assert.equal(entry[1].type, 'choice')
    assert.deepEqual(Object.keys(entry[1].criteria).sort(), ['continue', 'exhausted', 'satisfied'])
  }
  const ids = Object.keys(call.questions)
  assert.deepEqual(ids.sort(), ['kw.q1.0', 'kw.q1.1'])
  for (const [stateIndex, mapping] of call.state.keyword_states.entries()) assert.ok(ids.includes(`kw.${mapping.question_id}.${stateIndex}`))
  assert.ok(call.state.keyword_states.every((entry) => Number.isInteger(entry.useful_results) && Number.isInteger(entry.distinct_groups)))
})

await test('pending material is drained before another search is dispatched', async () => {
  const h = harness({
    search: () => Array.from({ length: 120 }, (_, i) => distinctHit(i)),
    limits: { maxJevCalls: 2, maxRounds: 3, maxSourceJudgeCandidatesPerRequest: 4 },
  })
  const r = await h.run(TASK_INPUT)
  assert.equal(h.calls.search.length, 1, 'no redundant re-search while reviewed material is pending')
  assert.ok(r.funnel.pending_associations > 0)
  assert.ok(r.questions[0].pendingKeywords > 0 || r.questions[0].openKeywords > 0)
  assert.equal(r.retrievalSufficient, false)
})

await test('per-round pool, byte, token, call and HTTP caps all hold', async () => {
  const h = harness({
    search: () => Array.from({ length: 500 }, (_, i) => distinctHit(i)),
    limits: { maxRounds: 1, maxJevCalls: 6, maxSourceJudgeCandidatesPerRequest: 24 },
  })
  const r = await h.run(TASK_INPUT)
  assert.equal(h.calls.search[0].maxResults, 500)
  assert.equal(h.calls.search[0].maxResultsCap, 500)
  assert.ok(r.evidence.sources <= 500)
  assert.ok(h.calls.jev.length <= 6)
  assert.ok(h.calls.jev.every((call) => requestFits(call, h.limits)), 'every request stays inside the serialized byte budget')
  assert.ok(r.usage.jevInputTokensEstimated <= ADAPTIVE_LIMITS.maxJevInputTokens)
  assert.ok(r.usage.jevCalls <= ADAPTIVE_LIMITS.maxJevCalls)
  assert.ok(r.usage.jevHttpAttempts <= ADAPTIVE_LIMITS.maxJevHttpAttempts)
  assert.ok(JSON.stringify(r).length <= ADAPTIVE_LIMITS.maxOutputChars)
})

await test('500 synthetic candidates across many targets stay bounded and disclose pending work', async () => {
  const tasks = [0, 1].map((taskIndex) => ({
    context: `Pressure task ${taskIndex}`,
    targets: Array.from({ length: 3 }, (_, i) => ({ id: `target${taskIndex}${i}`, keywords: [`kw${taskIndex}${i}`, `alt${taskIndex}${i}`], question: `Describe behavior ${taskIndex}${i}` })),
  }))
  const h = harness({
    search: (args, n) => Array.from({ length: args.maxResults }, (_, i) => distinctHit((n - 1) * 500 + i)),
    limits: { maxRounds: 1, maxJevCalls: 6, maxSourceJudgeCandidatesPerRequest: 8 },
  })
  const r = await h.run({ tasks })
  assert.equal(r.questions.length, 6)
  assert.equal(r.evidence.sources, 500, 'the 500 unique-URL pool is global, not per target')
  assert.ok(r.funnel.pending_associations > 0)
  assert.equal(r.retrievalSufficient, false)
  assert.ok(r.questions.every((question) => ['pending', 'partial', 'exhausted'].includes(question.status)))
  assert.ok(r.questions.some((question) => question.pendingKeywords > 0 || question.openKeywords > 0))
  assert.ok(r.uncovered.length > 0)
  assert.ok(r.usage.jevCalls <= 6)
  assert.ok(JSON.stringify(r).length <= ADAPTIVE_LIMITS.maxOutputChars)
})

await test('source-judge rotation keeps later targets judged instead of starving them', async () => {
  const h = harness({
    search: (args, n) => [distinctHit(n)],
    limits: { maxRounds: 1, maxJevCalls: 6, maxSourceJudgeCandidatesPerRequest: 1 },
  })
  const r = await h.run({ tasks: [{ context: 'Testing', targets: [{ id: 'a', keywords: ['alpha'], question: 'Alpha?' }, { id: 'b', keywords: ['beta'], question: 'Beta?' }] }] })
  const sourceCalls = h.calls.jev.filter((call) => call.phase === 'source_judge')
  assert.deepEqual(sourceCalls.slice(0, 2).map((call) => call.state.candidates[0].for_question), ['q1', 'q2'])
  assert.ok(sourceCalls.length >= 2)
  assert.ok(r.questions.every((question) => question.keywordProgress.length === 1))
  assert.ok(r.questions.every((question) => question.evidenceCount >= 1))
})

await test('default mode never runs the fact or coverage judges under a two-target mix', async () => {
  const h = harness({ search: (args, n) => [distinctHit(n), distinctHit(n + 50)] })
  const r = await h.run({ tasks: [{ context: 'Testing', targets: [{ id: 'a', keywords: ['alpha'], question: 'Alpha?' }, { id: 'b', keywords: ['beta'], question: 'Beta?' }] }] })
  assert.deepEqual([...new Set(h.calls.jev.map((call) => call.phase))].sort(), ['keyword_judge', 'plan', 'source_judge'])
  assert.equal(r.retrievalSufficient, true)
  assert.ok(r.questions.every((question) => question.status === 'satisfied'))
  assert.equal(r.uncovered.length, 0)
})

await test('frozen legacy comparison mode is reachable only through internal limits', async () => {
  const legacy = harness({ search: () => [distinctHit(1)], limits: { retrievalMode: false, maxRounds: 1 } })
  const r = await legacy.run(TASK_INPUT)
  assert.equal(r.schemaVersion, 2)
  assert.ok(!('retrievalSufficient' in r))
  assert.ok(r.questions[0].keywordProgress[0].ready === true || r.questions[0].keywordProgress[0].ready === false)
  assert.ok(legacy.calls.jev.some((call) => call.phase === 'coverage_judge'))
  const factless = harness({ search: () => [distinctHit(1)], limits: { keywordAccumulation: false, maxRounds: 1 } })
  const v1 = await factless.run({ questions: ['What does alpha do?'] })
  assert.equal(v1.schemaVersion, 2)
  assert.ok(!('retrievalSufficient' in v1))
})

await test('a missing continuation answer stays pending and is retried before another search', async () => {
  let keywordJudgeCalls = 0
  const h = harness({
    search: () => [distinctHit(1)],
    judge: ({ phase }) => {
      if (phase !== 'keyword_judge') return undefined
      keywordJudgeCalls++
      return keywordJudgeCalls === 1 ? 'omit' : 'satisfied'
    },
    limits: { maxRounds: 3 },
  })
  const r = await h.run(TASK_INPUT)
  assert.equal(h.calls.jev.filter((call) => call.phase === 'keyword_judge').length, 2, 'the pending decision is retried')
  assert.equal(h.calls.search.length, 1, 'no redundant search while only a decision is unresolved')
  assert.deepEqual(r.questions[0].keywordProgress[0].history.map((entry) => entry.status), ['pending', 'satisfied'])
  assert.equal(r.questions[0].keywordProgress[0].status, 'satisfied')
  assert.equal(r.retrievalSufficient, true)
})

await test('explicit date windows still gate reading value', async () => {
  const run = async (extra) => {
    const h = harness({ search: () => [{ ...distinctHit(1), ...extra }], limits: { maxRounds: 1 } })
    const r = await h.run({ tasks: [{ context: 'Release watch', time_range: { start: '2026-01-01', end: '2026-01-31', basis: 'published' }, targets: [{ id: 'a', keywords: ['alpha'], question: 'What shipped?' }] }] })
    return { h, r, row: h.calls.evidence.find((item) => item.textBasis) }
  }
  const unknown = await run({})
  assert.equal(unknown.row.status, 'date_unqualified')
  assert.equal(unknown.row.valueScore, null)
  assert.equal(unknown.r.retrievalSufficient, false)
  const eligible = await run({ published: '2026-01-15' })
  assert.equal(eligible.row.status, 'useful_result')
  assert.equal(eligible.r.retrievalSufficient, true)
})

await test('source draining reserves bounded continuation-decision headroom and stays honest', async () => {
  const h = harness({
    search: () => Array.from({ length: 100 }, (_, i) => distinctHit(i)),
    judge: ({ phase }) => (phase === 'keyword_judge' ? 'continue' : undefined),
    limits: { maxRounds: 2, maxJevCalls: 3 },
  })
  const r = await h.run(TASK_INPUT)
  assert.ok(h.calls.jev.some((call) => call.phase === 'keyword_judge'), 'the reserved decision still ran inside the same cap')
  assert.ok(r.warnings.some((warning) => warning.includes('continuation-decision headroom')))
  assert.ok(r.funnel.pending_associations > 0, 'undrained material stays pending, never silently dropped')
  const keyword = r.questions[0].keywordProgress[0]
  assert.ok(['continue', 'pending'].includes(keyword.status), keyword.status)
  assert.ok([REASONS.keywordContinue, REASONS.keywordPending].includes(keyword.reason), keyword.reason)
  assert.equal(r.retrievalSufficient, false)
  assert.ok(r.usage.jevCalls <= 3)
})

await test('one keyword_judge request covers every open target fairly', async () => {
  const h = harness({
    search: (args, n) => [distinctHit(n), distinctHit(n + 20)],
    judge: ({ phase, id }) => (phase === 'keyword_judge' ? 'continue' : undefined),
    limits: { maxRounds: 1 },
  })
  await h.run({ tasks: [{ context: 'Testing', targets: [{ id: 'a', keywords: ['alpha'], question: 'Alpha?' }, { id: 'b', keywords: ['beta'], question: 'Beta?' }] }] })
  const calls = h.calls.jev.filter((call) => call.phase === 'keyword_judge')
  assert.equal(calls.length, 1)
  assert.deepEqual(Object.keys(calls[0].questions).sort(), ['kw.q1.0', 'kw.q2.0'])
  assert.deepEqual(calls[0].state.keyword_states.map((entry) => entry.question_id).sort(), ['q1', 'q2'])
})

await test('cancellation and deadline stay truthful and never claim sufficiency', async () => {
  const controller = new AbortController()
  controller.abort()
  const cancelled = harness({ signal: controller.signal })
  const r = await cancelled.run(TASK_INPUT)
  assert.equal(r.stopReason, STOP_REASONS.cancelled)
  assert.equal(r.retrievalSufficient, false)
  assert.equal(cancelled.calls.search.length, 0)
  assert.equal(cancelled.calls.jev.length, 0)
})

await test('continuation sees reviewed material and cannot turn failed retrieval into exhaustion', async () => {
  const h = harness({ limits: { maxRounds: 1 } })
  await h.run(TASK_INPUT)
  const decision = h.calls.jev.find(call => call.phase === 'keyword_judge')
  assert.ok(decision.state.keyword_states[0].material[0].text.includes('Useful pointer'))
  assert.ok(decision.state.keyword_states[0].successful_engines > 0)
  const failed = harness({ searchError: new Error('provider unavailable'), judge: ({phase}) => phase === 'keyword_judge' ? 'exhausted' : undefined, limits: { maxRounds: 1 } })
  const result = await failed.run(TASK_INPUT)
  assert.notEqual(result.questions[0].keywordProgress[0].status, 'exhausted')
  assert.equal(result.retrievalSufficient, false)
})

await test('unreviewed candidates prevent an exhausted verdict', async () => {
  const h = harness({ search: () => Array.from({length:60}, (_,i) => distinctHit(i)), judge: ({phase}) => phase === 'keyword_judge' ? 'exhausted' : undefined, limits: {maxRounds:1,maxSourceJudgeMicroBatches:1} })
  const result = await h.run(TASK_INPUT)
  assert.ok(result.funnel.pending_associations > 0)
  assert.notEqual(result.questions[0].keywordProgress[0].status, 'exhausted')
})

await test('unknown mandatory source judgment remains unassessed, not off-topic or exhausted', async () => {
  const h = harness({ judge: ({phase,id}) => phase === 'source_judge' && id.endsWith('.reading_value') ? 'omit' : phase === 'keyword_judge' ? 'exhausted' : undefined, limits:{maxRounds:1} })
  const result = await h.run(TASK_INPUT)
  assert.equal(h.calls.evidence[0].status, 'unassessed')
  assert.equal(h.calls.evidence[0].assessed, false)
  assert.ok(result.funnel.pending_associations > 0)
  assert.notEqual(result.questions[0].keywordProgress[0].status, 'exhausted')
})

await test('URLs containing @ preserve satisfied material identity', async () => {
  for (const url of ['https://medium.com/@writer/guide', 'https://example.com/guide?a=b@c']) {
    const h = harness({search: () => [hit(1, {url})], limits:{maxRounds:2}})
    const result = await h.run(TASK_INPUT)
    assert.equal(result.retrievalSufficient, true, url)
    assert.equal(result.rounds, 1)
    assert.equal(result.questions[0].keywordProgress[0].status, 'satisfied')
  }
})

await test('closed-target pending material does not latch open-target retrieval', async () => {
  const h = harness({
    search: (args,n) => n <= 2 ? Array.from({length:4}, (_,i) => distinctHit(i)) : [distinctHit(n + 100)],
    judge: ({phase,id}) => phase === 'keyword_judge' ? (id.startsWith('kw.q1.') ? 'satisfied' : 'continue') : undefined,
    limits:{maxRounds:6,maxSourceJudgeMicroBatches:1,maxSourceJudgeCandidatesPerRequest:2},
  })
  const result = await h.run({tasks:[{context:'Testing',targets:[{id:'a',keywords:['alpha'],question:'Alpha?'},{id:'b',keywords:['beta'],question:'Beta?'}]}]})
  assert.ok(result.funnel.pending_associations > 0, 'closed-target candidates remain honestly pending')
  assert.ok(h.calls.search.length > 2, `open target must resume search; got ${h.calls.search.length}`)
  assert.equal(result.retrievalSufficient, false)
})

await test('an omitted match on known irrelevant material does not veto exhaustion', async () => {
  const h = harness({judge:({phase,id}) => phase === 'source_judge' ? (id.endsWith('.relevance') ? .1 : id.endsWith('.match') ? 'omit' : undefined) : phase === 'keyword_judge' ? 'exhausted' : undefined,limits:{maxRounds:1}})
  const result = await h.run(TASK_INPUT)
  assert.equal(result.questions[0].keywordProgress[0].status, 'exhausted')
  assert.equal(result.retrievalSufficient, false)
})

await test('direction lambda tuning reaches both public value and advisory index', async () => {
  const h = harness({thresholds:{directionLambda:0},limits:{maxRounds:1}})
  const result = await h.run({...TASK_INPUT,intent:'Useful guides'})
  const row = h.calls.evidence.find(item => item.status === 'useful_result')
  assert.equal(row.valueScore, .8)
  assert.ok(Math.abs(result.questions[0].keywordProgress[0].A - .8 * .9) < 1e-12)
})

await test('a missing required source answer gets a bounded later-round retry before more search', async () => {
  const h = harness({judge:({phase,id}) => phase === 'source_judge' && id.endsWith('.reading_value') && h.calls.jev.filter(c=>c.phase==='source_judge').length===1 ? 'omit' : undefined})
  const result = await h.run(TASK_INPUT)
  assert.equal(result.retrievalSufficient, true)
  assert.equal(h.calls.search.length, 1)
  assert.equal(h.calls.jev.filter(c=>c.phase==='source_judge').length, 2)
  assert.ok(result.questions[0].keywordProgress[0].A > 0, 'retry must invalidate the score cache')
})

await test('a capped keyword-match assessment allows an explicit exhausted decision without more search', async () => {
  const h = harness({
    search: (_, n) => [distinctHit(n)],
    judge: ({ phase, id }) => phase === 'source_judge' && /\.kw\d+\.match$/.test(id)
      ? 'omit' : phase === 'keyword_judge' ? 'exhausted' : undefined,
  })
  const result = await h.run(TASK_INPUT)
  assert.equal(result.stopReason, STOP_REASONS.keywordQueueEmpty)
  assert.equal(result.rounds, 2, 'only the bounded source retry is needed')
  assert.equal(h.calls.search.length, 1, 'unretryable keyword matches must not trigger more searches')
  assert.equal(result.questions[0].keywordProgress[0].status, 'exhausted')
  assert.equal(result.retrievalSufficient, false)
  assert.equal(result.funnel.pending_associations, 1, 'unresolved matches remain disclosed, not manufactured')
  assert.match(result.warnings.join('\n'), /keyword-match assessment retries exhausted/)
})

await test('exhausted is reconsidered when the same URL gains new text', async () => {
  const input = {tasks:[{context:'Testing',targets:[{id:'a',keywords:['alpha','beta'],question:'Alpha and beta?'}]}]}
  const h = harness({search:(_,n)=>[n===1 ? distinctHit(1) : {...distinctHit(1), content:distinctHit(1).snippet+' A new paragraph provides additional details and a useful migration example.'}],judge:({phase,id})=>phase==='keyword_judge' ? (h.calls.search.length===1 ? (id.endsWith('.0')?'exhausted':'continue'):'satisfied') : undefined})
  const result = await h.run(input)
  assert.equal(h.calls.jev.filter(c=>c.phase==='keyword_judge' && 'kw.q1.0' in c.questions).length, 2)
  assert.equal(result.retrievalSufficient, true)
})

await test('stalled scores do not skip an untried keyword query', async () => {
  const h = harness({search:(_,n)=>[distinctHit(n<4?1:4)],judge:({phase})=>phase==='keyword_judge' ? (h.calls.search.length>=4?'satisfied':'continue'):undefined,limits:{maxRounds:5}})
  const result = await h.run({tasks:[{context:'Testing',targets:[{id:'a',keywords:['alpha','beta'],question:'Alpha and beta?'}]}]})
  assert.equal(h.calls.search.length, 4)
  assert.equal(result.retrievalSufficient, true)
})

await test('canonical execution sharing retains every original target in public matches', async () => {
  const h = harness()
  const result = await h.run({tasks:[{context:'Testing',targets:[{id:'first',keywords:['alpha'],question:'Alpha?'},{id:'second',keywords:['alpha'],question:'Alpha?'}]}]})
  const {approvedResults} = await import('../lib/search/adaptive/pages.js')
  const rows = approvedResults(h.calls.evidence)
  assert.equal(h.calls.search.length, 1)
  assert.equal(result.questions.length, 2)
  assert.deepEqual(rows[0].matches.map(m=>m.targetId).sort(), ['first','second'])
})

await test('failed first continuation batch marks all remaining batches pending', async () => {
  const h = harness({fail:phase=>phase==='keyword_judge',limits:{maxRounds:1,maxStateChars:5000}})
  const result = await h.run({intent:'Prefer original migration notes. '.repeat(50),tasks:[{context:'Testing',targets:['a','b','c','d'].map(id=>({id,keywords:[id],question:'Where are '+id+' notes?'}))}]})
  assert.ok(h.calls.jev.some(c=>c.phase==='keyword_judge'))
  assert.ok(result.questions.every(q=>q.keywordProgress.every(k=>k.status==='pending')), JSON.stringify(result.questions.map(q=>q.keywordProgress)))
})

await test('source rejudging is capped even when the required field stays missing', async () => {
  const h = harness({judge:({phase,id})=>phase==='source_judge' && id.endsWith('.reading_value')?'omit':undefined,limits:{maxRounds:6}})
  const result = await h.run(TASK_INPUT)
  assert.equal(h.calls.jev.filter(c=>c.phase==='source_judge').length, 2)
  assert.ok(result.funnel.pending_associations > 0)
  assert.equal(result.retrievalSufficient, false)
})

await test('search call exhaustion is reported as a budget, not a no-progress or rounds stop', async () => {
  const h = harness({judge:({phase})=>phase==='keyword_judge'?'continue':undefined,limits:{maxSearchCalls:1,maxRounds:6}})
  const result = await h.run(TASK_INPUT)
  assert.equal(result.stopReason, 'budget_calls')
  assert.equal(h.calls.search.length, 1)
  assert.equal(result.retrievalSufficient, false)
})

await test('zero-success engine stats cannot justify an exhausted keyword', async () => {
  const h = harness({search:()=>[],engineStats:Object.fromEntries(ENGINES.map(name=>[name,{attempts:0,successes:0,errors:0}])),judge:({phase})=>phase==='keyword_judge'?'exhausted':undefined,limits:{maxRounds:1}})
  const result = await h.run(TASK_INPUT)
  assert.notEqual(result.questions[0].keywordProgress[0].status, 'exhausted')
})

await test('new publication metadata invalidates the old date judgment even with unchanged text', async () => {
  const h = harness({search:(_,n)=>[{...distinctHit(1),...(n>1?{published:'2026-01-15'}:{})}],judge:({phase,id,state})=>phase==='source_judge' && id.endsWith('.time_match') ? (candidateOf(state,id).source.published ? .9 : .1):undefined,limits:{maxRounds:3}})
  const result = await h.run({tasks:[{context:'Release',time_range:{start:'2026-01-01',end:'2026-01-31',basis:'published'},targets:[{id:'a',keywords:['alpha'],question:'What shipped?'}]}]})
  assert.equal(result.retrievalSufficient, true)
  assert.equal(h.calls.jev.filter(c=>c.phase==='source_judge').length, 2)
})

console.log(`${passed} retrieval-mode tests passed (hermetic; not retrieval quality)`)
