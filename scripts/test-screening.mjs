import './isolate-tests.mjs'
import assert from 'node:assert/strict'
import { screeningScore, normalizeBase, preferenceValue, validateParams, DEFAULT_SCREENING_PARAMS, SCREENING_POLICY_VERSION } from '../lib/search/screening/scoring.js'
import { validateSourceBiasPolicy, eligibleDiscountOptions, discountCriteria, normalizePreferenceMatches, NEUTRAL_SOURCE_BIAS_POLICY, RANKING_OPTIONS, DISCOUNT_OPTIONS, VALUE_OPTIONS, PREFERENCE_MATCH_OPTIONS } from '../lib/search/screening/policy.js'
import { buildStrategyRequest, decodeStrategy, buildScreeningRequest, decodeScreening, JUDGEMENT_POLICY_VERSION, JUDGEMENT_THRESHOLDS } from '../lib/search/screening/judgments.js'
import { buildSnapshot, admitAndRank, runScreening } from '../lib/search/screening/controller.js'
import { requestFits } from '../lib/search/adaptive/material.js'

const near = (actual, expected, eps = 1e-12) => assert.ok(Math.abs(actual - expected) < eps, `${actual} != ${expected}`)

// ---- scoring math: the documented examples (design doc appendix A) ----
const s = (baseScore, valueLevel, discount = 'none', preferenceMatches = []) =>
  screeningScore({ baseScore, valueLevel, discount, preferenceMatches })
near(s(1, 3).finalScore, .375)
near(s(.5, 5).finalScore, 2 / 3)
near(s(.1, 5).finalScore, 6 / 11)
near(s(1, 5, 'strong').finalScore, .5625)
near(s(1, 4, 'none', ['match', 'match']).finalScore, .65)
// old multiplier model cannot reverse a 2x base gap; the new one can (10x here)
assert.ok(s(.1, 5).finalScore > s(1, 3).finalScore)
assert.ok(s(1, 4, 'none', ['match', 'match']).finalScore > s(1, 5, 'strong').finalScore)
// ...but a very strong B still wins at the boundary: documented, not hidden
assert.ok(s(100, 3).finalScore > s(.01, 5).finalScore)
near(s(100, 3).finalScore, .6200495049504951)
near(s(.01, 5).finalScore, .504950495049505)

// contributions reconstruct the final score exactly
const detail = screeningScore({ baseScore: .7, valueLevel: 4, discount: 'mild', preferenceMatches: ['match', 'partial'] })
near(detail.baseContribution + detail.valueContribution, detail.coreScore)
near(detail.coreScore - detail.sourcePenalty + detail.preferenceBonus, detail.finalScore)
near(detail.selectionScore, detail.finalScore)
assert.equal(detail.policyVersion, SCREENING_POLICY_VERSION)

// ---- normalizeBase / preferenceValue / validateParams contracts ----
near(normalizeBase(1, 1), .5)
near(normalizeBase(2, 1), 2 / 3)
assert.ok(normalizeBase(10, 1) > normalizeBase(1, 1))
assert.ok(normalizeBase(Number.MAX_VALUE, 1) <= 1 && Number.isFinite(normalizeBase(Number.MAX_VALUE, 1)))
assert.ok(Number.isFinite(normalizeBase(Number.MIN_VALUE, Number.MAX_VALUE)))
near(normalizeBase(Number.MAX_VALUE, Number.MAX_VALUE), .5)
for (const [b, t] of [[0, 1], [-1, 1], [NaN, 1], [Infinity, 1], [1, 0], [1, -1], [1, Infinity]]) {
  assert.throws(() => normalizeBase(b, t), RangeError)
}
assert.equal(preferenceValue([], DEFAULT_SCREENING_PARAMS.preferenceMatchValues), 0)
near(preferenceValue(['match', 'partial', 'no_match', 'unknown'], DEFAULT_SCREENING_PARAMS.preferenceMatchValues), .375)
assert.throws(() => preferenceValue(['maybe'], DEFAULT_SCREENING_PARAMS.preferenceMatchValues), RangeError)
assert.throws(() => preferenceValue('match', DEFAULT_SCREENING_PARAMS.preferenceMatchValues), TypeError)
for (const bad of [
  { lambda: 1.5 }, { lambda: -.1 }, { tau: 0 }, { tau: Infinity }, { epsilon: -.1 }, { mu: -1 },
  { utilities: { 3: .6, 4: .6, 5: 1 } }, { utilities: { 3: -.1, 4: .6, 5: 1 } }, { utilities: { 3: .1, 4: .5, 5: 1, 6: .9 } },
  { discountFactors: { none: 0, mild: .9, strong: .75, unknown: 1 } },
  { discountFactors: { unknown: .5 } }, { discountFactors: { none: .9 } }, { discountFactors: { strong: .95 } },
  { preferenceMatchValues: { match: 1, partial: .5, no_match: .1, unknown: 0 } },
]) assert.throws(() => validateParams(bad), /./)
// partial tables merge over defaults (same pattern as SCORE_CONFIG overrides)
const partial = validateParams({ utilities: { 3: .2, 4: .6 } })
near(partial.utilities[5], 1)
const tuned = validateParams({ lambda: .25, tau: 2, utilities: { 3: .1, 4: .5, 5: 1 } })
assert.equal(tuned.lambda, .25)
near(tuned.discountFactors.none, 1)
assert.ok(Object.isFrozen(tuned) && Object.isFrozen(tuned.utilities))
for (const bad of [{ baseScore: 1, valueLevel: 2, discount: 'none' }, { baseScore: 1, valueLevel: 6, discount: 'none' },
  { baseScore: 1, valueLevel: 4.5, discount: 'none' }, { baseScore: 1, valueLevel: 3, discount: 'harsh' },
  { baseScore: 1, valueLevel: 3, discount: 'none', redundancy: 2 }, { baseScore: 0, valueLevel: 3, discount: 'none' }]) {
  assert.throws(() => screeningScore(bad), /./)
}

// ---- seeded property checks (fixed seed: reproducible, not a benchmark) ----
let seed = 20260928
const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32)
for (let i = 0; i < 10000; i++) {
  const base = 10 ** (-4 + 8 * random())
  const level = 3 + Math.floor(random() * 3)
  const discount = DISCOUNT_OPTIONS[Math.floor(random() * DISCOUNT_OPTIONS.length)]
  const matches = Array.from({ length: 1 + Math.floor(random() * 3) }, () => PREFERENCE_MATCH_OPTIONS[Math.floor(random() * PREFERENCE_MATCH_OPTIONS.length)])
  const params = { ...DEFAULT_SCREENING_PARAMS, tau: 10 ** (-2 + 4 * random()), lambda: random(), epsilon: random() * .2 }
  const score = screeningScore({ baseScore: base, valueLevel: level, discount, preferenceMatches: matches }, params)
  assert.ok(score.finalScore >= 0 && score.finalScore <= 1 + params.epsilon + 1e-12)
  assert.ok(screeningScore({ baseScore: base * 2, valueLevel: level, discount, preferenceMatches: matches }, params).finalScore >= score.finalScore - 1e-12)
  assert.ok(screeningScore({ baseScore: base, valueLevel: Math.min(5, level + 1), discount, preferenceMatches: matches }, params).finalScore >= score.finalScore - 1e-12)
  assert.ok(screeningScore({ baseScore: base, valueLevel: level, discount, preferenceMatches: [...matches, 'match'] }, params).finalScore >= score.finalScore - 1e-12)
  // A strictly stronger discount factor can only lower the score: no disjunct,
  // so none->mild and unknown->strong are really evaluated.
  assert.ok(screeningScore({ baseScore: base, valueLevel: level, discount: discount === 'none' ? 'mild' : 'strong', preferenceMatches: matches }, params).finalScore <= score.finalScore + 1e-12)
  // common rescaling of B and tau leaves b unchanged
  const scale = 10 ** (-3 + 6 * random())
  near(normalizeBase(base * scale, params.tau * scale), score.baseNormalized, 1e-9)
  // pairwise delta identity: value and preference effects are NOT multiplied by B
  const base2 = 10 ** (-4 + 8 * random())
  const level2 = 3 + Math.floor(random() * 3)
  const other = screeningScore({ baseScore: base2, valueLevel: level2, discount, preferenceMatches: matches }, params)
  near(score.finalScore - other.finalScore,
    score.sourceDiscountFactor * (params.lambda * (score.baseNormalized - other.baseNormalized) + (1 - params.lambda) * (score.valueUtility - other.valueUtility)), 1e-9)
}
// lambda=1, D=1, epsilon=0 reproduces the B ordering exactly
const flat = { ...DEFAULT_SCREENING_PARAMS, lambda: 1, epsilon: 0 }
const pool = [.01, 3, 1, 50, .2, 7].map((baseScore) => ({ baseScore, finalScore: screeningScore({ baseScore, valueLevel: 5, discount: 'none' }, flat).finalScore }))
assert.deepEqual([...pool].sort((a, b) => b.finalScore - a.finalScore).map((r) => r.baseScore), [50, 7, 3, 1, .2, .01])

