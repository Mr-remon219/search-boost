#!/usr/bin/env node
import './isolate-tests.mjs'
// Successor of the retired caller-fact coverage suite. The product no longer
// accepts caller facts/tasks/targets as completion gates; the surviving contract
// is the fixed value rubric: only safe, code-assessed value 3/4/5 is delivered,
// while unestablished levels, unavailable judgements and low value are disclosed
// separately and never rewritten into each other.
import assert from 'node:assert/strict'
import { admitAndRank } from '../lib/search/screening/controller.js'
import { runAdaptiveScreening } from '../lib/search/screening/run.js'
import { resultPages } from '../lib/search/screening/pages.js'
import { VALUE_OPTIONS, PUBLISHABLE_VALUE_LEVELS, VALUE_LABELS } from '../lib/search/screening/policy.js'
import { makeHarness, fixtureRows } from './screening-run-fixture.mjs'

let tests = 0
const test = async (name, fn) => { resultPages.clear(); await fn(); tests++; console.log(`ok: ${name}`) }
const INPUT = { questions: ['How does Node.js fetch support cancellation?'], intent: 'Find traceable implementation references', community: false }
const candidate = (n, over = {}) => ({ evidenceId: `m${n}`, key: `k${n}`, url: `https://k${n}/`, title: `T${n}`, text: `t${n}`, baseScore: 1, engines: ['bing'], safetyState: 'clear', ...over })
const judgement = (value, over = {}) => new Map([['m1', {
  safety: 'clear', value, discount: { state: 'selected', option: 'none', codeSelected: true, selectedBy: 'code' }, preferences: [], ...over,
}]])

await test('the rubric keeps 0-5 plus unestablished, and only 3/4/5 are publishable', () => {
  assert.deepEqual([...VALUE_OPTIONS], ['0', '1', '2', '3', '4', '5', 'unestablished'])
  assert.deepEqual([...PUBLISHABLE_VALUE_LEVELS], [3, 4, 5])
  assert.deepEqual(VALUE_LABELS, { 3: 'medium', 4: 'medium_high', 5: 'high' })
})

await test('0/1/2 are excluded as low value, never delivered or renamed', () => {
  for (const level of [0, 1, 2]) {
    const artifact = admitAndRank({ candidates: [candidate(1)], judgements: judgement({ state: 'level', level }) })
    assert.equal(artifact.results.length, 0, `value ${level} must not be delivered`)
    assert.equal(artifact.decisions[0].reason, 'value_filtered')
    assert.equal(artifact.diagnostics.valueFiltered, 1)
    assert.equal(artifact.diagnostics.valueUnestablished, 0)
    assert.equal(artifact.diagnostics.assessmentUnavailable, 0)
    assert.equal(artifact.diagnostics.safetyUnavailable, 0)
    assert.deepEqual(artifact.valueGroups[3], [])
    assert.deepEqual(artifact.valueGroups[4], [])
    assert.deepEqual(artifact.valueGroups[5], [])
  }
})

await test('3/4/5 are delivered with their labels and an increasing value utility', () => {
  const artifact = admitAndRank({
    candidates: [candidate(3), candidate(4), candidate(5)],
    judgements: new Map([
      ['m3', judgement({ state: 'level', level: 3 }).get('m1')],
      ['m4', judgement({ state: 'level', level: 4 }).get('m1')],
      ['m5', judgement({ state: 'level', level: 5 }).get('m1')],
    ]),
  })
  assert.deepEqual(artifact.results.map((row) => row.valueLevel), [5, 4, 3])
  assert.deepEqual(artifact.results.map((row) => row.valueLabel), ['high', 'medium_high', 'medium'])
  const utilities = artifact.results.map((row) => row.valueUtility)
  assert.ok(utilities[0] > utilities[1] && utilities[1] > utilities[2])
  assert.deepEqual(Object.keys(artifact.valueGroups).sort(), ['3', '4', '5'])
  assert.deepEqual(artifact.valueGroups[5], [artifact.results[0].id])
  assert.equal(artifact.diagnostics.qualityAssessed, 3)
})

