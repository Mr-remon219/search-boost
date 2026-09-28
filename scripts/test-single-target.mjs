#!/usr/bin/env node
// Current production controller. Hermetic scripted Jev answers verify routing,
// not semantic accuracy, calibrated thresholds, or real network performance.
import test from 'node:test'
import assert from 'node:assert/strict'
import { runAdaptiveLoop } from '../lib/search/adaptive/loop.mjs'
import { ADAPTIVE_LIMITS, ADAPTIVE_THRESHOLDS } from '../lib/search/adaptive/limits.js'
import { normalizeAdaptiveInput, ADAPTIVE_INPUT_SCHEMA, canonicalTargets } from '../lib/search/adaptive/input.js'
import { buildScopeRequest, decodeScopeAnswer, scopeVersion, readScope } from '../lib/search/adaptive/scope.js'
import { approvedResults, createResultPages, validatePageInput } from '../lib/search/adaptive/pages.js'
import { createEvidencePool } from '../lib/search/adaptive/evidence.js'
import { usefulEligible, readingValue } from '../lib/search/adaptive/retrieval-score.js'
import { requestFits } from '../lib/search/adaptive/material.js'
import { queryCandidates } from '../lib/search/adaptive/planning.js'
import { finalDecisionEstablished, retrievalFinalRequest } from '../lib/search/adaptive/retrieval-final.js'
import { adaptiveSearchInput, adaptiveSearchOutput } from '../adapters/mcp/schemas.mjs'
import { runAdaptiveSearch } from '../lib/runtime.mjs'
import { z } from 'zod'
import Ajv from 'ajv'

const input = { questions: ['How does Alpha preserve constraints?'], intent: 'Implementation mechanisms and concrete failure evidence.', keywords: ['mechanism'], constraints: ['Only official sources'] }
const hit = (id = 'a', extra = {}) => ({ url: `https://${id}.example/article`, title: `Alpha ${id}`,
  snippet: `Alpha ${id} implementation describes constraint preservation with a concrete code pointer and a reproducible failure case.`, engines: ['bing'], score: 1, ...extra })
function choice(spec, selected, probability = .99) {
  const keys = Object.keys(spec.criteria)
  return { type: 'choice', choice: selected, confidence: probability,
    probabilities: Object.fromEntries(keys.map(k => [k, k === selected ? probability : (1 - probability) / (keys.length - 1)])) }
}
function harness(options = {}) {
  const calls = { jev: [], search: [], fetch: [], evidence: [] }
  const limits = { ...ADAPTIVE_LIMITS, maxRounds: 4, ...options.limits }
  let attempts = 0
  const deps = {
    limits, thresholds: { ...ADAPTIVE_THRESHOLDS, ...options.thresholds }, signal: options.signal,
    snapshot: () => ({ capability: { defaultEnginePool: 'free', pools: { free: options.engines ?? ['bing', 'ddg'] }, availableEngines: options.engines ?? ['bing', 'ddg'] } }),
    runFused: async args => {
      calls.search.push(args)
      if (options.searchError) throw new Error('fake engine failure')
      return { results: await (options.search?.(args, calls.search.length) ?? [hit()]),
        engineStats: Object.fromEntries(args.engineList.map(e => [e, { used: true, attempts: 1, successes: 1, errors: 0 }])) }
    },
    runFetchPage: async (url, focus, signal) => {
      calls.fetch.push({ url, focus })
      return await (options.fetch?.(url, calls.fetch.length, signal) ?? { content: '', word_count: 0 })
    },
    onComplete: ({ evidence }) => { calls.evidence = evidence },
    jev: {
      usage: () => ({ httpAttempts: attempts, inputTokens: 0 }),
      ask: async ({ phase, state, questions, signal }) => {
        attempts++; calls.jev.push({ phase, state, questions })
        if (options.failPhase === phase) throw new Error('fake Jev failure')
        if (options.onAsk) await options.onAsk({ phase, state, questions, signal })
        const entries = new Map()
        for (const [id, spec] of Object.entries(questions)) {
          let answer = options.judge?.({ phase, state, id, spec, calls })
          if (answer === 'omit') continue
          if (answer && typeof answer === 'object') { entries.set(id, answer); continue }
          if (answer === undefined) {
            if (phase === 'scope_judge') answer = .95
            else if (phase === 'retrieval_final') answer = 'finish'
            else if (spec.type === 'choice') answer = id.endsWith('.kind') ? 'direct' : Object.keys(spec.criteria)[0]
            else answer = id.endsWith('.injection') ? .01 : .95
          }
          entries.set(id, spec.type === 'choice' ? choice(spec, answer) : { type: 'noul', value: answer })
        }
        return { entries, attempts: 1, model: 'hermetic-only' }
      },
    },
  }
  return { calls, limits, run: (i = input) => runAdaptiveLoop(i, deps) }
}
function sourceFor(state, id) {
  const ref = state.candidates.find(c => c.id === id.split('.')[1])
  return state.sources[ref.source_index]
}

