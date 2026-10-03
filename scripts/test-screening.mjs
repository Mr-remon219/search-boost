import './isolate-tests.mjs'
// N_off screening contract: prototype scoring math, fixed-option judgements,
// the no-scope/no-language admission gate, snapshot provenance and the bounded
// batch runner. Offline fixtures only; no network or Jev service is involved.
import assert from 'node:assert/strict'
import { screeningScore, normalizeBase, preferenceValue, validateParams, DEFAULT_SCREENING_PARAMS, SCREENING_POLICY_VERSION } from '../lib/search/screening/scoring.js'
import { validateSourceBiasPolicy, eligibleDiscountOptions, discountCriteria, normalizePreferenceMatches, NEUTRAL_SOURCE_BIAS_POLICY, RANKING_OPTIONS, COMMUNITY_OPTIONS, DISCOUNT_OPTIONS, VALUE_OPTIONS, PREFERENCE_MATCH_OPTIONS } from '../lib/search/screening/policy.js'
import { buildStrategyRequest, decodeStrategy, buildScreeningRequest, decodeScreening, JUDGEMENT_POLICY_VERSION, STRATEGY_POLICY_VERSION, SAFETY_OPTIONS, COMMUNITY_CRITERIA } from '../lib/search/screening/judgments.js'
import { buildSnapshot, admitAndRank, runScreening, ADMISSION_POLICY_VERSION } from '../lib/search/screening/controller.js'
import { requestFits } from '../lib/search/screening/material.js'

const near = (actual, expected, eps = 1e-12) => assert.ok(Math.abs(actual - expected) < eps, `${actual} != ${expected}`)

// ---- scoring math: the documented prototype examples ----
const s = (baseScore, valueLevel, discount = 'none', preferenceMatches = []) =>
  screeningScore({ baseScore, valueLevel, discount, preferenceMatches })
near(s(1, 3).finalScore, .375)
near(s(.5, 5).finalScore, 2 / 3)
near(s(.1, 5).finalScore, 6 / 11)
near(s(1, 5, 'strong').finalScore, .5625)
near(s(1, 4, 'none', ['match', 'match']).finalScore, .65)
assert.ok(s(.1, 5).finalScore > s(1, 3).finalScore)
assert.ok(s(1, 4, 'none', ['match', 'match']).finalScore > s(1, 5, 'strong').finalScore)
assert.ok(s(100, 3).finalScore > s(.01, 5).finalScore)
near(s(100, 3).finalScore, .6200495049504951)
near(s(.01, 5).finalScore, .504950495049505)
const detail = screeningScore({ baseScore: .7, valueLevel: 4, discount: 'mild', preferenceMatches: ['match', 'partial'] })
near(detail.baseContribution + detail.valueContribution, detail.coreScore)
near(detail.coreScore - detail.sourcePenalty + detail.preferenceBonus, detail.finalScore)
near(detail.selectionScore, detail.finalScore)
assert.equal(detail.policyVersion, SCREENING_POLICY_VERSION)
assert.equal(SCREENING_POLICY_VERSION, 'fused-screening-mix-v2-prototype')
assert.deepEqual({ ...DEFAULT_SCREENING_PARAMS, utilities: { ...DEFAULT_SCREENING_PARAMS.utilities }, discountFactors: { ...DEFAULT_SCREENING_PARAMS.discountFactors }, preferenceMatchValues: { ...DEFAULT_SCREENING_PARAMS.preferenceMatchValues } }, {
  tau: 1, lambda: .5, utilities: { 3: .25, 4: .6, 5: 1 },
  discountFactors: { none: 1, mild: .9, strong: .75, unknown: 1 },
  preferenceMatchValues: { match: 1, partial: .5, no_match: 0, unknown: 0 }, epsilon: .1, mu: 0,
})