// ---- source bias policy: fixed options, real provenance, no invented engines ----
assert.throws(() => validateSourceBiasPolicy({ version: 'x', nature: 'policy_preference', mildEligible: ['bing'], strongEligible: ['tavily'] }), RangeError)
assert.throws(() => validateSourceBiasPolicy({ version: '', nature: 'policy_preference' }), TypeError)
assert.throws(() => validateSourceBiasPolicy({ version: 'x', nature: 'quality_proof' }), TypeError)
const policy = validateSourceBiasPolicy({ version: 'bias-v1', nature: 'policy_preference', mildEligible: ['ddg', 'bing', 'bing'], strongEligible: ['bing'] })
assert.deepEqual(policy.mildEligible, ['bing', 'ddg'])
const neutralOptions = eligibleDiscountOptions(NEUTRAL_SOURCE_BIAS_POLICY, ['bing', 'exa'])
assert.deepEqual(neutralOptions.options, ['none', 'unknown'])
// A policy that only lists eligible engines does not say WHEN to discount, so
// the level is a code fact (nothing is asked) instead of an undefined choice.
assert.equal(neutralOptions.selection, 'code')
assert.equal(neutralOptions.codeSelected, 'none')
const noProvenance = eligibleDiscountOptions(policy, [])
assert.deepEqual(noProvenance.options, ['unknown'])
assert.equal(noProvenance.codeSelected, 'unknown')
assert.equal(noProvenance.basis, 'missing_provenance')
assert.equal(noProvenance.selection, 'code')
const mildOnly = eligibleDiscountOptions(policy, ['bing', 'ddg'])
assert.deepEqual(mildOnly.options, ['none', 'mild', 'unknown'])
assert.equal(mildOnly.codeSelected, 'mild')
const strong = eligibleDiscountOptions(policy, ['bing'])
assert.deepEqual(strong.options, ['none', 'mild', 'strong', 'unknown'])
assert.equal(strong.codeSelected, 'strong')
// an engine outside the policy sets can only weaken the discount
const mixed = eligibleDiscountOptions(policy, ['bing', 'tavily'])
assert.deepEqual(mixed.options, ['none', 'unknown'])
assert.equal(mixed.codeSelected, 'none')
// a policy that WRITES the conditions makes the level a real judgement, and the
// option text is self-contained instead of a bare label
const modelledPolicy = validateSourceBiasPolicy({
  version: 'bias-v2', nature: 'policy_preference', mildEligible: ['bing', 'ddg'], strongEligible: ['bing'],
  criteria: {
    none: 'No offered channel-discount condition applies.',
    mild: 'Mild applies only to incidental reliance on a generic channel.',
    strong: 'Strong applies when the answer depends on the generic channel alone.',
    unknown: 'The supplied evidence cannot establish channel reliance.',
  },
})
const modelledOptions = eligibleDiscountOptions(modelledPolicy, ['bing'])
assert.equal(modelledOptions.selection, 'model')
assert.equal(modelledOptions.codeSelected, null)
assert.deepEqual(Object.keys(discountCriteria(modelledPolicy, modelledOptions.options)).sort(), ['mild', 'none', 'strong', 'unknown'])
assert.match(discountCriteria(modelledPolicy, modelledOptions.options).mild, /incidental reliance/)
assert.equal(discountCriteria(modelledPolicy, modelledOptions.options).none, modelledPolicy.criteria.none)
// Partial policies used to silently combine custom criteria with overlapping
// engine-list defaults. Reject every incomplete subset, not just one example.
for (let mask = 1; mask < 15; mask++) {
  const criteria = Object.fromEntries(Object.entries(modelledPolicy.criteria).filter((_, index) => mask & (1 << index)))
  assert.throws(() => validateSourceBiasPolicy({ ...policy, criteria }), /must describe every option/)
}
assert.throws(() => validateSourceBiasPolicy({ ...policy, criteria: [] }), /must be an object/)
assert.throws(() => validateSourceBiasPolicy({ version: 'x', nature: 'policy_preference', criteria: { harsh: 'no' } }), RangeError)
assert.throws(() => validateSourceBiasPolicy({ version: 'x', nature: 'policy_preference', criteria: { mild: '  ' } }), TypeError)
// keyed/anonymous aliases normalise to the logical engine
assert.deepEqual(eligibleDiscountOptions(validateSourceBiasPolicy({ version: 'v', nature: 'policy_preference', mildEligible: ['anysearch'] }), ['anysearch-keyed']).options, ['none', 'mild', 'unknown'])
assert.throws(() => normalizePreferenceMatches(['match', 'match'], 1), RangeError)
assert.throws(() => normalizePreferenceMatches(['maybe'], 1), RangeError)
const echoed = ['partial', 'match']
const normalized = normalizePreferenceMatches(echoed, 2)
assert.deepEqual(normalized, ['partial', 'match']) // order preserved
assert.notEqual(normalized, echoed) // a fresh array, not the caller's input

// ---- judgements: Jev selects fixed options, missing answers are unavailable ----
const strategyRequest = buildStrategyRequest({ text: 'How do X and Y compare?' }, 'Direct experiments', ['Prefer public code'], { presets: { balanced: 'neutral weights', research: 'research weights', fresh: 'freshness weights' } })
// criteria are the operational definition of the option: no pointer to an empty state.presets
assert.equal(strategyRequest.questions['strategy.ranking'].criteria.research, 'research weights')
assert.throws(() => buildStrategyRequest({ text: 'Q?' }, 'I', [], { presets: { balanced: 'x', research: 'y' } }), TypeError)
assert.throws(() => buildStrategyRequest({ text: 'Q?' }, 'I'), TypeError)
assert.deepEqual(Object.keys(strategyRequest.questions).sort(), ['strategy.language', 'strategy.ranking'])
for (const id of RANKING_OPTIONS) {
  assert.deepEqual(decodeStrategy(new Map([['strategy.ranking', { type: 'choice', choice: id }], ['strategy.language', { type: 'choice', choice: 'english' }]])).ranking, { state: 'selected', ranking: id })
}
const goodStrategy = decodeStrategy(new Map([['strategy.language', { type: 'choice', choice: 'english' }], ['strategy.ranking', { type: 'choice', choice: 'research' }]]))
assert.equal(goodStrategy.language.state, 'english')
assert.deepEqual(goodStrategy.ranking, { state: 'selected', ranking: 'research' })
const badStrategy = decodeStrategy(new Map([['strategy.language', { type: 'choice', choice: 'english' }], ['strategy.ranking', { type: 'choice', choice: 'hybrid' }]]))
assert.deepEqual(badStrategy.ranking, { state: 'fallback', ranking: 'balanced' })
assert.equal(decodeStrategy(new Map()).language.state, 'unavailable')

const candidate = (n, extra = {}) => ({
  evidenceId: `m${n}`, assocId: `a${n}`, questionId: 'q1', key: `https://e${n}.org/`, url: `https://e${n}.org/`,
  title: `T${n}`, domain: `e${n}.org`, published: null, text: `text ${n}`, basis: 'engine_snippet', textVersion: null,
  baseScore: 1, engines: ['bing'], engineRanks: { bing: n }, provenance: [{ engine: 'bing', rank: n, variant: 'q', url: `https://e${n}.org/`, title: `T${n}`, snippet: `text ${n}` }],
  safetyState: 'clear', ...extra,
})
const constraints = ['Must use the same model for both approaches']
const withConstraints = buildScreeningRequest({ text: 'Q?', intent: 'I' }, [candidate(1)], { constraints, preferences: ['Prefer code'], policy })
const constraintless = buildScreeningRequest({ text: 'Q?', intent: 'I' }, [candidate(1)], { constraints: [], preferences: [], policy })
assert.ok('scope.m1' in withConstraints.questions && 'info.m1' in withConstraints.questions)
assert.ok(!('scope.m1' in constraintless.questions))
assert.ok('pref.m1.0' in withConstraints.questions)
// no criteria in `policy` -> the level is a code fact for that policy's engine lists
assert.deepEqual(Object.keys(constraintless.questions).sort(), ['value.m1'])
assert.deepEqual(decodeScreening(new Map(), constraintless.mapping).get('m1').discount,
  { state: 'selected', option: 'strong', codeSelected: true, selectedBy: 'code' })
// the neutral default declares no bias at all, so it stays at `none`
const neutralRequest = buildScreeningRequest({ text: 'Q?', intent: 'I' }, [candidate(1)], { constraints: [], preferences: [], policy: NEUTRAL_SOURCE_BIAS_POLICY })
assert.deepEqual(Object.keys(neutralRequest.questions).sort(), ['value.m1'])
assert.deepEqual(decodeScreening(new Map(), neutralRequest.mapping).get('m1').discount,
  { state: 'selected', option: 'none', codeSelected: true, selectedBy: 'code' })

const decoded = decodeScreening(new Map(), withConstraints.mapping)
const entry = decoded.get('m1')
assert.equal(entry.value.state, 'unavailable') // missing is NOT level 0
assert.equal(entry.scope.state, 'unavailable') // missing is NOT a failed constraint
assert.equal(entry.preferences[0], 'unknown') // missing is NOT no_match
// bias-v1 defines no discount criteria, so its level is a code fact from the
// policy's engine lists — a missing ANSWER can never silently become `unknown`
// when the policy already determines the level.
assert.equal(entry.discount.option, 'strong')
assert.equal(entry.discount.selectedBy, 'code')
const explicit = decodeScreening(new Map(withConstraints.mapping.map((m) => [m.id, m.kind === 'scope'
  ? { type: 'noul', value: .9 } : m.kind === 'info' ? { type: 'choice', choice: 'explicit_conflict' }
    : m.kind === 'value' ? { type: 'choice', choice: '5' } : m.kind === 'discount' ? { type: 'choice', choice: 'mild' } : { type: 'choice', choice: 'match' }])), withConstraints.mapping)
