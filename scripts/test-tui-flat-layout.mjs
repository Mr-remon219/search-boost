#!/usr/bin/env node
import './isolate-tests.mjs'
/**
 * BUG-004 regressions: flat home by default, optional folder layout in TUI
 * settings (layout before language), engine-first credential configuration and
 * an Update entry that previews its scope and waits for an explicit start.
 *
 * Menus are driven through runTui / runEngineConfigTui with an injected clack and
 * dispatch the real modules (only Update is injected), so a registered but dead
 * menu entry cannot pass this file.
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { runTui } from '../lib/installer/tui.mjs'
import { engineCredentialRows, runEngineConfigTui } from '../lib/installer/keys-wizard.mjs'
import {
  DEFAULT_TUI_LAYOUT, readTuiLanguage, readTuiLayout, readTuiSettings,
  saveTuiLanguage, saveTuiLayout, tuiSettingsPath, withTuiContext,
} from '../lib/installer/i18n.mjs'
import {
  CONFIG_KEY_NAMES, KEY_NAMES, keyStatus, keysFilePath, readEngineBaseUrls,
  readEngineRouting, writeKeysFile,
} from '../lib/keys.mjs'
import { ENGINE_BASE_URLS } from '../lib/engine-endpoints.mjs'

const savedExit = process.exitCode
process.env.LC_ALL = 'en_US.UTF-8'
const root = join(process.env.HOME, 'tui-flat-fixtures')
let fixtures = 0
function fresh() {
  process.env.SEARCH_BOOST_HOME = join(root, String(++fixtures))
  process.exitCode = undefined
}
const cancel = Symbol('fixture cancel')
const reply = (method, value, check) => ({ method, value, check })

/** Flat home order approved for BUG-004. */
const FLAT_VALUES = ['setup', 'install', 'upgrade', 'status', 'keys', 'layer', 'tools', 'x', 'jev', 'search', 'print', 'uninstall', 'settings', 'exit']
const FOLDER_HOME = ['integration', 'search-tools', 'credentials', 'maintenance', 'settings', 'exit']
const CATEGORY_VALUES = ['integration', 'search-tools', 'credentials', 'maintenance']
const SECTIONS = {
  integration: ['setup', 'install', 'search', 'print', 'uninstall', 'back'],
  'search-tools': ['layer', 'tools', 'back'],
  credentials: ['keys', 'x', 'jev', 'back'],
  maintenance: ['upgrade', 'status', 'back'],
  settings: ['layout', 'language', 'back'],
}
// Both layouts must reach exactly the same operations (the folder layout only adds categories).
assert.deepEqual(
  Object.values(SECTIONS).flat().filter((value) => value !== 'back' && value !== 'layout' && value !== 'language').sort(),
  FLAT_VALUES.filter((value) => value !== 'settings' && value !== 'exit').sort(),
  'the two layouts expose the same action set',
)

function fakeClack(steps, records, logs) {
  const clack = {
    intro: (text) => logs.push(text), outro: (text) => logs.push(text),
    note: (text, title) => logs.push(`${title}\n${text}`),
    spinner: () => ({ start: (text) => logs.push(text), stop: (text) => logs.push(text) }),
    cancel: () => { throw new Error('nested cancel must not terminate the TUI') },
    isCancel: (value) => value === cancel,
    log: Object.fromEntries(['info', 'error', 'warn', 'success'].map((kind) => [kind, (text) => {
      logs.push(`${kind}: ${text}`)
    }])),
  }
  for (const method of ['select', 'multiselect', 'confirm', 'text', 'password']) {
    clack[method] = async (options) => {
      assert.ok(steps.length, `unexpected prompt: ${method} ${options.message}`)
      const step = steps.shift()
      if (step === cancel) { records.push({ method, ...options }); return step }
      if (typeof step === 'string') {
        assert.equal(method, 'select', `planned "${step}" but the real flow asked: ${method} ${options.message}`)
        records.push({ method, ...options })
        return step
      }
      assert.equal(method, step.method, `planned ${step.method} but the real flow asked: ${method} ${options.message}`)
      records.push({ method, ...options })
      step.check?.(options)
      return step.value
    }
  }
  return clack
}

