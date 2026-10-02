#!/usr/bin/env node
import './isolate-tests.mjs'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, rmSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { runTui } from '../lib/installer/tui.mjs'
import { runDshSurfaceStep } from '../lib/installer/index.mjs'
import { CONFIG_KEY_NAMES } from '../lib/keys.mjs'
import {
  systemLanguage, readTuiLanguage, saveTuiLanguage, tuiSettingsPath,
  withTuiContext, t, TuiCancelled, integrationWarning, pluginUpgradeMessage, pluginUpgradeStatus,
} from '../lib/installer/i18n.mjs'
import { handleCancel } from '../lib/installer/ui.mjs'

const savedExit = process.exitCode
process.env.LC_ALL = 'en_US.UTF-8'
const root = join(process.env.HOME, 'tui-fixtures')
let fixtures = 0
function fresh() {
  process.env.SEARCH_BOOST_HOME = join(root, String(++fixtures))
  process.exitCode = undefined
}
const cancel = Symbol('fixture cancel')
const reply = (method, value, check) => ({ method, value, check })
async function scenario(steps, opts = {}) {
  const records = [], logs = []
  const clack = {
    intro: (text) => logs.push(text), outro: (text) => logs.push(text),
    note: (text, title) => logs.push(`${title}\n${text}`),
    cancel: () => { throw new Error('nested cancel must not terminate the TUI') },
    isCancel: (value) => value === cancel,
    log: Object.fromEntries(['info', 'error', 'warn', 'success'].map((kind) => [kind, (text) => {
      // An exhausted prompt queue must fail instead of spinning on the test error.
      if (!steps.length && text?.startsWith('unexpected prompt')) throw new Error(text)
      logs.push(`${kind}: ${text}`)
    }])),
    spinner: () => ({ start: (text) => logs.push(text), stop: (text) => logs.push(text) }),
  }
  for (const method of ['select', 'multiselect', 'confirm', 'text', 'password']) {
    clack[method] = async (options) => {
      assert.ok(steps.length, `unexpected prompt: ${method} ${options.message}`)
      const step = steps.shift()
      if (typeof step === 'string' || step === cancel) {
        assert.equal(method, 'select')
        records.push({ method, ...options })
        return step
      }
      assert.equal(method, step.method)
      records.push({ method, ...options })
      step.check?.(options)
      if (step.interrupt) process.stdin.emit('keypress', '\u0003', { name: 'c', ctrl: true })
      return step.value
    }
  }
  await runTui(opts, { clack })
  assert.equal(steps.length, 0, 'every planned action was reached')
  return { records, logs }
}