assert.deepEqual(explicit.get('m1').scope, { state: 'pass', probability: .9 })
assert.equal(explicit.get('m1').value.level, 5)
// policy `bias-v1` has no criteria, so its level is code-selected from engines
assert.equal(explicit.get('m1').discount.option, 'strong')
assert.equal(explicit.get('m1').discount.selectedBy, 'code')
assert.deepEqual(explicit.get('m1').preferences, ['match'])
// recorded confidence never changes what was decoded
const confident = decodeScreening(new Map([
  ['scope.m1', { type: 'noul', value: .9 }], ['info.m1', { type: 'choice', choice: 'established', confidence: .91 }],
  ['value.m1', { type: 'choice', choice: '4', confidence: .42 }],
]), withConstraints.mapping)
assert.equal(confident.get('m1').value.level, 4)
assert.equal(confident.get('m1').valueConfidence, .42)
assert.equal(confident.get('m1').infoConfidence, .91)
assert.equal(decodeScreening(new Map(), withConstraints.mapping).get('m1').valueConfidence, null)
// a modelled policy exposes the full option criteria and accepts the answer
const modelledRequest = buildScreeningRequest({ text: 'Q?', intent: 'I' }, [candidate(1)], { constraints, preferences: [], policy: modelledPolicy })
assert.ok('discount.m1' in modelledRequest.questions)
assert.deepEqual(modelledRequest.questions['discount.m1'].criteria, modelledPolicy.criteria)
assert.match(modelledRequest.state.sourceBiasPolicy.selectionRule, /strong before mild before none/)
assert.match(modelledRequest.state.sourceBiasPolicy.selectionRule, /uncertain, select unknown/)
assert.match(modelledRequest.questions['discount.m1'].instructions, /selectionRule/)
assert.match(modelledRequest.questions['discount.m1'].criteria.strong, /generic channel alone/)
const modelledDecoded = decodeScreening(new Map([
  ['scope.m1', { type: 'noul', value: .9 }], ['value.m1', { type: 'choice', choice: '5' }],
  ['discount.m1', { type: 'choice', choice: 'mild', confidence: .77 }],
]), modelledRequest.mapping)
assert.equal(modelledDecoded.get('m1').discount.option, 'mild')
assert.equal(modelledDecoded.get('m1').discount.selectedBy, 'model')
assert.equal(modelledDecoded.get('m1').discountConfidence, .77)
// a stray answer to a code-decided question is ignored, never adopted
assert.equal(decodeScreening(new Map([['discount.m1', { type: 'choice', choice: 'mild' }]]), withConstraints.mapping).get('m1').discount.option, 'strong')
assert.equal(JUDGEMENT_THRESHOLDS.scopePass, .85)
assert.equal(decodeScreening(new Map([
  ['scope.m1', { type: 'noul', value: .85 }], ['info.m1', { type: 'choice', choice: 'established' }],
]), withConstraints.mapping).get('m1').scope.state, 'pass')
assert.equal(decodeScreening(new Map([
  ['scope.m1', { type: 'noul', value: .849 }], ['info.m1', { type: 'choice', choice: 'established' }],
]), withConstraints.mapping).get('m1').scope.state, 'not_passed')
// a probability below the code threshold is a fail, not a soft pass
const lowScope = decodeScreening(new Map([['scope.m1', { type: 'noul', value: .5 }], ['info.m1', { type: 'choice', choice: 'unestablished_reason' }]]), withConstraints.mapping)
assert.equal(lowScope.get('m1').scope.state, 'not_passed')
// unestablished is its own state, never level 0
const unestablished = decodeScreening(new Map([['value.m1', { type: 'choice', choice: 'unestablished' }]]), withConstraints.mapping)
assert.equal(unestablished.get('m1').value.state, 'unestablished')

// ---- request completeness: real rubric, real provenance, code-decided discounts ----
const rubricRequest = buildScreeningRequest({ text: 'Q?', intent: 'I' }, [candidate(1)], { constraints: [], preferences: [], policy })
assert.match(rubricRequest.questions['value.m1'].criteria['5'], /original source|measurement conditions/)
assert.match(rubricRequest.questions['value.m1'].criteria['3'], /Medium:/)
assert.deepEqual(rubricRequest.state.sources[0].retrieval, { engines: ['bing'], engineRanks: { bing: 1 } })
// missing provenance must not become an invalid one-option question or a crash
const noEngines = buildScreeningRequest({ text: 'Q?', intent: 'I' }, [candidate(1, { engines: [], engineRanks: {} })], { constraints: [], preferences: [], policy })
assert.ok(!('discount.m1' in noEngines.questions))
assert.deepEqual(decodeScreening(new Map(), noEngines.mapping).get('m1').discount,
  { state: 'selected', option: 'unknown', codeSelected: true, selectedBy: 'code', disclosedUnknown: true })

// ---- snapshot: URL identity merging with real provenance ----
const rows = [
  { url: 'https://a.org/x', title: 'A', score: 1, engineRanks: { bing: 2 }, provenance: [{ engine: 'bing', rank: 2, variant: 'q', url: 'https://a.org/x', title: 'A', snippet: 's' }] },
  { url: 'https://a.org/x#frag', title: 'A alt', score: .5, snippet: 'other snippet', engineRanks: { exa: 1 }, provenance: [{ engine: 'exa', rank: 1, variant: 'q', url: 'https://a.org/x', title: 'A', snippet: 's' }] },
  { url: 'https://b.org/y', title: 'B', score: 2, content: 'full text', engineRanks: { bing: 1 }, provenance: [{ engine: 'bing', rank: 1, variant: 'q', url: 'https://b.org/y', title: 'B', snippet: 's' }] },
]
const snapshot = buildSnapshot(rows)
assert.equal(snapshot.length, 2) // fragment variants merge to one canonical URL
const mergedA = snapshot.find((r) => r.key.startsWith('https://a.org'))
assert.deepEqual(mergedA.engines, ['bing', 'exa'])
assert.equal(mergedA.engineRanks.bing, 2)
assert.equal(mergedA.engineRanks.exa, 1)
assert.equal(mergedA.baseScore, 1) // best fused score wins
assert.equal(snapshot[0].key, 'https://b.org/y') // deterministic: score desc
assert.equal(snapshot[0].basis, 'page_content')
assert.equal(mergedA.basis, 'engine_snippet')
assert.equal(mergedA.safetyState, 'unavailable') // unknown is not a pass

// ---- eligibility gate + ranking ----
const judged = (over = {}) => new Map([['m1', {
  scope: { state: 'pass' }, info: 'established', value: { state: 'level', level: 5 },
  discount: { state: 'selected', option: 'none', codeSelected: false }, preferences: [], ...over,
}]])
const cand = (n, over = {}) => ({ evidenceId: `m${n}`, key: `k${n}`, url: `https://k${n}/`, title: `T${n}`, text: `t${n}`, baseScore: 1, engines: ['bing'], safetyState: 'clear', ...over })

// hard constraints cannot be compensated by value or preferences
const blocked = admitAndRank({
  candidates: [cand(1)], judgements: judged({ scope: { state: 'not_passed' }, info: 'explicit_conflict' }),
  constraints, preferences: ['Prefer code'], maxResults: 8,
})
assert.equal(blocked.results.length, 0)
assert.equal(blocked.decisions[0].reason, 'scope_not_established')
const unknownScope = admitAndRank({ candidates: [cand(1)], judgements: judged({ scope: { state: 'unavailable' } }), constraints })
assert.equal(unknownScope.results.length, 0)
assert.equal(unknownScope.decisions[0].reason, 'scope_unavailable')
// a scope pass contradicted by an explicit conflict is not established
const contradictory = admitAndRank({ candidates: [cand(1)], judgements: judged({ scope: { state: 'pass' }, info: 'explicit_conflict' }), constraints })
assert.equal(contradictory.results.length, 0)
assert.equal(contradictory.decisions[0].reason, 'scope_explicit_conflict')
assert.equal(contradictory.decisions[0].info, 'explicit_conflict')
assert.equal(contradictory.diagnostics.scopeExplicitConflict, 1)
// unestablished value is not published and not level 0
const unest = admitAndRank({ candidates: [cand(1)], judgements: judged({ value: { state: 'unestablished' } }) })
assert.equal(unest.results.length, 0)
assert.equal(unest.decisions[0].reason, 'value_unestablished')
// missing judgement is pending, not rejected
const pending = admitAndRank({ candidates: [cand(1)], judgements: new Map() })
assert.equal(pending.decisions[0].reason, 'pending')
assert.equal(pending.diagnostics.pending, 1)
// a pure ranking helper must not claim the pool is exhausted while pending work remains
assert.equal(pending.selection.stopReason, 'pending_candidates')
assert.equal(pending.selection.incomplete, true)
// low levels are filtered
const filtered = admitAndRank({ candidates: [cand(1)], judgements: judged({ value: { state: 'level', level: 2 } }) })
assert.equal(filtered.decisions[0].reason, 'value_filtered')
// zero/invalid base score cannot be resurrected by bonuses
const zeroBase = admitAndRank({ candidates: [cand(1, { baseScore: 0 })], judgements: judged(), preferences: ['Prefer code'] })
assert.equal(zeroBase.decisions[0].reason, 'base_score_missing')
// safety gate: violation rejects, unknown holds
const violation = admitAndRank({ candidates: [cand(1, { safetyState: 'violation' })], judgements: judged() })
assert.equal(violation.decisions[0].reason, 'safety_rejected')
const unsafe = admitAndRank({ candidates: [cand(1, { safetyState: 'unavailable' })], judgements: judged() })
assert.equal(unsafe.decisions[0].reason, 'safety_unavailable')

