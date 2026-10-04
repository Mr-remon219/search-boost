#!/usr/bin/env node
import './isolate-tests.mjs'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createDecisionClient, decisionRegistry } from '../lib/judgment/registry.mjs'
import { activateJudgmentProfile, describeJudgmentForCapability, judgmentFilePath, readJudgmentConfig, readJudgmentProfiles, removeJudgmentProfile, saveJudgmentProfile } from '../lib/judgment/config.mjs'
import { headFingerprint, createHeadVerifier, validateCapacityManifest } from '../lib/judgment/capacity.mjs'
import { clearJevConfig, jevFilePath, saveJevConfig } from '../lib/jev-config.mjs'
import { runJudgmentWizard, formatJudgmentStatusLines } from '../lib/installer/judgment-wizard.mjs'
import { runJevWizard } from '../lib/installer/jev-wizard.mjs'
import { runAdaptiveSearch } from '../lib/runtime.mjs'
import { toolState } from '../lib/tool-config.mjs'
import { saveResearchResultsV3, loadResearchResults, researchResultsDir } from '../lib/research-results.mjs'
import { makeHarness, outputValidator } from './screening-run-fixture.mjs'

const KEY = 'release-test-secret-never-expose'
const JEV = { provider: 'jev', baseUrl: 'https://api.typesafe.ai/v1', model: 'jev-latest', authMode: 'bearer', apiKey: KEY }
const LAYA = { provider: 'laya', baseUrl: 'http://localhost:8000/v1', model: 'multilingual', authMode: 'none', apiKey: null }
const q = { type: 'choice', instructions: 'Choose a fixed label.', criteria: { yes: 'Present', no: 'Absent' } }
const validator = outputValidator()
let groups = 0
async function test(name, fn) { await fn(); groups++; console.log(`ok: ${name}`) }
const reset = () => { rmSync(judgmentFilePath(), { force: true }); clearJevConfig() }
const json = body => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
const modelCases = [[undefined, null], [null, null], ['', null], ['not a valid model!', null], [42, null], [KEY, null], ['jev-1.13.0', 'jev-1.13.0']]
function wireAnswers(questions, gateway) {
  return Object.fromEntries(Object.entries(questions).map(([id, spec]) => {
    const choice = id === 'strategy.ranking' ? 'research' : id === 'strategy.community' ? 'disable'
      : id.startsWith('safety.') ? 'clear' : id.startsWith('value.') ? '4'
        : id.startsWith('discount.') ? 'none' : Object.keys(spec.criteria)[0]
    return [id, gateway && spec.type === 'noul' ? { type: 'boolean', probability: .8 } : { type: spec.type, choice }]
  }))
}
function transport(reported, gateway, calls = []) {
  return {
    maxRetries: 0,
    fetchImpl: async (url, init) => {
      calls.push({ url, init })
      assert.equal(new URL(url).origin, gateway ? 'https://ai-gateway.vercel.sh' : 'https://api.typesafe.ai')
      const body = JSON.parse(init.body)
      return json({ ...(reported !== undefined ? { model: reported } : {}), answers: wireAnswers(body.questions, gateway),
        usage: gateway ? { inputTokens: 30, outputTokens: 5 } : { input_tokens: 30, output_tokens: 5 } })
    },
  }
}