// ---- normalizeBase / preferenceValue / validateParams contracts ----
near(normalizeBase(1, 1), .5)
near(normalizeBase(2, 1), 2 / 3)
assert.ok(normalizeBase(Number.MAX_VALUE, 1) <= 1 && Number.isFinite(normalizeBase(Number.MAX_VALUE, 1)))
for (const [b, t] of [[0, 1], [-1, 1], [NaN, 1], [Infinity, 1], [1, 0], [1, -1], [1, Infinity]]) assert.throws(() => normalizeBase(b, t), RangeError)
assert.equal(preferenceValue([], DEFAULT_SCREENING_PARAMS.preferenceMatchValues), 0)
near(preferenceValue(['match', 'partial', 'no_match', 'unknown'], DEFAULT_SCREENING_PARAMS.preferenceMatchValues), .375)
assert.throws(() => preferenceValue(['maybe'], DEFAULT_SCREENING_PARAMS.preferenceMatchValues), RangeError)
for (const bad of [
  { lambda: 1.5 }, { lambda: -.1 }, { tau: 0 }, { tau: Infinity }, { epsilon: -.1 }, { mu: -1 },
  { utilities: { 3: .6, 4: .6, 5: 1 } }, { discountFactors: { none: 0, mild: .9, strong: .75, unknown: 1 } },
  { preferenceMatchValues: { match: 1, partial: .5, no_match: .1, unknown: 0 } },
]) assert.throws(() => validateParams(bad), /./)
for (const bad of [{ baseScore: 1, valueLevel: 2, discount: 'none' }, { baseScore: 1, valueLevel: 6, discount: 'none' },
  { baseScore: 1, valueLevel: 4.5, discount: 'none' }, { baseScore: 1, valueLevel: 3, discount: 'harsh' },
  { baseScore: 1, valueLevel: 3, discount: 'none', redundancy: 2 }, { baseScore: 0, valueLevel: 3, discount: 'none' }]) {
  assert.throws(() => screeningScore(bad), /./)
}
// seeded property checks: reproducible invariants, not a benchmark
let seed = 20261002
const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32)
for (let i = 0; i < 4000; i++) {
  const base = 10 ** (-4 + 8 * random())
  const level = 3 + Math.floor(random() * 3)
  const discount = DISCOUNT_OPTIONS[Math.floor(random() * DISCOUNT_OPTIONS.length)]
  const matches = Array.from({ length: 1 + Math.floor(random() * 3) }, () => PREFERENCE_MATCH_OPTIONS[Math.floor(random() * PREFERENCE_MATCH_OPTIONS.length)])
  const params = { ...DEFAULT_SCREENING_PARAMS, tau: 10 ** (-2 + 4 * random()), lambda: random(), epsilon: random() * .2 }
  const score = screeningScore({ baseScore: base, valueLevel: level, discount, preferenceMatches: matches }, params)
  assert.ok(score.finalScore >= 0 && score.finalScore <= 1 + params.epsilon + 1e-12)
  assert.ok(screeningScore({ baseScore: base * 2, valueLevel: level, discount, preferenceMatches: matches }, params).finalScore >= score.finalScore - 1e-12)
  assert.ok(screeningScore({ baseScore: base, valueLevel: level, discount, preferenceMatches: [...matches, 'match'] }, params).finalScore >= score.finalScore - 1e-12)
  const scale = 10 ** (-3 + 6 * random())
  near(normalizeBase(base * scale, params.tau * scale), score.baseNormalized, 1e-9)
}

// ---- source bias policy: fixed options, real provenance, bounded version ----
assert.throws(() => validateSourceBiasPolicy({ version: 'x', nature: 'policy_preference', mildEligible: ['bing'], strongEligible: ['tavily'] }), RangeError)
assert.throws(() => validateSourceBiasPolicy({ version: 'x'.repeat(129), nature: 'policy_preference' }), TypeError)
const policy = validateSourceBiasPolicy({ version: 'bias-v1', nature: 'policy_preference', mildEligible: ['ddg', 'bing', 'bing'], strongEligible: ['bing'] })
assert.deepEqual(eligibleDiscountOptions(NEUTRAL_SOURCE_BIAS_POLICY, ['bing', 'exa']).options, ['none', 'unknown'])
assert.equal(eligibleDiscountOptions(NEUTRAL_SOURCE_BIAS_POLICY, []).codeSelected, 'unknown')
assert.equal(eligibleDiscountOptions(policy, ['bing', 'tavily']).codeSelected, 'none')
const modelledPolicy = validateSourceBiasPolicy({
  version: 'bias-v2', nature: 'policy_preference', mildEligible: ['bing'], strongEligible: ['bing'],
  criteria: { none: 'No offered condition applies.', mild: 'Mild applies to incidental channel reliance.', strong: 'Strong applies when the answer depends on the generic channel alone.', unknown: 'Cannot establish channel reliance.' },
})
assert.equal(eligibleDiscountOptions(modelledPolicy, ['bing']).selection, 'model')
assert.deepEqual(Object.keys(discountCriteria(modelledPolicy, ['none', 'mild', 'strong', 'unknown'])).sort(), ['mild', 'none', 'strong', 'unknown'])
assert.throws(() => normalizePreferenceMatches(['match', 'match'], 1), RangeError)
assert.throws(() => normalizePreferenceMatches(['maybe'], 1), RangeError)

