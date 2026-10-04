#!/usr/bin/env node
import './isolate-tests.mjs'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync, statSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DecisionRegistry, decisionRegistry, createDecisionClient } from '../lib/judgment/registry.mjs'
import { jevRegistration } from '../lib/judgment/adapters/jev.mjs'
import { DecisionError } from '../lib/judgment/contract.mjs'
import { judgmentFilePath, saveJudgmentProfile, readJudgmentConfig, activateJudgmentProfile, describeJudgmentForCapability } from '../lib/judgment/config.mjs'
import { headFingerprint, capacityFilePath, validateCapacityManifest, createHeadVerifier } from '../lib/judgment/capacity.mjs'
import { formatJudgmentStatusLines, runJudgmentWizard } from '../lib/installer/judgment-wizard.mjs'
import { saveJevConfig, readJevConfig } from '../lib/jev-config.mjs'
import { toolState, saveToolPreferences } from '../lib/tool-config.mjs'
import { runAdaptiveSearch } from '../lib/runtime.mjs'
import { saveResearchResultsV2, loadResearchResults, researchResultsDir } from '../lib/research-results.mjs'
import { makeHarness, outputValidator, fixtureRows } from './screening-run-fixture.mjs'

const KEY = 'secret-sentinel-do-not-expose'
const PROFILE = { provider: 'laya', model: 'multilingual', baseUrl: 'http://localhost:8000/proxy/v1/', authMode: 'none', apiKey: null, options: { max_len: null, head_max_len: null } }
const choice = { type: 'choice', instructions: 'Pick the observed label.', criteria: { yes: 'Present.', no: 'Absent.' } }
const request = { phase: 'screening', state: { text: 'Full original material. 中文材料。' }, questions: { a: choice, b: choice } }
const repo = 'owner/pinned-checkpoint'
const manifestFor = questions => ({ version: 1, baseUrl: PROFILE.baseUrl.replace(/\/$/, ''), model: 'multilingual', layaVersion: '0.3.26', sourceRevision: '2e4d9c87e8b1621deb344eac7de5c7258f32f849', repo, modelRevision: 'a'.repeat(40), tokenizerRevision: 'b'.repeat(40), maxLen: 1024, headMaxLen: 256, heads: Object.fromEntries(Object.values(questions).map(q => [headFingerprint(q), { headTokens: 20, instructionsTokens: 8, retainedInstructionsTokens: 8, optionTokens: Object.keys(q.criteria).map(() => 4), retainedOptionTokens: Object.keys(q.criteria).map(() => 4) }])) })
const payload = (questions = request.questions) => ({ model: 'laya-rl-agent', routing: { model: 'multilingual', repo }, answers: Object.fromEntries(Object.entries(questions).map(([id, q]) => [id, { type: q.type, choice: Object.keys(q.criteria)[0], confidence: .2, answer_confidence: .8, abstention: 'passed' }])), usage: { input_tokens: 30, output_tokens: 0, state_tokens: 15, state_tokens_dropped: 0, truncated: false, truncated_questions: [] } })
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
function clientFor(edit = () => {}, controls = {}, profile = PROFILE) {
  const calls = []
  const normalized = decisionRegistry.validateConfig(profile)
  const manifest = validateCapacityManifest(manifestFor(request.questions), normalized)
  const client = createDecisionClient(profile, { maxRetries: 1, sleep: async () => {}, verifyHead: createHeadVerifier(manifest), fetchImpl: async (url, init) => { calls.push({ url, init }); const raw = payload(); edit(raw); return json(raw) }, ...controls })
  return { client, calls }
}
let groups = 0
async function test(name, fn) { await fn(); groups++; console.log(`ok: ${name}`) }

