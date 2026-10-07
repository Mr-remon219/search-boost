#!/usr/bin/env node
import './isolate-tests.mjs'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runJudgmentWizard } from '../lib/installer/judgment-wizard.mjs'
import { runJudgmentStep } from '../lib/installer/index.mjs'
import { withTuiContext, TuiCancelled, TuiHome } from '../lib/installer/i18n.mjs'
import { judgmentFilePath, readJudgmentConfig, readJudgmentProfiles, saveJudgmentProfile } from '../lib/judgment/config.mjs'
import { saveJevConfig } from '../lib/jev-config.mjs'

const key = 'fixture-private-judgment-key'
const cancel = Symbol('cancel')
let fixture = 0
const fresh = () => { process.env.SEARCH_BOOST_HOME = join(process.env.HOME, 'judgment-wizard', String(++fixture)) }
const jev = { provider: 'jev', baseUrl: 'https://api.typesafe.ai/v1', apiKey: key }
const laya = { provider: 'laya', baseUrl: 'http://localhost:8000/v1', model: 'english', authMode: 'bearer', apiKey: key, options: { max_len: 2048, head_max_len: 512 } }
function prompter(steps, { onboarding = false } = {}) {
  const records = [], logs = []
  const clack = { isCancel: v => v === cancel, log: Object.fromEntries(['info', 'success'].map(k => [k, s => logs.push(s)])) }
  for (const method of ['select', 'text', 'password', 'confirm']) clack[method] = async prompt => {
    assert(steps.length, `unexpected ${method}: ${prompt.message}`)
    const [expected, value, check] = steps.shift()
    assert.equal(method, expected)
    check?.(prompt)
    if (method === 'select' && onboarding) assert(!prompt.options.some(o => o.value === 'home'), 'onboarding must never offer main-menu navigation')
    if (method === 'select' && value !== cancel) assert(prompt.options.some(o => o.value === value), `missing option ${value}`)
    records.push({ method, ...prompt })
    return value
  }
  return { clack, records, logs, done: () => assert.equal(steps.length, 0) }
}
async function wizard(steps, opts = {}, language = 'en') {
  const p = prompter(steps)
  await withTuiContext(() => runJudgmentWizard(p.clack, opts), { language, navigation: true })
  p.done()
  assert(!p.logs.join('\n').includes(key), 'secrets never logged')
  return p
}
const change = () => ['select', 'change']
const provider = (p, onboarding = false) => ['select', p, menu => assert.deepEqual(menu.options.map(o => o.value), ['jev', 'laya', 'back', ...(onboarding ? [] : ['home'])])]

fresh()
await wizard([
  ['select', 'change', p => assert.deepEqual(p.options.map(o => o.value), ['change', 'home'])],
  provider('jev'), ['select', 'typesafe'], ['password', key], ['confirm', false],
])
assert(!existsSync(judgmentFilePath()), 'rejection writes nothing')
await wizard([change(), provider('jev'), ['select', 'vercel'], ['password', key], ['confirm', true]], { dryRun: true })
assert(!existsSync(judgmentFilePath()), 'dry-run writes nothing')
const gateway = await wizard([change(), provider('jev'), ['select', 'vercel'], ['password', key, p => assert(p.message.includes('Vercel'))], ['confirm', true]])
assert.equal(readJudgmentConfig().model, 'typesafe-ai/jev')
assert.equal(readJudgmentConfig().transport, 'vercel-evaluation')
assert(gateway.logs.some(s => s.includes('/v4/ai/evaluation-model')))
assert(!gateway.records.some(p => p.method === 'text'), 'official Gateway URL is fixed')
const before = readFileSync(judgmentFilePath(), 'utf8')
await wizard([['select', 'existing', p => assert.deepEqual(p.options.map(o => o.value), ['existing', 'change', 'home'])], ['select', 'profile:jev-vercel'], ['select', 'activate'], ['confirm', true]])
assert.equal(readFileSync(judgmentFilePath(), 'utf8'), before)

