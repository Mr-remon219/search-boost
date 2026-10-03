#!/usr/bin/env node
import './isolate-tests.mjs'
// Successor of the retired recursion suite: N_off has exactly ONE pass. This entry
// proves there is no recursive re-search, no follow-up query plan, no automatic
// page read (rescue) and no second community round — in the run itself and in the
// code that would have to implement one.
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { runAdaptiveScreening } from '../lib/search/screening/run.js'
import { resultPages } from '../lib/search/screening/pages.js'
import { SCREENING_LIMITS, createScreeningBudget } from '../lib/search/screening/limits.js'
import { makeHarness, fixtureRows } from './screening-run-fixture.mjs'

let tests = 0
const test = async (name, fn) => { resultPages.clear(); await fn(); tests++; console.log(`ok: ${name}`) }
const INPUT = { questions: ['How does Node.js fetch support cancellation?'], intent: 'Find traceable implementation references' }

await test('a run performs one search, one strategy request and no automatic read', async () => {
  const h = makeHarness({ rows: fixtureRows(9) })
  const result = await runAdaptiveScreening({ ...INPUT, max_results: 3 }, {}, h.deps)
  assert.equal(h.calls.search.length, 1, 'exactly one fused snapshot call')
  assert.equal(h.calls.jev.filter((call) => call.request.phase === 'strategy').length, 1, 'exactly one strategy request')
  assert.equal(result.usage.fusedCalls, 1)
  assert.equal(result.usage.fetchReads, 0)
  assert.equal(result.usage.fetchCalls, 0)
  assert.equal(result.usage.fetchCacheReads, 0)
  assert.equal(result.usage.fetchHttpRequests, 0)
  assert.equal('fetch' in h.deps, false, 'the flow gets no page-read callback at all')
})

await test('community is a branch of the same call, never a second round', async () => {
  const enabled = makeHarness({ answer: { community: 'enable' } })
  const result = await runAdaptiveScreening({ ...INPUT, max_results: 2 }, {}, enabled.deps)
  assert.equal(enabled.calls.search.length, 1, 'the community branch shares the single fused call')
  assert.equal(result.usage.fusedCalls, 1)
  assert.equal(result.run.community.outcome, 'succeeded')
  const disabled = makeHarness({})
  await runAdaptiveScreening({ ...INPUT, max_results: 2 }, {}, disabled.deps)
  assert.equal(disabled.calls.search.length, 1, 'no branch is retried when community is not requested')
})

await test('retries are limited and never loop: one retry per logical call at most', async () => {
  const h = makeHarness({ attempts: 2 })
  const result = await runAdaptiveScreening({ ...INPUT, max_results: 1 }, {}, h.deps)
  assert.equal(result.run.limits.maxJevRetries, SCREENING_LIMITS.maxJevRetries)
  assert.equal(result.usage.jevRetries, result.usage.jevCalls, 'each logical call sends at most maxJevRetries extra attempts')
  assert.equal(result.usage.jevHttpAttempts, result.usage.jevCalls * 2)
  assert.equal(result.usage.fusedCalls, 1)
})

await test('the retired rescue read cannot be re-opened by configuration', () => {
  assert.equal(SCREENING_LIMITS.rescueReads, 0)
  assert.throws(() => createScreeningBudget({ rescueReads: 1 }), /rescueReads must be 0/)
  assert.throws(() => createScreeningBudget({ maxRescueTextChars: 10 }), /Unknown screening limit/)
  const budget = createScreeningBudget()
  assert.equal(typeof budget.attempt, 'function')
  assert.equal('rescue' in budget, false)
})

await test('the screening layer has no loop, planner or fetch path left', () => {
  const dir = fileURLToPath(new URL('../lib/search/screening/', import.meta.url))
  for (const name of readdirSync(dir).filter((file) => file.endsWith('.js') && file !== 'legacy-snapshot.js')) {
    const text = readFileSync(`${dir}${name}`, 'utf8')
    // limits.js/schema.js may only name `rescueReads` as the fixed 0 budget field,
    // and controller.js may only document that no rescue exists.
    const allowRescue = ['controller.js', 'limits.js', 'schema.js'].includes(name)
    for (const token of ['for (;;)', 'while (true)', 'runAdaptiveLoop', 'fetchPage', 'runFetchPage', 'fetch(', 'nextRound', 'rounds']) {
      assert.equal(text.includes(token), false, `${name} must not contain ${token}`)
    }
    if (!allowRescue) assert.equal(/rescue/i.test(text), false, `${name} must not mention any rescue path`)
  }
  assert.equal(readFileSync(`${dir}controller.js`, 'utf8').includes('rescueRead('), false)
  assert.match(readFileSync(`${dir}limits.js`, 'utf8'), /rescueReads: 0/)
})

await test('cancellation stops the single pass instead of scheduling another', async () => {
  const controller = new AbortController()
  const h = makeHarness()
  const result = await runAdaptiveScreening({ ...INPUT, max_results: 2 }, { signal: controller.signal }, h.deps)
  assert.equal(h.calls.search.length, 1)
  controller.abort()
  const abortedHarness = makeHarness()
  await assert.rejects(runAdaptiveScreening({ ...INPUT, max_results: 2 }, { signal: controller.signal }, abortedHarness.deps), /abort/i)
  assert.equal(abortedHarness.calls.search.length, 0, 'a pre-aborted signal dispatches nothing')
  assert.equal(result.usage.fusedCalls, 1)
})
console.log(`screening single-pass: ${tests} groups passed (no recursive search, no rescue read, no second community round)`)