for (const gateway of [false, true]) {
  await test(`${gateway ? 'Vercel SDK' : 'native Jev'} identity is reported-only in client, run, raw snapshot and restoration`, async () => {
    const profile = gateway ? { ...JEV, baseUrl: 'https://ai-gateway.vercel.sh/v1', model: 'typesafe-ai/jev' } : JEV
    for (const [reported, expected] of modelCases) {
      const calls = []
      const client = createDecisionClient(profile, transport(reported, gateway, calls))
      const result = await client.ask({ state: 'Evidence', phase: 'screening', questions: { a: q } })
      assert.equal(result.identity.requestedModel, profile.model)
      assert.equal(result.identity.resolvedModel, expected)
      assert.equal(client.usage().resolvedModel, expected)
      assert.equal(result.model, expected ?? profile.model, 'old model alias semantics remain compatible')
      assert.equal(result.entries.get('a').choice, 'yes', 'unknown identity must not change fixed answers')
      assert.equal(calls.length, 1)
      assert(!JSON.stringify({ result, usage: client.usage() }).includes(KEY))

      const h = makeHarness({ config: { ...profile, ready: true } })
      h.deps.createClient = config => createDecisionClient(profile, { ...config, ...transport(reported, gateway) })
      h.deps.saveResults = saveResearchResultsV3
      const live = await runAdaptiveSearch({ questions: ['Observed behavior?'], intent: 'Verify source evidence.', community: false, save_results: true }, {}, h.deps)
      assert.equal(validator(live), null)
      assert.equal(live.results.length, 4)
      assert.equal(h.calls.search.length, 1)
      assert.equal(live.run.judgment.requestedModel, profile.model)
      assert.equal(live.run.judgment.resolvedModel, expected)
      assert.equal(live.run.jevModel, expected ?? profile.model)
      assert.equal(live.run.judgment.adapterVersion, 1)
      const file = join(researchResultsDir(), `${live.savedResultId}.json`)
      const before = readFileSync(file, 'utf8')
      const raw = JSON.parse(before)
      assert.equal(raw.metadata.run.judgment.resolvedModel, expected)
      assert.equal(raw.metadata.run.judgment.requestedModel, profile.model)
      const loaded = loadResearchResults(live.savedResultId)
      assert.equal(loaded.metadata.run.judgment.resolvedModel, expected)
      const restored = await runAdaptiveSearch({ saved_result_id: live.savedResultId }, {}, {
        toolState: () => ({ enabled: true }), loadResults: loadResearchResults,
        readConfig: () => { throw Error('restore must not read config') },
        createClient: () => { throw Error('restore must not rejudge') },
        search: () => { throw Error('restore must not search') },
      })
      assert.equal(validator(restored), null)
      assert.equal(restored.run.judgment.resolvedModel, expected)
      assert.equal(readFileSync(file, 'utf8'), before, 'restoration never rewrites existing snapshots')
    }
  })
}
await test('model identity is reset to unknown if a later response omits it', async () => {
  let count = 0
  const client = createDecisionClient(JEV, { maxRetries: 0, fetchImpl: async () => json({ ...(count++ === 0 ? { model: 'jev-1.13.0' } : {}), answers: { a: { type: 'choice', choice: 'yes' } } }) })
  assert.equal((await client.ask({ phase: 'screening', state: 'x', questions: { a: q } })).identity.resolvedModel, 'jev-1.13.0')
  assert.equal((await client.ask({ phase: 'screening', state: 'x', questions: { a: q } })).identity.resolvedModel, null)
  assert.equal(client.usage().resolvedModel, null)
})
await test('clients with no declared adapter version cannot invent version 1', async () => {
  const h = makeHarness()
  const create = h.deps.createClient
  h.deps.createClient = config => { const client = create(config); client.describe = () => ({ provider: 'jev', model: 'jev-latest' }); return client }
  const out = await runAdaptiveSearch({ questions: ['Q?'], intent: 'I', community: false }, {}, h.deps)
  assert.equal(out.run.judgment.adapterVersion, null)
  assert.equal(validator(out), null)
})
await test('delete an active copied key disables judgments and cannot resurrect legacy credentials', async () => {
  reset()
  saveJevConfig({ apiKey: KEY })
  saveJudgmentProfile('local-laya', LAYA)
  activateJudgmentProfile('legacy-jev')
  let logs = []
  const log = console.log
  try { console.log = message => logs.push(message); await runJevWizard(null, { clear: true, yes: true }) }
  finally { console.log = log }
  assert(logs.join('\n').includes('do not change or remove keys'))
  assert(logs.join('\n').includes('judgment.json'))
  assert(!logs.join('\n').includes(KEY))
  assert.equal(readJudgmentConfig().apiKey, KEY, 'legacy clear is explicitly separate')
  const frozen = readJudgmentConfig()
  removeJudgmentProfile('legacy-jev')
  assert.equal(readJudgmentProfiles().activeProfile, null)
  assert.equal(readJudgmentConfig().ready, false)
  assert.equal(toolState('adaptive_search').locked, true)
  assert(!readFileSync(judgmentFilePath(), 'utf8').includes(KEY))
  assert.equal(frozen.apiKey, KEY, 'in-flight run keeps the documented frozen profile')
  assert(formatJudgmentStatusLines().join('\n').includes('judgments disabled'))
  activateJudgmentProfile('local-laya')
  removeJudgmentProfile('local-laya')
  assert.deepEqual(readJudgmentProfiles().profiles, {})
  assert(existsSync(judgmentFilePath()))
  saveJevConfig({ apiKey: KEY })
  assert.equal(readJudgmentConfig().ready, false, 'even new legacy keys cannot bypass the explicit disabled file')
  saveJudgmentProfile('fresh-laya', LAYA)
  assert.equal(readJudgmentConfig().provider, 'laya', 'disabled store can be configured again')
  saveJudgmentProfile('inactive-jev', JEV, { activate: false })
  removeJudgmentProfile('inactive-jev')
  assert.equal(readJudgmentProfiles().activeProfile, 'fresh-laya')
  const before = readFileSync(judgmentFilePath(), 'utf8')
  assert.throws(() => removeJudgmentProfile('../escape'))
  assert.throws(() => removeJudgmentProfile('missing'))
  assert.equal(readFileSync(judgmentFilePath(), 'utf8'), before)
})
await test('profile deletion TUI supports rejection/dry-run and explicit confirmation', async () => {
  reset()
  saveJudgmentProfile('delete-me', JEV)
  const before = readFileSync(judgmentFilePath(), 'utf8')
  async function wizard(confirm, dryRun) {
    const selections = ['delete-me', 'remove']
    await runJudgmentWizard({ select: async () => selections.shift(), confirm: async () => confirm,
      log: { info: () => {} }, isCancel: () => false }, { dryRun })
    assert.equal(selections.length, 0)
  }
  await wizard(false, false)
  assert.equal(readFileSync(judgmentFilePath(), 'utf8'), before)
  await wizard(true, true)
  assert.equal(readFileSync(judgmentFilePath(), 'utf8'), before)
  await wizard(true, false)
  assert.equal(readJudgmentConfig().ready, false)
  assert(!readFileSync(judgmentFilePath(), 'utf8').includes(KEY))
})
await test('legacy invalid profiles fail closed and default/custom destinations are truthful', async () => {
  reset()
  writeFileSync(jevFilePath(), JSON.stringify({ jev: { apiKey: KEY, baseUrl: 'not-a-url' } }))
  assert.throws(() => readJudgmentConfig())
  assert.equal(toolState('adaptive_search').locked, true)
  assert.equal(describeJudgmentForCapability().source, 'unreadable')
  writeFileSync(jevFilePath(), JSON.stringify({ jev: { apiKey: KEY } }))
  assert.equal(describeJudgmentForCapability().gateway, 'default')
  assert.match(describeJudgmentForCapability().destination, /TypeSafe Jev/)
  saveJudgmentProfile('vercel', { ...JEV, baseUrl: 'https://ai-gateway.vercel.sh/v1', model: 'typesafe-ai/jev' })
  assert.equal(describeJudgmentForCapability().gateway, 'default')
  assert.match(describeJudgmentForCapability().destination, /Vercel/)
  saveJudgmentProfile('custom', { ...JEV, baseUrl: 'https://private.example/v1' })
  assert.equal(describeJudgmentForCapability().gateway, 'custom')
  assert(!JSON.stringify(describeJudgmentForCapability()).includes('private.example'))
  saveJudgmentProfile('laya', LAYA)
  assert.match(describeJudgmentForCapability().destination, /self-hosted Laya/)
  assert(!JSON.stringify(describeJudgmentForCapability()).includes(KEY))
})
await test('NOUL label changes invalidate head evidence; unsupported fields never reach transport', async () => {
  const short = { type: 'noul', instructions: 'Does the statement hold?', criteria: { false: 'No', true: 'Yes' }, labels: { false: 'absent', true: 'present' } }
  const long = { ...short, labels: { false: 'absent', true: 'long changed label '.repeat(100) } }
  assert.notEqual(headFingerprint(short), headFingerprint(long))
  const repo = 'owner/pinned-checkpoint'
  const manifest = validateCapacityManifest({ version: 1, baseUrl: LAYA.baseUrl, model: LAYA.model, layaVersion: '0.3.26',
    sourceRevision: '2e4d9c87e8b1621deb344eac7de5c7258f32f849', repo, modelRevision: 'a'.repeat(40), tokenizerRevision: 'b'.repeat(40), maxLen: 1024, headMaxLen: 256,
    heads: { [headFingerprint(short)]: { headTokens: 20, instructionsTokens: 8, retainedInstructionsTokens: 8, optionTokens: [4, 4], retainedOptionTokens: [4, 4] } } }, decisionRegistry.validateConfig(LAYA))
  let calls = 0
  const client = createDecisionClient(LAYA, { verifyHead: createHeadVerifier(manifest), maxRetries: 0, fetchImpl: async (_url, init) => {
    calls++
    const body = JSON.parse(init.body)
    assert.deepEqual(body.questions.a.labels, calls === 1 ? short.labels : long.labels)
    return json({ routing: { model: LAYA.model, repo }, answers: { a: { type: 'noul', noul: .8 } },
      usage: { state_tokens: 15, state_tokens_dropped: 0, truncated: false, truncated_questions: [] } })
  } })
  assert.equal((await client.ask({ phase: 'screening', state: 'x', questions: { a: short } })).entries.get('a').value, .8)
  const changed = await client.ask({ phase: 'screening', state: 'x', questions: { a: long } })
  assert.equal(changed.entries.size, 0)
  assert.equal(changed.unavailable.a, 'head_capacity_unverified')
  for (const bad of [{ ...short, unknown: 'unbound head field' }, { ...q, labels: short.labels }, { ...short, labels: { false: 'same', true: 'same' } }]) {
    await assert.rejects(client.ask({ phase: 'screening', state: 'x', questions: { a: bad } }), /invalid_request/)
  }
  assert.equal(calls, 2, 'invalid questions never dispatch')
})
console.log(`${groups} judgment release regression groups passed (offline, including SDK fixtures).`)
