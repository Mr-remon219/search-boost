#!/usr/bin/env node
/**
 * Default reading-value score algebra — hermetic unit tests (no network, no loop).
 *
 * These assert the search-specific score module only: u = min(r,v)*(1-lambda+lambda*d),
 * the eligibility gates, A/F/R and the advisory S. They are algebra and
 * closed-book checks, never evidence of live retrieval quality.
 */
import assert from 'node:assert/strict'

const { readingValue, usefulEligible, retrievalScore, scoreField, keywordMatchOf, topicMatchOf, RETRIEVAL_SCORE_WEIGHTS } =
  await import('../lib/search/adaptive/retrieval-score.js')
const { contentGroups } = await import('../lib/search/adaptive/keyword-progress.js')
const { ADAPTIVE_THRESHOLDS } = await import('../lib/search/adaptive/limits.js')

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

const row = (id, over = {}, judgment = {}) => ({
  evidenceId: id,
  assocId: id,
  text: over.text ?? `Substantive reviewed text for ${id} with a concrete pointer to follow up.`,
  url: over.url ?? `https://${id}.test/a`,
  judgment: { relevance: 0.9, reading_value: 0.8, injection: 0.05, direction_match: 0.9, keywords: [], topics: [], ...judgment },
})

const score = (input) => {
  const rows = input.rows ?? []
  return retrievalScore({ keyword: 'alpha', rows: [], topics: [], intentPresent: false, thresholds: ADAPTIVE_THRESHOLDS, groups: contentGroups(rows), ...input })
}

await test('u = min(r,v) * (1 - lambda + lambda*d); intent adds a direction bonus only', () => {
  const judgment = { relevance: 0.9, reading_value: 0.8, direction_match: 1 }
  assert.equal(readingValue(judgment, { intentPresent: false }), 0.8)
  assert.ok(Math.abs(readingValue(judgment, { intentPresent: true }) - 0.8) < 1e-12)
  assert.ok(Math.abs(readingValue({ ...judgment, direction_match: 0 }, { intentPresent: true }) - 0.64) < 1e-12)
  assert.ok(Math.abs(readingValue({ ...judgment, direction_match: 0.5 }, { intentPresent: true }) - 0.72) < 1e-12)
})

await test('missing direction match loses the bonus but stays unknown, never a successful match', () => {
  const judgment = { relevance: 0.9, reading_value: 0.8 }
  assert.equal(scoreField(judgment, 'direction_match'), null)
  assert.ok(Math.abs(readingValue(judgment, { intentPresent: true }) - 0.64) < 1e-12)
  assert.equal(readingValue(judgment, { intentPresent: false }), 0.8)
  // d=0 must not reject otherwise useful material.
  assert.equal(usefulEligible({ relevance: 0.9, reading_value: 0.8, direction_match: 0, injection: 0.05 }, ADAPTIVE_THRESHOLDS), true)
})

await test('eligibility requires finite known r>.60, v>.50 and known injection<=.7', () => {
  const base = { relevance: 0.9, reading_value: 0.8, injection: 0.05 }
  assert.equal(usefulEligible(base, ADAPTIVE_THRESHOLDS), true)
  assert.equal(usefulEligible({ ...base, relevance: 0.60 }, ADAPTIVE_THRESHOLDS), false)
  assert.equal(usefulEligible({ ...base, relevance: 0.61 }, ADAPTIVE_THRESHOLDS), true)
  assert.equal(usefulEligible({ ...base, reading_value: 0.50 }, ADAPTIVE_THRESHOLDS), false)
  assert.equal(usefulEligible({ ...base, reading_value: 0.51 }, ADAPTIVE_THRESHOLDS), true)
  assert.equal(usefulEligible({ ...base, injection: 0.70 }, ADAPTIVE_THRESHOLDS), true)
  assert.equal(usefulEligible({ ...base, injection: 0.71 }, ADAPTIVE_THRESHOLDS), false)
  // Unknown mandatory values fail closed instead of being read as low scores.
  assert.equal(usefulEligible({ relevance: 0.9, reading_value: 0.8, injection: null }, ADAPTIVE_THRESHOLDS), false)
  assert.equal(usefulEligible({ relevance: null, reading_value: 0.8, injection: 0.05 }, ADAPTIVE_THRESHOLDS), false)
  assert.equal(usefulEligible({ relevance: 0.9, injection: 0.05 }, ADAPTIVE_THRESHOLDS), false)
})

