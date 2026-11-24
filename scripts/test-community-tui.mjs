#!/usr/bin/env node
import './isolate-tests.mjs'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { runTui } from '../lib/installer/tui.mjs'
import { saveTuiLanguage, saveTuiLayout } from '../lib/installer/i18n.mjs'
import {
  readCommunityConfig, communityConfigPath, manageCommunityBackend,
  planCommunityPlatformChange, applyCommunityPlatformPlan,
} from '../lib/community/config.mjs'
import { readPiAuth, piAuthPath, grokAuthFile } from '../lib/search/x/xauth.js'
import { saveToolPreferences } from '../lib/tool-config.mjs'

const root = join(process.env.HOME, 'community-tui-fixtures')
let counter = 0, network = 0
const savedFetch = globalThis.fetch, savedExit = process.exitCode
// UI and configuration validation must never run acquisition or probe a bridge.
globalThis.fetch = () => { network++; throw new Error('UI must not access the network') }
delete process.env.XAI_API_KEY
delete process.env.SEARCH_BOOST_BROWSER_TOKEN
const cancel = Symbol('cancel')
const reply = (method, value, check) => ({ method, value, check })
function fresh() {
  process.env.SEARCH_BOOST_HOME = join(root, String(++counter))
  process.exitCode = undefined
}
function bytes() { return existsSync(communityConfigPath()) ? readFileSync(communityConfigPath(), 'utf8') : null }
function rows(platform) { return readCommunityConfig().backends.filter(row => row.provider === 'existing-x' ? platform === 'x' : row.provider.startsWith(platform + '-')) }
async function scenario(steps, opts = {}) {
  const records = [], logs = []
  const clack = {
    intro: text => logs.push(text), outro: text => logs.push(text), note: (text, title) => logs.push(`${title}\n${text}`),
    log: Object.fromEntries(['info', 'warn', 'error', 'success'].map(kind => [kind, text => logs.push(text)])),
    isCancel: value => value === cancel,
  }
  for (const method of ['select', 'text', 'password', 'confirm']) clack[method] = async options => {
    assert(steps.length, `unexpected ${method}: ${options.message}`)
    const next = steps.shift(), step = typeof next === 'string' || next === cancel ? reply('select', next) : next
    assert.equal(step.method, method, `wrong prompt: ${options.message}`)
    records.push({ method, ...options })
    step.check?.(options)
    if (step.interrupt) process.stdin.emit('keypress', '\u0003', { name: 'c', ctrl: true })
    return step.value
  }
  await runTui(opts, { clack })
  assert.equal(steps.length, 0, `all actions dispatched; logs: ${logs.join('\n')}`)
  if (!opts.expectFailure) assert.notEqual(process.exitCode, 1, `no swallowed errors: ${logs.join('\n')}`)
  assert.equal(process.stdin.listenerCount('keypress'), 0)
  return { records, logs }
}
const page = (out, prefix) => out.records.filter(record => record.message.startsWith(prefix))
const close = ['back', 'back', 'exit']
try {
  for (const language of ['en', 'zh-CN']) {
    fresh(); saveTuiLanguage(language)
    const before = bytes()
    const out = await scenario(['community', 'reddit', 'back', 'x', 'back', 'bilibili', 'back', 'zhihu', 'back', 'xiaohongshu', 'back', 'back', 'exit'])
    const community = out.records[1]
    assert.deepEqual(community.options.map(row => row.value), ['reddit', 'x', 'bilibili', 'zhihu', 'xiaohongshu', 'browser-source', 'back'])
    assert(!out.records[0].options.some(row => row.value === 'x'))
    assert(!out.records.some(record => record.options?.some(row => ['show', 'check', 'advanced', 'help', 'credentials'].includes(row.value))), 'no duplicate view/check/credential menus')
    assert.deepEqual(out.records[4].options.map(row => row.value), ['set-key', 'disable', 'view', 'back'], 'X actions are direct; impossible import/removal options are absent')
    assert.equal(bytes(), before)
    assert.equal(out.records.at(-1).initialValue, 'community')
    assert(!out.logs.some(text => /provider|configuration-ready/.test(text)), 'internal implementation terms stay out of normal UI')
  }
  fresh()
  await scenario(['community', 'back', 'exit'])
  assert(!existsSync(process.env.SEARCH_BOOST_HOME), 'opening/closing an unconfigured UI creates no home or lock')
  console.log('ok: compact bilingual platform menus, real dispatch and read-only navigation')

  fresh(); saveTuiLayout('folder')
  const folder = await scenario(['credentials', 'community', 'reddit', 'back', 'back', 'back', 'exit'])
  assert.deepEqual(folder.records[1].options.map(row => row.value), ['keys', 'community', 'jev', 'back'])
  assert.equal(folder.records[5].initialValue, 'community')

  fresh()
  for (const answer of ['back', cancel]) {
    await scenario(['community', 'browser-source', answer, 'back', 'exit'])
    assert(!existsSync(process.env.SEARCH_BOOST_HOME), 'returning from browser choice creates no installation state')
  }
  const preview = await scenario(['community', 'bilibili', 'install', ...close], { dryRun: true })
  assert(!existsSync(process.env.SEARCH_BOOST_HOME), 'dry-run never downloads, launches a browser, creates configuration or locks')
  assert(!page(preview, 'Bilibili —')[0].options.some(row => row.value === 'source'), 'one free integration, no source selector')
  console.log('ok: both layouts, one free integration, explicit browser choice and dry-run')

  fresh()
  await scenario(['community', 'reddit', 'scopes', reply('text', 'r/Node， LocalLLaMA', options => {
    assert(options.validate('too-long-subreddit-name-over-limit'))
    assert(options.validate('a,b,c,d,e,f'))
    assert.equal(options.validate('node, LocalLLaMA'), undefined)
  }), ...close])
  assert.deepEqual(rows('reddit')[0].config.subreddits, ['node', 'localllama'])
  await scenario(['community', 'reddit', 'scopes', reply('text', ''), ...close])
  assert.deepEqual(rows('reddit')[0].config, {}, 'empty input restores automatic discovery')
  const beforeScopes = bytes()
  await scenario(['community', 'reddit', 'scopes', reply('text', cancel), ...close])
  assert.equal(bytes(), beforeScopes)
  console.log('ok: confirmation, dry-run, scope validation/clearing and form Escape')

  fresh()
  manageCommunityBackend({ action: 'register', id: 'reddit-extra', provider: 'reddit-arctic', config: { subreddits: ['node'] } })
  assert.equal(rows('reddit').filter(row => row.enabled).length, 2)
  await scenario(['community', 'reddit', 'disable', ...close])
  assert(rows('reddit').every(row => !row.enabled), 'platform Off disables all its instances')
  const enabled = await scenario(['community', 'reddit', 'enable', ...close])
  assert.deepEqual(rows('reddit').filter(row => row.enabled).map(row => row.id), ['reddit-default'])
  assert.deepEqual(rows('reddit').find(row => row.id === 'reddit-extra').config.subreddits, ['node'])
  assert(page(enabled, 'Reddit —').at(-1).options.some(row => row.value === 'scopes'))
  await scenario(['community', 'reddit', 'remove-instance', reply('confirm', true), ...close])
  assert.equal(rows('reddit').length, 1)
  assert.equal(rows('reddit')[0].enabled, true, 'deletion preserves the explicitly enabled built-in integration')
  assert.throws(() => planCommunityPlatformChange('reddit', { action: 'remove', id: 'reddit-default' }), /Cannot remove/)
  manageCommunityBackend({ action: 'register', id: 'reddit-one', provider: 'reddit-arctic', enabled: false, config: { subreddits: ['node'] } })
  manageCommunityBackend({ action: 'register', id: 'reddit-two', provider: 'reddit-web', enabled: false })
  const multiDelete = await scenario(['community', 'reddit', 'remove-instance', 'reddit-two', reply('confirm', true), ...close])
  assert(multiDelete.records.some(record => record.message === 'Delete which extra configuration?'), 'multiple extra configurations need an actual choice')
  assert(rows('reddit').some(row => row.id === 'reddit-one'))
  assert(!rows('reddit').some(row => row.id === 'reddit-two'))
  console.log('ok: all-instance disable, explicit re-enable, custom removal and retained built-ins')

  fresh()
  // Old bridge configuration remains readable/removable, but is no longer a second free option.
  manageCommunityBackend({ action: 'register', id: 'legacy-zhihu', provider: 'zhihu-browser', enabled: false, config: { endpoint: 'http://127.0.0.1:19826', token_env: 'SEARCH_BOOST_BROWSER_TOKEN' } })
  const legacy = await scenario(['community', 'zhihu', 'view', 'remove-instance', reply('confirm', true), ...close])
  assert(!page(legacy, 'Zhihu —')[0].options.some(row => ['source', 'browser'].includes(row.value)))
  assert(!rows('zhihu').some(row => row.id === 'legacy-zhihu'))
  assert(!existsSync(join(process.env.SEARCH_BOOST_HOME, 'config', 'community-browser-token')))
  console.log('ok: legacy configurations are preserved until explicitly removed; duplicate free source setup is hidden')

  fresh()
  const duringForm = await scenario(['community', 'reddit', 'scopes', reply('text', 'node', () => {
    manageCommunityBackend({ action: 'update', id: 'reddit-default', config: { subreddits: ['javascript'] } })
  }), ...close], { expectFailure: true })
  assert.deepEqual(rows('reddit')[0].config.subreddits, ['javascript'])
  assert(!duringForm.records.some(record => record.method === 'confirm'), 'a stale form cannot preview an overwrite')
  const forged = planCommunityPlatformChange('reddit', { action: 'disable' })
  forged.after.backends.find(row => row.id === 'x-default').enabled = false
  assert.throws(() => applyCommunityPlatformPlan(forged), /configuration changed/)
  assert.throws(() => planCommunityPlatformChange('reddit', { action: 'select', backend: { id: 'x-default', provider: 'reddit-arctic', enabled: true, config: {} } }), /replace/)
  console.log('ok: concurrent edits during forms/confirmation and modified transaction plans fail closed')

  fresh()
  const credentials = await scenario(['community', 'x', 'set-key', reply('password', 'xai-ui-secret-fixture'), 'remove-key', reply('confirm', false), ...close])
  assert.equal(readPiAuth().key, 'xai-ui-secret-fixture')
  assert(page(credentials, 'X —').at(-1).options.some(row => row.value === 'remove-key'))
  assert(!credentials.logs.some(text => text.includes('xai-ui-secret-fixture')))
  process.env.XAI_API_KEY = 'xai-env-secret-fixture'
  await scenario(['community', 'x', 'remove-key', reply('confirm', true), ...close])
  assert.equal(readPiAuth(), null)
  assert.equal(process.env.XAI_API_KEY, 'xai-env-secret-fixture')
  assert(rows('x')[0].enabled, 'local logout does not disable X')
  delete process.env.XAI_API_KEY
  assert(!existsSync(piAuthPath()))
  mkdirSync(dirname(grokAuthFile()), { recursive: true })
  writeFileSync(grokAuthFile(), JSON.stringify({ 'fixture::client': { key: 'xai-import-fixture' } }))
  const imported = await scenario(['community', 'x', 'import-grok', ...close])
  assert.equal(readPiAuth().key, 'xai-import-fixture')
  assert(page(imported, 'X —')[0].options.some(row => row.value === 'import-grok'))
  assert(!imported.logs.some(text => text.includes('xai-import-fixture')))
  await scenario(['community', 'x', 'disable', ...close])
  const reenabledX = await scenario(['community', 'x', 'enable', ...close])
  assert(rows('x')[0].enabled)
  assert(!reenabledX.records.some(record => record.message === 'Choose search source'), 'single-source X re-enable avoids an unnecessary picker')
  writeFileSync(piAuthPath(), JSON.stringify({ kind: 'grok-session', key: 'expired-secret-fixture', expires_at: new Date(Date.now() - 60000).toISOString() }))
  const expired = await scenario(['community', 'x', ...close])
  assert(page(expired, 'X —')[0].message.includes('credential is unavailable'))
  assert(page(expired, 'X —')[0].message.includes('basic search'))
  assert(!expired.logs.some(text => text.includes('expired-secret-fixture')))
  console.log('ok: direct X credential actions, conditional removal, environment priority and local-only logout')

  fresh()
  manageCommunityBackend({ action: 'update', id: 'reddit-default', enabled: false })
  manageCommunityBackend({ action: 'register', id: 'legacy-reddit', provider: 'reddit-web', enabled: true })
  await scenario(['community', 'reddit', 'enable', 'scopes', reply('text', 'r/node'), ...close])
  assert.equal(rows('reddit').find(row => row.id === 'legacy-reddit').enabled, false)
  assert.deepEqual(rows('reddit').find(row => row.id === 'reddit-default').config.subreddits, ['node'])
  assert.equal(rows('reddit').filter(row => row.enabled).length, 1, 'explicit enabling selects only the one free integration')

  fresh()
  const viewed = await scenario(['community', 'reddit', 'view', ...close])
  assert(viewed.logs.some(text => text.includes('reddit-default')))
  assert(viewed.logs.some(text => text.includes('not live connectivity')))
  assert.equal(bytes(), null, 'viewing saved configuration does not create defaults')

  fresh()
  saveToolPreferences({ community_search: false })
  const off = await scenario(['community', 'back', 'exit'])
  assert(off.records[1].message.includes('Community tool is off'))
  fresh()
  await scenario(['community', 'x', 'set-key', { method: 'password', value: cancel, interrupt: true }])
  assert(!existsSync(process.env.SEARCH_BOOST_HOME), 'Ctrl+C exits whole TUI without credential writes')
  fresh()
  const interrupted = await scenario(['community', 'reddit', 'scopes', reply('text', cancel), ...close])
  assert.equal(page(interrupted, 'Reddit —').length, 2, 'Escape in a form returns to its platform')
  fresh()
  mkdirSync(dirname(communityConfigPath()), { recursive: true })
  const corrupt = '{do-not-render-secret-config'
  writeFileSync(communityConfigPath(), corrupt)
  const invalid = await scenario(['community', 'exit'], { expectFailure: true })
  assert.equal(bytes(), corrupt)
  assert(invalid.logs.some(text => text.includes('configuration cannot be read')))
  assert(!invalid.logs.some(text => text.includes('do-not-render-secret')))
  assert.equal(network, 0, 'no menu/form/check performs a network request')
  console.log('ok: tool-entry distinction, Ctrl+C/Escape, unreadable config protection and zero-network UI')
  console.log('Community TUI regressions passed.')
} finally { globalThis.fetch = savedFetch; process.exitCode = savedExit }