// Input and public-host contract: old multi-target inputs cannot silently pass.
test('exactly one question, flat points, explicit restrictions; no truncation', () => {
  const parsed = normalizeAdaptiveInput(input)
  assert.equal(parsed.targets.length, 1)
  assert.deepEqual(parsed.targets[0].constraints, input.constraints)
  assert.equal(normalizeAdaptiveInput({ questions: ['Compare A and B, including their tradeoffs?'] }).error, undefined)
  for (const bad of [null, [], {}, { questions: [] }, { questions: ['a', 'b'] }, { questions: [' '] },
    { question: 'a' }, { tasks: [] }, { questions: ['a'], tasks: [] }, { questions: ['a'], keywords: [['k']] },
    { questions: ['a'], constraints: [''] }, { questions: ['a'], constraints: 'v22' },
    { questions: ['a'], intent: '' }, { questions: ['a'], scopeFirst: false }, { questions: ['a'.repeat(401)] }]) {
    assert.ok(normalizeAdaptiveInput(bad).error, JSON.stringify(bad))
  }
  assert.equal(normalizeAdaptiveInput({ questions: ['a'], constraints: [] }).targets[0].constraints.length, 0)
  assert.notEqual(canonicalTargets([parsed.targets[0], { ...parsed.targets[0], constraints: ['Version 22'] }])[0].id,
    canonicalTargets([parsed.targets[0], { ...parsed.targets[0], constraints: ['Version 22'] }])[1].id)
})

test('MCP and shared host schemas agree on new fields and hard bounds', () => {
  const validate = new Ajv().compile(ADAPTIVE_INPUT_SCHEMA)
  for (const good of [input, { questions: ['q'], constraints: [] }, { cursor: 'example', page_size: 2 }]) {
    assert.ok(validate(good), JSON.stringify(validate.errors)); assert.deepEqual(z.object(adaptiveSearchInput).strict().parse(good), good)
  }
  for (const bad of [{ questions: ['a', 'b'] }, { tasks: [] }, { questions: ['a'], constraints: Array(9).fill('v22') }, { questions: ['a'], keywords: [['a']] }]) {
    assert.equal(validate(bad), false); assert.equal(z.object(adaptiveSearchInput).strict().safeParse(bad).success, false)
  }
  for (const field of ['questions', 'intent', 'keywords', 'constraints']) assert.throws(() => validatePageInput({ cursor: 'c', [field]: input[field] }), /cannot be combined/)
})

test('invalid multi-question input returns before engines or Jev', async () => {
  const h = harness(); const r = await h.run({ questions: ['a', 'b'] })
  assert.equal(r.stopReason, 'invalid_input'); assert.equal(h.calls.search.length + h.calls.jev.length, 0)
  const publicResult = await runAdaptiveSearch({ questions: ['a', 'b'] })
  assert.equal(publicResult.stopReason, 'invalid_input'); assert.equal(publicResult.totalResults, 0)
})


// Point 3: explicit-only Boolean prefilter.
test('query choice -> selected-query engines -> constraints -> quality -> ALL-material final', async () => {
  const h = harness(); const r = await h.run()
  assert.deepEqual(h.calls.jev.map(c => c.phase), ['query_plan', 'engine_plan', 'scope_judge', 'source_judge', 'retrieval_final'])
  const engine = h.calls.jev.find(c => c.phase === 'engine_plan')
  assert.equal(engine.state.selected_search.query, h.calls.search[0].query)
  assert.equal(r.retrievalSufficient, true); assert.equal(r.finalReview.verdict, 'pass')
  assert.equal(r.finalReview.inputMaterials, 1); assert.equal(r.finalReview.allMaterialsIncluded, true)
})

test('one Boolean over ALL explicit conditions, no subject or inferred restriction questions', () => {
  const q = { text: 'Compare Alpha 20 and 22', intent: 'Failures', constraints: ['Only official', 'Region A in 2025 OR region B in 2026'] }
  const req = buildScopeRequest(q, [{ ...hit(), text: 'A concrete code pointer', evidenceId: 'e1', assocId: 'a', basis: 'snippet' }])
  assert.deepEqual(req.state.constraints, q.constraints)
  assert.equal('intent' in req.state, false)
  assert.deepEqual(Object.keys(req.questions), ['scope.e1.constraints'])
  assert.equal(req.questions['scope.e1.constraints'].type, 'noul')
  assert.match(req.state.rules, /AND/); assert.match(req.state.rules, /alternatives/)
  assert.equal(readScope(new Map([['scope.e1.constraints', { type: 'noul', value: .84 }]]), req.mapping[0]).route, 'reject')
})

test('empty constraints skip the network gate even if the question contains document restrictions', async () => {
  const h = harness(); const r = await h.run({ questions: ['Only official Alpha documents about implementation'], constraints: [] })
  assert.equal(h.calls.jev.some(c => c.phase === 'scope_judge'), false)
  assert.equal(r.reviewSummary.scopeSkipped, 1)
  assert.equal(r.retrievalSufficient, true)
  assert.equal(buildScopeRequest({ text: 'Only official Alpha' }, []), null)
})

