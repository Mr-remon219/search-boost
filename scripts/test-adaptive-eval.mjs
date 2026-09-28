#!/usr/bin/env node
import './isolate-tests.mjs'
// Exercise the real opt-in CLI with mock runtime/config modules: no network,
// credentials or billed calls. A stale input contract must fail this test.
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const temp = mkdtempSync(join(tmpdir(), 'sb-eval-contract-'))
const script = new URL('./eval-adaptive-search.mjs', import.meta.url)
const runtimeUrl = new URL('../lib/runtime.mjs', import.meta.url).href
const configUrl = new URL('../lib/jev-config.mjs', import.meta.url).href
const convergenceUrl = new URL('../lib/search/adaptive/convergence.js', import.meta.url).href
const runtime = `
import assert from 'node:assert/strict'
import { retrievalConvergence } from ${JSON.stringify(convergenceUrl)}
export const collectSearchStats = () => ({layer:'free'})
export const runFused = () => { throw new Error('Unexpected baseline search') }
export const runFetchPage = () => { throw new Error('Unexpected page fetch') }
export async function runAdaptiveSearch(input, options) {
  assert.equal(input.questions.length, 1, 'one question per actual adaptive call')
  assert.equal(options.diagnostics, true)
  if (process.env.SB_EVAL_TEST_REJECT === '1') return {stopReason:'invalid_input'}
  const keywordProgress = [{keyword:input.questions[0],score:.9,distinct:1}]
  return {stopReason:'keyword_queue_empty',rounds:1,usage:{searchCalls:1},
    convergence:retrievalConvergence(keywordProgress),
    jev:{used:true,degraded:false,calls:3,httpAttempts:3,inputTokens:100,inputTokensEstimated:110},
    questions:[{id:'q1',question:input.questions[0],status:'satisfied',assessed:true,
      retrievalSufficient:true,evidence:[],uncoveredReasons:[],usefulResults:1,evidenceCount:1,keywordProgress}]}
}
`
const config = 'export const jevStatus=()=>({configured:true}); export const readJevConfig=()=>({})'
try {
  const loader = join(temp, 'loader.mjs')
  writeFileSync(loader, `
const modules = new Map(${JSON.stringify([[runtimeUrl, runtime], [configUrl, config]])})
export async function load(url, context, nextLoad) {
  if (modules.has(url)) return {format:'module',shortCircuit:true,source:modules.get(url)}
  return nextLoad(url, context)
}
`)
  const questions = Array.from({length:8}, (_, i) => `How does example ${i} work?`)
  const questionFile = join(temp, 'questions.json')
  const reportFile = join(temp, 'report.json')
  writeFileSync(questionFile, JSON.stringify(questions))
  const run = (reject = false) => spawnSync(process.execPath, [
    '--loader', pathToFileURL(loader).href, fileURLToPath(script),
    '--yes', '--arm', 'adaptive', '--questions', questionFile, '--out', reportFile,
  ], {encoding:'utf8',timeout:30_000,env:{...process.env,SB_EVAL_TEST_REJECT:reject?'1':'0'}})
  const good = run()
  assert.equal(good.status, 0, good.stderr)
  const report = JSON.parse(readFileSync(reportFile, 'utf8'))
  assert.deepEqual(report.groupSizes, Array(8).fill(1))
  assert.equal(report.adaptive.length, 8)
  assert.deepEqual(report.adaptive.flatMap(group => group.perQuestion.map(q => q.question)), questions)
  assert.equal(report.totals.adaptive.satisfied, 8)
  assert.ok(report.adaptive.every(group => group.convergence.score === 90 && group.convergence.method === 'score_threshold_v1'))
  assert.ok(report.adaptive.every(group => group.perQuestion[0].keywordProgress.length === 1))
  assert.match(good.stdout, /CODE-SIDE heuristic stopping rule/)
  rmSync(reportFile)
  const rejected = run(true)
  assert.notEqual(rejected.status, 0)
  assert.match(rejected.stderr, /harness error, not an unsuccessful search/)
  assert.equal(existsSync(reportFile), false)
  console.log('Adaptive eval CLI passed: single-question calls, score diagnostics, invalid-input failure (mock runtime; no network).')
} finally {
  rmSync(temp, {recursive:true,force:true})
}