await test('unestablished and unavailable stay distinct disclosures', () => {
  const unestablished = admitAndRank({ candidates: [candidate(1)], judgements: judgement({ state: 'unestablished' }) })
  assert.equal(unestablished.decisions[0].reason, 'value_unestablished')
  assert.equal(unestablished.diagnostics.valueUnestablished, 1)
  assert.equal(unestablished.diagnostics.valueFiltered, 0)
  const unavailable = admitAndRank({ candidates: [candidate(1)], judgements: judgement({ state: 'unavailable' }) })
  assert.equal(unavailable.decisions[0].reason, 'value_unavailable')
  assert.equal(unavailable.diagnostics.assessmentUnavailable, 1)
  assert.equal(unavailable.diagnostics.judgementUnavailable, 0)
  assert.equal(unavailable.diagnostics.valueFiltered, 0, 'an unavailable judgement is not a low-value verdict')
})

await test('a missing or malformed value answer is unavailable, never a fabricated level', async () => {
  const rows = fixtureRows(2)
  const dropped = makeHarness({ rows, answer: () => ({ value: null }) })
  const result = await runAdaptiveScreening({ ...INPUT, max_results: 2 }, {}, dropped.deps)
  assert.equal(result.results.length, 0, 'no value answer means no level and no fabricated pass')
  assert.equal(result.diagnostics.valueFiltered, 0, 'a missing answer is not a low-value verdict')
  assert.equal(result.diagnostics.assessmentUnavailable, 2)
  assert.equal(result.selection.targetMet, false)
  const malformed = makeHarness({ rows, answer: { value: 'not-a-level' } })
  const second = await runAdaptiveScreening({ ...INPUT, max_results: 2 }, {}, malformed.deps)
  assert.equal(second.results.length, 0)
  assert.equal(second.diagnostics.valueFiltered, 0)
  assert.equal(second.diagnostics.assessmentUnavailable, 2)
  // A whole request with no answers at all leaves the safety state unresolved:
  // that is disclosed as unassessable material, never cleared by default.
  const silent = makeHarness({ rows, answer: () => null })
  const third = await runAdaptiveScreening({ ...INPUT, max_results: 2 }, {}, silent.deps)
  assert.equal(third.results.length, 0)
  assert.equal(third.diagnostics.safetyUnavailable, 2)
  assert.equal(third.selection.incomplete, true)
  assert.equal(third.stopReason, 'unassessable_material')
})

await test('caller facts/tasks/targets are refused: they cannot become completion gates', async () => {
  for (const input of [
    { ...INPUT, facts: [{ id: 'f1', text: 'must mention v24' }] },
    { ...INPUT, tasks: [{ context: 'c', targets: [{ id: 't', question: 'q', keywords: ['k'] }] }] },
    { ...INPUT, targets: ['https://example.com'] },
  ]) {
    await assert.rejects(runAdaptiveScreening(input, {}, new Proxy({}, { get: () => () => { throw new Error('no call expected') } })), /Unsupported adaptive input field/)
  }
  const h = makeHarness({ rows: fixtureRows(4) })
  const result = await runAdaptiveScreening({ ...INPUT, max_results: 4, preferences: ['Implementation details'] }, {}, h.deps)
  const state = JSON.stringify(h.calls.jev.map((call) => call.request.state))
  assert.equal(/facts|targets|"tasks"/.test(state), false, 'no fact or target state is sent to Jev')
  assert.equal(result.diagnostics.qualityAssessed, 4, 'the value judgement itself remains the gate')
})
console.log(`screening value rubric: ${tests} groups passed (0/1/2 excluded, 3/4/5 delivered, unestablished vs unavailable disclosed)`)