test('normal Boolean non-pass never enters quality or output', async () => {
  const h = harness({ limits: { maxRounds: 1 }, search: () => [hit('good'), hit('bad')], judge: ({ phase, state, id }) => {
    if (phase === 'scope_judge' && sourceFor(state, id).url.includes('bad.')) return .1
  } })
  const r = await h.run()
  assert.equal(r.reviewSummary.constraintsNotPassed, 1)
  assert.ok(h.calls.jev.filter(c => c.phase === 'source_judge').every(c => c.state.sources.every(s => !s.url.includes('bad.'))))
  assert.equal(approvedResults(h.calls.evidence).length, 1)
})

test('missing or invalid constraints assessment is execution-unavailable, not normal non-pass', async () => {
  for (const answer of ['omit', { type: 'noul', value: 2 }, { type: 'choice', choice: 'pass' }]) {
    const h = harness({ limits: { maxFetchCalls: 0 }, judge: ({ phase }) => phase === 'scope_judge' ? answer : undefined })
    const r = await h.run()
    assert.equal(r.reviewSummary.constraintsNotPassed, 0)
    assert.equal(r.scopeSummary.unknown, 1)
    assert.equal(approvedResults(h.calls.evidence).length, 0)
    assert.ok(h.calls.jev.filter(c => c.phase === 'scope_judge').length <= 2)
  }
})

test('Boolean decision boundaries do not create unknown/not_applicable options', () => {
  assert.equal(decodeScopeAnswer({ type: 'noul', value: .85 }).state, 'pass')
  assert.equal(decodeScopeAnswer({ type: 'noul', value: .849 }).state, 'not_passed')
  assert.equal(decodeScopeAnswer({ type: 'noul', value: 0 }).state, 'not_passed')
  for (const value of [null, { type: 'noul', value: NaN }, { type: 'noul', value: 2 }, { type: 'choice', choice: 'unknown' }]) {
    assert.equal(decodeScopeAnswer(value).state, 'unavailable')
  }
})

test('independent thin-snippet recovery must establish constraints anew before quality', async () => {
  const h = harness({ judge: ({ phase, state, id }) => phase === 'scope_judge'
    ? (sourceFor(state, id).fragments[0].text_basis === 'fetched_page' ? .95 : .7) : undefined,
    fetch: () => ({ content: 'Alpha implementation is officially documented here with a concrete mechanism for preserving constraints and recovery from failed processing.', word_count: 30 }) })
  const r = await h.run()
  assert.equal(h.calls.fetch.length, 1)
  const phases = h.calls.jev.map(c => c.phase)
  assert.equal(phases.filter(p => p === 'scope_judge').length, 2)
  assert.ok(phases.lastIndexOf('scope_judge') < phases.indexOf('source_judge'))
  assert.equal(r.retrievalSufficient, true)
})

test('normal non-pass cannot be promoted by an empty recovery fetch', async () => {
  const h = harness({ judge: ({ phase }) => phase === 'scope_judge' ? .7 : undefined })
  const r = await h.run()
  assert.equal(h.calls.fetch.length, 1)
  assert.equal(h.calls.jev.filter(c => c.phase === 'scope_judge').length, 1)
  assert.equal(r.retrievalSufficient, false); assert.equal(approvedResults(h.calls.evidence).length, 0)
})

// Point 4: broad admission with stronger focus ordering, not multiple vetoes.
for (const [field, value] of [['relevance', .2], ['reading_value', .1], ['injection', .99]]) {
  test(`core rejection still blocks ${field}=${value}`, async () => {
    const h = harness({ limits: { maxRounds: 1 }, judge: ({ phase, id }) => phase === 'source_judge' && id.endsWith('.'+field) ? value : undefined })
    const r = await h.run()
    assert.equal(r.retrievalSufficient, false); assert.equal(approvedResults(h.calls.evidence).length, 0)
    assert.equal(r.reviewSummary.qualityNotPassed, 1)
  })
}
for (const field of ['relevance', 'reading_value', 'injection']) {
  test(`missing mandatory ${field} never admits`, async () => {
    const h = harness({ limits: { maxRounds: 1 }, judge: ({ phase, id }) => phase === 'source_judge' && id.endsWith('.'+field) ? 'omit' : undefined })
    const r = await h.run(); assert.equal(approvedResults(h.calls.evidence).length, 0); assert.ok(r.funnel.pending_associations > 0)
  })
}

test('medium-value supporting pages survive low direction and keyword match, without filling the point', async () => {
  const h = harness({ limits: { maxRounds: 1 }, judge: ({ phase, id }) => {
    if (phase !== 'source_judge') return undefined
    if (id.endsWith('.relevance')) return .55
    if (id.endsWith('.reading_value')) return .60
    if (id.endsWith('.direction_match')) return .2
    if (id.endsWith('.match')) return .3
  } })
  const r = await h.run(); const results = approvedResults(h.calls.evidence)
  assert.equal(results.length, 1); assert.equal(results[0].tier, 'supporting')
  assert.ok(results[0].valueScore > 0)
  assert.equal(r.questions[0].keywordProgress[0].admitted, 0)
  assert.equal(r.retrievalSufficient, false)
})