await test('A is the keyword-local max and a keyword match below .5 earns nothing', () => {
  const hit = row('e1', {}, { keywords: [{ keyword: 'alpha', match: 0.9 }] })
  const weak = row('e2', { url: 'https://e2b.test/a' }, { keywords: [{ keyword: 'alpha', match: 0.4 }] })
  const one = score({ rows: [hit] })
  assert.ok(Math.abs(one.A - 0.9 * 0.8) < 1e-12)
  assert.equal(one.F, one.A, 'with no caller topic the keyword itself is the topic')
  assert.equal(one.R, 0)
  assert.ok(Math.abs(one.score - (0.25 * one.A + 0.90 * one.F + 0.10 * one.R)) < 1e-12)
  assert.equal(one.eligible, 1)
  const weakOnly = score({ rows: [weak] })
  assert.equal(weakOnly.A, 0)
  assert.equal(weakOnly.eligible, 0)
})

await test('R is bounded geometric extra-group credit; duplicates add none', () => {
  const a = row('e1', { url: 'https://one.test/a' }, { keywords: [{ keyword: 'alpha', match: 0.9 }] })
  const b = row('e2', { url: 'https://two.test/b' }, { keywords: [{ keyword: 'alpha', match: 0.9 }] })
  const c = row('e3', { url: 'https://three.test/c' }, { keywords: [{ keyword: 'alpha', match: 0.9 }] })
  const three = score({ rows: [a, b, c] })
  assert.equal(three.distinct, 3)
  const q = 0.9 * 0.8
  assert.ok(Math.abs(three.R - (0.5 * q + 0.25 * q)) < 1e-12, `R=${three.R}`)
  const duplicated = score({ rows: [a, { ...a, evidenceId: 'e9', url: 'https://one.test/a' }, { ...a, evidenceId: 'e10', url: 'https://one.test/a-copy' }] })
  assert.equal(duplicated.distinct, 1)
  assert.equal(duplicated.R, 0)
  assert.ok(Math.abs(duplicated.score - score({ rows: [a] }).score) < 1e-12)
  // Identical text on different sites is still one content group (conservative).
  const copies = score({ rows: [a, { ...b, text: a.text }] })
  assert.equal(copies.distinct, 1)
  assert.equal(copies.R, 0)
})

await test('row order and repeated recomputation do not change any score', () => {
  const rows = [
    row('e1', { url: 'https://one.test/a' }, { keywords: [{ keyword: 'alpha', match: 0.9 }] }),
    row('e2', { url: 'https://two.test/b' }, { keywords: [{ keyword: 'alpha', match: 0.8 }] }),
    row('e3', { url: 'https://three.test/c' }, { keywords: [{ keyword: 'alpha', match: 0.7 }] }),
  ]
  const first = score({ rows })
  const second = score({ rows: [...rows].reverse() })
  const third = score({ rows })
  for (const value of ['score', 'A', 'F', 'R', 'distinct', 'eligible']) assert.equal(second[value], first[value])
  assert.deepEqual({ ...third }, { ...first })
})

await test('a new caller topic adds F without positional decay; same-site complements both count', () => {
  const t1 = row('e1', { url: 'https://same.test/one' }, { topics: [{ topicId: 'T1', match: 0.9 }], keywords: [{ keyword: 'alpha', match: 0.9 }] })
  const t2 = row('e2', { url: 'https://same.test/two' }, { topics: [{ topicId: 'T2', match: 0.9 }], keywords: [{ keyword: 'alpha', match: 0.4 }] })
  const topics = [{ id: 'T1', weight: 1 }, { id: 'T2', weight: 1 }]
  const both = score({ rows: [t1, t2], topics })
  const onlyT1 = score({ rows: [t1], topics })
  const q = 0.9 * 0.8
  assert.ok(Math.abs(onlyT1.F - 0.5 * q) < 1e-12)
  assert.ok(Math.abs(both.F - q) < 1e-12, 'adding a topic adds its own max without decay')
  assert.ok(both.F > onlyT1.F)
  // The same-site second complement cannot add R (one content group) ...
  assert.equal(both.distinct, 1)
  assert.equal(both.R, 0)
  // ... but F still counts it, so a same-site missing condition is never erased.
  assert.ok(Math.abs(both.F - (0.5 * (0.9 * 0.8) + 0.5 * (0.9 * 0.8))) < 1e-12)
})