await test('one explicit registry owns models, metadata, factories and URL-aware TUI configuration', () => {
  assert.deepEqual(decisionRegistry.list().map(a => a.id), ['jev', 'laya'])
  assert.throws(() => new DecisionRegistry().register(jevRegistration).register(jevRegistration), /duplicate_provider/)
  assert.throws(() => decisionRegistry.get('chat'), /unknown_provider/)
  assert.throws(() => decisionRegistry.validateConfig({ ...PROFILE, model: 'auto' }), /unknown_model/)
  assert.throws(() => decisionRegistry.validateConfig({ ...PROFILE, import: 'malicious.mjs' }), /unknown_profile_field/)
  assert.throws(() => decisionRegistry.validateConfig({ ...PROFILE, baseUrl: 'http://user:password@localhost/v1' }), /invalid_base_url/)
  assert.throws(() => decisionRegistry.validateConfig({ provider: 'jev', baseUrl: 'https://api.typesafe.ai/v1' }), /not_configured/)
  assert.deepEqual(decisionRegistry.configurationFor('jev', 'https://ai-gateway.vercel.sh/v1').models, ['typesafe-ai/jev'])
  assert.equal(decisionRegistry.configurationFor('jev', 'https://ai-gateway.vercel.sh/v1').endpoint, 'https://ai-gateway.vercel.sh/v4/ai/evaluation-model')
  assert.deepEqual(decisionRegistry.configurationFor('jev', 'https://api.typesafe.ai/v1').models, ['jev-latest'])
  assert(Object.isFrozen(decisionRegistry.get('laya').models))
})
await test('keyless Laya preserves the API prefix, original state/rubric, real routing and true zero usage', async () => {
  const { client, calls } = clientFor()
  const out = await client.ask(request)
  assert.equal(calls[0].url, 'http://localhost:8000/proxy/v1/systemone')
  assert.equal(calls[0].init.redirect, 'manual')
  assert.equal('authorization' in calls[0].init.headers, false)
  const body = JSON.parse(calls[0].init.body)
  assert.deepEqual(body, { state: request.state, questions: request.questions, model: 'multilingual' })
  assert.equal(out.entries.size, 2)
  assert.deepEqual(out.identity, { provider: 'laya', requestedModel: 'multilingual', resolvedModel: 'multilingual', transport: 'systemone', adapterVersion: 1 })
  assert.equal(out.entries.get('a').confidence, undefined)
  assert.deepEqual(out.providerDiagnostics.answers.a, { confidence: .2, answerConfidence: .8, abstention: 'passed', lowConfidence: null })
  assert.equal(out.usage.outputTokens, 0)
  assert.equal(client.usage().httpAttempts, 1)
  assert(client.validateConfig())
})
await test('Bearer is optional but explicit; transport controls never upload key, fixtures or new refusal thresholds', async () => {
  const profile = { ...PROFILE, authMode: 'bearer', apiKey: KEY, options: { max_len: 1024, head_max_len: 256 } }
  const { client, calls } = clientFor(() => {}, {}, profile)
  const out = await client.ask(request)
  assert.equal(calls[0].init.headers.authorization, `Bearer ${KEY}`)
  assert.equal(JSON.parse(calls[0].init.body).max_len, 1024)
  assert.equal(JSON.parse(calls[0].init.body).min_confidence, undefined)
  assert(!calls[0].init.body.includes(KEY))
  assert(!JSON.stringify({ described: client.describe(), out, usage: client.usage() }).includes(KEY))
  for (const bad of [{ ...PROFILE, apiKey: KEY }, { ...PROFILE, authMode: 'bearer' }, { ...PROFILE, options: { min_confidence: .5 } }, { ...PROFILE, options: { max_len: 0 } }, { ...PROFILE, model: 'jev-latest' }]) assert.throws(() => decisionRegistry.validateConfig(bad))
})
await test('HTTP 200 cannot conceal per-question truncation, collapse, abstention or unevaluated confidence', async () => {
  for (const [edit, reason] of [
    [r => { r.usage.truncated = true; r.usage.state_tokens_dropped = 2; r.usage.truncated_questions = ['a'] }, 'state_truncated'],
    [r => { r.usage.options = { a: { total: 2, distinct: 1, tokens_per_option: 4 } } }, 'options_collapsed'],
    [r => { r.answers.a.abstention = 'abstained' }, 'abstained'],
    [r => { r.answers.a.low_confidence = true }, 'abstained'],
    [r => { r.answers.a.abstention = 'unevaluated' }, 'abstention_unevaluated'],
    [r => { r.answers.a.abstention = 'unrecognized' }, 'diagnostics_unavailable'],
  ]) {
    const { client, calls } = clientFor(edit)
    const out = await client.ask(request)
    assert.equal(out.entries.has('a'), false, reason)
    assert.equal(out.unavailable.a, reason)
    assert.equal(out.entries.has('b'), true, 'valid sibling must survive')
    assert.equal(calls.length, 1, 'no alternate provider or semantic retry')
  }
})
await test('strict projection, missing diagnostics, wrong routing and contradictory summaries fail closed', async () => {
  for (const edit of [r => { delete r.routing }, r => { delete r.usage.truncated_questions }, r => { r.routing.model = 'english' }, r => { r.routing.model = 'auto' }, r => { r.usage.truncated = true }, r => { r.usage.truncated_questions = ['unknown'] }, r => { r.usage = { input_tokens: 30, output_tokens: 0 } }]) {
    const out = await clientFor(edit).client.ask(request)
    assert.equal(out.entries.size, 0)
    assert.equal(Object.keys(out.unavailable).length, 2)
  }
  const out = await clientFor(r => { delete r.routing }).client.ask(request)
  assert.equal(out.identity.resolvedModel, null, 'generic laya-rl-agent is not a checkpoint')
})
await test('missing, invalid and unknown answers never become a safety pass or low-value label', async () => {
  const out = await clientFor(r => { delete r.answers.a; r.answers.b.choice = 'not-offered'; r.answers.extra = { type: 'choice', choice: 'yes' } }).client.ask(request)
  assert.equal(out.entries.size, 0)
  assert.deepEqual(out.missingIds, ['a'])
  assert.deepEqual(out.invalidIds, ['b:choice_not_offered'])
  assert.deepEqual(out.unknownIds, ['extra'])
})
await test('capacity evidence is exact, pinned, token-based and never replaced with a length heuristic', async () => {
  const { client } = clientFor(() => {}, { verifyHead: undefined })
  assert.equal((await client.ask(request)).unavailable.a, 'head_capacity_unverified')
  const checked = decisionRegistry.validateConfig(PROFILE)
  const raw = manifestFor(request.questions)
  const verify = manifest => createHeadVerifier(validateCapacityManifest(manifest, checked))({ question: choice, profile: checked, routing: { repo, model: 'multilingual' } })
  assert(verify(raw))
  for (const change of [f => { f.headTokens = 257 }, f => { f.retainedInstructionsTokens = 7 }, f => { f.optionTokens[0] = 49; f.retainedOptionTokens[0] = 49 }, f => { f.retainedOptionTokens[0] = 3 }]) {
    const altered = structuredClone(raw); change(altered.heads[headFingerprint(choice)]); assert.equal(verify(altered), false)
  }
  const dynamic = { ...choice, instructions: `${choice.instructions} preference: 动态偏好` }
  assert.equal(createHeadVerifier(validateCapacityManifest(raw, checked))({ question: dynamic, profile: checked, routing: { repo } }), false)
  assert.throws(() => validateCapacityManifest({ ...raw, modelRevision: 'latest' }, checked), /capacity_manifest_mismatch/)
  const chinese = { ...request, state: { text: '中文完整长材料'.repeat(2000) } }
  const out = await clientFor(r => { r.usage.state_tokens = 9000; r.usage.state_tokens_dropped = 8000; r.usage.truncated = true; r.usage.truncated_questions = ['a', 'b'] }).client.ask(chinese)
  assert.equal(out.entries.size, 0)
  assert.equal(out.unavailable.a, 'state_truncated')
})
await test('limited retry, authentication, redirects, size and cancellation preserve controlled transport', async () => {
  let attempts = 0
  const { client } = clientFor(() => {}, { fetchImpl: async () => ++attempts === 1 ? json({}, 429) : json(payload()) })
  assert.equal((await client.ask(request)).attempts, 2)
  assert.equal(client.usage().retries, 1)
  for (const status of [401, 422, 302]) {
    let attempts = 0
    const { client } = clientFor(() => {}, { fetchImpl: async () => { attempts++; return json({ message: KEY }, status, { location: 'https://outside.invalid' }) } })
    await assert.rejects(client.ask(request), error => error instanceof DecisionError && !error.message.includes(KEY))
    assert.equal(attempts, 1)
  }
  const oversized = clientFor(() => {}, { maxRequestChars: 10 })
  await assert.rejects(oversized.client.ask(request), /request_too_large/)
  assert.equal(oversized.calls.length, 0)
  const cancelled = new AbortController()
  cancelled.abort()
  const before = clientFor()
  await assert.rejects(before.client.ask({ ...request, signal: cancelled.signal }))
  assert.equal(before.calls.length, 0)
  const during = new AbortController(); let dispatched = 0
  const backoff = clientFor(() => {}, { fetchImpl: async () => { dispatched++; return json({}, 503) }, sleep: async () => { during.abort(); throw Error('aborted') } })
  await assert.rejects(backoff.client.ask({ ...request, signal: during.signal }), /cancelled/)
  assert.equal(dispatched, 1)
})
await test('canonical profiles support keyless Laya, preserve legacy keys, freeze each run and expose honest status', async () => {
  saveJevConfig({ apiKey: KEY })
  assert.equal(readJudgmentConfig().provider, 'jev')
  saveJudgmentProfile('local-laya', PROFILE)
  assert.equal(readJevConfig().apiKey, KEY, 'profile writes do not alter the legacy key')
  assert.equal(toolState('adaptive_search').locked, false)
  const frozen = readJudgmentConfig()
  saveJudgmentProfile('local-laya', { ...PROFILE, model: 'english' })
  assert.equal(frozen.model, 'multilingual')
  assert(Object.isFrozen(frozen.options))
  assert.equal(readJudgmentConfig().model, 'english')
  assert(formatJudgmentStatusLines().join('\n').includes('laya · english · systemone'))
  assert(!formatJudgmentStatusLines().join('\n').includes(KEY))
  assert(!JSON.stringify(describeJudgmentForCapability()).includes(KEY))
  activateJudgmentProfile('legacy-jev')
  assert.equal(readJudgmentConfig().provider, 'jev')
  if (process.platform !== 'win32') assert.equal(statSync(judgmentFilePath()).mode & 0o777, 0o600)
  saveJudgmentProfile('local-laya', PROFILE)
  const capacityPath = capacityFilePath('local-laya'); mkdirSync(dirname(capacityPath), { recursive: true })
  writeFileSync(capacityPath, JSON.stringify({ ...manifestFor(request.questions), model: 'english' }))
  assert.equal(readJudgmentConfig().capacityStatus, 'mismatch')
  assert.equal(readJudgmentConfig().capacityManifest, null)
  assert.equal(toolState('adaptive_search').locked, false, 'stale evidence is unavailable, not a false credential failure')
  assert(formatJudgmentStatusLines().join('\n').includes('judgment-capacity/local-laya.json'))
  rmSync(capacityPath)
  const old = readFileSync(judgmentFilePath(), 'utf8')
  for (const broken of ['{broken', '{}', 'null']) {
    writeFileSync(judgmentFilePath(), broken)
    assert.throws(() => readJudgmentConfig())
    assert.equal(toolState('adaptive_search').locked, true)
    assert.throws(() => saveJudgmentProfile('fresh', PROFILE))
    assert.equal(readFileSync(judgmentFilePath(), 'utf8'), broken)
  }
  writeFileSync(judgmentFilePath(), old)
  saveToolPreferences({ adaptive_search: false })
  await assert.rejects(() => runAdaptiveSearch({ saved_result_id: '11111111-1111-4111-8111-111111111111' }), /Disabled by user/)
  saveToolPreferences({ adaptive_search: true })
})
await test('both phases use one Laya client with ranking/community together and preserve partially valid materials', async () => {
  const calls = []
  const h = makeHarness({ config: { ...decisionRegistry.validateConfig(PROFILE), ready: true } })
  h.deps.createClient = config => createDecisionClient(decisionRegistry.validateConfig(PROFILE), { ...config, verifyHead: () => true, fetchImpl: async (_url, init) => {
    const body = JSON.parse(init.body); calls.push(body)
    const r = payload(body.questions)
    for (const [id, q] of Object.entries(body.questions)) r.answers[id].choice = id === 'strategy.ranking' ? 'research' : id === 'strategy.community' ? 'disable' : id.startsWith('safety.') ? 'clear' : id.startsWith('value.') ? '4' : Object.keys(q.criteria)[0]
    if (calls.length === 2) { const values = Object.keys(body.questions).filter(id => id.startsWith('value.')); r.usage.truncated = true; r.usage.state_tokens_dropped = 1; r.usage.truncated_questions = [values[1]] }
    return json(r)
  } })
  const out = await runAdaptiveSearch({ questions: ['原文问题？'], intent: '原文方向', max_results: 4 }, {}, h.deps)
  assert.equal(outputValidator()(out), null)
  assert.deepEqual(Object.keys(calls[0].questions), ['strategy.ranking', 'strategy.community'])
  assert.equal(calls[0].state.question, '原文问题？')
  assert.equal(out.run.judgment.provider, 'laya')
  assert.equal(out.run.community.source, 'judge')
  assert.equal(out.results.length, 3)
  assert(out.results.every(row => row.valueLevel === 4 && row.signals.valueConfidence === null))
  assert(out.warnings.some(w => w.includes('state_truncated')))
  assert.equal(h.calls.search.length, 1)
  assert.equal(calls.length, 2)
  const race = makeHarness(); race.deps.readConfig = () => { throw Error('config replaced') }
  const unknown = await runAdaptiveSearch({ questions: ['Q?'], intent: 'I' }, {}, race.deps)
  assert.equal(unknown.run.judgment.provider, null)
  assert.equal(unknown.run.judgment.transport, null)
  assert.equal(outputValidator()(unknown), null)
})
await test('v2/v5 snapshots retain identity, rows and metadata without writes, network or upgrade', async () => {
  const h = makeHarness({ rows: fixtureRows(2) })
  const live = await runAdaptiveSearch({ questions: ['Q?'], intent: 'I', community: false }, {}, h.deps)
  const { results, totalResults, pageResults, nextCursor, expiresAt, ...metadata } = live
  metadata.schemaVersion = 5; delete metadata.run.judgment; metadata.run.community.source = 'explicit'
  const id = saveResearchResultsV2(results, metadata)
  const file = join(researchResultsDir(), `${id}.json`); const before = readFileSync(file, 'utf8')
  const restoring = { toolState: () => ({ enabled: true }), loadResults: loadResearchResults, createClient: () => { throw Error('must not create client') }, readConfig: () => { throw Error('must not read judgment config') }, search: () => { throw Error('must not search') } }
  const out = await runAdaptiveSearch({ saved_result_id: id, page_size: 1 }, {}, restoring)
  assert.equal(out.schemaVersion, 5)
  assert.equal(out.run.judgment, undefined)
  assert.equal(out.results[0].description, results[0].description)
  assert.match(out.nextCursor, /^s5:/)
  assert.equal(readFileSync(file, 'utf8'), before)
  assert.equal(outputValidator()(out), null)
})
await test('TUI derives gateway model/endpoint from registry, saves keyless Laya and supports cancel/dry-run', async () => {
  const execute = async (values, dryRun = false, gateway = false) => {
    const logs = []
    const clack = { isCancel: () => false, log: { info: s => logs.push(s), success: s => logs.push(s) }, select: async p => { if (p.message === 'Model' && gateway) assert.deepEqual(p.options.map(o => o.value), ['typesafe-ai/jev']); return values.shift() }, text: async () => values.shift(), password: async () => values.shift(), confirm: async () => values.shift() }
    await runJudgmentWizard(clack, { dryRun }); assert.equal(values.length, 0); return logs
  }
  const prior = readFileSync(judgmentFilePath(), 'utf8')
  await execute(['+new', 'cancelled', 'laya', PROFILE.baseUrl, 'multilingual', 'none', '', '', false])
  assert.equal(readFileSync(judgmentFilePath(), 'utf8'), prior)
  await execute(['+new', 'dry-run', 'laya', PROFILE.baseUrl, 'multilingual', 'none', '', '', true], true)
  assert.equal(readFileSync(judgmentFilePath(), 'utf8'), prior)
  const logs = await execute(['+new', 'gateway', 'jev', 'https://ai-gateway.vercel.sh/v1', 'typesafe-ai/jev', KEY, true], false, true)
  assert(logs.join('\n').includes('/v4/ai/evaluation-model'))
  assert(!logs.join('\n').includes(KEY))
  await execute(['+new', 'keyless', 'laya', PROFILE.baseUrl, 'multilingual', 'none', '', '', true])
  assert.equal(readJudgmentConfig().provider, 'laya')
  assert.equal(readJudgmentConfig().apiKey, null)
})
console.log(`${groups} decision-adapter groups passed (offline fixtures; no real model-quality trial).`)