test('unknown direction is disclosed, not fabricated or used as a veto', async () => {
  const h = harness({ judge: ({ phase, id }) => phase === 'source_judge' && id.endsWith('.direction_match') ? 'omit' : undefined })
  const r = await h.run({ questions: input.questions, constraints: [] })
  const out = approvedResults(h.calls.evidence)
  assert.equal(out.length, 1); assert.equal(out[0].directionMatch, null); assert.equal(out[0].tier, 'supporting')
  assert.ok(r.funnel.pending_associations > 0)
  assert.ok(h.calls.jev.find(c => c.phase === 'source_judge').questions['src.e1.direction_match'])
})

test('focus comes first, but supporting materials are retained and included in final', async () => {
  const h = harness({ search: () => [hit('support'), hit('focus')], judge: ({ phase, id, state }) => {
    if (phase === 'source_judge' && sourceFor(state, id).url.includes('support') && id.endsWith('.direction_match')) return .1
  } })
  const r = await h.run(); const out = approvedResults(h.calls.evidence)
  assert.deepEqual(out.map(i => i.tier), ['focus', 'supporting'])
  assert.equal(r.reviewSummary.admitted, 2); assert.equal(r.finalReview.inputMaterials, 2)
})

test('missing keyword answers do not erase useful material or become fake point contributions', async () => {
  const h = harness({ limits: { maxRounds: 2, maxFetchCalls: 0 }, judge: ({ phase, id }) => phase === 'source_judge' && id.endsWith('.match') ? 'omit' : undefined })
  const r = await h.run()
  assert.equal(approvedResults(h.calls.evidence).length, 1)
  assert.equal(r.questions[0].keywordProgress[0].admitted, 0)
  assert.ok(r.funnel.pending_associations > 0)
  assert.equal(r.retrievalSufficient, false)
})

test('current counts retract when material metadata changes and constraints no longer pass', async () => {
  const h = harness({ limits: { maxFetchCalls: 0, maxRounds: 2 }, search: (_, n) => [hit('a', { title: n === 1 ? 'Official Alpha' : 'Unofficial Alpha' })],
    judge: ({ phase, state, id }) => {
      if (phase === 'retrieval_final') return 'keyword0'
      if (phase === 'scope_judge' && sourceFor(state, id).title.startsWith('Unofficial')) return .1
    } })
  const r = await h.run()
  assert.equal(r.questions[0].keywordProgress[0].admitted, 0)
  assert.equal(approvedResults(h.calls.evidence).length, 0)
  assert.equal(r.finalReview.checks, 1)
})

test('duplicates do not accumulate point groups', async () => {
  const h = harness({ search: () => [hit('a'), hit('a'), hit('copy', { snippet: hit('a').snippet })] })
  const r = await h.run(); assert.equal(r.questions[0].keywordProgress[0].admitted, 1)
})

test('200 collected pages are not mistaken for 200 reviewed; breadth window retains medium material', async () => {
  const h = harness({ search: () => Array.from({ length: 200 }, (_, i) => hit(`page${i}`)), judge: ({ phase, id }) => {
    if (phase === 'source_judge' && id.endsWith('.relevance')) return .55
    if (phase === 'source_judge' && id.endsWith('.direction_match')) return .4
  } })
  const r = await h.run()
  assert.equal(r.reviewSummary.collected, 200)
  assert.ok(r.reviewSummary.qualityAssessed >= 64)
  assert.ok(r.reviewSummary.admitted >= 64)
  assert.equal(r.reviewSummary.supporting, r.reviewSummary.admitted)
  assert.equal(r.reviewSummary.admitted + r.reviewSummary.awaitingAdmission, 200)
  assert.equal(h.calls.search.length, 1, 'review existing pool before filling another pool')
})

test('a missing point gets a new focused search without first draining the old broad pool', async () => {
  const h = harness({ limits: { maxRounds: 3, maxJevCalls: 16, maxFetchCalls: 0, maxSourceJudgeCandidatesPerRequest: 2 },
    search: (_, n) => n === 1 ? Array.from({ length: 100 }, (_, i) => hit(`mechanism${i}`)) : [hit('failure-found')],
    judge: ({ phase, id, state }) => phase === 'source_judge' && id.endsWith('kw1.match') && !sourceFor(state, id).url.includes('failure-found') ? .1 : undefined })
  await h.run({ ...input, keywords: ['mechanism', 'failures'] })
  assert.ok(h.calls.search.length >= 2); assert.ok(h.calls.search[1].query.includes('failures'))
})

// Point 2: every admitted row in the final request; two normal semantic verdicts.
test('final sees EVERY admitted material, including the low-ranked counterexample and supplementary non-keyword material', async () => {
  const h = harness({ search: () => Array.from({ length: 12 }, (_, i) => hit(`row${i}`)), judge: ({ phase, state, id }) => {
    if (phase !== 'source_judge') return undefined
    const last = sourceFor(state, id).url.includes('row11')
    if (last && id.endsWith('.kind')) return 'counterevidence'
    if (last && id.endsWith('.direction_match')) return .2
    if (last && id.endsWith('.match')) return .1
  } })
  const r = await h.run()
  const final = h.calls.jev.find(c => c.phase === 'retrieval_final').state
  assert.equal(final.material_count, 12); assert.equal(final.materials.length, 12); assert.equal(final.sources.length, 12)
  assert.ok(final.materials.some(m => m.kind === 'counterevidence'))
  assert.equal('constraints' in final, false)
  assert.ok(!JSON.stringify(final).includes('Only official sources'))
  assert.equal(r.finalReview.inputMaterials, r.reviewSummary.admitted)
})