// ---- strategy: ranking plus an optional fixed community choice, never language ----
assert.deepEqual(COMMUNITY_OPTIONS, ['enable', 'disable', 'unknown'])
const presets = { balanced: 'neutral weights', research: 'research weights', fresh: 'freshness weights' }
const rankingOnly = buildStrategyRequest({ text: 'How do X and Y compare?' }, 'Direct experiments', ['Prefer public code'], { presets, includeCommunity: false })
assert.deepEqual(Object.keys(rankingOnly.questions), ['strategy.ranking'])
assert.deepEqual(rankingOnly.mapping.map((item) => item.kind), ['ranking'])
assert.equal(rankingOnly.questions['strategy.ranking'].criteria.research, 'research weights')
assert.equal(rankingOnly.state.constraints, undefined)
assert.equal(rankingOnly.state.task.includes('language'), false)
const withCommunity = buildStrategyRequest({ text: 'Q?' }, 'I', [], { presets, includeCommunity: true })
assert.deepEqual(Object.keys(withCommunity.questions).sort(), ['strategy.community', 'strategy.ranking'])
assert.deepEqual(withCommunity.mapping.map((item) => item.kind), ['ranking', 'community'])
for (const id of COMMUNITY_OPTIONS) assert.equal(withCommunity.questions['strategy.community'].criteria[id], COMMUNITY_CRITERIA[id])
assert.throws(() => buildStrategyRequest({ text: 'Q?' }, 'I', [], { includeCommunity: true }), TypeError)
for (const id of RANKING_OPTIONS) {
  assert.deepEqual(decodeStrategy(new Map([['strategy.ranking', { type: 'choice', choice: id }]])).ranking, { state: 'selected', ranking: id })
}
assert.deepEqual(decodeStrategy(new Map([['strategy.ranking', { type: 'choice', choice: 'hybrid' }]])).ranking, { state: 'fallback', ranking: 'balanced' })
assert.deepEqual(decodeStrategy(new Map()).ranking, { state: 'fallback', ranking: 'balanced' })
assert.deepEqual(decodeStrategy(new Map(), { includeCommunity: true }).community, { state: 'unavailable', choice: 'unavailable' })
assert.deepEqual(decodeStrategy(new Map([['strategy.community', { type: 'choice', choice: 'enable' }]]), { includeCommunity: true }).community, { state: 'selected', choice: 'enable' })
assert.deepEqual(decodeStrategy(new Map([['strategy.community', { type: 'choice', choice: 'sometimes' }]]), { includeCommunity: true }).community, { state: 'unavailable', choice: 'unavailable' })
// an explicit caller value is never asked back, so a stray answer is ignored
assert.deepEqual(decodeStrategy(new Map([['strategy.community', { type: 'choice', choice: 'enable' }]]), { includeCommunity: false }).community, { state: 'explicit', choice: null })
assert.equal(STRATEGY_POLICY_VERSION, 'screening-strategy-v2-community-no-language')
assert.equal(JUDGEMENT_POLICY_VERSION, 'screening-judgement-v4-no-scope-no-language')