// ranking: a preference-matching 4 can outrank a discounted 5; labels unchanged
const ranked = admitAndRank({
  candidates: [cand(1, { baseScore: 1 }), cand(2, { baseScore: 1 })],
  judgements: new Map([
    ['m1', { scope: { state: 'skipped' }, value: { state: 'level', level: 5 }, discount: { state: 'selected', option: 'strong' }, preferences: [] }],
    ['m2', { scope: { state: 'skipped' }, value: { state: 'level', level: 4 }, discount: { state: 'selected', option: 'none' }, preferences: ['match', 'match'] }],
  ]),
  preferences: ['Prefer code', 'Prefer data'],
  maxResults: 2,
})
assert.deepEqual(ranked.results.map((r) => r.evidenceId), ['m2', 'm1'])
assert.equal(ranked.results[0].valueLabel, 'medium_high')
assert.equal(ranked.results[1].valueLabel, 'high') // label is not rewritten by rank
near(ranked.results[0].finalScore, .65)
near(ranked.results[1].finalScore, .5625)
assert.deepEqual(ranked.valueGroups, { 3: [], 4: ['r1'], 5: ['r2'] })
assert.equal(ranked.selection.targetMet, true)
assert.equal(ranked.selection.stopReason, 'target_met')
assert.equal(ranked.judgementPolicyVersion, JUDGEMENT_POLICY_VERSION)
assert.equal(ranked.diagnostics.requestTooLarge, 0)
assert.equal(ranked.diagnostics.judgementUnavailable, 0)

// each bonus changes ranking on its own (attribution, not a bundled claim)
const discountFlip = (useDiscount) => admitAndRank({
  candidates: [cand(1, { baseScore: 1.86 }), cand(2, { baseScore: 1.5 })],
  judgements: new Map([
    ['m1', { scope: { state: 'skipped' }, value: { state: 'level', level: 3 }, discount: { state: 'selected', option: useDiscount ? 'mild' : 'none' }, preferences: [] }],
    ['m2', { scope: { state: 'skipped' }, value: { state: 'level', level: 3 }, discount: { state: 'selected', option: 'none' }, preferences: [] }],
  ]),
})
assert.deepEqual(discountFlip(false).results.map((r) => r.evidenceId), ['m1', 'm2'])
assert.deepEqual(discountFlip(true).results.map((r) => r.evidenceId), ['m2', 'm1'])
const preferenceFlip = (usePreferences) => admitAndRank({
  candidates: [cand(1, { baseScore: 1 }), cand(2, { baseScore: 1.05 })],
  judgements: new Map([
    ['m1', { scope: { state: 'skipped' }, value: { state: 'level', level: 3 }, discount: { state: 'selected', option: 'none' }, preferences: usePreferences ? ['match', 'match'] : [] }],
    ['m2', { scope: { state: 'skipped' }, value: { state: 'level', level: 3 }, discount: { state: 'selected', option: 'none' }, preferences: usePreferences ? ['match', 'no_match'] : [] }],
  ]),
  preferences: usePreferences ? ['Prefer official docs', 'Prefer recent docs'] : [],
})
assert.deepEqual(preferenceFlip(false).results.map((r) => r.evidenceId), ['m2', 'm1'])
assert.deepEqual(preferenceFlip(true).results.map((r) => r.evidenceId), ['m1', 'm2'])

// near-duplicate folding is explicit opt-in: independent pages sharing a slug
// and title WOULD be merged, so the default must not fold
const twinPages = {
  candidates: [
    cand(1, { url: 'https://a.example/blog/duckdb-vs-sqlite', key: 'https://a.example/blog/duckdb-vs-sqlite', title: 'DuckDB vs SQLite' }),
    cand(2, { url: 'https://b.example/blog/duckdb-vs-sqlite', key: 'https://b.example/blog/duckdb-vs-sqlite', title: 'DuckDB vs SQLite' }),
  ],
  judgements: new Map([
    ['m1', { scope: { state: 'skipped' }, value: { state: 'level', level: 3 }, discount: { state: 'selected', option: 'none' }, preferences: [] }],
    ['m2', { scope: { state: 'skipped' }, value: { state: 'level', level: 3 }, discount: { state: 'selected', option: 'none' }, preferences: [] }],
  ]),
}
assert.deepEqual(admitAndRank(twinPages).results.map((r) => r.evidenceId), ['m1', 'm2'])
assert.deepEqual(admitAndRank({ ...twinPages, dedupe: true }).results.map((r) => r.evidenceId), ['m1'])
assert.equal(admitAndRank({ ...twinPages, dedupe: true }).diagnostics.duplicatesFolded, 1)

// low-B high-value beats high-B background; no preferences means zero bonus
const reversal = admitAndRank({
  candidates: [cand(1, { baseScore: 1 }), cand(2, { baseScore: .1 })],
  judgements: new Map([
    ['m1', { scope: { state: 'skipped' }, value: { state: 'level', level: 3 }, discount: { state: 'selected', option: 'none' }, preferences: [] }],
    ['m2', { scope: { state: 'skipped' }, value: { state: 'level', level: 5 }, discount: { state: 'selected', option: 'none' }, preferences: [] }],
  ]),
})
assert.deepEqual(reversal.results.map((r) => r.evidenceId), ['m2', 'm1'])
assert.ok(reversal.results.every((r) => r.preferenceBonus === 0))
assert.equal(reversal.selection.stopReason, 'candidate_pool_exhausted')
assert.equal(reversal.selection.targetMet, false)

// maxResults truncates after ranking; diagnostics count every disposition
const trunc = admitAndRank({
  candidates: [cand(1), cand(2), cand(3, { safetyState: 'violation' }), cand(4, { baseScore: NaN })],
  judgements: new Map([
    ['m1', { scope: { state: 'skipped' }, value: { state: 'level', level: 5 }, discount: { state: 'selected', option: 'none' }, preferences: [] }],
    ['m2', { scope: { state: 'skipped' }, value: { state: 'level', level: 3 }, discount: { state: 'selected', option: 'none' }, preferences: [] }],
  ]),
  maxResults: 1,
})
assert.equal(trunc.results.length, 1)
assert.equal(trunc.selection.returned, 1)
assert.equal(trunc.diagnostics.collected, 4)
assert.equal(trunc.diagnostics.selected, 1)
assert.equal(trunc.diagnostics.safetyRejected, 1)
assert.equal(trunc.diagnostics.baseScoreMissing, 1)
assert.equal(trunc.diagnostics.valueCounts[5], 1)
const dispositions = ['pending', 'safetyRejected', 'safetyUnavailable', 'scopeNotEstablished', 'scopeExplicitConflict', 'scopeInconsistent', 'scopeUnavailable', 'valueFiltered', 'valueUnestablished', 'assessmentUnavailable', 'baseScoreMissing']
assert.equal(dispositions.reduce((sum, k) => sum + trunc.diagnostics[k], 0) + trunc.diagnostics.qualityAssessed, trunc.diagnostics.collected) // every candidate counted exactly once

// deterministic replay: identical input, identical artifact
const twice = (x) => JSON.stringify(x)
assert.equal(twice(admitAndRank({ candidates: [cand(2), cand(1)], judgements: judged() })), twice(admitAndRank({ candidates: [cand(2), cand(1)], judgements: judged() })))

// ---- runScreening: batched judge calls + bounded rescue of the SAME candidate ----
const entryFor = (id, kind, value) => [id, kind === 'scope' ? { type: 'noul', value } : { type: 'choice', choice: value }]
const scriptJudge = (perCall) => {
  let call = 0
  return async (request) => {
    const answers = perCall[Math.min(call++, perCall.length - 1)]
    return new Map(request.mapping.filter((m) => Object.hasOwn(request.questions, m.id)).map((m) => entryFor(m.id, m.kind, answers[m.candidateId]?.[m.kind] ?? (m.kind === 'scope' ? 0 : m.kind === 'info' ? ((answers[m.candidateId]?.scope ?? 0) >= .85 ? 'established' : 'unestablished_reason') : m.kind === 'value' ? '4' : m.kind === 'discount' ? 'none' : 'no_match'))))
  }
}
const baseAnswers = { m1: { scope: .9, value: '5', discount: 'none' }, m2: { scope: .9, value: '4', discount: 'none' } }
const screened = await runScreening({
  candidates: [cand(1), cand(2), cand(3)], question: { text: 'Q?', intent: 'I' }, constraints, policy,
  batchSize: 2, maxResults: 8, judge: scriptJudge([baseAnswers, { m3: { scope: .9, value: '3', discount: 'none' } }]),
})
assert.equal(screened.diagnostics.judgeCalls, 2) // ceil(3/2) bounded batches
assert.equal(screened.results.length, 3)
assert.deepEqual(screened.results.map((r) => r.valueLevel), [5, 4, 3])

let rescueReads = 0
const rescued = await runScreening({
  candidates: [cand(1)], question: { text: 'Q?', intent: 'I' }, constraints, policy, maxResults: 8,
  judge: scriptJudge([{ m1: { scope: .2, info: 'insufficient_information', value: '5', discount: 'none' } }, { m1: { scope: .9, value: '5', discount: 'none' } }]),
  rescue: { maxReads: 1 },
  rescueRead: async (candidate) => { rescueReads++; assert.equal(candidate.evidenceId, 'm1'); return { text: 'full document text', safetyState: 'clear' } },
})
assert.equal(rescueReads, 1) // one read, same URL, then a fresh scope judgement on the new text
assert.equal(rescued.diagnostics.rescueAttempted, 1)
assert.equal(rescued.diagnostics.rescueRecovered, 1)
assert.equal(rescued.results.length, 1)
assert.equal(rescued.results[0].description, 'full document text') // the reviewed text is what ships

// explicit conflict is never rescued; budget caps the reads
let conflictReads = 0
const conflict = await runScreening({
  candidates: [cand(1), cand(2)], question: { text: 'Q?', intent: 'I' }, constraints, policy, maxResults: 8,
  judge: scriptJudge([{ m1: { scope: .2, info: 'explicit_conflict' }, m2: { scope: .2, info: 'insufficient_information' } }, { m2: { scope: .2, info: 'unestablished_reason' } }]),
  rescue: { maxReads: 2 },
  rescueRead: async () => { conflictReads++; return { text: 'more text' } },
})
assert.equal(conflictReads, 1) // only the insufficient-information candidate
assert.equal(conflict.results.length, 0) // still-unknown after rescue is not published
assert.equal(conflict.diagnostics.rescueRecovered, 0)
assert.ok(conflict.decisions.some((d) => d.reason === 'safety_unavailable')) // a rescued text never inherits the old clearance

