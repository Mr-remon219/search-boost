#!/usr/bin/env node
import './isolate-tests.mjs'
// Successor of the retired keyword-retrieval score test: the ONE ranking math the
// product still uses. Every number is code-owned; the value utility and the
// preference bonus are never multiplied by the fused score, and no confidence,
// probability or engine identity enters the formula.
import assert from 'node:assert/strict'
import {
  DEFAULT_SCREENING_PARAMS, SCREENING_POLICY_VERSION, normalizeBase, preferenceValue, screeningScore, validateParams,
} from '../lib/search/screening/scoring.js'

const near = (a, b, message = '') => assert.ok(Math.abs(a - b) <= 1e-12, `${a} !== ${b}${message ? ` (${message})` : ''}`)
let tests = 0
const test = (name, fn) => { fn(); tests++; console.log(`ok: ${name}`) }

test('b = B/(B+tau) is bounded, order preserving and overflow safe', () => {
  assert.equal(SCREENING_POLICY_VERSION, 'fused-screening-mix-v2-prototype')
  near(normalizeBase(1), 0.5)
  near(normalizeBase(3), 0.75)
  near(normalizeBase(0.25), 0.2)
  assert.ok(normalizeBase(Number.MAX_VALUE) <= 1 && Number.isFinite(normalizeBase(Number.MAX_VALUE)), 'huge bases saturate instead of overflowing')
  assert.ok(normalizeBase(1e15) < 1)
  assert.ok(normalizeBase(1e-9) > 0)
  for (const [low, high] of [[0.1, 0.2], [1, 1e6], [1e-6, 1e6]]) assert.ok(normalizeBase(low) < normalizeBase(high))
  assert.throws(() => normalizeBase(0), /positive/)
  assert.throws(() => normalizeBase(1, 0), /positive/)
})

test('finalScore = D*core + epsilon*preference and core = lambda*b + (1-lambda)*u', () => {
  const params = validateParams({})
  assert.deepEqual(params.utilities, { 3: 0.25, 4: 0.6, 5: 1 })
  assert.deepEqual(params.discountFactors, { none: 1, mild: 0.9, strong: 0.75, unknown: 1 })
  assert.equal(params.epsilon, 0.1)
  assert.equal(params.mu, 0)
  for (const [base, level, discount, matches] of [
    [1, 3, 'none', []], [12.5, 4, 'mild', ['match']], [0.3, 5, 'strong', ['partial', 'no_match']], [4, 4, 'unknown', ['unknown']],
  ]) {
    const score = screeningScore({ baseScore: base, valueLevel: level, discount, preferenceMatches: matches })
    const b = base / (base + 1)
    near(score.baseNormalized, b)
    near(score.baseContribution, 0.5 * b)
    near(score.valueContribution, 0.5 * params.utilities[level])
    near(score.coreScore, score.baseContribution + score.valueContribution)
    near(score.finalScore, score.sourceDiscountFactor * score.coreScore + 0.1 * score.preferenceValue)
    near(score.selectionScore, score.finalScore, 'mu defaults to 0')
  }
  assert.throws(() => screeningScore({ baseScore: 1, valueLevel: 2, discount: 'none' }), /valueLevel/)
  assert.throws(() => screeningScore({ baseScore: 1, valueLevel: 4, discount: 'severe' }), /Unknown discount/)
})

test('value utility and preference bonus are independent of the fused score', () => {
  const withPreference = screeningScore({ baseScore: 3, valueLevel: 4, discount: 'none', preferenceMatches: ['match'] })
  const without = screeningScore({ baseScore: 3, valueLevel: 4, discount: 'none' })
  near(withPreference.finalScore - without.finalScore, 0.1)
  near(withPreference.coreScore, without.coreScore)
  const high = screeningScore({ baseScore: 1e6, valueLevel: 3, discount: 'none' })
  const low = screeningScore({ baseScore: 1e-6, valueLevel: 5, discount: 'none' })
  assert.ok(high.baseContribution > low.baseContribution)
  assert.ok(low.valueContribution > high.valueContribution, 'the value leg is not scaled by B')
})

test('preference matches are averaged, never accumulated, and deduplicated upstream', () => {
  assert.equal(preferenceValue([]), 0)
  near(preferenceValue(['match']), 1)
  near(preferenceValue(['match', 'partial']), 0.75)
  near(preferenceValue(['match', 'partial', 'no_match', 'unknown']), 0.375)
  assert.equal(preferenceValue(['no_match']), 0)
  assert.equal(preferenceValue(['unknown']), 0)
  assert.throws(() => preferenceValue(['agree']), /Unknown preference match/)
})

test('discount factors only lower the core: none and unknown are neutral, strong<=mild<=none', () => {
  const core = (discount) => screeningScore({ baseScore: 5, valueLevel: 4, discount }).finalScore
  assert.ok(core('strong') < core('mild'))
  assert.ok(core('mild') < core('none'))
  near(core('none'), core('unknown'), 1e-12)
  // A zero discount factor is refused: provenance must never erase a candidate.
  assert.throws(() => validateParams({ discountFactors: { strong: 0 } }), /discount factors/)
  assert.throws(() => validateParams({ discountFactors: { none: 0.5 } }), /none must be 1/)
  assert.throws(() => validateParams({ discountFactors: { unknown: 0.5 } }), /provenance stays neutral/)
})

test('parameter validation keeps the fixed policy shape', () => {
  assert.throws(() => validateParams({ tau: 0 }), /tau/)
  assert.throws(() => validateParams({ lambda: 1.5 }), /lambda/)
  assert.throws(() => validateParams({ epsilon: -1 }), /epsilon/)
  assert.throws(() => validateParams({ mu: -1 }), /mu/)
  assert.throws(() => validateParams({ utilities: { 4: 0.2 } }), /utilities must satisfy/)
  assert.throws(() => validateParams({ utilities: { 3: 0.9, 4: 0.95, 5: 1.1 } }), /utilities must satisfy/)
  assert.throws(() => validateParams({ preferenceMatchValues: { no_match: 0.5 } }), /no_match/)
  const tuned = validateParams({ mu: 0.25, epsilon: 0 })
  assert.equal(tuned.mu, 0.25)
  assert.equal(tuned.epsilon, 0)
  assert.equal(screeningScore({ baseScore: 2, valueLevel: 5, discount: 'none', redundancy: 0.5 }, tuned).selectionScore,
    screeningScore({ baseScore: 2, valueLevel: 5, discount: 'none' }, tuned).finalScore - 0.125)
})

test('the frozen prototype defaults are unchanged by these tests', () => {
  assert.equal(DEFAULT_SCREENING_PARAMS.tau, 1)
  assert.equal(DEFAULT_SCREENING_PARAMS.lambda, 0.5)
  assert.equal(DEFAULT_SCREENING_PARAMS.epsilon, 0.1)
  assert.equal(DEFAULT_SCREENING_PARAMS.mu, 0)
})
console.log(`screening ranking math: ${tests} groups passed (fused-screening-mix-v2-prototype)`)
