#!/usr/bin/env node
import './isolate-tests.mjs'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import QRCode from 'qrcode'
import { createQrArtifact } from '../lib/community/qr-image.mjs'
import { ConsoleModel, renderConsole, displayWidth } from '../lib/console-tui.mjs'
import { runCommunityStep, runNativePlatformSetup, runNativePlatformUninstall } from '../lib/installer/community-setup.mjs'
import { runCommunityWizard } from '../lib/installer/community-wizard.mjs'
import { runInstallerWithOptions } from '../lib/installer/index.mjs'
import { withTuiContext } from '../lib/installer/i18n.mjs'
import { readCommunityConfig, communityConfigPath, planCommunityPlatformChange, applyCommunityPlatformPlan, manageCommunityBackend } from '../lib/community/config.mjs'
import { installNativePlatform, nativeEnablePlan, uninstallNativePlatform } from '../lib/community/setup-flow.mjs'

let fixture = 0, count = 0
const fresh = () => { process.env.SEARCH_BOOST_HOME = join(process.env.HOME, 'community-onboarding', String(++fixture)); process.exitCode = undefined }
async function test(name, work) { fresh(); await work(); count++; console.log(`ok: ${name}`) }
const bytes = () => existsSync(communityConfigPath()) ? readFileSync(communityConfigPath(), 'utf8') : null
const enabled = platform => readCommunityConfig().backends.filter(row => row.enabled && row.provider.startsWith(platform + '-'))
const cancel = Symbol('cancel')
const qrPng = await QRCode.toBuffer('https://example.test/login?fixture=only', { width: 240 })
function fakeServices({ browser = true, session = false, failure, duringLogin, qrWait = false } = {}) {
  const calls = [], sessions = new Set(session ? ['xiaohongshu', 'zhihu', 'bilibili'] : [])
  let preference = { source: 'auto' }, finishQr, managed = false
  const services = { calls, sessions, completeQr: () => finishQr?.(true),
    selectNativeBrowser: choice => { calls.push('choose-browser'); preference = choice },
    removeManagedBrowser: () => { calls.push('remove-browser'); managed = false },
    nativeSetupState: platform => ({ browser: { ready: browser || managed, source: preference.source === 'managed' ? 'managed' : browser ? 'system' : null, path: '/fixture/chrome' }, session: sessions.has(platform), installed: sessions.has(platform), preference,
      localBrowsers: browser ? [{ id: 'local', source: 'system', path: '/fixture/chrome', label: 'Chrome fixture' }] : [], managedBrowser: { installed: managed, ready: managed, source: 'managed', path: '/fixture/owned-chrome' } }),
    ensureNativeBrowser: async ({ onProgress, source, signal } = {}) => { signal?.throwIfAborted(); calls.push('browser'); onProgress?.({ phase: 'preparing' }); if (failure === 'browser') throw new Error('secret path / private data'); if (source === 'managed') managed = true; else browser = true },
    initializeNativeSession: async (platform, confirm, { signal } = {}) => {
      calls.push(`login:${platform}`)
      if (failure === 'login') throw new Error('secret credential')
      duringLogin?.()
      const result = await confirm(); signal?.throwIfAborted()
      if (result) sessions.add(platform)
      return result
    },
    initializeNativeQrSession: async (platform, { onQr, onStatus, signal }) => {
      calls.push(`qr:${platform}`); if (failure === 'qr') throw new Error('unverified login')
      const artifact = createQrArtifact(platform)
      try {
        onQr?.(artifact.update(qrPng)); onStatus?.({ phase: 'waiting', remainingSeconds: 120 }); duringLogin?.()
        if (qrWait) await new Promise((resolve, reject) => { finishQr = resolve; signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true }) })
        signal?.throwIfAborted(); sessions.add(platform); onStatus?.({ phase: 'authenticated' }); return true
      } finally { artifact.remove() }
    },
    removeNativeSession: platform => { calls.push(`remove:${platform}`); if (failure === 'remove') throw new Error('Session busy'); sessions.delete(platform) },
  }; return services
}
function prompter(steps) {
  const logs = [], records = [], clack = {
    isCancel: value => value === cancel,
    note: text => logs.push(text), log: Object.fromEntries(['info', 'warn', 'error', 'success'].map(kind => [kind, text => logs.push(text)])),
    spinner: () => ({ start: text => logs.push(text), stop: text => logs.push(text) }),
  }
  for (const method of ['select', 'confirm', 'multiselect', 'text']) clack[method] = async prompt => {
    assert(steps.length, `unexpected ${method}: ${prompt.message}`)
    const [expected, reply, check] = steps.shift(); assert.equal(method, expected); records.push(prompt); check?.(prompt)
    if (method === 'select' && reply !== cancel) assert(prompt.options.some(option => option.value === reply), `missing option ${reply}`)
    return reply
  }
  return { clack, records, logs, done: () => assert.equal(steps.length, 0) }
}
const context = fn => withTuiContext(fn, { language: 'en', navigation: true })
const key = (model, name) => model.handleKey('', { name })
const settle = async () => { for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve)) }
async function consent(model) { key(model, 'down'); key(model, 'return'); await settle() }