// ---- screening request: no scope/info/constraints, safety only for pending ----
const candidate = (n, extra = {}) => ({
  evidenceId: `m${n}`, assocId: `a${n}`, questionId: 'q1', key: `https://e${n}.org/`, url: `https://e${n}.org/`,
  title: `T${n}`, domain: `e${n}.org`, published: null, text: `text ${n}`, basis: 'engine_snippet', textVersion: null,
  baseScore: 1, engines: ['bing'], engineRanks: { bing: n }, provenance: [], safetyState: 'clear', ...extra,
})
const clearPool = buildScreeningRequest({ text: 'Q?', intent: 'I' }, [candidate(1)], { preferences: ['Prefer code'], policy })
assert.deepEqual(Object.keys(clearPool.questions).sort(), ['pref.m1.0', 'value.m1'])
assert.deepEqual(clearPool.mapping.map((item) => item.kind), ['value', 'discount', 'preference'])
assert.equal(clearPool.state.constraints, undefined)
assert.equal(JSON.stringify(clearPool).includes('scope.'), false)
assert.equal(JSON.stringify(clearPool).includes('info.'), false)
assert.deepEqual(SAFETY_OPTIONS, ['clear', 'violation', 'unavailable'])
const pendingPool = buildScreeningRequest({ text: 'Q?', intent: 'I' }, [candidate(1, { safetyState: 'pending' })], { preferences: [], policy })
assert.deepEqual(pendingPool.mapping.map((item) => item.kind), ['safety', 'value', 'discount'])
assert.deepEqual(Object.keys(pendingPool.questions['safety.m1'].criteria).sort(), ['clear', 'unavailable', 'violation'])
assert.match(pendingPool.questions['safety.m1'].instructions, /state\.sources\[0\]/)
// real provenance is attached; missing provenance stays a code fact
const rubric = buildScreeningRequest({ text: 'Q?', intent: 'I' }, [candidate(1)], { preferences: [], policy })
assert.match(rubric.questions['value.m1'].criteria['5'], /original source|measurement conditions/)
assert.deepEqual(rubric.state.sources[0].retrieval, { engines: ['bing'], engineRanks: { bing: 1 } })
const noEngines = buildScreeningRequest({ text: 'Q?', intent: 'I' }, [candidate(1, { engines: [], engineRanks: {} })], { preferences: [], policy })
assert.ok(!('discount.m1' in noEngines.questions))
assert.deepEqual(decodeScreening(new Map(), noEngines.mapping).get('m1').discount,
  { state: 'selected', option: 'unknown', codeSelected: true, selectedBy: 'code', disclosedUnknown: true })
const decoded = decodeScreening(new Map(), pendingPool.mapping).get('m1')
assert.deepEqual(decoded.safety, 'unavailable') // missing safety is NOT clear
assert.equal(decoded.value.state, 'unavailable') // missing value is NOT level 0
assert.equal(decoded.preferences.length, 0)
assert.equal(decodeScreening(new Map([['safety.m1', { type: 'choice', choice: 'violation' }], ['value.m1', { type: 'choice', choice: '5', confidence: .42 }]]), pendingPool.mapping).get('m1').safety, 'violation')
assert.equal(decodeScreening(new Map([['value.m1', { type: 'choice', choice: '4', confidence: .42 }]]), clearPool.mapping).get('m1').valueConfidence, .42)
assert.equal(decodeScreening(new Map([['value.m1', { type: 'choice', choice: 'unestablished' }]]), clearPool.mapping).get('m1').value.state, 'unestablished')
assert.deepEqual(Object.keys(decodeScreening(new Map(), clearPool.mapping).get('m1')), ['safety', 'value', 'valueConfidence', 'discount', 'discountConfidence', 'preferences', 'preferenceConfidences'])
// a modelled policy turns the discount into a real judgement with full criteria
const modelledRequest = buildScreeningRequest({ text: 'Q?', intent: 'I' }, [candidate(1)], { preferences: [], policy: modelledPolicy })
assert.ok('discount.m1' in modelledRequest.questions)
assert.match(modelledRequest.questions['discount.m1'].criteria.strong, /generic channel alone/)
const modelledDecoded = decodeScreening(new Map([['value.m1', { type: 'choice', choice: '5' }], ['discount.m1', { type: 'choice', choice: 'mild', confidence: .77 }]]), modelledRequest.mapping)
assert.equal(modelledDecoded.get('m1').discount.option, 'mild')
assert.equal(modelledDecoded.get('m1').discount.selectedBy, 'model')
assert.equal(modelledDecoded.get('m1').discountConfidence, .77)

