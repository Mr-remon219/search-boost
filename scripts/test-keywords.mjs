#!/usr/bin/env node
import './isolate-tests.mjs'
// Successor of the retired keyword-planning suite: keywords are GONE. This entry
// proves the retirement is structural, not just hidden: the shared input rejects
// every keyword-era field, the single strategy request contains only the fixed
// ranking/community choices, no continuation state is produced, and the wiring
// scan finds no keyword planning left anywhere in the screening layer.
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { ADAPTIVE_INPUT_SCHEMA, normalizeAdaptiveInput } from '../lib/search/screening/input.js'
import { runAdaptiveScreening, RANKING_PRESETS } from '../lib/search/screening/run.js'
import { buildStrategyRequest } from '../lib/search/screening/judgments.js'
import { COMMUNITY_OPTIONS } from '../lib/search/screening/policy.js'
import { makeHarness } from './screening-run-fixture.mjs'

let tests = 0
const test = async (name, fn) => { await fn(); tests++; console.log(`ok: ${name}`) }

await test('every keyword-era input field is refused before any dependency call', async () => {
  const forbidden = new Proxy({}, { get: () => { throw new Error('no dependency may run for a rejected input') } })
  for (const field of ['keywords', 'tasks', 'targets', 'facts', 'time_range', 'keyword_progress', 'coverage']) {
    const input = { questions: ['Q?'], intent: 'I', [field]: [] }
    await assert.rejects(runAdaptiveScreening(input, {}, forbidden), /Unsupported adaptive input field/, field)
    assert.throws(() => normalizeAdaptiveInput(input), /Unsupported adaptive input field/)
  }
  assert.equal('keywords' in ADAPTIVE_INPUT_SCHEMA.properties, false)
})

await test('the one strategy request asks only ranking, plus community when omitted', async () => {
  const withCommunity = buildStrategyRequest({ text: 'Q?' }, 'I', [], { presets: RANKING_PRESETS, includeCommunity: true })
  assert.deepEqual(Object.keys(withCommunity.questions).sort(), ['strategy.community', 'strategy.ranking'])
  const rankingOnly = buildStrategyRequest({ text: 'Q?' }, 'I', [], { presets: RANKING_PRESETS, includeCommunity: false })
  assert.deepEqual(Object.keys(rankingOnly.questions), ['strategy.ranking'])
  for (const request of [withCommunity, rankingOnly]) {
    const text = JSON.stringify(request)
    assert.equal(/keyword/i.test(text), false, 'no keyword planning may leak into the strategy request')
    assert.equal(/scope|constraint/i.test(text), false, 'no per-material scope/constraint instruction may leak in')
    assert.equal(/language/i.test(text), false, 'no language question or hint may leak in')
    assert.equal(request.state.question, 'Q?')
    assert.equal(request.state.intent, 'I')
  }
})

await test('a run produces no keyword progress, continuation or convergence field', async () => {
  const h = makeHarness()
  const result = await runAdaptiveScreening({ questions: ['Q?'], intent: 'I', community: false }, {}, h.deps)
  for (const field of ['keywordProgress', 'retrievalSufficient', 'coverageComplete', 'convergence', 'uncovered', 'keywordTarget', 'keywordFloor', 'minimumProgress']) {
    assert.equal(field in result, false, `${field} must not exist in a schema-v5 response`)
    assert.equal(JSON.stringify(result).includes(`"${field}"`), false)
  }
  assert.equal(h.calls.search.length, 1, 'no per-keyword follow-up search exists')
  assert.equal(h.calls.jev.length >= 1, true)
  assert.equal(Object.keys(h.calls.jev[0].request.questions).filter((id) => /keyword/i.test(id)).length, 0)
})

await test('the screening layer keeps no keyword planner, continuation queue or approvedResults selector', () => {
  const dir = fileURLToPath(new URL('../lib/search/screening/', import.meta.url))
  const files = readdirSync(dir).filter((name) => name.endsWith('.js') && name !== 'legacy-snapshot.js')
  for (const name of files) {
    const text = readFileSync(`${dir}${name}`, 'utf8')
    for (const token of ['keywordProgress', 'nextKeyword', 'keywordQueue', 'approvedResults', 'selectEngineCandidates', 'planning.js', 'adaptive/loop', 'adaptive/input', 'adaptive/pages', 'adaptive/output']) {
      assert.equal(text.includes(token), false, `${name} must not reference ${token}`)
    }
  }
  // legacy-snapshot.js only DECODES the frozen v1 field for historical display:
  // it must not import or implement any execution path.
  const legacy = readFileSync(`${dir}legacy-snapshot.js`, 'utf8')
  for (const token of ['runScreening', 'runAdaptiveScreening', 'judge', 'search(', 'fetch(', '../runtime', 'loop.mjs']) {
    assert.equal(legacy.includes(token), false, `legacy-snapshot.js must stay a pure data contract (found ${token})`)
  }
  // The retired execution tree is gone from the package, not merely unreferenced.
  assert.throws(() => readFileSync(`${dir}../adaptive/loop.mjs`), /ENOENT/)
})

await test('community is a branch choice, not a second retrieval algorithm', async () => {
  const h = makeHarness()
  assert.deepEqual([...COMMUNITY_OPTIONS], ['enable', 'disable', 'unknown'])
  const result = await runAdaptiveScreening({ questions: ['Q?'], intent: 'I' }, {}, h.deps)
  assert.equal(h.calls.search.length, 1, 'still exactly one fused call when community is auto-selected')
  assert.equal(h.calls.search[0].args.community, false, 'a disable answer only skips the branch')
  assert.equal(result.run.reviewRule.includes('no_quantity_early_stop'), true)
  assert.equal(result.run.diversity, 'mu=0; URL deduplication only; near-duplicate folding disabled')
})
console.log(`screening keyword retirement: ${tests} groups passed (no keyword planning, continuation or convergence state)`)