try {
  assert.equal(systemLanguage({ LC_ALL: 'zh_CN.UTF-8', LANG: 'en_US' }, 'en'), 'zh-CN')
  assert.equal(systemLanguage({ LC_MESSAGES: 'zh-TW', LANG: 'en' }, 'en'), 'zh-CN')
  assert.equal(systemLanguage({ LANG: 'en_GB.UTF-8' }, 'zh-CN'), 'en')
  assert.equal(systemLanguage({}, 'zh-Hans-CN'), 'zh-CN')
  assert.equal(systemLanguage({ LC_ALL: 'C' }, 'zh-CN'), 'en')
  fresh()
  assert.equal(readTuiLanguage(), 'en')
  assert(!existsSync(tuiSettingsPath()), 'reading the default never writes settings')
  saveTuiLanguage('zh-CN')
  assert.equal(readTuiLanguage(), 'zh-CN')
  const persisted = execFileSync(process.execPath, ['--input-type=module', '-e', `
    import { readTuiLanguage } from ${JSON.stringify(new URL('../lib/installer/i18n.mjs', import.meta.url).href)};
    console.log(readTuiLanguage());
  `], { env: process.env, encoding: 'utf8' }).trim()
  assert.equal(persisted, 'zh-CN', 'a new process retains the selected language')
  writeFileSync(tuiSettingsPath(), JSON.stringify({ language: 'zh-CN', future: { keep: true } }))
  saveTuiLanguage('en')
  assert.deepEqual(JSON.parse(readFileSync(tuiSettingsPath(), 'utf8')), { language: 'en', future: { keep: true } })
  assert.throws(() => saveTuiLanguage('de'), /Unsupported/)
  for (const invalid of ['{broken', '{"language":"de"}', '[]']) {
    writeFileSync(tuiSettingsPath(), invalid)
    assert.throws(() => readTuiLanguage())
    assert.throws(() => saveTuiLanguage('en'))
    assert.equal(readFileSync(tuiSettingsPath(), 'utf8'), invalid, 'invalid settings are not silently overwritten')
  }
  const warnings = []
  const originalWarn = console.warn
  console.warn = (text) => warnings.push(text)
  try {
    await withTuiContext(() => assert.equal(t('English', '中文'), 'English'))
    assert(warnings.some((text) => text.includes('Could not read TUI settings')), 'standalone interactive commands warn and continue with system language')
    assert.equal(readFileSync(tuiSettingsPath(), 'utf8'), '[]', 'fallback does not overwrite corrupt settings')
  } finally { console.warn = originalWarn }
  fresh()
  assert.equal(t('English', '中文'), 'English')
  await Promise.all([
    withTuiContext(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); assert.equal(t('English', '中文'), '中文') }, { language: 'zh-CN' }),
    withTuiContext(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); assert.equal(t('English', '中文'), 'English') }, { language: 'en' }),
  ])
  assert.equal(t('English', '中文'), 'English', 'language contexts do not leak into CLI output')
  console.log('ok: system language, persistence, validation, unknown-field preservation and context isolation')

  fresh()
  let out = await scenario(['integration', 'back', 'search-tools', 'back', 'credentials', 'back', 'maintenance', 'back', 'settings', 'back', 'exit'])
  assert.deepEqual(out.records[0].options.map((o) => o.value), ['integration', 'search-tools', 'credentials', 'maintenance', 'settings', 'exit'])
  const expected = [
    ['setup', 'install', 'search', 'print', 'uninstall', 'back'],
    ['layer', 'tools', 'back'], ['keys', 'x', 'jev', 'back'], ['upgrade', 'status', 'back'], ['language', 'back'],
  ]
  expected.forEach((values, index) => assert.deepEqual(out.records[index * 2 + 1].options.map((o) => o.value), values))
  assert(!existsSync(process.env.SEARCH_BOOST_HOME), 'browsing menus is read-only')

  fresh()
  out = await scenario(['settings', 'language', 'zh-CN', 'back', 'search-tools', 'layer', 'free', 'back', 'exit'])
  assert.equal(out.records[3].message, 'TUI 设置', 'switch applies before the next menu')
  assert.equal(out.records[4].options[0].label, '安装与接入')
  assert.equal(out.records[6].message, '默认搜索层？')
  assert(out.records[6].options[0].label.includes('无需 Key'))
  assert(out.logs.some((line) => line.includes('搜索层已设为 free')))
  assert.equal(readTuiLanguage(), 'zh-CN')
  out = await scenario(['settings', 'language', 'en', 'back', 'exit'])
  assert.equal(out.records[0].options[4].label, 'TUI 设置', 'restart follows saved language')
  assert.equal(out.records[3].message, 'TUI settings')
  assert.equal(readTuiLanguage(), 'en')
  console.log('ok: every existing action is grouped exactly once; language changes immediately and survives restart')

  fresh()
  out = await scenario(['search-tools', 'layer', cancel, 'back', 'credentials', 'x', cancel, 'jev', cancel, 'keys', cancel, 'back', 'integration', 'print', cancel, 'install', reply('multiselect', cancel), 'back', 'exit'])
  assert.equal(out.records[3].message, 'Search & tools')
  assert.equal(out.records[7].message, 'Services & credentials')
  assert.equal(out.records[15].message, 'Installation & integrations')
  assert(!existsSync(process.env.SEARCH_BOOST_HOME), 'cancelled wizards do not write configuration')
  out = await scenario(['integration', cancel, 'exit'])
  assert.equal(out.records[2].message, 'What do you want to do?', 'submenu Escape returns home')
  out = await scenario([cancel])
  assert(out.logs.includes('Done.'), 'home Escape exits')
  out = await scenario(['search-tools', 'tools', { method: 'multiselect', value: cancel, interrupt: true }])
  assert(out.logs.includes('Done.'), 'Ctrl+C exits even inside a wizard with its own catch')
  assert.equal(process.stdin.listenerCount('keypress'), 0, 'prompt listeners are cleaned up')
  out = await scenario(['search-tools', { method: 'select', value: 'layer', interrupt: true }, cancel, 'back', 'exit'])
  assert.equal(out.records[3].message, 'Search & tools', 'a stray Ctrl+C in a resolved prompt cannot poison a later Escape')
  out = await scenario(['integration', 'install', reply('multiselect', ['codex']), reply('confirm', cancel), 'back', 'exit'])
  assert(!existsSync(process.env.SEARCH_BOOST_HOME), 'cancelling later install-only choices cannot initialize a layer')
  await withTuiContext(() => assert.throws(() => handleCancel(cancel, { isCancel: (v) => v === cancel }), TuiCancelled), { language: 'en', navigation: true })
  console.log('ok: nested Escape returns to its submenu, submenu Escape returns home, Ctrl+C exits and listeners are cleaned up')

  fresh()
  out = await scenario(['settings', 'language', 'zh-CN', 'back', 'search-tools', 'layer', 'api', 'tools', reply('multiselect', []), reply('confirm', true, (options) => {
    assert.equal(options.active, '是'); assert.equal(options.inactive, '否')
  }), 'back', 'integration', 'setup', 'free', reply('multiselect', []), 'install', reply('multiselect', []), 'uninstall', reply('multiselect', []), 'search', reply('multiselect', []), 'back', 'credentials', 'x', 'set-key', reply('password', 'xai-dry-run-sentinel', (options) => {
    assert.equal(options.validate('bad'), '必须以 xai- 开头（可在 console.x.ai 获取）。')
  }), 'jev', 'set', reply('text', 'https://api.typesafe.ai/v1'), reply('password', 'jev-dry-run-sentinel'), 'back', 'exit'], { dryRun: true })
  assert(!existsSync(process.env.SEARCH_BOOST_HOME), 'dry-run remains entirely read-only, including language preference')
  assert(out.logs.some((line) => line.includes('仅预览显示语言')))
  assert(out.logs.some((line) => line.includes('Jev（实验性）')))
  assert(!out.logs.some((line) => line.includes('dry-run-sentinel')), 'entered secrets never appear in logs')
  assert.equal(readTuiLanguage(), 'en', 'dry-run language preview is session-only')
  console.log('ok: dry-run previews language and runs localized tools/setup/install/uninstall/native search/X/Jev without writes')

  fresh()
  saveTuiLanguage('zh-CN')
  const keepKeys = CONFIG_KEY_NAMES.map(() => 'keep')
  out = await scenario(['credentials', 'keys', ...keepKeys, 'x', 'keep', 'jev', 'keep', 'back', 'maintenance', 'status', 'back', 'exit'])
  assert(out.logs.some((line) => line.includes('API 引擎池') || line.includes('API Keys')))
  assert(out.logs.some((line) => line.includes('X 凭据（x_search）')))
  assert(out.logs.some((line) => line.includes('搜索层：')))
  assert(out.logs.some((line) => line.includes('已管理 / 旧版接入')))
  assert(!out.logs.some((line) => /no credentials|not set|not configured/.test(line)), 'owned status text is localized')
  const cli = execFileSync(process.execPath, [fileURLToPath(new URL('../cli.mjs', import.meta.url)), 'status'], { env: process.env, encoding: 'utf8' })
  assert(cli.includes('Layer:'), 'saved TUI language does not change non-interactive CLI output')

  for (const language of ['en', 'zh-CN']) {
    saveTuiLanguage(language)
    const setup = execFileSync(process.execPath, [fileURLToPath(new URL('../cli.mjs', import.meta.url)), 'setup', '--yes', '--target', 'cursor', '--dry-run'], { env: { ...process.env, LC_ALL: 'zh_CN.UTF-8' }, encoding: 'utf8' })
    assert(setup.includes('Dry run complete'), 'setup --yes stays English regardless of saved/system language')
    assert(!setup.includes('安装') && !setup.includes('完成'))
  }

  const dshMenus = []
  await withTuiContext(async () => {
    assert.equal(await runDshSurfaceStep({ log: { info() {} }, select: async (menu) => { dshMenus.push(menu); return 'desktop' }, isCancel: () => false }, ['dsh'], {}, { desktopStatus: () => ({ detected: true }) }), 'desktop')
  }, { language: 'zh-CN' })
  await withTuiContext(() => {
    assert.equal(integrationWarning('Recorded project unavailable: /tmp/my project'), '已记录的项目不可用：/tmp/my project')
    assert.equal(integrationWarning('Codex: raw upstream failure'), 'Codex: raw upstream failure')
    assert.equal(pluginUpgradeStatus('disabled'), '已停用')
    assert.equal(pluginUpgradeMessage('Grok plugin is disabled; registration left unchanged, not re-enabled.'), 'Grok 插件已停用，保留原注册，不重新启用。')
    assert.equal(pluginUpgradeMessage('raw upstream failure'), 'raw upstream failure')
  }, { language: 'zh-CN' })
  assert(dshMenus[0].message.includes('安装'))
  assert.deepEqual(dshMenus[0].options.map((o) => o.value), ['desktop', 'cli', 'all'], 'display translation does not alter DSH surface values')
  console.log('ok: credentials/status/DSH prompts are translated; CLI, tool names, commands and configuration values remain unchanged')

  fresh()
  mkdirSync(join(process.env.SEARCH_BOOST_HOME, 'config'), { recursive: true })
  writeFileSync(tuiSettingsPath(), '{broken')
  out = await scenario(['settings', 'language', 'zh-CN', 'back', 'exit'])
  assert(out.logs.some((line) => line.includes('Could not read TUI settings')))
  assert(out.logs.some((line) => line.includes('Operation failed:')))
  assert.equal(readFileSync(tuiSettingsPath(), 'utf8'), '{broken')
  assert.equal(out.records[3].message, 'TUI settings', 'failed save does not change the current language')
  fresh()
  saveTuiLanguage('en')
  writeFileSync(`${tuiSettingsPath()}.lock`, 'another writer')
  assert.throws(() => saveTuiLanguage('zh-CN'), /another writer/)
  assert.equal(readTuiLanguage(), 'en')
  rmSync(`${tuiSettingsPath()}.lock`)
  if (process.platform !== 'win32') {
    const target = join(process.env.SEARCH_BOOST_HOME, 'target.json')
    writeFileSync(target, '{"language":"en"}')
    rmSync(tuiSettingsPath())
    symlinkSync(target, tuiSettingsPath())
    assert.throws(() => saveTuiLanguage('zh-CN'), /symlink/)
    assert.equal(readFileSync(target, 'utf8'), '{"language":"en"}')
  }
  const leftovers = readdirSync(join(process.env.SEARCH_BOOST_HOME, 'config'))
  assert(!leftovers.some((name) => name.endsWith('.tmp') || name.endsWith('.lock')))
  console.log('ok: corrupt settings, concurrent writers and symlink targets are preserved rather than overwritten')
} finally {
  process.exitCode = savedExit
}
