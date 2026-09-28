import './isolate-tests.mjs'
// Public v3 pagination/schema regression: no network or Jev calls.
import assert from 'node:assert/strict'
import { z } from 'zod'
import { approvedResults, createResultPages, validatePageInput } from '../lib/search/adaptive/pages.js'
import { adaptiveSearchInput, adaptiveSearchOutput } from '../adapters/mcp/schemas.mjs'
import { renderAdaptiveSummary } from '../lib/search/adaptive/describe.js'
import { runAdaptiveSearch } from '../lib/runtime.mjs'

const source = (url, valueScore, extra = {}) => ({ url, title: 'Pointer', reviewedText: 'Open this migration guide for the compatibility details.', status: 'useful_result', assessed: true, valueScore, kind: 'lead', judgment: { relevance: .95, reading_value: .9, direction_match: 0 }, ...extra })
const rows = approvedResults([source('https://example.com/a', .72), source('https://example.com/b', .9), source('https://example.com/a', .8), source('https://example.com/c', 1, { assessed: false }), source('https://example.com/d', 1, { status: 'off_topic' })])
assert.equal(rows.length, 2)
assert.equal(rows[0].url, 'https://example.com/b')
assert.equal(rows[1].valueScore, .8)
assert.equal(rows[1].directionMatch, 0, 'known mismatch is not replaced by null')
assert.equal(rows[1].kind, 'lead', 'pointers need no answer fact')
const shared = approvedResults([
  source('https://example.com/shared', .8, {taskId:'t1',targetId:'a',canonicalId:'q1'}),
  source('https://example.com/shared', .9, {taskId:'t1',targetId:'b',canonicalId:'q2',judgment:{direction_match:1},kind:'counterevidence'}),
])
assert.equal(shared.length, 1)
assert.equal(shared[0].matches.length, 2)
assert.equal(shared[0].directionMatch, 1)
assert.equal(shared[0].matches.find(x => x.targetId === 'a').directionMatch, 0)
assert.equal(shared[0].matches.find(x => x.targetId === 'b').kind, 'counterevidence')
const metadata = { schemaVersion: 3, retrievalSufficient: true, coverageComplete: false, stopReason: 'keyword_queue_empty', warnings: [], pendingAssessments: 4, keywordProgress: [{ targetId: 'q1', taskId: null, canonicalId: 'q1', keyword: 'migration', status: 'satisfied', reason: 'keyword_satisfied', score: .9, distinctEvidence: 1, finalStatus: 'satisfied', A:.8, F:.8, R:0 }] }
const pages = createResultPages()
const first = pages.save(rows, metadata, 1)
const second = pages.read(first.nextCursor, 1)
for (const page of [first, second]) {
  assert.equal(page.retrievalSufficient, true)
  assert.equal(page.coverageComplete, false)
  assert.equal(page.schemaVersion, 3)
  assert.equal(page.pendingAssessments, 4)
  assert.deepEqual(z.object(adaptiveSearchOutput).strict().parse(page), page, 'MCP schema must not strip public fields')
  assert.match(renderAdaptiveSummary(page), /answer completeness not assessed/)
}
assert.equal(second.nextCursor, null)
for (const key of ['intent', 'keywords', 'tasks', 'questions']) assert.throws(() => validatePageInput({ cursor: first.nextCursor, [key]: [] }), /cannot be combined/)
for (const input of [{ questions: ['migration?'], keywords:['upgrade'], intent:'Find primary guides and counterexamples.' }, { questions:['a?', 'b?'], keywords:[['a'], ['b']] }, { tasks:[{ context:'Product', targets:[{ id:'a', keywords:['a'], question:'Where?', intent:'A credible pointer is useful.' }] }] }]) {
  validatePageInput(input)
  assert.deepEqual(z.object(adaptiveSearchInput).strict().parse(input), input)
}
// Invalid input is checked before credentials/network even in the runtime path.
const invalid = await runAdaptiveSearch({ questions:['a?', 'b?'], keywords:['ambiguous'] })
assert.equal(invalid.stopReason, 'invalid_input')
assert.equal(invalid.retrievalSufficient, false)
assert.equal(invalid.coverageComplete, false)
assert.equal(invalid.schemaVersion, 3)
assert.deepEqual(z.object(adaptiveSearchOutput).strict().parse(invalid), invalid)
console.log('Retrieval interface checks passed: pagination, scores, schemas, cursor isolation, runtime validation (offline).')
