import './isolate-tests.mjs'
// BUG-005: the real shared snapshot must honor the declared capacity, bind it
// into cache identity, and keep pagination lossless for long UTF-8 excerpts.
import assert from 'node:assert/strict'
import { runFused, invalidateSearchCaches } from '../lib/runtime.mjs'
import { runAdaptiveScreening } from '../lib/search/screening/run.js'
import { createResultPages, MAX_PAGE_BYTES } from '../lib/search/screening/pages.js'
import { makeHarness, fixtureRows, outputValidator } from './screening-run-fixture.mjs'

const calls = []
const rows = fixtureRows(100)
const snapshot = () => ({
  engines: { bing: { available: () => true, search: async (query, count) => { calls.push({ query, count }); return rows } } },
  fingerprint: 'adaptive-capacity-regression',
  capability: { x: { official: { available: false }, fallback: { available: true } } },
})
const args = { query: 'capacity fixture', enginePool: 'free', engineList: ['bing'], maxResults: 64, maxResultsCap: 64, candidateSelection: 'snapshot' }
invalidateSearchCaches()
const small = await runFused({ ...args, snapshotCandidateLimit: 8 }, { snapshot })
assert.equal(small.results.length, 8, 'the explicit snapshot capacity must control real truncation')
const larger = await runFused({ ...args, snapshotCandidateLimit: 64 }, { snapshot })
assert.equal(larger.results.length, 64)
assert.equal(larger.cacheHit, false, 'a different capacity cannot reuse a smaller snapshot')
assert.equal((await runFused({ ...args, snapshotCandidateLimit: 64 }, { snapshot })).cacheHit, true)
const before = calls.length
for (const invalid of [0, -1, 1.5, 501, '32', NaN]) {
  await assert.rejects(runFused({ ...args, snapshotCandidateLimit: invalid }, { snapshot }), /snapshot.*limit/i)
}
assert.equal(calls.length, before, 'invalid capacities must not dispatch engines')
const ordinary = await runFused({ ...args, candidateSelection: 'fused', maxResults: 2 }, { snapshot })
assert.equal(ordinary.results.length, 2, 'public fused selection remains independent')

for (const [requested, capacity] of [[1, 32], [10, 32], [12, 39], [50, 160]]) {
  const h = makeHarness({ rows: fixtureRows(capacity) })
  const out = await runAdaptiveScreening({ questions: ['Capacity?'], intent: 'Find useful material', community: false, max_results: requested, page_size: 50 }, {}, h.deps)
  assert.equal(out.run.limits.candidateLimit, capacity)
  assert.equal(h.calls.search[0].args.snapshotCandidateLimit, capacity)
  assert.equal(out.selection.returned, requested)
  assert.equal(out.selection.targetMet, true)
  assert.equal(out.run.targetExceedsReviewCap, false)
  assert.equal(out.diagnostics.collected, capacity)
  assert.equal(out.diagnostics.valueJudged, capacity)
  assert.equal(out.usage.jevCalls, 1 + Math.ceil(capacity / 4), 'every declared batch is still judged')
  assert.equal(outputValidator()(out), null)
}
// Valid value judgements are not admission counts: filtered, unestablished
// and unavailable answers must remain distinguishable in the audit metrics.
for (const [value, judged, filtered, unestablished, unavailable] of [['2', 4, 4, 0, 0], ['unestablished', 4, 0, 4, 0], [null, 0, 0, 0, 4]]) {
  const h = makeHarness({ rows: fixtureRows(4), answer: { value } })
  const result = await runAdaptiveScreening({ questions: ['Counts?'], intent: 'Review counts', community: false }, {}, h.deps)
  assert.equal(result.diagnostics.valueJudged, judged)
  assert.equal(result.diagnostics.qualityAssessed, 0)
  assert.equal(result.diagnostics.valueFiltered, filtered)
  assert.equal(result.diagnostics.valueUnestablished, unestablished)
  assert.equal(result.diagnostics.assessmentUnavailable, unavailable)
}
// An internal explicit limit remains authoritative rather than being silently
// expanded; this intentionally constrained invocation must disclose shortage.
const limited = makeHarness({ rows: fixtureRows(8) })
const out = await runAdaptiveScreening({ questions: ['Capacity?'], intent: 'Find useful material', max_results: 12 }, { limits: { candidateLimit: 8 } }, limited.deps)
assert.equal(out.run.limits.candidateLimit, 8)
assert.equal(limited.calls.search[0].args.snapshotCandidateLimit, 8)
assert.equal(out.run.targetExceedsReviewCap, true)

// Test real long reviewed rows and metadata, not just short ASCII fixtures.
const h = makeHarness({ rows: fixtureRows(10).map(row => ({ ...row, snippet: '中'.repeat(8000) })) })
const page = await runAdaptiveScreening({ questions: ['中文问题？'], intent: '中文材料', community: false, max_results: 10, page_size: 20 }, {}, h.deps)
assert.ok(page.pageResults >= 3, 'default page capacity should not fragment long CJK evidence into single-row pages')
const seen = [...page.results]
let current = page
const searchCalls = h.calls.search.length, jevCalls = h.calls.jev.length
while (current.nextCursor) {
  current = await runAdaptiveScreening({ cursor: current.nextCursor, page_size: 20 }, {}, h.deps)
  seen.push(...current.results)
  assert.equal(outputValidator()(current), null)
}
assert.deepEqual(seen.map(row => row.id), Array.from({ length: 10 }, (_, index) => `r${index + 1}`))
assert.ok(seen.every(row => row.description === '中'.repeat(8000)))
assert.equal(h.calls.search.length, searchCalls)
assert.equal(h.calls.jev.length, jevCalls)
const oversize = createResultPages().save([{ description: 'x'.repeat(MAX_PAGE_BYTES + 1000) }], { schemaVersion: 5, warnings: [] }, 20)
assert.equal(oversize.results.length, 1)
assert.ok(oversize.warnings.some(warning => /exceeds the soft page byte budget/.test(warning)))
console.log('ok: effective snapshot capacity, target headroom, cache binding, complete judgement and lossless UTF-8 pagination')