// ---- snapshot: URL identity merging, worst safety, provenance, text cap ----
const rows = [
  { url: 'https://a.org/x', title: 'A', score: 1, engineRanks: { bing: 2 }, provenance: [{ engine: 'bing', rank: 2 }] },
  { url: 'https://a.org/x#frag', title: 'A alt', score: .5, snippet: 'other snippet', engineRanks: { exa: 1 }, provenance: [{ engine: 'exa', rank: 1 }] },
  { url: 'https://b.org/y', title: 'B', score: 2, content: 'full text', engineRanks: { bing: 1 }, provenance: [{ engine: 'bing', rank: 1 }] },
]
const snapshot = buildSnapshot(rows)
assert.equal(snapshot.length, 2)
assert.equal(snapshot[0].key, 'https://b.org/y')
assert.equal(snapshot[0].basis, 'page_content')
const mergedA = snapshot.find((row) => row.key.startsWith('https://a.org'))
assert.deepEqual(mergedA.engines, ['bing', 'exa'])
assert.equal(mergedA.baseScore, 1)
assert.equal(mergedA.safetyState, 'unavailable') // unknown is not a pass
assert.equal(buildSnapshot(rows, { maxTextChars: 3 })[0].text, 'ful')
assert.throws(() => buildSnapshot(rows, { maxTextChars: 0 }), TypeError)
for (const order of [[{ safetyState: 'pending', score: 2 }, { safetyState: 'violation', score: 1 }], [{ safetyState: 'violation', score: 2 }, { safetyState: 'pending', score: 1 }]]) {
  const merged = buildSnapshot(order.map((extra) => ({ ...candidate(1), url: 'https://dup.example/p', title: 'P', snippet: 's', ...extra })))[0]
  assert.equal(merged.safetyState, 'violation')
}
// zero-weight engines cannot widen provenance or discount eligibility
const weighted = buildSnapshot([{ url: 'https://z.org/r', score: 1, snippet: 's', engineRanks: { bing: 1, exa: 1 }, provenance: [{ engine: 'bing' }, { engine: 'exa' }] }], { engineWeights: { bing: 1, exa: 0 } })[0]
assert.deepEqual(weighted.engines, ['bing'])
assert.deepEqual(weighted.provenance.map((entry) => entry.engine), ['bing'])
assert.equal(weighted.provenanceBasis, 'positive_weight_contributors')
assert.deepEqual(eligibleDiscountOptions(validateSourceBiasPolicy({ version: 'b', nature: 'policy_preference', mildEligible: ['bing'], strongEligible: ['bing'] }), weighted.engines).options, ['none', 'mild', 'strong', 'unknown'])