// a rescued text that fails its own safety check is rejected outright
const rescuedViolation = await runScreening({
  candidates: [cand(1)], question: { text: 'Q?', intent: 'I' }, constraints, policy, maxResults: 8,
  judge: scriptJudge([{ m1: { scope: .2, info: 'insufficient_information', value: '5', discount: 'none' } }, { m1: { scope: .9, value: '5', discount: 'none' } }]),
  rescue: { maxReads: 1 },
  rescueRead: async () => ({ text: 'unsafe page body', safetyState: 'violation' }),
})
assert.equal(rescuedViolation.results.length, 0)
assert.equal(rescuedViolation.decisions[0].reason, 'safety_rejected')
assert.throws(() => admitAndRank({ candidates: [cand(1)], judgements: judged(), maxResults: 0 }), /./)
await assert.rejects(runScreening({ candidates: [], question: 'Q?', judge: null }), TypeError)

// Complete wire-state matrix: a positive option exists, and BOTH answers must
// establish compliance. Missing info is unknown, not an implicit approval.
for (const scope of [.1, .99]) {
  for (const info of ['established', 'insufficient_information', 'explicit_conflict', 'unestablished_reason', 'invalid', null]) {
    const artifact = await runScreening({
      candidates: [cand(1)], question: 'Question?', intent: 'Research intent', constraints,
      judge: async (request) => {
        assert.ok(request.questions['info.m1'].criteria.established)
        const entries = await scriptJudge([{ m1: { scope, info: info ?? 'established', value: '5' } }])(request)
        if (info === null) entries.delete('info.m1')
        return entries
      },
    })
    assert.equal(artifact.results.length, scope === .99 && info === 'established' ? 1 : 0, `${scope}/${info}`)
    assert.equal(artifact.diagnostics.scopePassed, artifact.results.length)
  }
}

// Object and string forms preserve the exact intent. Ambiguous/missing inputs
// are rejected before calling the judge rather than quietly dropping context.
for (const input of [
  { question: 'Q?', intent: 'Top-level intent' },
  { question: { text: 'Q?', intent: 'Nested intent' } },
  { question: { text: 'Q?', intent: 'Same' }, intent: 'Same' },
]) {
  // Observed outside the judge: an assertion thrown inside it is swallowed by the
  // batch-failure handler and would turn a wrong intent into a "judge_failure".
  let seenIntent = null
  const artifact = await runScreening({ ...input, candidates: [cand(1)], judge: async (request) => {
    seenIntent = request.state.intent
    return scriptJudge([baseAnswers])(request)
  } })
  assert.equal(seenIntent, input.intent ?? input.question.intent)
  assert.equal(artifact.run.halted, null)
  assert.equal(artifact.results.length, 1)
}
for (const input of [
  { question: 'Q?' }, { question: 'Q?', intent: ' ' },
  { question: { text: 'Q?', intent: 'Nested' }, intent: 'Different' },
]) {
  await assert.rejects(runScreening({ ...input, candidates: [cand(1)], judge: async () => assert.fail('invalid input reached judge') }), TypeError)
}

// Prior safety blocks cannot be washed away by a subsequently clear reread.
for (const safetyState of ['violation', 'unavailable']) {
  let reads = 0
  const artifact = await runScreening({
    candidates: [cand(1, { safetyState })], question: 'Q?', intent: 'I', constraints,
    judge: scriptJudge([{ m1: { scope: .1, info: 'insufficient_information' } }, baseAnswers]),
    rescue: { maxReads: 1 }, rescueRead: async () => { reads++; return { text: 'safe later text', safetyState: 'clear' } },
  })
  assert.equal(reads, 0)
  assert.equal(artifact.diagnostics.rescueAttempted, 0)
  assert.equal(artifact.diagnostics.rescueRecovered, 0)
  assert.equal(artifact.results.length, 0)
}

// Scope recovery and restored eligibility are deliberately different counters.
for (const [safetyState, value, info, scopeCount, admittedCount] of [
  ['clear', '5', 'established', 1, 1],
  ['clear', '2', 'established', 1, 0],
  ['clear', 'unestablished', 'established', 1, 0],
  ['violation', '5', 'established', 1, 0],
  [undefined, '5', 'established', 1, 0],
  ['clear', '5', 'explicit_conflict', 0, 0],
  ['clear', '5', 'insufficient_information', 0, 0],
]) {
  const artifact = await runScreening({
    candidates: [cand(1)], question: 'Q?', intent: 'I', constraints,
    judge: scriptJudge([{ m1: { scope: .1, info: 'insufficient_information', value: 'unestablished' } }, { m1: { scope: .99, info, value } }]),
    rescue: { maxReads: 1 }, rescueRead: async () => ({ text: 'new checked text', safetyState }),
  })
  assert.equal(artifact.diagnostics.rescueScopeRecovered, scopeCount)
  assert.equal(artifact.diagnostics.rescueRecovered, admittedCount)
  assert.equal(artifact.results.length, admittedCount)
}

let failedReadJudges = 0
const readFailure = await runScreening({
  candidates: [cand(1)], question: 'Q?', intent: 'I', constraints,
  judge: async (request) => { failedReadJudges++; return scriptJudge([{ m1: { scope: .1, info: 'insufficient_information', value: 'unestablished' } }])(request) },
  rescue: { maxReads: 1 }, rescueRead: async () => ({ status: 'read_failed', httpStatus: 403 }),
})
assert.equal(failedReadJudges, 1, 'failed read must not cause a fabricated second judgement')
assert.equal(readFailure.diagnostics.rescueReadFailed, 1)
assert.equal(readFailure.diagnostics.rescueRecovered, 0)
assert.equal(readFailure.results.length, 0)

const recoveredButLimited = await runScreening({
  candidates: [cand(1), cand(2)], question: 'Q?', intent: 'I', constraints, maxResults: 1,
  judge: scriptJudge([
    { m1: { scope: .1, info: 'insufficient_information' }, m2: { scope: .1, info: 'insufficient_information' } },
    { m1: { scope: .99, info: 'established', value: '5' } },
    { m2: { scope: .99, info: 'established', value: '5' } },
  ]),
  rescue: { maxReads: 2 }, rescueRead: async () => ({ text: 'new text', safetyState: 'clear' }),
})
assert.equal(recoveredButLimited.results.length, 1)
assert.equal(recoveredButLimited.diagnostics.rescueRecovered, 2, 'eligibility recovery is counted before selection limits')

// ---- snapshot: text, text version and safety clearance travel together ----
// The reported safety state is the worst of the merged rows and the delivered
// text is the longest one, so input order can neither upgrade a violation to
// `clear` nor keep a snippet while delivering an unchecked body.
{
  const snippetRow = { url: 'https://x.org/p', title: 'P', score: 1, snippet: 'short snippet', safetyState: 'clear', textVersion: 'v1', engineRanks: { bing: 1 }, provenance: [] }
  const contentRow = { url: 'https://x.org/p', title: 'P', score: .5, content: 'a much longer violating page body', safetyState: 'violation', textVersion: 'v2', engineRanks: { exa: 1 }, provenance: [] }
  for (const order of [[snippetRow, contentRow], [contentRow, snippetRow]]) {
    const merged = buildSnapshot(order)[0]
    assert.equal(merged.safetyState, 'violation')
    assert.equal(merged.text, 'a much longer violating page body')
    assert.equal(merged.textVersion, 'v2')
    assert.equal(merged.basis, 'page_content')
  }
  const unverified = buildSnapshot([
    { url: 'https://y.org/q', score: 1, content: 'body', safetyState: 'clear', engineRanks: { bing: 1 } },
    { url: 'https://y.org/q', score: .5, snippet: 'snip', engineRanks: { exa: 1 } },
  ])[0]
  assert.equal(unverified.safetyState, 'unavailable') // an unchecked sibling is not silently cleared
}

// ---- snapshot: only positive-weight engines count as provenance ----
{
  const biasPolicy = validateSourceBiasPolicy({ version: 'bias-v1', nature: 'policy_preference', mildEligible: ['bing'], strongEligible: ['bing'] })
  const rowsFor = (engineRanks) => [{ url: 'https://z.org/r', title: 'R', score: 1.1, snippet: 's', engineRanks, provenance: [] }]
  const widened = buildSnapshot(rowsFor({ bing: 1, exa: 1 }))[0]
  assert.deepEqual(widened.engines, ['bing', 'exa'])
  assert.equal(widened.provenanceBasis, 'observed_ranks')
  // a zero-weight engine that only returned a rank record must not weaken the discount
  assert.deepEqual(eligibleDiscountOptions(biasPolicy, widened.engines).options, ['none', 'unknown'])
  const weighted = buildSnapshot(rowsFor({ bing: 1, exa: 1 }), { engineWeights: { bing: 1, exa: 0 } })[0]
  assert.deepEqual(weighted.engines, ['bing'])
  assert.deepEqual(weighted.engineRanks, { bing: 1 })
  assert.equal(weighted.provenanceBasis, 'positive_weight_contributors')
  assert.deepEqual(eligibleDiscountOptions(biasPolicy, weighted.engines).options, ['none', 'mild', 'strong', 'unknown'])
  assert.deepEqual(eligibleDiscountOptions(biasPolicy, buildSnapshot(rowsFor({ bing: 1 }))[0].engines).options, ['none', 'mild', 'strong', 'unknown'])
  assert.throws(() => buildSnapshot(rowsFor({ bing: 1 }), { engineWeights: 3 }), TypeError)
}