fresh()
saveJevConfig({ apiKey: key })
await wizard([['select', 'existing'], ['select', 'profile:legacy-jev'], ['select', 'activate'], ['confirm', true]])
assert.equal(readJudgmentConfig().profileId, 'legacy-jev', 'legacy config is selectable')
await wizard([change(), provider('jev'), ['select', 'vercel'], ['password', key, p => assert(p.validate(''), 'TypeSafe key must not be reused for Gateway')], ['confirm', true]])
assert.equal(Object.keys(readJudgmentProfiles().profiles).length, 2, 'old destination preserved')
await wizard([change(), provider('jev'), ['select', 'typesafe'], ['password', '', p => assert.equal(p.validate(''), undefined)], ['confirm', true]])
assert.equal(readJudgmentConfig().profileId, 'legacy-jev', 'same destination updates its existing profile')

fresh()
await wizard([change(), provider('laya'), ['text', 'http://localhost:8000/v1'], ['password', ''], ['confirm', true]], {}, 'zh-CN')
assert.equal(readJudgmentConfig().model, 'multilingual')
assert.equal(readJudgmentConfig().authMode, 'none')
assert.equal(readJudgmentConfig().apiKey, null)
assert.equal(readJudgmentConfig().capacityStatus, 'missing', 'simplification does not invent capacity evidence')
saveJudgmentProfile('custom-laya', laya)
await wizard([change(), provider('laya'), ['text', laya.baseUrl], ['password', ''], ['confirm', true]])
assert.equal(readJudgmentConfig().profileId, 'custom-laya')
assert.equal(readJudgmentConfig().model, 'english', 'existing model preserved')
assert.deepEqual(readJudgmentConfig().options, laya.options, 'existing budgets preserved')
await wizard([change(), provider('laya'), ['text', laya.baseUrl], ['password', '-'], ['confirm', true]])
assert.equal(readJudgmentConfig().authMode, 'none', 'optional stored key can be cleared')
await wizard([change(), provider('laya'), ['text', 'http://localhost:9000/v1'], ['password', '', p => assert(p.message.includes('optional'))], ['confirm', true]])
assert.equal(readJudgmentConfig().apiKey, null, 'new destination never inherits key')
assert.equal(readJudgmentConfig().profileId, 'laya-2', 'automatic names avoid collisions')

fresh()
const custom = await wizard([change(), provider('jev'), ['select', 'custom'], ['text', 'https://private.example/v1/', p => {
  assert(p.validate('https://ai-gateway.vercel.sh/v4/ai/evaluation-model'))
  assert(p.validate('https://user:secret@example.com/v1'))
  assert.equal(p.validate('https://private.example/v1/'), undefined)
}], ['password', key], ['confirm', true]])
assert(custom.logs.some(s => s.includes('https://private.example/v1/systemone')))
for (const steps of [
  [['select', cancel]],
  [change(), ['select', cancel]],
  [change(), provider('laya'), ['text', cancel]],
  [change(), provider('jev'), ['select', 'typesafe'], ['password', cancel]],
  [change(), provider('jev'), ['select', 'typesafe'], ['password', key], ['confirm', cancel]],
]) {
  const prior = readFileSync(judgmentFilePath(), 'utf8')
  const p = prompter(steps)
  await assert.rejects(withTuiContext(() => runJudgmentWizard(p.clack), { language: 'en', navigation: true }), TuiCancelled)
  p.done()
  assert.equal(readFileSync(judgmentFilePath(), 'utf8'), prior)
}