async function runScenario(steps, opts = {}) {
  const records = [], logs = [], printed = [], updates = []
  const clack = fakeClack(steps, records, logs)
  const original = console.log
  console.log = (...args) => { printed.push(args.join(' ')) }
  try {
    await runTui(opts, { clack, update: async (updateOpts) => { updates.push(updateOpts); return { ok: true, reloaded: false } } })
  } finally { console.log = original }
  assert.equal(steps.length, 0, 'every planned action was reached')
  assert.equal(process.stdin.listenerCount('keypress'), 0, 'prompt listeners are cleaned up')
  return { records, logs, printed, updates }
}

/** Drive the engine configuration entry the way the TUI does: inside a navigation context. */
async function engineScenario(steps, { dryRun = false } = {}) {
  const records = [], logs = []
  const clack = fakeClack(steps, records, logs)
  await withTuiContext(() => runEngineConfigTui(clack, { dryRun }), { language: 'en', layout: 'flat', navigation: true })
  assert.equal(steps.length, 0, 'every planned engine step was reached')
  return { records, logs }
}

const keysDoc = () => JSON.parse(readFileSync(keysFilePath(), 'utf8'))
const homeMenus = (records) => records.filter((r) => r.message === 'What do you want to do?')

try {
  // ---------------------------------------------------------------------------
  // Layout preference storage
  // ---------------------------------------------------------------------------
  fresh()
  assert.equal(DEFAULT_TUI_LAYOUT, 'flat')
  assert.equal(readTuiLayout(), 'flat', 'no saved preference defaults to the flat layout')
  assert.deepEqual(readTuiSettings(), { language: 'en', layout: 'flat' })
  assert(!existsSync(tuiSettingsPath()), 'reading the default layout never writes settings')
  saveTuiLayout('folder')
  assert.equal(readTuiLayout(), 'folder')
  const persisted = execFileSync(process.execPath, ['--input-type=module', '-e', `
    import { readTuiSettings } from ${JSON.stringify(new URL('../lib/installer/i18n.mjs', import.meta.url).href)};
    console.log(JSON.stringify(readTuiSettings()));
  `], { env: process.env, encoding: 'utf8' }).trim()
  assert.deepEqual(JSON.parse(persisted), { language: 'en', layout: 'folder' }, 'a new process keeps the saved layout')

  const fixtureHome = process.env.SEARCH_BOOST_HOME
  mkdirSync(join(fixtureHome, 'config'), { recursive: true })
  writeFileSync(tuiSettingsPath(), JSON.stringify({ language: 'zh-CN' }))
  assert.equal(readTuiLayout(), 'flat', 'a legacy language-only config gets the flat default')
  assert.equal(readTuiLanguage(), 'zh-CN', 'the legacy language preference is preserved')
  writeFileSync(tuiSettingsPath(), JSON.stringify({ language: 'en', layout: 'flat', future: { keep: true } }))
  saveTuiLayout('folder')
  assert.deepEqual(JSON.parse(readFileSync(tuiSettingsPath(), 'utf8')), { language: 'en', layout: 'folder', future: { keep: true } })
  saveTuiLanguage('zh-CN')
  assert.deepEqual(
    JSON.parse(readFileSync(tuiSettingsPath(), 'utf8')),
    { language: 'zh-CN', layout: 'folder', future: { keep: true } },
    'layout and language share one store without dropping other fields',
  )
  assert.throws(() => saveTuiLayout('grid'), /Unsupported/)
  for (const invalid of ['{"layout":"grid"}', '{broken', '[]']) {
    writeFileSync(tuiSettingsPath(), invalid)
    assert.throws(() => readTuiLayout())
    assert.throws(() => saveTuiLayout('flat'))
    assert.equal(readFileSync(tuiSettingsPath(), 'utf8'), invalid, 'invalid settings are not silently overwritten')
  }
  writeFileSync(tuiSettingsPath(), JSON.stringify({ language: 'en', layout: 'flat' }))
  writeFileSync(`${tuiSettingsPath()}.lock`, 'another writer')
  assert.throws(() => saveTuiLayout('folder'), /another writer/)
  assert.equal(readTuiLayout(), 'flat')
  rmSync(`${tuiSettingsPath()}.lock`)
  if (process.platform !== 'win32') {
    const target = join(fixtureHome, 'layout-target.json')
    writeFileSync(target, JSON.stringify({ language: 'en' }))
    rmSync(tuiSettingsPath())
    symlinkSync(target, tuiSettingsPath())
    assert.throws(() => saveTuiLayout('folder'), /symlink/)
    assert.equal(JSON.parse(readFileSync(target, 'utf8')).layout, undefined, 'a symlinked settings file is never replaced')
  }
  console.log('ok: flat is the default, the layout preference persists atomically under lock and preserves other fields')

  // ---------------------------------------------------------------------------
  // Flat home order and the real operation behind every entry
  // ---------------------------------------------------------------------------
  fresh()
  const walk = await runScenario([
    'setup', 'free', reply('multiselect', []),
    'install', reply('multiselect', []),
    'upgrade', reply('select', 'back'),
    'status',
    'keys', 'back',
    'layer', 'free',
    'tools', reply('multiselect', []), reply('confirm', false),
    'x', 'keep',
    'jev', 'keep',
    'search', reply('multiselect', []),
    'print', 'cursor', reply('confirm', false), reply('confirm', true),
    'uninstall', reply('multiselect', []),
    'settings', 'back',
    'exit',
  ], { dryRun: true })
  const homes = homeMenus(walk.records)
  assert.deepEqual(homes[0].options.map((o) => o.value), FLAT_VALUES, 'flat home lists the approved order')
  assert(!homes[0].options.some((o) => CATEGORY_VALUES.includes(o.value)), 'the flat home never inserts category rows')
  assert(homes[0].options.every((o) => o.label && !/^\s*$/.test(o.label)), 'no blank spacer row occupies a selection')
  assert.deepEqual(
    homes.map((h) => h.initialValue),
    [undefined, 'setup', 'install', 'upgrade', 'status', 'keys', 'layer', 'tools', 'x', 'jev', 'search', 'print', 'uninstall', 'settings'],
    'a completed flat operation returns to the home menu with its entry selected',
  )
  assert(walk.logs.some((l) => l.includes('dry-run: would offer API key setup')), 'Setup still offers the credential step')
  assert(walk.logs.some((l) => l.includes('Skipped API keys, layer, and X credentials (install-only)')), 'Install keeps the install-only scope')
  assert(walk.logs.some((l) => l.includes('Update scope')), 'Update shows a scope preview')
  assert(walk.logs.some((l) => l.includes('Update cancelled; nothing was changed')), 'Update waits for an explicit start')
  assert.equal(walk.updates.length, 0, 'backing out of the Update preview changes nothing')
  assert(walk.logs.some((l) => l.startsWith('Status\n') && l.includes('Agents')), 'Status prints the real read-only status')
  const engineMenu = walk.records.find((r) => r.message === 'Engine configuration')
  assert.deepEqual(engineMenu.options.map((o) => o.value), [...CONFIG_KEY_NAMES, 'routing', 'back'], 'the engine entry lists every credential slot plus routing')
  assert.equal(walk.records.find((r) => r.message === 'Default search layer?').options.map((o) => o.value).join(','), 'free,api')
  const toolsNote = walk.logs.find((l) => l.includes('Tool switches — shared by MCP / Pi / DSH'))
  assert(toolsNote && toolsNote.includes('fused_search'), 'Tool switches is the real wizard with real tool names')
  assert.equal(walk.records.find((r) => r.message === 'X credentials').options.map((o) => o.value).join(','), 'keep,import-grok,set-key,remove')
  assert.equal(walk.records.find((r) => r.message === 'Jev credentials (experimental)').options.map((o) => o.value).join(','), 'keep,set,remove')
  assert(walk.logs.some((l) => l.includes('Built-in web search')), 'Native web search prints the real per-agent state')
  assert(walk.printed.some((line) => line.includes('search-boost') && line.includes('mcpServers')), 'Print MCP snippet writes a real snippet')
  const targetPrompts = walk.records.filter((r) => r.message === 'Which agents should search-boost configure?')
  assert.equal(targetPrompts.length, 3, 'Setup, Install and Uninstall each reach the real target selection')
  assert(targetPrompts[0].options.some((o) => o.value === 'cursor') && targetPrompts[0].options.some((o) => o.value === 'dsh'))
  assert(!existsSync(process.env.SEARCH_BOOST_HOME), 'the whole dry-run walk stays read-only')

  const uninstallRun = await runScenario(['uninstall', reply('multiselect', ['cursor']), 'exit'], { dryRun: true })
  assert(uninstallRun.logs.some((l) => l.includes('uninstall…')), 'Uninstall dispatches the uninstall verb, not install')
  assert(uninstallRun.logs.some((l) => l.includes('Cursor IDE: uninstalled')))
  assert(uninstallRun.logs.some((l) => l.includes('Dry run complete')))
  assert(!uninstallRun.logs.some((l) => l.includes('Skipped API keys')), 'Uninstall does not run the install credential steps')

  const englishHome = await runScenario(['exit'])
  assert.deepEqual(englishHome.records[0].options.map((o) => o.label), [
    'Setup wizard', 'Install / refresh agent integrations', 'Update SearchBoost', 'Status',
    'Search engine configuration', 'Default search layer', 'Tool switches', 'X credentials',
    'Jev configuration (experimental)', 'Native web search', 'Print MCP snippet',
    'Uninstall agent integrations', 'TUI settings', 'Exit',
  ])
  saveTuiLanguage('zh-CN')
  const zhHome = await runScenario(['exit'])
  assert.deepEqual(zhHome.records[0].options.map((o) => o.label), [
    '首次配置向导', '安装 / 刷新 Agent 接入', '更新 SearchBoost', '查看当前状态', '搜索引擎配置',
    '默认搜索层', '工具开关', 'X 凭据', 'Jev 配置', '原生搜索替换', '输出 MCP 配置片段',
    '卸载 Agent 接入', 'TUI 设置', '退出',
  ])
  assert.equal(zhHome.records[0].message, '请选择操作')
  console.log('ok: flat home order, localized labels and every entry dispatch the real operation')

  // ---------------------------------------------------------------------------
  // Layout switch in TUI settings (layout before language) and folder navigation
  // ---------------------------------------------------------------------------
  fresh()
  const settings = await runScenario(['settings', 'back', 'exit'])
  assert.equal(settings.records[1].message, 'TUI settings')
  assert.deepEqual(settings.records[1].options.map((o) => o.value), ['layout', 'language', 'back'], 'layout comes before language')
  assert.equal(settings.records[1].options[0].hint, 'Flat')
  const optedOut = await runScenario(['settings', 'layout', 'back', 'back', 'exit'])
  assert.equal(optedOut.records[2].message, 'Main menu layout')
  assert.deepEqual(optedOut.records[2].options.map((o) => o.value), ['flat', 'folder', 'back'])
  assert.equal(readTuiLayout(), 'flat', 'backing out of the layout chooser saves nothing')
  assert(!existsSync(tuiSettingsPath()))

  const switched = await runScenario(['settings', 'layout', 'folder', 'exit'])
  assert.equal(switched.records[2].initialValue, 'flat', 'the chooser starts on the saved layout')
  assert.deepEqual(switched.records[3].options.map((o) => o.value), FOLDER_HOME, 'the new layout shows immediately')
  assert.equal(switched.records[3].initialValue, 'settings', 'the switch returns to the new home with TUI settings selected')
  assert.equal(readTuiLayout(), 'folder')
  assert.equal(switched.logs.filter((l) => l.includes('Menu layout saved')).length, 1)

  const restarted = await runScenario(['exit'])
  assert.deepEqual(restarted.records[0].options.map((o) => o.value), FOLDER_HOME, 'a restart follows the saved layout')
  for (const [section, values] of Object.entries(SECTIONS)) {
    const folderWalk = await runScenario([section, 'back', 'exit'])
    assert.deepEqual(folderWalk.records[1].options.map((o) => o.value), values, `folder section ${section}`)
  }
  const folderOps = await runScenario(['search-tools', 'layer', 'free', 'back', 'credentials', 'keys', 'back', 'back', 'exit'])
  assert.equal(folderOps.records[3].message, 'Search & tools', 'a completed folder operation stays in its section')
  assert.equal(folderOps.records[3].initialValue, 'layer', 'and keeps its entry selected')
  assert.equal(folderOps.records[7].message, 'Services & credentials', 'the engine entry returns to its section')
  assert.equal(folderOps.records[7].initialValue, 'keys')
  assert.equal(folderOps.records[8].message, 'What do you want to do?', 'Esc in a section returns home')
  assert.equal(folderOps.records[8].initialValue, 'credentials')
  const folderUpdate = await runScenario(['maintenance', 'upgrade', reply('select', 'back'), 'back', 'exit'], { dryRun: true })
  assert.equal(folderUpdate.records[2].options.map((o) => o.value).join(','), 'start,back')
  assert.equal(folderUpdate.updates.length, 0)
  assert.equal(folderUpdate.records[3].message, 'Update & status', 'cancelling Update returns to its section')

  fresh()
  saveTuiLayout('folder')
  const drySwitch = await runScenario(['settings', 'layout', 'flat', 'exit'], { dryRun: true })
  assert.equal(readTuiLayout(), 'folder', 'dry-run previews the layout without saving it')
  assert(drySwitch.logs.some((l) => l.includes('layout preview only')))
  assert.deepEqual(drySwitch.records[3].options.map((o) => o.value), FLAT_VALUES, 'the preview switches the session to the new home immediately')
  console.log('ok: layout lives before language in TUI settings, switches immediately and folder mode keeps its sections')

  // ---------------------------------------------------------------------------
  // Engine configuration: pick any engine, then key / base URL / routing
  // ---------------------------------------------------------------------------
  fresh()
  writeKeysFile({ tavily: 'tvly-fixture-key-12345678', enabledEngines: ['tavily'], jev: { apiKey: 'jev-fixture-key' } })
  const engineList = await engineScenario(['exa', 'back', 'back'])
  assert.equal(engineList.records[0].message, 'Engine configuration')
  assert.deepEqual(engineList.records[0].options.map((o) => o.value), [...CONFIG_KEY_NAMES, 'routing', 'back'])
  const tavilyHint = engineList.records[0].options.find((o) => o.value === 'tavily').hint
  assert.match(tavilyHint, /^file \S*\*{4}\S* · enabled$/)
  assert(!tavilyHint.includes('tvly-fixture-key-12345678'), 'the engine list never shows a raw credential')
  assert.match(tavilyHint, /enabled/)
  assert.equal(engineList.records[1].message.startsWith('exa'), true, 'any engine opens directly, without walking the others first')
  assert.deepEqual(engineList.records[1].options.map((o) => o.value), ['set', 'url', 'reset-url', 'back'])
  assert.equal(engineList.records.length, 3, 'the engine menu returns to the engine list, not home')

  await engineScenario(['exa', 'url', reply('text', 'https://tui.example/exa/', (options) => {
    assert.match(options.validate('ftp://bad.example'), /Base URL/)
    assert.equal(options.validate('https://tui.example/exa/'), undefined)
  }), 'back', 'back'])
  assert.equal(readEngineBaseUrls().exa, 'https://tui.example/exa')
  assert.equal(keysDoc().tavily, 'tvly-fixture-key-12345678')
  assert.deepEqual(keysDoc().enabledEngines, ['tavily'], 'setting a base URL never resets routing')
  assert.equal(keysDoc().jev.apiKey, 'jev-fixture-key')

  await engineScenario(['exa', 'set', reply('password', 'exa-fixture-key-87654321', (options) => {
    assert.match(options.validate('   '), /cannot be empty/)
  }), 'back', 'back'])
  assert.equal(keysDoc().exa, 'exa-fixture-key-87654321')
  assert.deepEqual(keysDoc().enabledEngines, ['tavily'], 'setting a key never resets routing')
  assert.equal(keysDoc().jev.apiKey, 'jev-fixture-key')

  await engineScenario(['exa', 'reset-url', 'back', 'back'])
  assert.equal(readEngineBaseUrls().exa, ENGINE_BASE_URLS.exa)

  const routingOpen = await engineScenario(['routing', reply('multiselect', ['tavily']), 'back'])
  const routingPrompt = routingOpen.records[1]
  assert.deepEqual(routingPrompt.options.map((o) => o.value), ['tavily', 'exa'], 'only configured runnable engines are selectable')
  assert.deepEqual(routingPrompt.initialValues, ['tavily'], 'the routing prompt starts from the current enablement')
  assert.equal(routingPrompt.options.some((o) => o.value === 'brave'), false, 'Clack 0.10 does not support disabled options: keyless engines must not be offered')
  const beforeInvalidRouting = readFileSync(keysFilePath(), 'utf8')
  await assert.rejects(engineScenario(['routing', reply('multiselect', ['brave']), 'back']), /configured engines/)
  assert.equal(readFileSync(keysFilePath(), 'utf8'), beforeInvalidRouting, 'a stale/injected keyless selection cannot write routing')
  assert(routingOpen.logs.some((l) => l.includes('unchanged')), 'confirming the same enablement is reported as unchanged')

  const routingChange = await engineScenario(['brave', 'set', reply('password', 'brave-fixture-key-123456'), 'back', 'routing', reply('multiselect', ['brave']), 'back'])
  assert.deepEqual(readEngineRouting().enabledEngines, ['brave'])
  assert(routingChange.logs.some((l) => l.includes('Enabled keyed engines: brave')))
  const afterRouting = readFileSync(keysFilePath(), 'utf8')
  await engineScenario(['routing', reply('multiselect', cancel), 'back'])
  assert.equal(readFileSync(keysFilePath(), 'utf8'), afterRouting, 'Esc in the routing prompt writes nothing')

  const beforeDry = readFileSync(keysFilePath(), 'utf8')
  const engineDry = await engineScenario(['exa', 'set', reply('password', 'exa-dry-run-key-123456'), 'back', 'back'], { dryRun: true })
  assert.equal(readFileSync(keysFilePath(), 'utf8'), beforeDry, 'dry-run engine edits write nothing')
  assert(engineDry.logs.some((l) => l.includes('dry-run')))

  await engineScenario(['exa', 'remove', 'back', 'back'])
  assert.equal(keysDoc().exa, undefined)
  assert.equal(keysDoc().tavily, 'tvly-fixture-key-12345678', 'removing one key keeps the others')
  assert.deepEqual(keysDoc().enabledEngines, ['brave'], 'removing a key never resets routing')
  assert.equal(keysDoc().jev.apiKey, 'jev-fixture-key')

  process.env.EXA_API_KEY = 'exa-env-fixture-key-12345678'
  const envEngine = await engineScenario(['exa', 'back', 'back'])
  assert.match(envEngine.records[0].options.find((o) => o.value === 'exa').hint, /from env/)
  assert.equal(envEngine.records[1].options.some((o) => o.value === 'remove'), false, 'an env-only key has nothing to remove from the file')
  const beforeEnvRemove = readFileSync(keysFilePath(), 'utf8')
  await engineScenario(['exa', 'remove', 'back', 'back'])
  assert.equal(readFileSync(keysFilePath(), 'utf8'), beforeEnvRemove, 'even a stale/injected remove cannot write an env-only key')
  delete process.env.EXA_API_KEY

  const escEngine = await engineScenario(['tavily', cancel, 'back'])
  assert.equal(escEngine.records[2].message, 'Engine configuration', 'Esc inside an engine steps back to the engine list')

  const pendingRows = engineCredentialRows({ pending: ['future-engine'], status: { ...keyStatus(), 'future-engine': { source: 'file', masked: '****cdef' } } })
  const pendingRow = pendingRows.find((row) => row.name === 'future-engine')
  assert.equal(pendingRow.storedOnly, true)
  assert.match(pendingRow.hint, /stored only/)
  assert.match(pendingRow.hint, /\*\*\*\*cdef/)
  assert.equal(KEY_NAMES.includes('future-engine'), false, 'a stored-only slot is never routable')
  assert.deepEqual(engineCredentialRows().map((row) => row.name), CONFIG_KEY_NAMES)
  assert(!engineCredentialRows().some((row) => row.storedOnly), 'no stored-only slot ships today; the rule is still enforced')
  console.log('ok: engine configuration is engine-first, writes only what changed and keeps stored-only slots unroutable')

  // ---------------------------------------------------------------------------
  // Setup keeps guiding the full initial configuration
  // ---------------------------------------------------------------------------
  fresh()
  writeKeysFile({ tavily: 'tvly-setup-fixture-key-1234', enabledEngines: ['tavily'], jev: { apiKey: 'jev-setup-key' } })
  const setup = await runScenario([
    'setup',
    reply('confirm', true),
    'keep', 'keep', 'keep', 'keep',
    reply('multiselect', ['tavily']),
    'free',
    reply('multiselect', []),
    'exit',
  ])
  assert(setup.records[1].message.includes('Configure API keys now?'), 'Setup asks before credentials')
  assert.deepEqual(
    setup.records.slice(2, 6).map((r) => r.message.match(/^(\w+)/)[1]),
    CONFIG_KEY_NAMES,
    'Setup still guides every credential slot',
  )
  assert(setup.records.some((r) => r.message === 'Default search layer?'), 'Setup still sets the search layer')
  assert.equal(setup.logs.filter((l) => l.includes('Skipped API keys')).length, 0, 'Setup does not skip credentials')
  assert(setup.logs.some((l) => l.includes('No agents selected')), 'Setup reached the agent selection step')
  assert.equal(keysDoc().tavily, 'tvly-setup-fixture-key-1234', 'Setup keeps existing credentials')
  assert.equal(keysDoc().jev.apiKey, 'jev-setup-key', 'Setup keeps unrelated stored credentials')
  assert.deepEqual(readEngineRouting().enabledEngines, ['tavily'], 'Setup does not reset existing routing')
  console.log('ok: Setup still walks credentials → layer → agents and preserves stored credentials and routing')
} finally {
  process.exitCode = savedExit
}