// ---- soft redundancy: a selection-time penalty, never a score rewrite ----
{
  const mirror = 'Concurrent writes to one SQLite database file from two processes require a busy timeout and careful transaction scope to avoid lock errors'
  const distinct = 'The cone mode of git sparse-checkout restricts the working tree to a directory and its parents which is faster than pattern matching'
  const pool = [
    cand(1, { baseScore: 1, title: 'SQLite concurrent writers', text: mirror }),
    cand(2, { baseScore: .9, title: 'SQLite concurrent writers mirror', text: mirror }),
    cand(3, { baseScore: .8, title: 'Git sparse-checkout cone mode', text: distinct }),
  ]
  const judgements = new Map(pool.map((item) => [item.evidenceId, {
    scope: { state: 'skipped' }, info: null, value: { state: 'level', level: 5 },
    discount: { state: 'selected', option: 'none', selectedBy: 'code' }, preferences: [],
  }]))
  const flatPick = admitAndRank({ candidates: pool, judgements, maxResults: 2 })
  assert.deepEqual(flatPick.results.map((r) => r.evidenceId), ['m1', 'm2'])
  assert.equal(flatPick.results[1].redundancy, 0)
  const diversePick = admitAndRank({ candidates: pool, judgements, maxResults: 2, mu: .8 })
  assert.deepEqual(diversePick.results.map((r) => r.evidenceId), ['m1', 'm3']) // the mirror is deferred, not merged
  assert.equal(diversePick.results[0].redundancy, 0)
  assert.equal(diversePick.results[1].redundancy, 0)
  const allThree = admitAndRank({ candidates: pool, judgements, maxResults: 3, mu: .8 })
  assert.deepEqual(allThree.results.map((r) => r.evidenceId), ['m1', 'm3', 'm2'])
  near(allThree.results[2].selectionScore, allThree.results[2].finalScore - .8 * allThree.results[2].redundancy)
  assert.ok(allThree.results[2].redundancy > .8) // near-identical body: only the penalty moved it down
  assert.ok(allThree.results[2].selectionScore < allThree.results[2].finalScore - .5)
  near(allThree.results[2].finalScore, .9 / 1.9 / 2 + .5) // the score itself did not change
}

// ---- size-bounded packing: batchSize is an upper bound, the wire limit rules ----
{
  const big = (n) => cand(n, { text: 'x'.repeat(6000) })
  const bigLimits = { maxStateChars: 12000, maxRequestChars: 16000 }
  let calls = 0
  const judgedOrder = []
  const packed = await runScreening({
    candidates: [big(1), big(2), big(3), big(4)], question: 'Q?', intent: 'I', constraints, policy, limits: bigLimits,
    judge: async (request) => {
      calls++
      assert.ok(requestFits(request, bigLimits), 'every dispatched request must fit the configured envelope')
      judgedOrder.push(...request.state.candidates.map((ref) => ref.id))
      const batch = Object.fromEntries(request.state.candidates.map((ref) => [ref.id, { scope: .9, value: '4', discount: 'none' }]))
      return scriptJudge([batch])(request)
    },
  })
  assert.ok(calls >= 2, 'oversized material must be split, not sent as one request')
  // Exactly once each, in order: packing may neither drop nor duplicate a candidate.
  assert.deepEqual(judgedOrder, ['m1', 'm2', 'm3', 'm4'])
  assert.equal(packed.results.length, 4)
  assert.equal(packed.diagnostics.requestTooLarge, 0)
  assert.equal(packed.run.limits.maxStateChars, 12000)
  // packing is a wire-layer choice: identical answers keep an identical order
  const ordered = (request) => Object.fromEntries(request.state.candidates.map((ref) => [ref.id, { scope: .9, value: ref.id === 'm3' ? '3' : '4', discount: 'none' }]))
  const oneAtATime = await runScreening({ candidates: [cand(1), cand(2), cand(3)], question: 'Q?', intent: 'I', constraints, policy, batchSize: 1, judge: async (request) => scriptJudge([ordered(request)])(request) })
  const together = await runScreening({ candidates: [cand(1), cand(2), cand(3)], question: 'Q?', intent: 'I', constraints, policy, batchSize: 8, judge: async (request) => scriptJudge([ordered(request)])(request) })
  assert.equal(oneAtATime.diagnostics.judgeCalls, 3)
  assert.equal(together.diagnostics.judgeCalls, 1)
  assert.deepEqual(oneAtATime.results.map((r) => r.evidenceId), together.results.map((r) => r.evidenceId))
  // a candidate that cannot fit even alone is disclosed, never sent and never lost
  let oversizedCalls = 0
  const oversized = await runScreening({
    candidates: [big(1), big(2)], question: 'Q?', intent: 'I', constraints, policy,
    limits: { maxStateChars: 400, maxRequestChars: 600 },
    judge: async () => { oversizedCalls++; return new Map() },
  })
  assert.equal(oversizedCalls, 0)
  assert.equal(oversized.diagnostics.requestTooLarge, 2)
  assert.equal(oversized.diagnostics.judgeCalls, 0)
  assert.deepEqual(oversized.run.unassessable, [{ evidenceId: 'm1', reason: 'request_too_large' }, { evidenceId: 'm2', reason: 'request_too_large' }])
  assert.deepEqual(oversized.decisions.map((d) => d.reason), ['request_too_large', 'request_too_large'])
  assert.equal(oversized.selection.stopReason, 'unassessable_material')
  assert.equal(oversized.selection.incomplete, true)
}

// ---- failure isolation: a failed batch keeps everything already decided ----
{
  let attempt = 0
  const flaky = await runScreening({
    candidates: [cand(1), cand(2), cand(3), cand(4)], question: 'Q?', intent: 'I', constraints, policy, batchSize: 2,
    judge: async (request) => {
      attempt++
      if (attempt === 2) throw new Error('judge unavailable')
      return scriptJudge([baseAnswers])(request)
    },
  })
  assert.equal(flaky.diagnostics.judgeCalls, 2)
  assert.equal(flaky.run.judgeFailures, 1)
  assert.equal(flaky.run.halted, 'judge_failure')
  assert.deepEqual(flaky.run.judgeFailedIds, ['m3', 'm4'])
  assert.deepEqual(flaky.results.map((r) => r.evidenceId), ['m1', 'm2']) // the first batch survives
  assert.deepEqual(flaky.decisions.filter((d) => d.reason === 'judgement_unavailable').map((d) => d.evidenceId), ['m3', 'm4'])
  assert.equal(flaky.selection.stopReason, 'judge_failure')
  assert.equal(flaky.selection.incomplete, true)
  // terminal code facts never reach the judge at all
  let terminalCalls = 0
  const terminal = await runScreening({
    candidates: [cand(1, { safetyState: 'violation' }), cand(2, { baseScore: 0 }), cand(3)], question: 'Q?', intent: 'I',
    judge: async (request) => { terminalCalls++; assert.deepEqual(request.state.candidates.map((ref) => ref.id), ['m3']); return scriptJudge([baseAnswers])(request) },
  })
  assert.equal(terminalCalls, 1)
  assert.equal(terminal.diagnostics.safetyRejected, 1)
  assert.equal(terminal.diagnostics.baseScoreMissing, 1)
  assert.deepEqual(terminal.results.map((r) => r.evidenceId), ['m3'])
}

// ---- cancellation and deadline stop the work without discarding results ----
{
  const preAborted = new AbortController()
  preAborted.abort()
  const cancelled = await runScreening({
    candidates: [cand(1)], question: 'Q?', intent: 'I', constraints, policy, signal: preAborted.signal,
    judge: async () => assert.fail('an already-aborted signal must perform no work'),
  })
  assert.equal(cancelled.diagnostics.judgeCalls, 0)
  assert.equal(cancelled.run.halted, 'cancelled')
  assert.equal(cancelled.selection.stopReason, 'cancelled')
  assert.deepEqual(cancelled.decisions.map((d) => d.reason), ['pending'])
  const midAbort = new AbortController()
  const midRun = await runScreening({
    candidates: [cand(1), cand(2)], question: 'Q?', intent: 'I', constraints, policy, batchSize: 1, signal: midAbort.signal,
    judge: async (request) => { midAbort.abort(); return scriptJudge([baseAnswers])(request) },
  })
  assert.equal(midRun.diagnostics.judgeCalls, 1)
  assert.equal(midRun.run.halted, 'cancelled')
  assert.deepEqual(midRun.results.map((r) => r.evidenceId), ['m1'])
  assert.equal(midRun.selection.stopReason, 'cancelled')
  const late = await runScreening({
    candidates: [cand(1), cand(2)], question: 'Q?', intent: 'I', constraints, policy, batchSize: 1, deadlineMs: 40,
    judge: async (request) => { await new Promise((resolve) => setTimeout(resolve, 80)); return scriptJudge([baseAnswers])(request) },
  })
  assert.equal(late.diagnostics.judgeCalls, 1)
  assert.equal(late.run.halted, 'deadline')
  assert.equal(late.selection.stopReason, 'deadline')
}

