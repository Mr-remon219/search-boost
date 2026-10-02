#!/usr/bin/env node
import './isolate-tests.mjs'
// Successor of the retired keyword-retrieval suite: the ONE retrieval step the
// product still performs is a bounded fused candidate snapshot that is reviewed
// whole, then ranked by the prototype formula. No keyword loop, no per-engine
// quota, no second search round.
import assert from 'node:assert/strict'
import { runAdaptiveScreening } from '../lib/search/screening/run.js'
import { resultPages } from '../lib/search/screening/pages.js'
import { makeHarness, fixtureRows } from './screening-run-fixture.mjs'

let tests = 0
const test = async (name, fn) => { resultPages.clear(); await fn(); tests++; console.log(`ok: ${name}`) }
const INPUT = { questions: ['How does Node.js fetch support cancellation?'], intent: 'Find traceable implementation references', community: false }

await test('one run performs exactly one fused snapshot call with the full declared pool', async () => {
  const rows = fixtureRows(40)
  const h = makeHarness({ rows })
  const result = await runAdaptiveScreening({ ...INPUT, max_results: 4 }, {}, h.deps)
  assert.equal(h.calls.search.length, 1, 'the retrieval step runs once per run')
  const [{ args }] = h.calls.search
  assert.equal(args.candidateSelection, 'snapshot')
  assert.equal(args.complexity, 'medium')
  assert.equal(args.maxResults, 32)
  assert.equal(args.maxResultsCap, 32)
  assert.equal(args.query, INPUT.questions[0], 'the original question is the query; no keyword expansion')
  assert.equal(args.community, false)
  // The declared snapshot is bounded to 32 by the shared core (asserted in the
  // host and fused-baseline suites); this fixture hands over its whole pool.
  assert.equal(result.diagnostics.snapshotCandidates, rows.length)
  assert.equal(result.diagnostics.unreviewed, result.diagnostics.pending + result.diagnostics.outsideReview)
  assert.equal(result.selection.returned, 4)
  assert.equal(result.run.targetExceedsReviewCap, false)
})

await test('declared-snapshot review finishes before selection; quantity never stops it early', async () => {
  const rows = fixtureRows(30)
  const h = makeHarness({ rows })
  const result = await runAdaptiveScreening({ ...INPUT, max_results: 2 }, {}, h.deps)
  assert.equal(result.diagnostics.collected, 30)
  assert.equal(result.diagnostics.selected, 2)
  assert.equal(result.diagnostics.judgementUnavailable, 0)
  assert.equal(result.selection.targetMet, true)
  assert.equal(result.selection.incomplete, false)
  // The count is only a quantity claim: the answer is not declared complete.
  assert.equal('coverageComplete' in result, false)
  assert.equal('retrievalSufficient' in result, false)
  assert.equal('keywordProgress' in result, false)
})

await test('ranking is the prototype formula over real provenance and stable ties', async () => {
  const rows = [
    { ...fixtureRows(1)[0], url: 'https://b.example/doc', score: 4, engineRanks: { bing: 1 }, engines: ['bing'] },
    { ...fixtureRows(1)[0], url: 'https://a.example/doc', score: 4, engineRanks: { bing: 2 }, engines: ['bing'] },
    { ...fixtureRows(1)[0], url: 'https://c.example/doc', score: 1, engineRanks: { bing: 3 }, engines: ['bing'] },
  ]
  const h = makeHarness({ rows })
  const result = await runAdaptiveScreening({ ...INPUT, max_results: 3 }, {}, h.deps)
  assert.deepEqual(result.results.map((row) => row.url), ['https://a.example/doc', 'https://b.example/doc', 'https://c.example/doc'], 'equal scores fall back to a stable key order')
  assert.deepEqual(result.results.map((row) => row.rank), [1, 2, 3])
  assert.ok(result.results.every((row) => row.engines.length === 1 && row.engines[0] === 'bing'), 'provenance stays the real retrieval source')
  const indexed = Object.values(result.valueGroups).flat()
  assert.deepEqual(indexed.sort(), result.results.map((row) => row.id).sort(), 'valueGroups indexes the whole selected set')
  assert.deepEqual(result.run.effectiveWeights, { bing: 1 })
})

await test('the ranked snapshot is process-local, stable across page sizes and never re-searched', async () => {
  const h = makeHarness({ rows: fixtureRows(5) })
  const first = await runAdaptiveScreening({ ...INPUT, max_results: 5, page_size: 2 }, {}, h.deps)
  const byPage = await runAdaptiveScreening({ cursor: first.nextCursor, page_size: 5 }, {}, h.deps)
  assert.equal(h.calls.search.length, 1, 'paging never searches again')
  assert.deepEqual(byPage.selection, first.selection)
  assert.equal(byPage.totalResults, 5)
  assert.deepEqual(byPage.results.map((row) => row.rank), [3, 4, 5])
  await assert.rejects(() => runAdaptiveScreening({ cursor: '11111111-1111-4111-8111-111111111111.1' }, {}, h.deps), /Invalid or incompatible adaptive cursor/)
  assert.equal(h.calls.search.length, 1, 'a rejected legacy cursor never searches')
})

await test('a request above the review cap is disclosed instead of promised', async () => {
  const h = makeHarness({ rows: fixtureRows(32), searchResult: { funnel: { fusionRows: 50 } } })
  const result = await runAdaptiveScreening({ ...INPUT, max_results: 50 }, { limits: { candidateLimit: 32 } }, h.deps)
  assert.equal(result.run.targetExceedsReviewCap, true)
  assert.equal(result.diagnostics.outsideReview, 18, 'rows beyond the declared snapshot are disclosed, not silently dropped')
  assert.equal(result.diagnostics.unreviewed, 18)
  assert.ok(result.warnings.some((warning) => /exceeds the declared review cap/.test(warning)))
  assert.equal(result.stopReason, 'review_cap_reached', 'fewer results than requested are explained by the review cap')
  assert.equal(result.selection.targetMet, false)
})
console.log(`screening retrieval contract: ${tests} groups passed (single bounded fused snapshot)`)
