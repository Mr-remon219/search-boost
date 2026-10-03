#!/usr/bin/env node
import './isolate-tests.mjs'
// Successor of the retired loop-funnel suite: the surviving accounting contract
// of the single N_off run. Every collected candidate is counted exactly once, the
// declared snapshot / outside-review / unreviewed numbers are conserved, usage is
// observation only, and a bounded page keeps the full metadata.
import assert from 'node:assert/strict'
import { runAdaptiveScreening } from '../lib/search/screening/run.js'
import { resultPages } from '../lib/search/screening/pages.js'
import { admitAndRank } from '../lib/search/screening/controller.js'
import { makeHarness, fixtureRows } from './screening-run-fixture.mjs'

let tests = 0
const test = async (name, fn) => { resultPages.clear(); await fn(); tests++; console.log(`ok: ${name}`) }
const INPUT = { questions: ['How does Node.js fetch support cancellation?'], intent: 'Find traceable implementation references', community: false }
const candidate = (n, over = {}) => ({ evidenceId: `m${n}`, key: `k${n}`, url: `https://k${n}/`, title: `T${n}`, text: `t${n}`, baseScore: 1, engines: ['bing'], safetyState: 'clear', ...over })
const JUDGED = (ids) => new Map(ids.map((id) => [id, {
  safety: 'clear', value: { state: 'level', level: 4 },
  discount: { state: 'selected', option: 'none', codeSelected: true, selectedBy: 'code' }, preferences: [],
}]))

await test('every collected candidate is counted exactly once in the disposition totals', () => {
  const artifact = admitAndRank({
    candidates: [candidate(1), candidate(2), candidate(3, { safetyState: 'violation' }), candidate(4, { baseScore: NaN }), candidate(5)],
    judgements: new Map([...JUDGED(['m1', 'm2', 'm3', 'm4']), ['m5', {
      safety: 'clear', value: { state: 'level', level: 1 },
      discount: { state: 'selected', option: 'none', codeSelected: true, selectedBy: 'code' }, preferences: [],
    }]]),
  })
  const d = artifact.diagnostics
  const dispositions = d.safetyRejected + d.safetyUnavailable + d.baseScoreMissing + d.valueFiltered + d.valueUnestablished + d.assessmentUnavailable + d.judgementUnavailable + d.pending + d.qualityAssessed
  assert.equal(dispositions, d.collected, 'each candidate lands in exactly one disposition bucket')
  assert.equal(d.collected, 5)
  assert.equal(d.safetyRejected, 1)
  assert.equal(d.baseScoreMissing, 1)
  assert.equal(d.valueFiltered, 1)
  assert.equal(d.qualityAssessed, 2)
  assert.equal(d.selected, 2)
  assert.equal(artifact.decisions.length, d.collected - d.selected, 'every non-selected candidate carries one bounded reason')
  assert.deepEqual(artifact.decisions.map((decision) => decision.reason).sort(), ['base_score_missing', 'safety_rejected', 'value_filtered'])
})

await test('a run conserves declared-snapshot counts against the wider fused pool', async () => {
  const rows = fixtureRows(40)
  const h = makeHarness({ rows, searchResult: { funnel: { fusionRows: 55 } } })
  const result = await runAdaptiveScreening({ ...INPUT, max_results: 5 }, {}, h.deps)
  assert.equal(result.diagnostics.collected, 40)
  assert.equal(result.diagnostics.snapshotCandidates, 40)
  assert.equal(result.diagnostics.outsideReview, 15, 'reviewed rows plus rows outside the declared review cap are conserved')
  assert.equal(result.diagnostics.unreviewed, result.diagnostics.pending + result.diagnostics.outsideReview)
  assert.equal(result.diagnostics.selected, result.selection.returned)
  assert.equal(result.selection.returned, 5)
  assert.equal(result.totalResults, 5)
  assert.ok(result.warnings.some((warning) => /outside the declared review cap/.test(warning)))
})

await test('usage is observed, never enforced, and unknown counters stay unknown', async () => {
  const h = makeHarness({ attempts: 3, usage: {} })
  const result = await runAdaptiveScreening({ ...INPUT, max_results: 1 }, {}, h.deps)
  assert.equal(result.usage.fusedCalls, 1)
  assert.equal(result.usage.jevCalls >= 1, true)
  assert.equal(result.usage.jevHttpAttempts, result.usage.jevCalls * 3, 'every metered send is counted, none is refused')
  assert.equal(result.usage.jevRetries, result.usage.jevCalls * 2)
  assert.equal(result.usage.jevInputTokensEstimated > 0, true)
  assert.equal(result.usage.jevTokensEstimatedReserved > result.usage.jevInputTokensEstimated, true)
  assert.equal(result.usage.jevInputTokens, null, 'unreported provider tokens stay null instead of zero')
  assert.equal(result.usage.jevOutputTokens, null)
  assert.equal(result.usage.fetchReads, 0, 'this layer performs no page read')
  assert.equal(result.usage.fetchCalls, 0)
  assert.equal(result.usage.fetchCacheReads, 0)
  assert.equal(result.usage.fetchHttpRequests, 0)
  assert.equal(result.usage.engineRequests, 1)
  assert.equal(result.usage.engineHttpRequests, null)
})

await test('page metadata keeps the counters while the result list is bounded by page_size', async () => {
  const rows = fixtureRows(12).map((row, index) => (index < 2 ? { ...row, score: 0 } : row))
  const h = makeHarness({ rows })
  const first = await runAdaptiveScreening({ ...INPUT, max_results: 12, page_size: 4 }, {}, h.deps)
  assert.equal(first.results.length, 4)
  assert.equal(first.totalResults, 10)
  assert.equal(first.diagnostics.collected, 12)
  assert.equal(first.diagnostics.baseScoreMissing, 2)
  assert.equal(first.usage.fusedCalls, 1)
  assert.equal(first.run.decisionCount, 2, 'one bounded entry per non-selected candidate')
  assert.deepEqual(Object.keys(first.run.decisions[0]).sort(), ['admitted', 'evidenceId', 'reason'])
  assert.equal(first.run.decisionsTruncated, false)
  const next = await runAdaptiveScreening({ cursor: first.nextCursor, page_size: 50 }, {}, h.deps)
  assert.equal(next.results.length, 6)
  assert.deepEqual(next.run.diagnostics, first.run.diagnostics)
  assert.equal(next.usage.fusedCalls, 1)
  assert.deepEqual(next.selection, first.selection)
})

await test('a real failure keeps every already-valid result and discloses the stop', async () => {
  const h = makeHarness({ rows: fixtureRows(6), failAt: 2, failKind: 'unauthorized' })
  const result = await runAdaptiveScreening({ ...INPUT, max_results: 6 }, {}, h.deps)
  assert.equal(result.stopReason, 'unauthorized')
  assert.equal(result.selection.incomplete, true)
  assert.equal(result.diagnostics.collected, 6)
  assert.equal(result.diagnostics.unreviewed, result.diagnostics.pending + result.diagnostics.outsideReview)
  assert.equal(result.run.judgeFailures >= 1, true)
  assert.ok(result.warnings.some((warning) => /Screening stopped/.test(warning)))
})
console.log(`screening accounting: ${tests} groups passed (per-candidate conservation, observed usage, bounded pages, disclosed failures)`)