test('full-set final cannot silently sample when the request is too large', async () => {
  const h = harness({ limits: { maxRounds: 6, minInitialReviewMaterials: 80 }, search: () => Array.from({ length: 80 }, (_, i) => hit(`long${i}`, {
    snippet: `Alpha concrete implementation ${i} explains preservation. ` + 'Detailed context and operational evidence are provided in this excerpt. '.repeat(10),
  })) })
  const r = await h.run()
  assert.ok(r.reviewSummary.admitted >= 64)
  assert.equal(h.calls.jev.some(c => c.phase === 'retrieval_final'), false)
  assert.equal(r.retrievalSufficient, false)
  assert.equal(r.stopReason, 'budget_tokens')
  assert.match(r.stopDetail, /full admitted set/)
  assert.equal(approvedResults(h.calls.evidence).length, r.reviewSummary.admitted)
})

test('not-passed final names one existing keyword and forces a new search before another verdict', async () => {
  let checks = 0
  const h = harness({ search: (_, n) => [hit(`round${n}`)], judge: ({ phase }) => phase === 'retrieval_final' ? (++checks === 1 ? 'keyword1' : 'finish') : undefined })
  const r = await h.run({ ...input, keywords: ['mechanism', 'failures'] })
  assert.equal(h.calls.search.length, 2); assert.equal(checks, 2)
  assert.ok(h.calls.search[1].query.includes('failures'))
  assert.equal(h.calls.fetch.length, 0, 'do not replace requested re-search with a fetch-only action')
  assert.equal(r.retrievalSufficient, true)
})

test('mirror arrivals do not automatically resolve a not-passed verdict or repeat final on identical content', async () => {
  const original = hit('a')
  const h = harness({ limits: { maxRounds: 3, maxFetchCalls: 0 }, search: (_, n) => [{ ...original, url: `https://mirror${n}.example/article` }], judge: ({ phase }) => phase === 'retrieval_final' ? 'keyword0' : undefined })
  const r = await h.run()
  assert.equal(r.finalReview.checks, 1); assert.equal(r.finalReview.verdict, 'not_passed')
  assert.equal(r.finalReview.researchKeyword, 'mechanism')
  assert.equal(r.questions[0].keywordProgress[0].reason, 'final_review_gap')
})

test('current gap stays open through an unavailable final answer', async () => {
  let checks=0
  const h = harness({ limits: { maxRounds: 2 }, search: (_,n)=>[hit(`new${n}`)], judge: ({phase})=>phase==='retrieval_final' ? (++checks===1?'keyword0':'omit') : undefined })
  const r=await h.run()
  assert.equal(r.retrievalSufficient,false)
  assert.equal(r.questions[0].keywordProgress[0].reason,'final_review_gap')
  assert.equal(r.finalReview.verdict,null)
})

test('invalid/unavailable final answers cannot manufacture pass or a new keyword', async () => {
  for (const answer of ['omit', { type: 'choice', choice: 'keyword99', probabilities: {} },
    { type: 'choice', choice: 'finish', confidence: .99, probabilities: { finish: .01, keyword0: .99 } }]) {
    const h = harness({ limits: { maxRounds: 1 }, judge: ({ phase }) => phase === 'retrieval_final' ? answer : undefined })
    const r = await h.run(); assert.equal(r.retrievalSufficient, false); assert.equal(r.finalReview.verdict, null)
  }
})

test('final uses the action probability distribution, not optional confidence', () => {
  for (let n=1;n<=8;n++) {
    const keys=['finish',...Array.from({length:n},(_,i)=>`keyword${i}`)]
    const p=Object.fromEntries(keys.map(k=>[k,k==='finish'?.1:.9/n]))
    assert.equal(finalDecisionEstablished({valid:true,choice:'keyword0',confidence:null,probabilities:p},keys),true)
    assert.equal(finalDecisionEstablished({valid:true,choice:'finish',confidence:1,probabilities:p},keys),false)
    const pass=Object.fromEntries(keys.map(k=>[k,k==='finish'?.9:.1/n]))
    assert.equal(finalDecisionEstablished({valid:true,choice:'finish',confidence:.01,probabilities:pass},keys),true)
  }
})

test('final attempt cap stops before another planning round; dispatched failures are counted', async () => {
  const h=harness({limits:{maxRounds:6},judge:({phase})=>phase==='retrieval_final'?'omit':undefined})
  const r=await h.run(); assert.equal(r.finalReview.checks,3);assert.equal(r.rounds,3);assert.equal(h.calls.search.length,1)
  const failed=harness({failPhase:'retrieval_final'});const f=await failed.run()
  assert.equal(f.finalReview.checks,1);assert.equal(f.retrievalSufficient,false)
})