// ---- admission gate + ranking ----
const judged = (over = {}) => new Map([['m1', {
  safety: 'clear', value: { state: 'level', level: 5 },
  discount: { state: 'selected', option: 'none', codeSelected: true, selectedBy: 'code' }, preferences: [], ...over,
}]])
const cand = (n, over = {}) => ({ evidenceId: `m${n}`, key: `k${n}`, url: `https://k${n}/`, title: `T${n}`, text: `t${n}`, baseScore: 1, engines: ['bing'], safetyState: 'clear', ...over })
for (const level of [0, 1, 2]) {
  const artifact = admitAndRank({ candidates: [cand(1)], judgements: judged({ value: { state: 'level', level } }) })
  assert.equal(artifact.results.length, 0, `value ${level} must not be delivered`)
  assert.equal(artifact.decisions[0].reason, 'value_filtered')
}
const admitted = admitAndRank({ candidates: [cand(1)], judgements: judged() })
assert.equal(admitted.results.length, 1)
assert.equal(admitted.results[0].valueLabel, 'high')
assert.equal(admitted.results[0].rank, 1)
assert.deepEqual(Object.keys(admitted.results[0].signals), ['valueConfidence', 'discountConfidence'])
assert.equal(admitted.admissionPolicyVersion, ADMISSION_POLICY_VERSION)
assert.equal(ADMISSION_POLICY_VERSION, 'no-scope-v1')
// safety facts are terminal and independent of any judgement
for (const [safety, reason, key] of [['violation', 'safety_rejected', 'safetyRejected'], ['unavailable', 'safety_unavailable', 'safetyUnavailable'], ['pending', 'safety_unavailable', 'safetyUnavailable']]) {
  const artifact = admitAndRank({ candidates: [cand(1, { safetyState: safety })], judgements: judged() })
  assert.equal(artifact.results.length, 0, safety)
  assert.equal(artifact.decisions[0].reason, reason)
  assert.equal(artifact.diagnostics[key], 1)
}
// unknown value states and missing base scores are disclosed, never defaulted
assert.equal(admitAndRank({ candidates: [cand(1)], judgements: judged({ value: { state: 'unestablished' } }) }).decisions[0].reason, 'value_unestablished')
assert.equal(admitAndRank({ candidates: [cand(1)], judgements: judged({ value: { state: 'unavailable' } }) }).decisions[0].reason, 'value_unavailable')
assert.equal(admitAndRank({ candidates: [cand(1, { baseScore: 0 })], judgements: judged() }).decisions[0].reason, 'base_score_missing')
assert.equal(admitAndRank({ candidates: [cand(1)], judgements: new Map() }).decisions[0].reason, 'pending')
assert.equal(admitAndRank({ candidates: [cand(1)], judgements: new Map(), unassessable: { m1: 'request_too_large' } }).decisions[0].reason, 'request_too_large')
// no scope/info residue on decisions or diagnostics
const decisionKeys = Object.keys(admitAndRank({ candidates: [cand(1)], judgements: judged({ value: { state: 'level', level: 2 } }) }).decisions[0])
assert.deepEqual(decisionKeys.sort(), ['admitted', 'evidenceId', 'reason', 'url'])
const diagnosticKeys = Object.keys(admitAndRank({ candidates: [cand(1)], judgements: judged() }).diagnostics)
assert.equal(diagnosticKeys.some((key) => /scope|info|rescue/i.test(key)), false)
assert.equal(diagnosticKeys.some((key) => /constraint/i.test(key)), false)
// conservation: every collected candidate is counted exactly once
const conservation = admitAndRank({
  candidates: [cand(1), cand(2), cand(3, { safetyState: 'violation' }), cand(4, { baseScore: NaN }), cand(5)],
  judgements: new Map([['m1', judged().get('m1')], ['m2', judged({ value: { state: 'level', level: 2 } }).get('m1')], ['m5', judged({ value: { state: 'unestablished' } }).get('m1')]]),
  maxResults: 2,
})
const dispositions = ['pending', 'safetyRejected', 'safetyUnavailable', 'valueFiltered', 'valueUnestablished', 'assessmentUnavailable', 'baseScoreMissing', 'requestTooLarge', 'judgementUnavailable']
assert.equal(dispositions.reduce((sum, key) => sum + conservation.diagnostics[key], 0) + conservation.diagnostics.qualityAssessed, conservation.diagnostics.collected)
assert.deepEqual(conservation.results.map((row) => row.id), ['r1'])
assert.deepEqual(conservation.valueGroups[5], ['r1'])
// ranking order: finalScore, then fused base score, then key; valueGroups never reorder
const ranked = admitAndRank({
  candidates: [cand(1, { baseScore: .5, key: 'a' }), cand(2, { baseScore: .9, key: 'b' }), cand(3, { baseScore: .5, key: 'c' })],
  judgements: new Map([
    ['m1', judged({ value: { state: 'level', level: 4 } }).get('m1')],
    ['m2', judged({ value: { state: 'level', level: 4 } }).get('m1')],
    ['m3', judged({ value: { state: 'level', level: 5 } }).get('m1')],
  ]),
  maxResults: 8,
})
assert.deepEqual(ranked.results.map((row) => [row.rank, row.evidenceId]), [[1, 'm3'], [2, 'm2'], [3, 'm1']])
assert.deepEqual(ranked.valueGroups[5], ['r1'])
near(ranked.results[0].finalScore, 2 / 3)
// confidence changes the recorded signal only
const sameLevel = admitAndRank({
  candidates: [cand(1), cand(2)],
  judgements: new Map([['m1', judged({ valueConfidence: .2 }).get('m1')], ['m2', judged({ valueConfidence: .99 }).get('m1')]]),
})
assert.deepEqual(sameLevel.results.map((row) => [row.valueLevel, row.finalScore, row.signals.valueConfidence]), [[5, .75, .2], [5, .75, .99]])
// maxResults truncates after ranking; replay is deterministic
const trunc = admitAndRank({ candidates: [cand(1), cand(2), cand(3)], judgements: new Map([['m1', judged().get('m1')], ['m2', judged().get('m1')], ['m3', judged().get('m1')]]), maxResults: 1 })
assert.equal(trunc.results.length, 1)
assert.equal(trunc.selection.targetMet, true)
assert.equal(admitAndRank({ candidates: [cand(2), cand(1)], judgements: new Map([['m1', judged().get('m1')], ['m2', judged().get('m1')]]) }).results.length, 2)
const twice = (value) => JSON.stringify(value)
assert.equal(twice(admitAndRank({ candidates: [cand(2), cand(1)], judgements: new Map([['m1', judged().get('m1')], ['m2', judged().get('m1')]]) })), twice(admitAndRank({ candidates: [cand(2), cand(1)], judgements: new Map([['m1', judged().get('m1')], ['m2', judged().get('m1')]]) })))
assert.throws(() => admitAndRank({ candidates: [cand(1)], judgements: judged(), maxResults: 0 }), RangeError)
// preferences average exactly once and unknown provenance stays neutral D=1
const prefOnly = admitAndRank({
  candidates: [cand(1)], preferences: ['P'],
  judgements: new Map([['m1', judged({ discount: { state: 'selected', option: 'unknown', codeSelected: true, disclosedUnknown: true }, preferences: ['match'] }).get('m1')]]),
})
assert.equal(prefOnly.results[0].sourceDiscountFactor, 1)
near(prefOnly.results[0].preferenceBonus, .1)
assert.throws(() => admitAndRank({ candidates: 'x', judgements: judged() }), TypeError)