// ---- rescue: opt-in value-unknown extension, priority by fused base score ----
{
  const twoBlocked = (valueUnknown, maxReads = 1) => {
    const reads = []
    return runScreening({
      candidates: [cand(1, { baseScore: .5 }), cand(2, { baseScore: .9 })], question: 'Q?', intent: 'I',
      judge: scriptJudge([{ m1: { scope: .9, value: 'unestablished' }, m2: { scope: .9, value: 'unestablished' } }, { m2: { scope: .9, value: '5' } }]),
      rescue: { maxReads, valueUnknown },
      rescueRead: async (candidate) => { reads.push(candidate.evidenceId); return { text: 'full page text', safetyState: 'clear' } },
    }).then((artifact) => ({ artifact, reads }))
  }
  const scopeOnly = await twoBlocked(false)
  assert.deepEqual(scopeOnly.reads, []) // scope-only rescue never targets unknown value
  assert.deepEqual(scopeOnly.artifact.run.rescuePlan, [])
  const budgetOne = await twoBlocked(true, 1)
  assert.deepEqual(budgetOne.artifact.run.rescuePlan, ['m2']) // the plan is what the budget allows to attempt
  assert.deepEqual(budgetOne.reads, ['m2'])
  assert.equal(budgetOne.artifact.diagnostics.rescueAttempted, 1)
  assert.equal(budgetOne.artifact.diagnostics.rescueValueRecovered, 1)
  assert.deepEqual(budgetOne.artifact.results.map((r) => r.evidenceId), ['m2'])
  const ordered = await twoBlocked(true, 2)
  assert.deepEqual(ordered.artifact.run.rescuePlan, ['m2', 'm1']) // priority: higher fused base score first
  assert.deepEqual(ordered.reads, ['m2', 'm1'])
  // a throwing reader is a failed read, not a crashed run and not a fabricated judgement
  let afterThrow = 0
  const throwing = await runScreening({
    candidates: [cand(1)], question: 'Q?', intent: 'I',
    judge: async (request) => { afterThrow++; return scriptJudge([{ m1: { scope: .9, value: 'unestablished' } }])(request) },
    rescue: { maxReads: 1, valueUnknown: true },
    rescueRead: async () => { throw new Error('network down') },
  })
  assert.equal(throwing.diagnostics.rescueAttempted, 1)
  assert.equal(throwing.diagnostics.rescueReadFailed, 1)
  assert.equal(afterThrow, 1) // no second judgement was invented
  assert.equal(throwing.results.length, 0)
}

// ---- confidence is recorded for audit and never scored ----
{
  const judgedByConfidence = await runScreening({
    candidates: [cand(1), cand(2)], question: 'Q?', intent: 'I',
    judge: async (request) => new Map(request.mapping
      .filter((m) => Object.hasOwn(request.questions, m.id))
      .map((m) => [m.id, { type: 'choice', choice: m.candidateId === 'm1' ? '5' : '4', confidence: m.candidateId === 'm1' ? .31 : .99 }])),
  })
  assert.deepEqual(judgedByConfidence.results.map((r) => [r.evidenceId, r.valueLevel, r.signals.valueConfidence]), [['m1', 5, .31], ['m2', 4, .99]])
  assert.ok(judgedByConfidence.results.every((r) => r.signals.infoConfidence === null))
  assert.deepEqual(judgedByConfidence.results.map((r) => r.finalScore), [.75, .55]) // value 4 -> u=.6, not 1
}

// ---- result rows keep the context the material actually carried ----
{
  const meta = await runScreening({
    candidates: [cand(1, { basis: 'page_content', published: '2025-03-04', textVersion: 'v7', scoreVersion: 'consensus-v2.1', engineRanks: { bing: 1 } })],
    question: 'Q?', intent: 'I', judge: scriptJudge([baseAnswers]),
  })
  assert.deepEqual({
    basis: meta.results[0].basis, published: meta.results[0].published, textVersion: meta.results[0].textVersion,
    scoreVersion: meta.results[0].scoreVersion, engineRanks: meta.results[0].engineRanks, safetyState: meta.results[0].safetyState,
  }, {
    basis: 'page_content', published: '2025-03-04', textVersion: 'v7',
    scoreVersion: 'consensus-v2.1', engineRanks: { bing: 1 }, safetyState: 'clear',
  })
  // a policy that writes the conditions makes the discount a real judgement, reported as such
  const modelledRun = await runScreening({
    candidates: [cand(1)], question: 'Q?', intent: 'I', policy: modelledPolicy,
    judge: async (request) => { assert.ok('discount.m1' in request.questions); return scriptJudge([{ m1: { scope: .9, value: '5', discount: 'mild' } }])(request) },
  })
  assert.equal(modelledRun.results[0].sourceDiscount, 'mild')
  assert.equal(modelledRun.results[0].sourceDiscountSelectedBy, 'model')
}

// ---- review regressions: short-text redundancy, rescue envelopes, halted rescue ----
{
  // A candidate too short to shingle must not crash the whole selection loop.
  const level5 = { scope: { state: 'skipped' }, info: null, value: { state: 'level', level: 5 }, discount: { state: 'selected', option: 'none', selectedBy: 'code' }, preferences: [] }
  const shortText = admitAndRank({
    candidates: [cand(1), cand(2)],
    judgements: new Map([['m1', level5], ['m2', level5]]),
    mu: .5, maxResults: 2,
  })
  assert.equal(shortText.results.length, 2)
  assert.ok(shortText.results.every((r) => r.redundancy === 0))
  // The rescue dispatch is size-checked like a batch: an oversized reread is
  // never sent and the candidate keeps its pre-read text and judgement.
  const rescueLimits = { maxStateChars: 9000, maxRequestChars: 12000 }
  let rescueJudgeCalls = 0
  const oversizedReread = await runScreening({
    candidates: [cand(1)], question: 'Q?', intent: 'I', constraints, policy, limits: rescueLimits,
    rescue: { maxReads: 1 },
    judge: async (request) => {
      rescueJudgeCalls++
      assert.ok(requestFits(request, rescueLimits), 'the rescue request must fit the configured envelope too')
      return scriptJudge([{ m1: { scope: .1, info: 'insufficient_information' } }])(request)
    },
    rescueRead: async () => ({ text: 'z'.repeat(30000), safetyState: 'clear' }),
  })
  assert.equal(rescueJudgeCalls, 1, 'an oversized reread must not be dispatched')
  assert.equal(oversizedReread.diagnostics.rescueTooLarge, 1)
  assert.equal(oversizedReread.run.halted, null)
  assert.equal(oversizedReread.decisions[0].reason, 'scope_not_established')
  // A read that outlasts the deadline stops the run before its dispatch.
  const lateReread = await runScreening({
    candidates: [cand(1)], question: 'Q?', intent: 'I', constraints, policy, deadlineMs: 40,
    rescue: { maxReads: 1 },
    judge: scriptJudge([{ m1: { scope: .1, info: 'insufficient_information' } }]),
    rescueRead: async () => { await new Promise((resolve) => setTimeout(resolve, 80)); return { text: 'late text', safetyState: 'clear' } },
  })
  assert.equal(lateReread.diagnostics.judgeCalls, 1, 'no judgement may start after the deadline')
  assert.equal(lateReread.run.halted, 'deadline')
  assert.equal(lateReread.selection.stopReason, 'deadline')
  assert.equal(lateReread.results.length, 0)
  // Cancelling during a rescue read stops the loop before the next read.
  const abortDuringRescue = new AbortController()
  let rescueReadsAfterAbort = 0
  const haltedRescue = await runScreening({
    candidates: [cand(1), cand(2)], question: 'Q?', intent: 'I', constraints, policy, signal: abortDuringRescue.signal,
    rescue: { maxReads: 2 },
    judge: scriptJudge([{ m1: { scope: .1, info: 'insufficient_information' }, m2: { scope: .1, info: 'insufficient_information' } }]),
    rescueRead: async () => { rescueReadsAfterAbort++; abortDuringRescue.abort(); return { text: 'new text', safetyState: 'clear' } },
  })
  assert.equal(rescueReadsAfterAbort, 1)
  assert.equal(haltedRescue.diagnostics.judgeCalls, 1)
  assert.equal(haltedRescue.run.halted, 'cancelled')
  assert.equal(haltedRescue.selection.stopReason, 'cancelled')
  // A failed rescue dispatch keeps the pre-read judgement instead of publishing
  // a reread text that was never judged.
  let rescueAttempt = 0
  const rescueDispatchFailure = await runScreening({
    candidates: [cand(1, { text: 'excerpt text' })], question: 'Q?', intent: 'I', constraints, policy,
    rescue: { maxReads: 1 },
    judge: async (request) => {
      rescueAttempt++
      if (rescueAttempt === 2) throw new Error('judge unavailable')
      return scriptJudge([{ m1: { scope: .1, info: 'insufficient_information', value: '5' } }])(request)
    },
    rescueRead: async () => ({ text: 'full page text', safetyState: 'clear' }),
  })
  assert.equal(rescueDispatchFailure.diagnostics.rescueAttempted, 1)
  assert.equal(rescueDispatchFailure.diagnostics.rescueJudgeFailed, 1)
  assert.deepEqual(rescueDispatchFailure.run.judgeFailedIds, ['m1'])
  assert.equal(rescueDispatchFailure.run.halted, 'judge_failure')
  assert.equal(rescueDispatchFailure.decisions[0].reason, 'scope_not_established')
}