// Point 1: every actual search chooses a query, THEN evaluates its engines.
test('query selection without confidence is honoured and conditions engine assessment', async () => {
  const h=harness({judge:({phase,spec,state})=>{
    if(phase==='query_plan') { const a=choice(spec,state.options.at(-1).id);delete a.confidence;return a }
  }})
  await h.run()
  const q=h.calls.jev.find(c=>c.phase==='query_plan').state.options.at(-1)
  const e=h.calls.jev.find(c=>c.phase==='engine_plan')
  assert.equal(h.calls.search[0].query,q.query)
  assert.equal(e.state.selected_search.query,q.query)
  assert.ok(Object.values(e.questions).every(spec=>spec.instructions.includes('EXACT query')))
})

test('invalid query distribution uses a disclosed feasible fallback', async () => {
  const h=harness({judge:({phase})=>phase==='query_plan'?{type:'choice',choice:'query0',confidence:1,probabilities:{}}:undefined})
  const r=await h.run();assert.ok(r.warnings.some(w=>w.includes('Query planning')))
  assert.equal(h.calls.search[0].query,h.calls.jev.find(c=>c.phase==='query_plan').state.options[0].query)
})

test('follow-up planning sees the named gap, past search outcome and admitted context', async () => {
  let finals=0
  const h=harness({search:(_,n)=>[hit(`r${n}`)],judge:({phase})=>phase==='retrieval_final'?(++finals===1?'keyword1':'finish'):undefined})
  await h.run({...input,keywords:['mechanism','failures']})
  const plans=h.calls.jev.filter(c=>c.phase==='query_plan')
  assert.equal(plans.length,2)
  assert.equal(plans[1].state.feedback.requested_keyword,'failures')
  assert.equal(plans[1].state.feedback.recent_searches[0].returned,1)
  assert.ok(plans[1].state.feedback.sample_admitted_material.length)
  assert.ok(plans[1].state.options.some(o=>o.query.includes('failures')))
  for(const req of plans)assert.ok(req.state.options.every(o=>!o.query.includes(input.intent)))
})

test('each new query re-evaluates its engines, while exact-query preferences can be reused', async () => {
  const h=harness({limits:{maxRounds:3,maxFetchCalls:0},judge:({phase,id})=>{
    if(phase==='engine_plan')return id.endsWith('.bing')?.9:.1
    if(phase==='retrieval_final')return 'keyword0'
  }})
  await h.run()
  assert.deepEqual(h.calls.search[0].engineList,['bing'])
  assert.deepEqual(h.calls.search[1].engineList,['ddg'])
  assert.equal(h.calls.search[0].query,h.calls.search[1].query)
  assert.ok(h.calls.search[1].engineWeights.ddg < h.calls.search[0].engineWeights.bing)
  assert.equal(h.calls.jev.filter(c=>c.phase==='engine_plan').length,2)
  assert.notEqual(h.calls.search[2].query,h.calls.search[1].query)
})

test('no identical engine/query/depth action is executed twice', async () => {
  const h=harness({limits:{maxRounds:6,maxFetchCalls:0},judge:({phase})=>phase==='retrieval_final'?'keyword0':undefined})
  await h.run()
  const keys=h.calls.search.flatMap(s=>s.engineList.map(e=>JSON.stringify([e,s.query,s.complexity])))
  assert.equal(new Set(keys).size,keys.length)
})

// Shared invariants: request limits, failure honesty, metadata, output, extraction.
test('all phases charge existing budgets and preserve downstream headroom', async () => {
  const h=harness({limits:{maxJevCalls:4,maxRounds:6},search:()=>Array.from({length:30},(_,i)=>hit(`p${i}`))})
  const r=await h.run();assert.equal(r.stopReason,'budget_calls');assert.equal(r.rounds,1)
  assert.ok(r.usage.jevCalls<=4);assert.equal(r.retrievalSufficient,false)
})

test('500 candidates with eight conditions stay within bounded requests, calls and partial-result semantics', async () => {
  const h=harness({search:()=>Array.from({length:500},(_,i)=>hit(`bulk${i}`))})
  const r=await h.run({...input,constraints:Array.from({length:8},(_,i)=>`Explicit complete condition ${i}`)})
  assert.ok(h.calls.jev.every(c=>requestFits(c,h.limits)))
  assert.ok(r.usage.jevCalls<=h.limits.maxJevCalls);assert.ok(r.reviewSummary.admitted>0)
  assert.equal(r.reviewSummary.collected,500)
  for(const request of h.calls.jev.filter(c=>c.phase==='source_judge')){
    const seen=new Set(h.calls.jev.slice(0,h.calls.jev.indexOf(request)).filter(c=>c.phase==='scope_judge').flatMap(c=>c.state.candidates.map(x=>x.id)))
    assert.ok(request.state.candidates.every(c=>seen.has(c.id)))
  }
})

test('service failure in restriction stage never dispatches quality', async()=>{
  const h=harness({failPhase:'scope_judge'});const r=await h.run()
  assert.equal(r.retrievalSufficient,false);assert.equal(h.calls.jev.some(c=>c.phase==='source_judge'),false)
  assert.equal(approvedResults(h.calls.evidence).length,0)
})