await test('all platforms use one free source; installation is exclusive, isolated and repeatable', async () => {
  const services = fakeServices()
  const offered = manageCommunityBackend({ action: 'list' }).providers
  assert.equal(offered.length, 5)
  assert.equal(new Set(offered.map(provider => provider.platform)).size, 5)
  assert.deepEqual(offered.filter(provider => ['zhihu', 'bilibili', 'xiaohongshu'].includes(provider.platform)).map(provider => provider.id).sort(), ['bilibili-native', 'xiaohongshu-native', 'zhihu-native'])
  for (const platform of ['xiaohongshu', 'zhihu', 'bilibili']) {
    const other = readCommunityConfig().backends.filter(row => !row.provider.startsWith(platform + '-'))
    await installNativePlatform(platform, async () => true, { services })
    assert.deepEqual(readCommunityConfig().backends.filter(row => !row.provider.startsWith(platform + '-')), other)
    assert.equal(enabled(platform).length, 1); assert.equal(enabled(platform)[0].provider, `${platform}-native`)
    await installNativePlatform(platform, async () => true, { services })
    assert.equal(readCommunityConfig().backends.filter(row => row.provider === `${platform}-native`).length, 1)
  }
})
await test('cancel/failure and a concurrent configuration change do not activate a new source', async () => {
  const services = fakeServices()
  const before = bytes()
  assert.equal((await installNativePlatform('zhihu', async () => false, { services })).cancelled, true)
  assert.equal(bytes(), before)
  await assert.rejects(installNativePlatform('zhihu', async () => true, { services: fakeServices({ failure: 'browser' }) }))
  assert.equal(bytes(), before)
  const changed = fakeServices({ duringLogin: () => applyCommunityPlatformPlan(planCommunityPlatformChange('zhihu', { action: 'disable' })) })
  await assert.rejects(installNativePlatform('zhihu', async () => true, { services: changed }), /Community configuration changed/)
  assert(!enabled('zhihu').some(row => row.provider.endsWith('-native')))
})
await test('uninstall is preview-guarded, leaves other platforms and shared browser alone, and never enables fallback', async () => {
  const services = fakeServices()
  await installNativePlatform('zhihu', async () => true, { services })
  await installNativePlatform('bilibili', async () => true, { services })
  const others = readCommunityConfig().backends.filter(row => !row.provider.startsWith('zhihu-'))
  const plan = planCommunityPlatformChange('zhihu', { action: 'uninstall-native' }), before = bytes()
  uninstallNativePlatform(plan, { services, dryRun: true }); assert.equal(bytes(), before); assert(!services.calls.includes('remove:zhihu'))
  assert.throws(() => uninstallNativePlatform(plan, { services: fakeServices({ failure: 'remove' }) }), /Session busy/)
  assert.equal(bytes(), before)
  uninstallNativePlatform(plan, { services }); assert.equal(enabled('zhihu').length, 0)
  assert.deepEqual(readCommunityConfig().backends.filter(row => !row.provider.startsWith('zhihu-')), others)
  assert.deepEqual([...services.sessions], ['bilibili'])
  assert.deepEqual(services.calls.filter(value => value.startsWith('remove')), ['remove:zhihu'])
  const stale = planCommunityPlatformChange('bilibili', { action: 'uninstall-native' })
  applyCommunityPlatformPlan(planCommunityPlatformChange('x', { action: 'disable' }))
  assert.throws(() => uninstallNativePlatform(stale, { services }), /Community configuration changed/)
  assert(services.sessions.has('bilibili'))
})
await test('legacy TUI has install/login/uninstall, not multiple free source choices', async () => {
  const services = fakeServices({ session: true })
  const p = prompter([['select', 'zhihu'], ['select', 'back', prompt => {
    const values = prompt.options.map(option => option.value)
    assert(values.includes('install') && values.includes('uninstall') && values.includes('enable-native'))
    assert(!values.some(value => ['source', 'browser'].includes(value)))
  }], ['select', 'reddit'], ['select', 'back', prompt => assert(!prompt.options.some(option => option.value === 'source'))], ['select', 'back']])
  await context(() => runCommunityWizard(p.clack, { services })); p.done(); assert.equal(bytes(), null)
})
await test('Clack chooses isolated browser source, prints QR path and auto-verifies; cancel/dry-run never prepare', async () => {
  const services = fakeServices({ browser: false })
  const p = prompter([['select', 'managed', prompt => assert.match(prompt.options.find(row => row.value === 'managed').label, /Download/)]])
  await context(() => runNativePlatformSetup(p.clack, 'zhihu', { services })); p.done()
  assert.equal(enabled('zhihu')[0].provider, 'zhihu-native')
  assert(p.logs.some(text => /\.png/.test(text))); assert(p.logs.some(text => /connected/.test(text)))
  const before = bytes(), calls = services.calls.length
  const dry = prompter([]); await context(() => runNativePlatformSetup(dry.clack, 'bilibili', { services, dryRun: true })); dry.done()
  assert.equal(bytes(), before); assert.equal(services.calls.length, calls)
  const cancelled = prompter([['select', 'back']]); await context(() => runNativePlatformSetup(cancelled.clack, 'bilibili', { services: fakeServices({ browser: false }) })); cancelled.done()
  assert.equal(bytes(), before)
  const u = prompter([['confirm', false]])
  await context(() => runNativePlatformUninstall(u.clack, 'zhihu', { services })); u.done(); assert.equal(bytes(), before)
})
await test('onboarding is optional, last, and never runs for --yes / install-only / dry-run', async () => {
  const services = fakeServices()
  for (const opts of [{ yes: true }, { skipKeys: true }, { uninstall: true }, { dryRun: true }]) {
    const p = prompter([]); await context(() => runCommunityStep(p.clack, opts, { services })); p.done()
  }
  assert.equal(services.calls.length, 0); assert(!existsSync(process.env.SEARCH_BOOST_HOME))
  const p = prompter([['multiselect', ['zhihu', 'bilibili']]])
  await context(() => runCommunityStep(p.clack, {}, { services })); p.done(); assert.equal(enabled('zhihu').length, 1)
  // Full installer, with no agent selected, must still present community as the last prompt.
  const full = prompter([['confirm', false], ['select', 'free'], ['multiselect', []], ['multiselect', [], prompt => assert.match(prompt.message, /Connect community accounts/)]])
  await context(() => runInstallerWithOptions({ clack: full.clack, skipXAuth: true, skipJudgment: true }, { executeOperations: async () => [] }))
  full.done()
  assert.match(full.records.at(-1).message, /Connect community accounts/)

})
await test('console lifecycle cards are bilingual, bounded and the first action is direct setup', async () => {
  for (const language of ['en', 'zh-CN']) {
    const model = new ConsoleModel({ language, services: fakeServices() }); model.navigate(4)
    for (const platform of ['bilibili', 'zhihu', 'xiaohongshu']) {
      const row = model.rows.find(row => row.id === platform)
      assert.equal(row.actions.filter(action => action.id === 'install').length, 1)
      assert(!row.actions.some(action => action.id.startsWith('configure:')))
      model.selection.community = model.rows.indexOf(row); model.focus = 'detail'
      for (const columns of [54, 80, 112, 160]) {
        const text = renderConsole(model, { columns, rows: 32, color: false })
        assert(text.split('\n').every(line => displayWidth(line) <= columns - 1))
        assert.match(text, language === 'en' ? /01.*Browser/ : /01.*浏览器/)
      }
    }
  }
})
await test('console QR login auto-verifies, cancel/quit settles, both browser lifecycles are guarded', async () => {
  const services = fakeServices({ qrWait: true }), model = new ConsoleModel({ language: 'en', services })
  const begin = async (model, platform) => { void model.setupCommunity(platform); await settle() }
  await begin(model, 'zhihu')
  assert.equal(model.modal.kind, 'qr'); assert.equal(model.busy, false)
  assert.equal(bytes(), null); services.completeQr(); await settle()
  assert.equal(enabled('zhihu')[0].provider, 'zhihu-native'); assert.match(model.notice, /connected/)
  model.uninstallCommunity('zhihu'); key(model, 'return'); await settle(); assert(services.sessions.has('zhihu'))
  model.uninstallCommunity('zhihu'); await consent(model); assert(!services.sessions.has('zhihu')); assert.equal(enabled('zhihu').length, 0)
  await begin(model, 'bilibili'); key(model, 'escape'); await settle()
  assert.equal(model.communityTask, null); assert.equal(model.busy, false); assert(!enabled('bilibili').some(row => row.provider === 'bilibili-native'))
  await begin(model, 'bilibili'); key(model, 'q'); await settle(); assert.equal(model.closed, true); assert.equal(model.communityTask, null)
  const bad = new ConsoleModel({ language: 'en', services: fakeServices({ failure: 'browser' }) })
  await begin(bad, 'zhihu'); assert.match(bad.notice, /incomplete/); assert.doesNotMatch(bad.notice, /secret/)
  const dryServices = fakeServices(), dry = new ConsoleModel({ language: 'en', dryRun: true, services: dryServices })
  const before = bytes(); await begin(dry, 'bilibili'); dry.uninstallCommunity('zhihu'); await consent(dry)
  dry.configureBrowser({ source: 'managed' }); await settle(); dry.uninstallBrowser(); await consent(dry)
  assert.equal(dryServices.calls.length, 0); assert.equal(bytes(), before)
  const browserOnly = new ConsoleModel({ language: 'en', services: fakeServices() })
  await browserOnly.configureBrowser({ source: 'managed' }); await settle()
  assert(browserOnly.rows || browserOnly.services.nativeSetupState('xiaohongshu').managedBrowser.installed)
  browserOnly.uninstallBrowser(); key(browserOnly, 'return'); await settle()
  assert(browserOnly.services.nativeSetupState('xiaohongshu').managedBrowser.installed)
  browserOnly.uninstallBrowser(); await consent(browserOnly)
  assert(!browserOnly.services.nativeSetupState('xiaohongshu').managedBrowser.installed)
})
console.log(`\n${count} community onboarding tests passed.`)