// ---- review regressions: unassessed material, held safety, snapshot context ----
{
  // An empty or invalid answer map is not proof that the pool held nothing else.
  const unassessed = await runScreening({ candidates: [cand(1)], question: 'Q?', intent: 'I', judge: async () => new Map() })
  assert.equal(unassessed.diagnostics.assessmentUnavailable, 1)
  assert.equal(unassessed.decisions[0].reason, 'value_unavailable')
  assert.equal(unassessed.selection.incomplete, true)
  assert.equal(unassessed.selection.stopReason, 'unassessable_material')
  // A safety state that is not `clear` can never be admitted here, so it is not
  // sent to the judge either — its disposition stays `safety_unavailable`.
  let heldCalls = 0
  const held = await runScreening({
    candidates: [cand(1, { safetyState: 'unavailable' }), cand(2)], question: 'Q?', intent: 'I',
    judge: async (request) => { heldCalls++; assert.deepEqual(request.state.candidates.map((ref) => ref.id), ['m2']); return scriptJudge([baseAnswers])(request) },
  })
  assert.equal(heldCalls, 1)
  assert.equal(held.diagnostics.safetyUnavailable, 1)
  assert.equal(held.decisions.find((d) => d.evidenceId === 'm1').reason, 'safety_unavailable')
  assert.deepEqual(held.results.map((r) => r.evidenceId), ['m2'])
  // An empty content string must not hide the snippet of the same row.
  const emptyContent = buildSnapshot([{ url: 'https://a.org/x', title: 'A', score: 1, content: '', snippet: 'the real snippet text', engineRanks: { bing: 1 }, provenance: [] }])[0]
  assert.equal(emptyContent.text, 'the real snippet text')
  assert.equal(emptyContent.basis, 'engine_snippet')
  // A row that carries `engines` without `engineRanks` keeps its provenance, and
  // the positive-weight projection also covers the provenance entries.
  const enginesOnly = buildSnapshot([{ url: 'https://a.org/x', score: 1, engines: ['bing'], snippet: 's', provenance: [{ engine: 'bing', rank: 1 }] }], { engineWeights: { bing: 1 } })[0]
  assert.deepEqual(enginesOnly.engines, ['bing'])
  assert.deepEqual(enginesOnly.provenance.map((entry) => entry.engine), ['bing'])
  const projectedProvenance = buildSnapshot([{
    url: 'https://z.org/r', score: 1, snippet: 's', engineRanks: { bing: 1, exa: 1 },
    provenance: [{ engine: 'bing', rank: 1 }, { engine: 'exa', rank: 1 }],
  }], { engineWeights: { bing: 1, exa: 0 } })[0]
  assert.deepEqual(projectedProvenance.engines, ['bing'])
  assert.deepEqual(projectedProvenance.provenance.map((entry) => entry.engine), ['bing'])
  assert.equal(projectedProvenance.provenanceBasis, 'positive_weight_contributors')
  // Same value level, different confidence: the recorded signal changes and the
  // score does not.
  const sameLevel = await runScreening({
    candidates: [cand(1), cand(2)], question: 'Q?', intent: 'I',
    judge: async (request) => new Map(request.mapping
      .filter((m) => Object.hasOwn(request.questions, m.id))
      .map((m) => [m.id, { type: 'choice', choice: '5', confidence: m.candidateId === 'm1' ? .2 : .99 }])),
  })
  assert.deepEqual(sameLevel.results.map((r) => [r.valueLevel, r.finalScore, r.signals.valueConfidence]), [[5, .75, .2], [5, .75, .99]])
}

// ---- follow-up review: terminal stops, snapshot binding, early validation ----
{
  const common = { candidates: [cand(1)], question: 'Q?', intent: 'I', maxResults: 1 }
  // A final judge has no next batch to notice cancellation. Preserve its valid
  // result, but report the interruption separately from the count target.
  for (const throws of [false, true]) {
    const signal = new AbortController()
    const artifact = await runScreening({ ...common, signal: signal.signal,
      judge: async (request) => {
        signal.abort()
        if (throws) throw new Error('aborted transport')
        return scriptJudge([baseAnswers])(request)
      },
    })
    assert.equal(artifact.run.halted, 'cancelled')
    assert.equal(artifact.selection.incomplete, true)
    assert.equal(artifact.results.length, throws ? 0 : 1)
    assert.equal(artifact.selection.stopReason, throws ? 'cancelled' : 'target_met')
  }
  // Deterministic clock: no timing-dependent sleep assumptions in these cases.
  const realNow = Date.now
  let now = 1000
  Date.now = () => now
  try {
    for (const throws of [false, true]) {
      now = 1000
      const artifact = await runScreening({ ...common, deadlineMs: 10,
        judge: async (request) => {
          now += 20
          if (throws) throw new Error('timed out transport')
          return scriptJudge([baseAnswers])(request)
        },
      })
      assert.equal(artifact.run.halted, 'deadline')
      assert.equal(artifact.selection.incomplete, true)
      assert.equal(artifact.results.length, throws ? 0 : 1)
    }
    // Stops during the LAST read must be checked before all early exits: a
    // throw, an empty read, an oversized read, and a valid read.
    for (const reason of ['cancelled', 'deadline']) {
      for (const outcome of ['throw', 'empty', 'oversized', 'valid']) {
        now = 1000
        const signal = new AbortController()
        const artifact = await runScreening({ ...common, constraints,
          signal: signal.signal, deadlineMs: 10,
          limits: { maxStateChars: 9000, maxRequestChars: 12000 },
          rescue: { maxReads: 1 },
          judge: scriptJudge([{ m1: { scope: .1, info: 'insufficient_information' } }]),
          rescueRead: async () => {
            if (reason === 'cancelled') signal.abort()
            else now += 20
            if (outcome === 'throw') throw new Error('interrupted read')
            return { text: outcome === 'empty' ? '' : outcome === 'oversized' ? 'x'.repeat(20000) : 'new text', safetyState: 'clear' }
          },
        })
        assert.equal(artifact.run.halted, reason, outcome)
        assert.equal(artifact.selection.stopReason, reason, outcome)
        assert.equal(artifact.selection.incomplete, true, outcome)
        assert.equal(artifact.diagnostics.judgeCalls, 1, outcome)
        assert.equal(artifact.diagnostics.rescueReadFailed, 0, 'interruption is not an ordinary failed read')
      }
    }
    // The final rescue judgement also has no next iteration to catch its stop.
    for (const reason of ['cancelled', 'deadline']) {
      now = 1000
      const signal = new AbortController()
      let calls = 0
      const artifact = await runScreening({ ...common, constraints,
        signal: signal.signal, deadlineMs: 10, rescue: { maxReads: 1 },
        judge: async (request) => {
          if (++calls === 1) return scriptJudge([{ m1: { scope: .1, info: 'insufficient_information' } }])(request)
          if (reason === 'cancelled') signal.abort()
          else now += 20
          return scriptJudge([baseAnswers])(request)
        },
        rescueRead: async () => ({ text: 'new text', safetyState: 'clear' }),
      })
      assert.equal(artifact.run.halted, reason)
      assert.equal(artifact.results.length, 1)
      assert.equal(artifact.selection.stopReason, 'target_met')
      assert.equal(artifact.selection.incomplete, true)
    }
  } finally { Date.now = realNow }

  for (const invalid of [{ params: { lambda: 2 } }, { params: { tau: 0 } },
    { maxResults: 0 }, { maxResults: 1.5 }, { maxResults: Infinity },
    { policy: { ...policy, criteria: { unknown: 'Cannot decide.' } } }]) {
    let calls = 0, reads = 0
    await assert.rejects(runScreening({ ...common, ...invalid,
      rescue: { maxReads: 1 }, rescueRead: async () => { reads++; return null },
      judge: async (request) => { calls++; return scriptJudge([baseAnswers])(request) },
    }), /lambda|tau|maxResults|must describe every option/)
    assert.equal(calls, 0, 'invalid configuration must not consume a judge call')
    assert.equal(reads, 0)
  }

  const first = { url: 'https://snapshot.org/page', score: 1, scoreVersion: 'score-v1',
    snippet: 'short', textVersion: 'v1', title: 'Old title', published: '2020-01-01', safetyState: 'clear' }
  const second = { ...first, score: 2, scoreVersion: 'score-v2', snippet: 'a much longer updated excerpt',
    textVersion: 'v2', title: 'New title', published: '2026-01-01' }
  const context = (row) => [row.text, row.textVersion, row.title, row.published, row.baseScore, row.scoreVersion]
  for (const rows of [[first, second], [second, first]]) {
    assert.deepEqual(context(buildSnapshot(rows)[0]),
      [second.snippet, 'v2', 'New title', '2026-01-01', 2, 'score-v2'])
  }
  // Equal lengths still choose the same observation regardless of arrival order.
  const equal = { ...second, snippet: 'other' }
  assert.deepEqual(context(buildSnapshot([first, equal])[0]), context(buildSnapshot([equal, first])[0]))
  // Missing metadata in the winning observation cannot borrow old metadata.
  const missing = { ...second, title: undefined, published: undefined, textVersion: undefined }
  for (const rows of [[first, missing], [missing, first]]) {
    const merged = buildSnapshot(rows)[0]
    assert.equal(merged.text, missing.snippet)
    assert.equal(merged.textVersion, null)
    assert.equal(merged.published, null)
    assert.equal(merged.title, missing.url)
  }
  // Content wins over even a longer snippet; its metadata moves with it.
  const page = { ...first, content: 'body', textVersion: 'page-v1', published: '2021-01-01' }
  for (const rows of [[second, page], [page, second]]) {
    assert.deepEqual(context(buildSnapshot(rows)[0]), ['body', 'page-v1', 'Old title', '2021-01-01', 2, 'score-v2'])
  }
  const valueOnly = await runScreening({ ...common, constraints, rescue: { maxReads: 1, valueUnknown: true },
    judge: scriptJudge([{ m1: { scope: .9, value: 'unestablished' } }, baseAnswers]),
    rescueRead: async () => ({ text: 'full page', safetyState: 'clear' }),
  })
  assert.equal(valueOnly.diagnostics.rescueScopeRecovered, 0)
  assert.equal(valueOnly.diagnostics.rescueValueRecovered, 1)
  assert.equal(valueOnly.diagnostics.rescueRecovered, 1)
}

console.log('ok: screening contracts, complete scope-state matrix, safety-terminal rescue, size-bounded packing (incl. the rescue dispatch), failure/cancel isolation, unassessed-material honesty, soft redundancy, weight-aware provenance, confidence recording, intent preservation and eligibility recovery counters')