test('cancellation before dispatch makes no network requests',async()=>{
  const c=new AbortController();c.abort()
  const h=harness({signal:c.signal});const r=await h.run()
  assert.equal(r.stopReason,'cancelled');assert.equal(h.calls.jev.length+h.calls.search.length,0)
})

test('engine failure never implies absence or a passing final',async()=>{
  const h=harness({searchError:true});const r=await h.run()
  assert.equal(r.retrievalSufficient,false);assert.equal(approvedResults(h.calls.evidence).length,0)
})

test('scope identity binds question, conditions, metadata, text, basis and policy threshold',()=>{
  const q={text:'Alpha',constraints:['version 22']}
  const m={text:'Alpha information',basis:'snippet',title:'Alpha',url:'https://a.test/doc',domain:'a.test',published:null}
  const original=scopeVersion(q,m)
  for(const field of Object.keys(m))assert.notEqual(scopeVersion(q,{...m,[field]:'changed'}),original)
  assert.notEqual(scopeVersion({...q,constraints:['version 20']},m),original)
  assert.notEqual(scopeVersion(q,m,{scopeAllow:.9}),original)
})

test('new shorter same-basis text replaces stale approval',()=>{
  const q={id:'q1',text:'Alpha',constraints:[]},p=createEvidencePool({questions:[q],limits:ADAPTIVE_LIMITS})
  const a=p.ingestSearch({questionId:q.id,results:[hit()],round:1}).created[0]
  a.judgment={relevance:.9};a.judgmentVersion=a.textVersion
  p.ingestSearch({questionId:q.id,results:[hit('a',{snippet:'Alpha now reports a contradictory failure.'})],round:2})
  assert.equal(a.text,'Alpha now reports a contradictory failure.');assert.equal(a.judgment,null)
})

test('restriction and keyword facets survive extraction among generic paragraphs',()=>{
  const q={id:'q1',text:'Alpha constraint preservation implementation',keywords:['rollback'],constraints:['Requires support for the Zephyr platform']}
  const p=createEvidencePool({questions:[q],limits:ADAPTIVE_LIMITS})
  const body=[...Array.from({length:8},(_,i)=>`Alpha constraint preservation implementation path ${i} describes standard internal data structures and runtime lifecycle.`),
    'Zephyr platform support uses a dedicated compatibility layer with documented operational safeguards.',
    'Rollback recovers the previous snapshot and stops corrupted transactions without losing records.'].join('\n\n')
  const a=p.ingestSearch({questionId:q.id,results:[hit()],round:1}).created[0]
  p.ingestFetch({questionId:q.id,sourceKey:a.sourceKey,round:2,page:{content:body}})
  assert.ok(a.text.includes('Zephyr'));assert.ok(a.text.includes('Rollback'))
})

test('pages preserve tiers, full-set verdict and review funnel without additional calls',async()=>{
  const h=harness();const r=await h.run()
  const store=createResultPages();const rows=approvedResults(h.calls.evidence)
  const page=store.save(rows,{schemaVersion:3,retrievalSufficient:r.retrievalSufficient,coverageComplete:false,
    scopeSummary:r.scopeSummary,finalReview:r.finalReview,reviewSummary:r.reviewSummary,keywordProgress:[],pendingAssessments:0,stopReason:r.stopReason,warnings:[]},20)
  const parsed=z.object(adaptiveSearchOutput).strict().parse(page)
  assert.equal(parsed.results[0].tier,'focus');assert.deepEqual(parsed.reviewSummary,r.reviewSummary)
  assert.equal(parsed.finalReview.verdict,'pass')
  assert.equal(approvedResults([{...h.calls.evidence[0],admitted:false}]).length,0)
})

test('restriction count changes neither broad admission nor the hard-condition cutoff',async()=>{
  for(const count of [0,1,8]){
    const h=harness({judge:({phase,id})=>phase==='source_judge'&&id.endsWith('.direction_match')?.1:undefined})
    const r=await h.run({...input,constraints:Array.from({length:count},(_,i)=>`Condition ${i}`)})
    assert.equal(approvedResults(h.calls.evidence).length,1)
    assert.equal(r.reviewSummary.supporting,1)
  }
})

test('errors and never-reviewed candidates have separate admission diagnostics',async()=>{
  for(const failPhase of ['scope_judge','source_judge']) {
    const h=harness({failPhase,search:()=>[hit('one'),hit('two')]});const r=await h.run()
    assert.equal(r.reviewSummary.assessmentUnavailable,2)
    assert.equal(r.reviewSummary.constraintsNotPassed,0)
    assert.equal(r.reviewSummary.qualityNotPassed,0)
    assert.equal(r.reviewSummary.unreviewed,0)
  }
})

test('current public prompts do not extract hidden version/year restrictions',async()=>{
  const h=harness();await h.run({...input,questions:['Compare Alpha 20 and 22 in 2026'],constraints:[]})
  for(const call of h.calls.jev)assert.ok(!JSON.stringify(call.state).includes('explicit_requirements'))
})