await test('caller topics are never completion gates: unmatched topics leave A and eligibility intact', () => {
  const hit = row('e1', {}, { keywords: [{ keyword: 'alpha', match: 0.9 }], topics: [{ topicId: 'T1', match: 0.2 }] })
  const scored = score({ rows: [hit], topics: [{ id: 'T1', weight: 1 }] })
  assert.equal(scored.F, 0, 'an unmatched optional topic adds no F')
  assert.ok(scored.A > 0, 'the keyword index still has its own qualified material')
  assert.equal(scored.eligible, 1)
})

await test('intent changes u through d only; d=None stays null and topic/keyword matches read typed entries', () => {
  const judgment = { relevance: 0.9, reading_value: 0.8, injection: 0.05, direction_match: 0.9, keywords: [{ keyword: 'alpha', match: 0.9 }], topics: [{ topicId: 'T1', match: 0.7 }] }
  assert.equal(keywordMatchOf(judgment, 'alpha'), 0.9)
  assert.equal(keywordMatchOf(judgment, 'beta'), null)
  assert.equal(topicMatchOf(judgment, 'T1'), 0.7)
  const neutral = score({ rows: [row('e1', {}, judgment)], intentPresent: false })
  const directed = score({ rows: [row('e1', {}, judgment)], intentPresent: true })
  // intent present: u = .8 * (1 - .2 + .2*.9) = .784, match .9
  assert.ok(Math.abs(neutral.score - (0.25 + 0.90) * 0.9 * 0.8) < 1e-12)
  assert.ok(Math.abs(directed.score - (0.25 + 0.90) * 0.9 * 0.784) < 1e-12)
  assert.ok(directed.score < neutral.score, 'the direction factor is applied to u, never to the match')
})

await test('weights are fixed algebra, not calibration, and invalid weights throw', () => {
  assert.deepEqual({ ...RETRIEVAL_SCORE_WEIGHTS }, { alpha: 0.25, beta: 0.90, gamma: 0.10, rho: 0.5 })
  assert.throws(() => score({ rows: [], weights: { alpha: 0.9, beta: 0.9, gamma: 0.1, rho: 0.5 } }))
})

await test('contentGroups is a duplicate discount only: distinct sites and supersets stay separate groups', () => {
  const a = row('e1', { url: 'https://x.test/a', text: 'Alpha releases every quarter with a fixed schedule.' })
  const superset = row('e2', { url: 'https://y.test/b', text: 'Alpha releases every quarter with a fixed schedule. The recovery window is thirty seconds.' })
  const sameSite = row('e3', { url: 'https://x.test/c', text: 'Unrelated page text about a different subsystem entirely.' })
  const sameText = row('e4', { url: 'https://z.test/d', text: 'Alpha releases every quarter with a fixed schedule.' })
  const groups = contentGroups([a, superset, sameSite, sameText])
  assert.notEqual(groups.get(a), groups.get(superset), 'a superset on another site is not deleted as a copy')
  assert.equal(groups.get(a), groups.get(sameSite), 'one site is a conservative single group')
  assert.equal(groups.get(a), groups.get(sameText), 'identical text is one content group across sites')
})

await test('first result on a new topic earns F, only repeated same-topic results earn R', () => {
  const topics = [{ id:'T1', weight:1 }, { id:'T2', weight:1 }]
  const make = (id, topic) => row(id, {}, { keywords:[{keyword:'alpha', match:.9}], topics:[{topicId:topic, match:.9}] })
  const a = make('t1', 'T1'), b = make('t2', 'T2'), c = make('t3', 'T1')
  const different = score({ rows:[a,b], topics })
  assert.equal(different.R, 0)
  assert.ok(different.F > score({rows:[a], topics}).F)
  const repeated = score({rows:[a,b,c], topics})
  assert.equal(repeated.F, different.F)
  assert.ok(Math.abs(repeated.R - .5 * .5 * .8 * .9) < 1e-12)
})

console.log(`${passed} reading-value score tests passed (hermetic; not retrieval quality)`)
