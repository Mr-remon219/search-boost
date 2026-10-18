import './isolate-tests.mjs'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { engineRegistry } from '../lib/search/engines.js'
import { resolveSearchRoute } from '../lib/search/routing.js'
import { writeKeysFile, readKeysRouting, keysFilePath } from '../lib/keys.mjs'
import { runEngineConfigTui } from '../lib/installer/keys-wizard.mjs'
import { withTuiContext } from '../lib/installer/i18n.mjs'
import { ConsoleModel } from '../lib/console-tui.mjs'

// Normal automatic subsets are not broken configurations. Explicit selections
// retain the diagnostics promised to callers.
const engines = engineRegistry({ tavily: 'fixture-key' })
assert.deepEqual(resolveSearchRoute({ engines }).warnings, [])
assert.deepEqual(resolveSearchRoute({ engines }).enginesRequested, ['tavily'])
assert.ok(resolveSearchRoute({ engines, enginePool: 'api' }).warnings.some(w => w.startsWith('brave unavailable')))
assert.ok(resolveSearchRoute({ engines, engineList: ['brave'] }).warnings.some(w => w.startsWith('brave unavailable')))
assert.equal(resolveSearchRoute({ engines, engineList: ['brave'] }).engineNames.length, 0)

function seed() {
  writeKeysFile({ tavily: 'old-tavily-fixture', brave: 'keep-brave-fixture', enabledEngines: ['brave'], baseUrls: { brave: 'https://gateway.example/brave' } })
}
const bytes = () => readFileSync(keysFilePath(), 'utf8')
async function lightweight(language, steps, { dryRun = false, confirm = false } = {}) {
  const logs = [], menus = []
  const clack = {
    isCancel: () => false,
    select: async menu => {
      menus.push(menu)
      const step = steps.shift()
      assert.ok(menu.options.some(o => o.value === step), `action ${step} must be offered`)
      return step
    },
    password: async () => 'replacement-tavily-fixture',
    confirm: async menu => {
      assert.equal(menu.initialValue, false, 'exclusive use defaults to cancel')
      assert.match(menu.message, /Other APIs|其他 API/)
      return typeof confirm === 'function' ? confirm() : confirm
    },
    log: Object.fromEntries(['info', 'warn', 'success'].map(kind => [kind, text => logs.push(text)])),
  }
  await withTuiContext(() => runEngineConfigTui(clack, { dryRun }), { language })
  assert.equal(steps.length, 0)
  assert.ok(!logs.join('\n').includes('replacement-tavily-fixture'))
  return { logs, menus }
}
for (const language of ['en', 'zh-CN']) {
  seed()
  const saved = await lightweight(language, ['tavily', 'set', 'back', 'back'])
  assert.deepEqual(readKeysRouting().enabledNames, ['brave'], 'saving a key never expands a whitelist')
  assert.ok(saved.logs.some(text => /still disabled|尚未启用|未启用/.test(text)), 'saved-but-disabled state gives an actionable explanation')
  assert.ok(saved.menus.some(menu => /disabled|已停用/.test(menu.message)))
  const before = bytes()
  await lightweight(language, ['tavily', 'only', 'back', 'back'])
  assert.equal(bytes(), before, 'cancel exclusive mode changes nothing')
  await lightweight(language, ['tavily', 'only', 'back', 'back'], { dryRun: true, confirm: true })
  assert.equal(bytes(), before, 'exclusive preview changes nothing')
  await lightweight(language, ['tavily', 'only', 'back', 'back'], { confirm: true })
  let state = readKeysRouting()
  assert.deepEqual(state.enabledNames, ['tavily'])
  assert.equal(state.keys.brave, 'keep-brave-fixture')
  assert.equal(state.baseUrls.brave, 'https://gateway.example/brave')

  seed()
  const model = new ConsoleModel({ language })
  model.editKey('tavily')
  model.modal.onSubmit(['console-tavily-fixture'])
  await model.modal.options[1].run()
  assert.deepEqual(readKeysRouting().enabledNames, ['brave'])
  assert.match(model.notice, /still disabled|尚未启用/)
  assert.ok(!model.notice.includes('console-tavily-fixture'))
  const row = model.pages.engines.find(row => row.id === 'tavily')
  row.actions.find(action => action.id === 'only').run()
  assert.equal(model.modal.index, 0)
  assert.deepEqual(readKeysRouting().enabledNames, ['brave'], 'opening the action cannot switch engines')
  await model.modal.options[1].run()
  state = readKeysRouting()
  assert.deepEqual(state.enabledNames, ['tavily'])
  assert.equal(state.keys.brave, 'keep-brave-fixture')
  assert.equal(state.baseUrls.brave, 'https://gateway.example/brave')
  assert.equal(model.pages.search[0].status, 'API')
  const dry = new ConsoleModel({ language, dryRun: true })
  const snapshot = bytes()
  dry.useOnlyEngine('brave'); await dry.modal.options[1].run()
  assert.equal(bytes(), snapshot)
}
seed()
await assert.rejects(lightweight('en', ['tavily', 'only'], { confirm: () => {
  writeKeysFile({ brave: 'concurrent-brave-fixture' })
  return true
} }), /Configuration changed/)
assert.deepEqual(readKeysRouting().enabledNames, ['brave'], 'stale exclusive confirmation must not replace a newer selection')
const stale = new ConsoleModel({ language: 'en' })
stale.useOnlyEngine('tavily')
writeKeysFile({ brave: 'newer-brave-fixture' })
await assert.rejects(stale.modal.options[1].run(), /Configuration changed/)
assert.deepEqual(readKeysRouting().enabledNames, ['brave'])
console.log('Engine usability: quiet automatic subsets, explicit diagnostics, actionable key feedback, exclusive use, preservation, cancel, stale confirmation and dry-run passed in both languages/TUIs.')
