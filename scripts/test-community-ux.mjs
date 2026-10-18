#!/usr/bin/env node
import './isolate-tests.mjs'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import QRCode from 'qrcode'
import { runCommunityStep, runNativePlatformSetup, runNativeBrowserSetup } from '../lib/installer/community-setup.mjs'
import { withTuiContext } from '../lib/installer/i18n.mjs'
import { ConsoleModel, renderConsole } from '../lib/console-tui.mjs'
import { createQrArtifact } from '../lib/community/qr-image.mjs'
import { initializeNativeQrSession } from '../lib/community/qr-login.mjs'
import { nativeHome, nativeSessionLockPath, scanNativeBrowsers } from '../lib/community/native-setup.mjs'
import { initializeNativeSession, withNativeSession } from '../lib/community/native-session.mjs'
import { readCommunityConfig, planCommunityPlatformChange, applyCommunityPlatformPlan, communityConfigPath } from '../lib/community/config.mjs'
import { installNativePlatform } from '../lib/community/setup-flow.mjs'
import { communitySearch } from '../lib/community/service.mjs'
import { fulfillNativeRequest } from '../lib/community/native-transport.mjs'
import { CommunityRegistry } from '../lib/community/registry.mjs'
import { toolStates, saveToolPreferences } from '../lib/tool-config.mjs'