fresh()
for (const opts of [{ yes: true }, { skipKeys: true }, { skipJudgment: true }, { dryRun: true }]) {
  const p = prompter([])
  await runJudgmentStep(p.clack, opts)
  p.done()
  assert(!existsSync(judgmentFilePath()))
}
const skip = prompter([['confirm', false, p => assert.equal(p.initialValue, false)]])
await runJudgmentStep(skip.clack, {})
skip.done()
assert(!existsSync(judgmentFilePath()))
const onboarding = prompter([['confirm', true], change(), provider('jev', true), ['select', 'typesafe'], ['password', key], ['confirm', true]], { onboarding: true })
await runJudgmentStep(onboarding.clack, {})
onboarding.done()
assert.equal(readJudgmentConfig().provider, 'jev')
const onboardingBefore = readFileSync(judgmentFilePath(), 'utf8')
const onboardingBack = prompter([
  ['confirm', true],
  ['select', 'existing'], ['select', 'profile:jev'], ['select', 'back'], ['select', 'back'],
  change(), provider('jev', true), ['select', 'back'], ['select', 'back'],
  ['select', 'back'], ['confirm', false],
], { onboarding: true })
await withTuiContext(() => runJudgmentStep(onboardingBack.clack, {}), { language: 'zh-CN', navigation: true })
onboardingBack.done()
assert.equal(readFileSync(judgmentFilePath(), 'utf8'), onboardingBefore, 'onboarding backtracking never writes or activates a profile')
assert.equal(onboardingBack.records.at(-1).method, 'confirm', 'root Back returns to the optional judgment step, not main menu')
const navigationBefore = readFileSync(judgmentFilePath(), 'utf8')
for (const steps of [
  [['select', 'home']],
  [change(), ['select', 'home']],
  [change(), provider('jev'), ['select', 'home']],
  [change(), provider('jev'), ['select', 'back'], ['select', 'back'], ['select', 'home']],
  [['select', 'existing'], ['select', 'back'], ['select', 'home']],
  [['select', 'existing'], ['select', 'profile:jev'], ['select', 'back'], ['select', 'home']],
]) {
  const p = prompter(steps)
  await assert.rejects(withTuiContext(() => runJudgmentWizard(p.clack), { language: 'zh-CN', navigation: true }), TuiHome)
  p.done()
  assert.equal(readFileSync(judgmentFilePath(), 'utf8'), navigationBefore, 'back/home navigation is read-only')
}
// Existing disk IDs remain untouched, even when they match navigation values.
for (const id of ['home', 'back', 'existing', 'change']) {
  fresh()
  saveJudgmentProfile(id, jev)
  saveJudgmentProfile('other', laya)
  const rootMenu = ['select', 'existing']
  const profileMenu = ['select', `profile:${id}`, p => {
    assert(p.options.some(o => o.value === 'back'))
    assert(p.options.some(o => o.value === 'home'))
    assert(p.options.some(o => o.value === `profile:${id}`))
    assert.equal(p.initialValue, 'profile:other')
  }]
  await wizard([rootMenu, profileMenu, ['select', 'activate'], ['confirm', true]])
  assert.equal(readJudgmentConfig().profileId, id, `${id} is activated as a profile, never navigation`)
  const before = readFileSync(judgmentFilePath(), 'utf8')
  const selectCurrent = ['select', `profile:${id}`, p => assert.equal(p.initialValue, `profile:${id}`)]
  await wizard([rootMenu, selectCurrent, ['select', 'remove'], ['confirm', false]])
  assert.equal(readFileSync(judgmentFilePath(), 'utf8'), before)
  await wizard([rootMenu, selectCurrent, ['select', 'remove'], ['confirm', true]], { dryRun: true })
  assert.equal(readFileSync(judgmentFilePath(), 'utf8'), before)
  await wizard([rootMenu, selectCurrent, ['select', 'remove'], ['confirm', true]])
  assert(!Object.hasOwn(readJudgmentProfiles().profiles, id))
  assert(Object.hasOwn(readJudgmentProfiles().profiles, 'other'))
  assert.equal(readJudgmentConfig().ready, false, 'deleting active reserved-name profile still disables judgments')
}
console.log('ok: simplified judgment menus, collision-free profile IDs, explicit back/home navigation, legacy reuse, Gateway separation, key isolation, Laya defaults/preservation, cancellation and optional onboarding (offline)')