// ---- batched runner: bounded packing, failure isolation, cancellation ----
const answers = (request) => new Map(request.mapping.map((item) => [item.id, item.kind === 'safety' ? { type: 'choice', choice: 'clear' }
  : item.kind === 'value' ? { type: 'choice', choice: '5' } : item.kind === 'discount' ? { type: 'choice', choice: 'none' } : { type: 'choice', choice: 'match' }]))
const judgedPool = [candidate(1), candidate(2), candidate(3)]
const batched = await runScreening({ candidates: judgedPool, question: 'Q?', intent: 'I', batchSize: 2, maxResults: 8, judge: async (request) => answers(request) })
assert.equal(batched.diagnostics.judgeCalls, 2)
assert.equal(batched.results.length, 3)
assert.deepEqual(batched.results.map((row) => row.rank), [1, 2, 3])
assert.deepEqual(batched.results.map((row) => row.safetyState), ['clear', 'clear', 'clear'])
// a pending candidate's safety answer is bound to the text that was reviewed
const safetyBound = await runScreening({
  candidates: [candidate(1, { safetyState: 'pending', text: 'reviewed text' })], question: 'Q?', intent: 'I', maxResults: 8,
  judge: async (request) => { assert.ok('safety.m1' in request.questions); return answers(request) },
})
assert.equal(safetyBound.results[0].description, 'reviewed text')
assert.equal(safetyBound.results[0].safetyState, 'clear')
const safetyViolation = await runScreening({
  candidates: [candidate(1, { safetyState: 'pending' })], question: 'Q?', intent: 'I', maxResults: 8,
  judge: async (request) => new Map(request.mapping.map((item) => [item.id, item.kind === 'safety' ? { type: 'choice', choice: 'violation' } : item.kind === 'value' ? { type: 'choice', choice: '5' } : { type: 'choice', choice: 'none' }])),
})
assert.equal(safetyViolation.results.length, 0)
assert.equal(safetyViolation.decisions[0].reason, 'safety_rejected')
// safetyUNAVAILABLE from a missing safety answer counts as incomplete
const safetyMissing = await runScreening({
  candidates: [candidate(1, { safetyState: 'pending' })], question: 'Q?', intent: 'I', maxResults: 8,
  judge: async (request) => new Map(request.mapping.filter((item) => item.kind !== 'safety').map((item) => [item.id, item.kind === 'value' ? { type: 'choice', choice: '5' } : { type: 'choice', choice: 'none' }])),
})
assert.equal(safetyMissing.decisions[0].reason, 'safety_unavailable')
assert.equal(safetyMissing.diagnostics.safetyUnavailable, 1)
assert.equal(safetyMissing.selection.incomplete, true)
// terminal code facts never reach the judge; no rescue/read path exists
let terminalCalls = 0
const terminal = await runScreening({
  candidates: [candidate(1, { safetyState: 'violation' }), candidate(2, { baseScore: 0 }), candidate(3)], question: 'Q?', intent: 'I',
  judge: async (request) => { terminalCalls++; assert.deepEqual(request.state.candidates.map((ref) => ref.id), ['m3']); return answers(request) },
})
assert.equal(terminalCalls, 1)
assert.equal(terminal.diagnostics.safetyRejected, 1)
assert.equal(terminal.diagnostics.baseScoreMissing, 1)
assert.deepEqual(terminal.results.map((row) => row.evidenceId), ['m3'])
// size-bounded packing: batchSize is an upper bound, the wire envelope rules
{
  const big = (n) => candidate(n, { text: 'x'.repeat(6000) })
  const bigLimits = { maxStateChars: 12000, maxRequestChars: 16000 }
  const judgedOrder = []
  let calls = 0
  const packed = await runScreening({
    candidates: [big(1), big(2), big(3), big(4)], question: 'Q?', intent: 'I', limits: bigLimits,
    judge: async (request) => { calls++; assert.ok(requestFits(request, bigLimits)); judgedOrder.push(...request.state.candidates.map((ref) => ref.id)); return answers(request) },
  })
  assert.ok(calls >= 2)
  assert.deepEqual(judgedOrder, ['m1', 'm2', 'm3', 'm4'])
  assert.equal(packed.results.length, 4)
  assert.equal(packed.diagnostics.requestTooLarge, 0)
  const oversized = await runScreening({
    candidates: [big(1), big(2)], question: 'Q?', intent: 'I', limits: { maxStateChars: 400, maxRequestChars: 600 },
    judge: async () => { throw new Error('must not be called') },
  })
  assert.equal(oversized.diagnostics.requestTooLarge, 2)
  assert.equal(oversized.diagnostics.judgeCalls, 0)
  assert.equal(oversized.selection.stopReason, 'unassessable_material')
  assert.equal(oversized.selection.incomplete, true)
}
// a failed batch keeps everything already decided
{
  let attempt = 0
  const flaky = await runScreening({
    candidates: [candidate(1), candidate(2), candidate(3), candidate(4)], question: 'Q?', intent: 'I', batchSize: 2,
    judge: async (request) => { if (++attempt === 2) throw new Error('judge unavailable'); return answers(request) },
  })
  assert.equal(flaky.run.judgeFailures, 1)
  assert.equal(flaky.run.halted, 'judge_failure')
  assert.deepEqual(flaky.run.judgeFailedIds, ['m3', 'm4'])
  assert.deepEqual(flaky.results.map((row) => row.evidenceId), ['m1', 'm2'])
  assert.equal(flaky.selection.stopReason, 'judge_failure')
  assert.equal(flaky.selection.incomplete, true)
}
// cancellation and deadline stop the work without discarding valid results
{
  const preAborted = new AbortController()
  preAborted.abort()
  const cancelled = await runScreening({
    candidates: [candidate(1)], question: 'Q?', intent: 'I', signal: preAborted.signal,
    judge: async () => assert.fail('an already-aborted signal must perform no work'),
  })
  assert.equal(cancelled.diagnostics.judgeCalls, 0)
  assert.equal(cancelled.run.halted, 'cancelled')
  assert.equal(cancelled.selection.stopReason, 'cancelled')
  const midAbort = new AbortController()
  const midRun = await runScreening({
    candidates: [candidate(1), candidate(2)], question: 'Q?', intent: 'I', batchSize: 1, signal: midAbort.signal,
    judge: async (request) => { midAbort.abort(); return answers(request) },
  })
  assert.equal(midRun.diagnostics.judgeCalls, 1)
  assert.equal(midRun.run.halted, 'cancelled')
  assert.deepEqual(midRun.results.map((row) => row.evidenceId), ['m1'])
  // No internal total deadline exists: a judge that outlasts the retired
  // 120/150-second values still finishes, and only the caller's signal stops it.
  const realNow = Date.now
  let now = 1_000
  Date.now = () => now
  try {
    const slow = await runScreening({
      candidates: [candidate(1), candidate(2)], question: 'Q?', intent: 'I', batchSize: 1, maxResults: 2,
      judge: async (request) => { now += 90_000; return answers(request) },
    })
    assert.equal(slow.run.halted, null)
    assert.equal(slow.selection.stopReason, 'target_met')
    assert.equal(slow.results.length, 2)
    assert.ok(now - 1_000 > 150_000, 'simulated wall clock passes the retired total-duration caps')
  } finally { Date.now = realNow }
}
// invalid configuration never consumes a judgement call
for (const invalid of [{ params: { lambda: 2 } }, { maxResults: 0 }, { policy: { ...policy, criteria: { unknown: 'x' } } }]) {
  let calls = 0
  await assert.rejects(runScreening({ candidates: [candidate(1)], question: 'Q?', intent: 'I', ...invalid, judge: async () => { calls++ } }), /lambda|maxResults|must describe every option/)
  assert.equal(calls, 0)
}
await assert.rejects(runScreening({ candidates: [candidate(1)], question: 'Q?', judge: null }), TypeError)
await assert.rejects(runScreening({ candidates: [], question: 'Q?', intent: ' ' }), TypeError)

console.log('ok: N_off screening gate, prototype math, fixed-option strategy/community decoding, snapshot provenance, bounded batches and failure isolation')