const png = await QRCode.toBuffer('https://example.test/login?fixture=not-a-real-token', { width: 180 })
const beforeFetch = globalThis.fetch
// Browser/account traffic is injected; a walkthrough must not touch real accounts.
globalThis.fetch = () => { throw new Error('No live traffic in UX journeys') }
let fixtures = 0, tests = 0
const fresh = () => { process.env.SEARCH_BOOST_HOME = join(process.env.HOME, 'community-ux', String(++fixtures)); process.exitCode = undefined }
const context = fn => withTuiContext(fn, { language: 'zh-CN', navigation: true })
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)) }
const key = (model, name) => model.handleKey('', { name })
async function test(name, fn) { fresh(); await fn(); tests++; console.log(`ok: ${name}`) }
function fixture({ browser = true, waitForScan = false, failures = 0 } = {}) {
  let preference = { source: 'auto' }, managed = false, finish
  const calls = [], sessions = new Set(), events = []
  const services = {
    calls, sessions, events, finish: () => finish?.(),
    nativeSetupState: () => ({ browser: { ready: browser || managed, source: preference.source === 'managed' ? 'managed' : 'system', path: '/fixture/chrome' },
      session: false, installed: false, preference, localBrowsers: browser ? [{ id: 'chrome', label: 'Chrome', path: '/fixture/chrome' }] : [], managedBrowser: { ready: managed, installed: managed } }),
    ensureNativeBrowser: async ({ source, onProgress, signal } = {}) => { events.push('ensure'); signal?.throwIfAborted(); calls.push('prepare'); if (source === 'managed') { onProgress?.({ phase: 'download', percent: 25 }); managed = true } },
    selectNativeBrowser: choice => { preference = choice; calls.push('choose') },
    initializeNativeQrSession: async (platform, { onQr, onStatus, signal }) => {
      calls.push(`login:${platform}`)
      if (failures-- > 0) throw Object.assign(new Error('SECRET private browser error'), { kind: 'qr_unavailable' })
      const artifact = createQrArtifact(platform)
      try {
        onStatus?.({ phase: 'opening' }); onStatus?.({ phase: 'preparing' }); onQr?.(artifact.update(png)); onStatus?.({ phase: 'waiting', remainingSeconds: 120 })
        if (waitForScan) await new Promise((resolve, reject) => { finish = resolve; signal.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError')), { once: true }) })
        signal?.throwIfAborted(); sessions.add(platform); onStatus?.({ phase: 'authenticated' }); return true
      } finally { artifact.remove() }
    },
    removeNativeSession: platform => { calls.push('delete-session'); sessions.delete(platform) },
    removeManagedBrowser: () => { calls.push('delete-browser'); managed = false },
  }
  const state = services.nativeSetupState
  services.nativeSetupState = (platform, options) => ({ ...state(), session: sessions.has(platform), installed: sessions.has(platform) })
  return services
}
function prompts(replies = [], events = []) {
  const records = [], logs = []
  const clack = { isCancel: value => typeof value === 'symbol', note: (text, title) => logs.push(`${title}: ${text}`),
    log: Object.fromEntries(['info', 'warn', 'success', 'error'].map(method => [method, text => logs.push(text)])),
    spinner: () => ({ start: text => { events.push('feedback'); logs.push(text) }, message: text => logs.push(text), stop: text => logs.push(text) }),
  }
  for (const method of ['select', 'multiselect', 'confirm', 'text']) clack[method] = async options => {
    records.push({ method, ...options }); assert(replies.length, `unexpected prompt: ${method} ${options.message}`)
    const [expected, value] = replies.shift(); assert.equal(method, expected); return value
  }
  return { clack, records, logs, done: () => assert.equal(replies.length, 0) }
}
try {
  await test('UX01/02/05/15: three platforms require one multi-select, no repeated approval, configured platforms skip login', async () => {
    const services = fixture(), p = prompts([['multiselect', ['xiaohongshu', 'zhihu', 'bilibili']]])
    const result = await context(() => runCommunityStep(p.clack, {}, { services })); p.done()
    assert(result.ok); assert.equal(p.records.length, 1); assert.equal(services.calls.filter(call => call.startsWith('login:')).length, 3)
    assert.equal(services.calls.filter(call => call === 'choose').length, 1)
    assert(p.logs.some(text => text.includes('3 已连接')))
    assert(!p.logs.some(text => /MCP|Docker|verification|private profile/.test(text)))
    const again = prompts([['multiselect', ['xiaohongshu', 'zhihu', 'bilibili']]])
    const before = services.calls.length; await context(() => runCommunityStep(again.clack, {}, { services })); again.done()
    assert.equal(services.calls.length, before)
    const relogin = prompts([]); await context(() => runNativePlatformSetup(relogin.clack, 'xiaohongshu', { services })); relogin.done()
    assert.equal(services.calls.filter(call => call === 'choose').length, 1, 'no browser re-selection or preference rewrite')
  })
  await test('UX02/06/07: explicit download choice is sufficient consent, with feedback before work; source settings keep current browser', async () => {
    const services = fixture({ browser: false }), p = prompts([['select', 'managed']], services.events)
    await context(() => runNativePlatformSetup(p.clack, 'zhihu', { services })); p.done()
    assert.equal(p.records.length, 1); assert.match(p.records[0].options.find(o => o.value === 'managed').label, /下载/)
    assert(services.events.indexOf('feedback') < services.events.indexOf('ensure')); assert(p.logs.some(line => /25%/.test(line)))
    const settings = prompts([['select', 'managed']], services.events)
    await context(() => runNativeBrowserSetup(settings.clack, { services })); settings.done(); assert.equal(settings.records[0].initialValue, 'managed')
    assert.equal(settings.records.filter(p => p.method === 'confirm').length, 0)
    let external = 0
    scanNativeBrowsers({ platform: 'win32', env: {}, homeDir: 'C:\\fixture', quick: true, probes: { isExecutable: () => false, execFileSync: () => { external++; return '' } } })
    assert.equal(external, 0, 'status-only scans execute no OS commands')
    scanNativeBrowsers({ platform: 'win32', env: {}, homeDir: 'C:\\fixture', budgetMs: 1, probes: { isExecutable: () => false, execFileSync: () => { external++; const end = Date.now() + 4; while (Date.now() < end) {} return '' } } })
    assert(external <= 1, 'system queries respect the total discovery budget')
  })
  await test('UX03/04/05: console connects immediately, pauses/resumes without QR or confirmations, and uses read-only default after success', async () => {
    const services = fixture({ waitForScan: true }), model = new ConsoleModel({ language: 'zh-CN', services }); model.navigate(4)
    const target = () => model.rows.find(row => row.id === 'zhihu')
    model.selection.community = model.rows.indexOf(target())
    assert.equal(target().status, '未连接'); assert(!target().actions.some(action => action.id === 'toggle'))
    void model.setupCommunity('zhihu'); await settle(); assert.equal(model.modal.kind, 'qr')
    services.finish(); await settle(); assert.equal(model.modal, null); assert.equal(target().status, '已配置'); assert.equal(target().actions[0].id, 'view')
    target().actions.find(action => action.id === 'toggle').run(); assert.equal(model.modal, null); assert.equal(target().status, '已暂停')
    const before = services.calls.length; model.enableCommunity('zhihu'); assert.equal(model.modal, null); assert.equal(target().status, '已配置'); assert.equal(services.calls.length, before)
    const details = target().details.join(''); assert(details.length < 160); assert(!/MCP|Docker|provider/.test(details))
    model.uninstallCommunity('zhihu'); assert.equal(model.modal.kind, 'select'); assert.equal(model.modal.index, 0, 'deletion still defaults to cancel')
    key(model, 'return'); await settle(); assert(services.sessions.has('zhihu'))
    const backend = readCommunityConfig().backends.find(row => row.id === 'reddit-default')
    model.configureCommunity('reddit', backend); model.modal.values = ['node']; model.modal.index = model.modal.fields.length
    key(model, 'return'); await settle(); assert.equal(model.modal, null); assert.deepEqual(readCommunityConfig().backends.find(row => row.id === backend.id).config.subreddits, ['node'])
    const frame = renderConsole(model, { columns: 120, rows: 32, color: false }); assert(!frame.includes('配置状态 ≠'))
  })
  await test('UX09/10/11: quick Escape cancels and restores input, retries do not repeat consent, timeout keeps settings', async () => {
    const services = fixture({ failures: 1 }), p = prompts([['select', 'retry']])
    await context(() => runNativePlatformSetup(p.clack, 'zhihu', { services })); p.done()
    assert.equal(services.calls.filter(call => call.startsWith('login:')).length, 2); assert.equal(process.exitCode, undefined)
    assert(!p.logs.join('').includes('SECRET'))
    const waiting = fixture({ waitForScan: true }), q = prompts([]), input = new EventEmitter()
    input.isTTY = true; input.isRaw = false; input.isPaused = () => true; input.setRawMode = value => { input.isRaw = value }; input.resume = () => {}; input.pause = () => {}
    const operation = context(() => runNativePlatformSetup(q.clack, 'xiaohongshu', { services: waiting, input }))
    await settle(); input.emit('keypress', '', { name: 'escape' }); const cancelled = await operation
    assert(cancelled.cancelled); assert.equal(input.isRaw, false); assert.equal(input.listenerCount('keypress'), 0)
    const retryWait = fixture({ waitForScan: true }), r = prompts([]), keys = new EventEmitter()
    const retried = context(() => runNativePlatformSetup(r.clack, 'bilibili', { services: retryWait, input: keys }))
    await settle(); keys.emit('keypress', '', { name: 'r' }); await settle(); retryWait.finish(); await retried
    assert.equal(retryWait.calls.filter(call => call.startsWith('login:')).length, 2); assert.equal(r.records.length, 0)
  })
  await test('UX08/10: QR precedes fresh identity API calls, checks are sparse, and a hung identity check has a short bound', async () => {
    let now = 0, ready = false, checks = 0, shownAt, saved = 0
    const page = { close: async () => {} }
    const result = await initializeNativeQrSession('zhihu', { timeoutMs: 10000, pollMs: 1000,
      session: async (_p, work) => work({ newPage: async () => page }), prepare: async () => {},
      identityReady: async () => ready, verify: async () => ++checks >= 2,
      capture: async () => png, onQr: event => { shownAt = now; assert.equal(checks, 0); assert.equal(event.expiresAt, undefined); ready = true },
      persist: () => { saved++ }, clock: () => now, wait: async () => { now += 1000 },
    })
    assert(result); assert.equal(shownAt, 0); assert.equal(checks, 2); assert.equal(now, 5000); assert.equal(saved, 1)
    let hungQr = false
    await assert.rejects(initializeNativeQrSession('zhihu', { timeoutMs: 90, pollMs: 2, verifyTimeoutMs: 5, verifyIntervalMs: 20,
      session: async (_p, work) => work({ newPage: async () => page }), prepare: async () => {}, identityReady: async () => true,
      verify: async () => new Promise(() => {}), capture: async () => Buffer.from('injected'),
      artifactFactory: () => ({ update: () => ({ path: '/fixture/qr.png', matrix: null }), remove() {} }),
      onQr: () => { hungQr = true }, persist: () => { throw new Error('Unverified login must not be saved') },
    }), { kind: 'qr_login_timeout' })
    assert(hungQr, 'unresponsive account API does not prevent QR presentation')
  })
  await test('UX13: unrelated platform edits merge after scan; changes to the scanned platform remain protected', async () => {
    const services = fixture(), login = services.initializeNativeQrSession
    services.initializeNativeQrSession = async (...args) => { applyCommunityPlatformPlan(planCommunityPlatformChange('x', { action: 'disable' })); return login(...args) }
    await installNativePlatform('zhihu', null, { services, loginMode: 'qr' }); assert.equal(readCommunityConfig().backends.find(b => b.id === 'x-default').enabled, false)
    const conflict = fixture(), ownLogin = conflict.initializeNativeQrSession
    conflict.initializeNativeQrSession = async (...args) => { applyCommunityPlatformPlan(planCommunityPlatformChange('bilibili', { action: 'disable' })); return ownLogin(...args) }
    await assert.rejects(installNativePlatform('bilibili', null, { services: conflict, loginMode: 'qr' }), /Community configuration changed/)
  })
  await test('UX14: concurrent native queries wait briefly, unknown locks are never removed, and queue waits cancel', async () => {
    const executable = join(process.env.HOME, 'ux-browser'); writeFileSync(executable, 'fixture', { mode: 0o700 }); process.env.SEARCH_BOOST_BROWSER_EXECUTABLE = executable
    const driver = { launchPersistentContext: async () => ({ setDefaultTimeout() {}, routeWebSocket: async () => {}, route: async () => {}, close: async () => {}, newPage: async () => ({ goto: async () => {} }) }) }
    await initializeNativeSession('zhihu', async () => true, { chromium: driver })
    let active = 0, maximum = 0
    const work = async () => { active++; maximum = Math.max(maximum, active); await delay(35); active--; return true }
    await Promise.all([withNativeSession('zhihu', work, { chromium: driver, waitForSessionMs: 600 }), withNativeSession('zhihu', work, { chromium: driver, waitForSessionMs: 600 })])
    assert.equal(maximum, 1)
    const lock = nativeSessionLockPath('zhihu'); writeFileSync(lock, 'unknown-lock')
    await assert.rejects(withNativeSession('zhihu', work, { chromium: driver, waitForSessionMs: 600 }), { kind: 'session_busy' }); assert.equal(readFileSync(lock, 'utf8'), 'unknown-lock')
    writeFileSync(lock, String(process.pid)); const abort = new AbortController()
    const queued = withNativeSession('zhihu', work, { chromium: driver, signal: abort.signal, waitForSessionMs: 600 }); abort.abort()
    await assert.rejects(queued, { name: 'AbortError' }); assert.equal(readFileSync(lock, 'utf8'), String(process.pid)); rmSync(lock)
    delete process.env.SEARCH_BOOST_BROWSER_EXECUTABLE
  })
  await test('UX12/16: search returns typed recovery hints, keeps partial evidence and does not ask to reconfigure a rate limit', async () => {
    const provider = { id: 'fixture-native', platform: 'zhihu', label: 'fixture', version: 1, operations: ['keyword'], retrievalMode: 'native', validateConfig: () => ({}), describeAvailability: () => ({ ready: true }), search: async () => {} }
    const registry = new CommunityRegistry().register(provider), config = { schema_version: 1, backends: [{ id: 'fixture', provider: provider.id, config: {}, enabled: true }] }
    for (const reason of ['rate_limited', 'session_busy', 'session_expired', 'browser_unavailable']) {
      const errorProvider = { ...provider, search: async () => { throw Object.assign(new Error('SECRET'), { kind: reason }) } }
      const result = await communitySearch({ engines: ['zhihu'], query: 'fixture' }, { registry: new CommunityRegistry().register(errorProvider), config })
      assert.equal(result.channels[0].reason, reason); assert(result.channels[0].note); assert(!JSON.stringify(result).includes('SECRET'))
      if (reason === 'rate_limited') assert.match(result.channels[0].note, /do not reconfigure/)
    }
    const partial = { ...provider, search: async () => ({ via: 'native', error: 'session_expired', warnings: [], items: [{ url: 'https://www.zhihu.com/question/123/answer/456', title: 'Retained answer', text: 'A concrete public answer about actual product usage and detailed experience. '.repeat(8) }] }) }
    const kept = await communitySearch({ engines: ['zhihu'], query: 'fixture' }, { registry: new CommunityRegistry().register(partial), config })
    assert.equal(kept.results, 1); assert.equal(kept.channels[0].status, 'partial'); assert.equal(kept.channels[0].reason, 'session_expired')
    let requests = 0
    const route = { request: () => ({ url: () => 'https://www.zhihu.com/search', method: () => 'GET', resourceType: () => 'document', allHeaders: async () => ({}), postDataBuffer: () => null }), abort: async () => {}, fulfill: async () => {} }
    for (const [location, kind] of [['/signin?next=/search', 'session_expired'], ['https://untrusted.test/login', 'redirect_blocked']]) {
      await assert.rejects(fulfillNativeRequest(route, { env: {}, allow: url => new URL(url).hostname === 'www.zhihu.com', validateUrl: async () => ({ validatedAddresses: [] }), fetchHop: async () => { requests++; return new Response('', { status: 302, headers: { location } }) } }), { kind })
    }
    assert.equal(requests, 2, 'redirects were classified without following them')
    saveToolPreferences({ community_search: false }); const services = fixture(), p = prompts([])
    await context(() => runNativePlatformSetup(p.clack, 'xiaohongshu', { services })); assert(p.logs.some(text => text.includes('工具开关')))
    const model = new ConsoleModel({ language: 'zh-CN', services }); model.navigate(4); assert(model.rows.some(row => row.id === 'tool-off'))
    assert.equal(toolStates().find(tool => tool.name === 'community_search').enabled, false, 'setup never silently grants tool access')
    model.rows.find(row => row.id === 'tool-off').actions[0].run()
    assert.equal(toolStates().find(tool => tool.name === 'community_search').enabled, true, 'the explicitly labelled tool-enable action is direct')
  })
  console.log(`\n${tests} user-journey groups cover the 16 frozen UX findings.`)
} finally { globalThis.fetch = beforeFetch; process.exitCode = undefined }