test('every query option after not-passed final is bound to the named point, including the broadest option',async()=>{
  let finals=0
  const h=harness({search:(_,n)=>[hit(`gap${n}`)],judge:({phase,spec,state})=>{
    if(phase==='retrieval_final')return ++finals===1?'keyword1':'finish'
    if(phase==='query_plan'&&state.feedback.requested_keyword)return choice(spec,state.options.at(-1).id)
  }})
  await h.run({...input,keywords:['mechanism','failures']})
  const repeat=h.calls.jev.filter(c=>c.phase==='query_plan')[1]
  assert.ok(repeat.state.options.every(o=>o.keyword==='failures'))
  assert.ok(h.calls.search[1].query.includes('failures'))
})

test('follow-up query planning offers a deeper feasible alternative without waiting to exhaust all shallow queries',async()=>{
  const h=harness({limits:{maxRounds:2,maxFetchCalls:0},judge:({phase,id,state,spec})=>{
    if(phase==='source_judge'&&id.endsWith('.match'))return .1
    if(phase==='engine_plan')return id.endsWith('.bing')?.9:.1
    if(phase==='query_plan'&&state.feedback.recent_searches.length){
      const deep=state.options.find(o=>o.complexity==='complex')
      assert.ok(deep,'a depth alternative should survive the bounded choice list')
      return choice(spec,deep.id)
    }
  }})
  await h.run({...input,keywords:['mechanism','failures','recovery']})
  assert.equal(h.calls.search[1].complexity,'complex')
})

test('conflicting query choice and complete probabilities remain invalid rather than silently reinterpreted',async()=>{
  const h=harness({judge:({phase,spec,state})=>{
    if(phase==='query_plan'){const answer=choice(spec,state.options[1].id);answer.choice=state.options[0].id;return answer}
  }})
  const r=await h.run()
  assert.ok(r.warnings.some(w=>w.includes('no valid consistent option distribution')))
  assert.equal(h.calls.search[0].query,h.calls.jev[0].state.options[0].query)
})

test('planning failure uses a disclosed bounded unassessed fallback, never a passing verdict',async()=>{
  const h=harness({failPhase:'query_plan',engines:['bing','ddg','yahoo','exa-free','anysearch']});const r=await h.run()
  assert.equal(r.usage.searchCalls,1);assert.equal(h.calls.search[0].engineList.length,3)
  assert.equal(r.retrievalSufficient,false);assert.equal(approvedResults(h.calls.evidence).length,0)
  assert.match(r.stopDetail,/fallback/)
})

test('no-point material is retained but cannot fabricate final readiness or a normal not-passed verdict',async()=>{
  const h=harness({limits:{maxRounds:2,maxFetchCalls:0},judge:({phase,id})=>phase==='source_judge'&&id.endsWith('kw1.match')?.1:undefined})
  const r=await h.run({...input,keywords:['mechanism','failures']})
  assert.equal(r.finalReview.status,'not_ready');assert.equal(r.finalReview.verdict,null)
  assert.equal(h.calls.jev.some(c=>c.phase==='retrieval_final'),false)
  assert.ok(approvedResults(h.calls.evidence).length>0)
  assert.ok(h.calls.search[1].query.includes('failures'))
})

test('current diagnostic partition distinguishes mixed rejection, unavailable and unreviewed rows',async()=>{
  const h=harness({limits:{maxRounds:1,maxSourceJudgeCandidatesPerRequest:6},search:()=>Array.from({length:30},(_,i)=>hit(`mix${i}`)),judge:({phase,id,state})=>{
    if(phase==='scope_judge'&&sourceFor(state,id).url.includes('mix0.'))return .1
    if(phase==='source_judge'&&sourceFor(state,id).url.includes('mix1.')&&id.endsWith('.reading_value'))return .1
    if(phase==='source_judge'&&sourceFor(state,id).url.includes('mix10.')&&id.endsWith('.injection'))return 'omit'
  }})
  const r=await h.run();const x=r.reviewSummary
  assert.equal(x.collected,x.admitted+x.constraintsNotPassed+x.qualityNotPassed+x.awaitingAdmission)
  assert.equal(x.awaitingAdmission,x.unreviewed+x.assessmentUnavailable)
  assert.ok(x.constraintsNotPassed>0&&x.qualityNotPassed>0&&x.assessmentUnavailable>0&&x.unreviewed>0)
})

test('quality event counters can include retries while qualityAssessed counts current distinct candidates',async()=>{
  let rounds=0
  const h=harness({judge:({phase,id})=>{
    if(phase==='query_plan')rounds++
    if(phase==='source_judge'&&id.endsWith('.match')&&rounds===1)return 'omit'
  }})
  const r=await h.run()
  assert.equal(r.reviewSummary.qualityAssessed,1)
  assert.equal(r.funnel.reviewed_associations,2)
})

test('extra closed-set probability keys invalidate final verdicts; invalid scope thresholds throw',()=>{
  assert.equal(finalDecisionEstablished({valid:true,choice:'finish',probabilities:{finish:.9,keyword0:.1,foreign:0}},['finish','keyword0']),false)
  for(const allow of [.5,0,1.01,NaN])assert.throws(()=>decodeScopeAnswer({type:'noul',value:.9},{allow}),RangeError)
})
