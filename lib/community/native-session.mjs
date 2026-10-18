import { setTimeout as delay } from 'node:timers/promises'
import { existsSync, lstatSync, openSync, closeSync, rmSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { ensurePrivateDir, readJsonStore, writeFileAtomicPrivate } from '../private-file.mjs'
import { assertPublicHttpUrl, assertStaticHttpUrl } from '../search/ssrf.js'
import { fulfillNativeRequest } from './native-transport.mjs'
import {
  NATIVE_PLATFORMS, assertOwnedProfile, ensureNativeSessionHome, nativeHome, nativeProfileOwnerPath,
  nativeProfilePath, nativeSessionLockPath, nativeSessionMarkerPath, nativeSessionRecord, resolveNativeBrowser, acquireManagedBrowserLease,
} from './native-setup.mjs'

export { NATIVE_PLATFORMS, nativeHome }

/** Marker is the same shared helper the setup lifecycle reads. */
export function nativeSessionState(platform) {
  return nativeSessionRecord(platform)
}
export function nativeAvailability(platform) {
  if (!nativeSessionState(platform)) return { ready: false, reason: 'Connect this platform in Community once to save its login', reason_code: 'session_required' }
  let browser
  try { browser = resolveNativeBrowser() } catch { return { ready: false, reason: 'Browser preference unreadable; repair browser-preference.json', reason_code: 'browser_preference_invalid' } }
  if (!browser.ready) return { ready: false, reason: browser.reason, reason_code: 'browser_unavailable' }
  return { ready: true, reason: 'Owned session and browser found; actual access/coverage not verified' }
}
export const nativeAvailable = platform => nativeAvailability(platform).ready
export const nativeSessionIdentity = () => NATIVE_PLATFORMS.map(platform => [platform, nativeSessionState(platform)?.revision ?? null])
const roots = {
  xiaohongshu: ['xiaohongshu.com', 'xhscdn.com'],
  zhihu: ['zhihu.com', 'zhimg.com'],
  bilibili: ['bilibili.com', 'hdslb.com', 'biliimg.com', 'biligame.com'],
}
export function allowedNativeRequest(platform, value, method = 'GET') {
  let url
  try { url = assertStaticHttpUrl(value) } catch { return false }
  if (url.protocol !== 'https:' || url.username || url.password || url.port && url.port !== '443'
    || !roots[platform]?.some(root => url.hostname === root || url.hostname.endsWith('.' + root))) return false
  // Site search is a read, despite XHS's POST transport. Never forward platform writes.
  if (method === 'POST') return platform === 'xiaohongshu' && url.hostname === 'edith.xiaohongshu.com' && ['/api/sns/web/v1/search/notes', '/api/sns/web/v1/feed'].includes(url.pathname)
  if (platform === 'bilibili' && url.hostname === 'api.bilibili.com' && /^\/x\/note\/publish\/(?:info|list\/archive)$/.test(url.pathname)) return ['GET', 'HEAD'].includes(method)
  return ['GET', 'HEAD'].includes(method) && !/\/(?:logout|delete|publish|like|favorite|vote|follow)(?:\/|$)/i.test(url.pathname)
}

async function takeSessionLock(platform, signal, waitMs) {
  const lock = nativeSessionLockPath(platform), deadline = Date.now() + Math.max(0, Math.min(8000, Number.isFinite(waitMs) ? waitMs : 0))
  for (;;) {
    signal?.throwIfAborted()
    try {
      const fd = openSync(lock, 'wx', 0o600)
      try { writeFileSync(fd, String(process.pid)) } catch (error) { closeSync(fd); rmSync(lock, { force: true }); throw error }
      return fd
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      let before
      try { before = lstatSync(lock) } catch (failure) { if (failure.code === 'ENOENT') continue; throw failure }
      if (!before.isFile() || before.nlink !== 1) throw Object.assign(new Error('Invalid browser.lock; see docs/community-search.md'), { kind: 'session_busy' })
      let pid
      try { pid = Number(readFileSync(lock, 'utf8')) } catch (failure) { if (failure.code === 'ENOENT') continue; throw failure }
      if (!Number.isSafeInteger(pid) || pid <= 0) throw Object.assign(new Error('Unresolved browser.lock; see docs/community-search.md; never remove an active lock'), { kind: 'session_busy' })
      let dead = false
      try { process.kill(pid, 0) } catch (failure) { dead = failure.code === 'ESRCH' }
      let after
      try { after = lstatSync(lock) } catch (failure) { if (failure.code === 'ENOENT') continue; throw failure }
      if (before.ino !== after.ino || before.dev !== after.dev) continue
      if (dead) { rmSync(lock); continue }
      if (Date.now() >= deadline) throw Object.assign(new Error('Platform session busy: browser.lock; see docs/community-search.md; retry shortly, no setup needed'), { kind: 'session_busy' })
      await delay(Math.min(200, deadline - Date.now()), undefined, { signal })
    }
  }
}

/** One owned profile per platform; short, cancellable waits avoid query collisions. */
export async function withNativeSession(platform, work, { signal, login = false, headless = !login, chromium, validateUrl = assertPublicHttpUrl, waitForSessionMs = 0 } = {}) {
  signal?.throwIfAborted()
  if (!login && !nativeSessionState(platform)) throw Object.assign(new Error('Connect this platform in Community'), { kind: 'session_required' })
  ensureNativeSessionHome(platform)
  const profile = nativeProfilePath(platform)
  if (existsSync(profile) && (!lstatSync(profile).isDirectory() || lstatSync(profile).isSymbolicLink())) throw new Error('Native profile path is not an owned directory')
  ensurePrivateDir(profile)
  const lock = nativeSessionLockPath(platform)
  const fd = await takeSessionLock(platform, signal, waitForSessionMs)
  let context, closing, releaseBrowserLease, policyFailure
  const close = () => closing ??= Promise.resolve().then(() => context?.close()).catch(() => {})
  const abort = () => { void close() }
  try {
    assertOwnedProfile(profile)
    const ownerPath = nativeProfileOwnerPath(platform)
    let owner = readJsonStore(ownerPath).doc
    if (!owner) {
      if (!login || readdirSync(profile).length) throw new Error('Refusing to adopt a pre-existing browser profile')
      owner = { platform, profile_id: randomUUID() }
      writeFileAtomicPrivate(ownerPath, JSON.stringify(owner))
    }
    if (owner.platform !== platform || typeof owner.profile_id !== 'string') throw new Error('Invalid native profile ownership marker')
    const env = { ...process.env }
    const browser = resolveNativeBrowser()
    if (!browser.ready && !chromium) throw Object.assign(new Error('Community browser not ready'), { kind: 'browser_unavailable' })
    releaseBrowserLease = browser.ready ? acquireManagedBrowserLease(browser) : () => {}
    const options = { headless, acceptDownloads: false, serviceWorkers: 'block', timeout: 30_000,
      args: ['--disable-background-networking', '--disable-component-update', '--no-proxy-server'],
      ...(browser.path ? { executablePath: browser.path } : {}) }
    const driver = chromium ?? (await import('playwright-core')).chromium
    context = await driver.launchPersistentContext(profile, options)
    signal?.throwIfAborted()
    signal?.addEventListener('abort', abort, { once: true })
    context.setDefaultTimeout(20_000)
    await context.routeWebSocket('**/*', websocket => websocket.close())
    const diagnostics = { aborted_by_policy: 0, blocked_redirects: 0 }
    await context.route('**/*', async intercepted => {
      try {
        await fulfillNativeRequest(intercepted, { signal, env, validateUrl, login, cookiesFor: url => context.cookies(url), onStatus: status => { if (!login && [401, 403, 429].includes(status)) policyFailure = status === 401 ? 'session_expired' : status === 429 ? 'rate_limited' : 'access_denied' }, allow: (value, method) => {
          const parsed = assertStaticHttpUrl(value)
          const allowed = allowedNativeRequest(platform, value, method) || login && parsed.protocol === 'https:' && !parsed.port
            && roots[platform].some(root => parsed.hostname === root || parsed.hostname.endsWith('.' + root))
            && method === 'POST' && /\/(?:login|signin|sign_in|oauth|passport(?:-login)?|qrcode|sms|verify|captcha|send_code)(?:\/|$)/i.test(parsed.pathname)
          if (!allowed) diagnostics.aborted_by_policy++
          return allowed
        } })
      } catch (error) {
        if (error.kind === 'redirect_blocked' || error.kind === 'session_expired') { diagnostics.blocked_redirects++; policyFailure = error.kind }
        else diagnostics.aborted_by_policy++
        await intercepted.abort().catch(() => {})
      }
    })
    const result = await work(context)
    signal?.throwIfAborted()
    if (result && typeof result === 'object') {
      result.diagnostics = { ...result.diagnostics, ...diagnostics }
      if (!login && policyFailure) { result.error = policyFailure; result.warnings = [...(result.warnings ?? []), policyFailure] }
    }
    return result
  } catch (error) {
    signal?.throwIfAborted()
    // Never echo browser errors containing profile paths, requests, cookie or signed URLs.
    throw Object.assign(new Error(login ? 'Native browser login failed; check browser installation/display' : 'Native browser retrieval failed; check browser installation/session'), { kind: error?.kind ?? policyFailure ?? 'retrieval_failed' })
  } finally {
    signal?.removeEventListener('abort', abort)
    await close()
    releaseBrowserLease?.()
    closeSync(fd); rmSync(lock, { force: true })
  }
}
export async function initializeNativeSession(platform, confirm, options = {}) {
  return withNativeSession(platform, async context => {
    const page = await context.newPage()
    await page.goto({ xiaohongshu: 'https://www.xiaohongshu.com/', zhihu: 'https://www.zhihu.com/', bilibili: 'https://www.bilibili.com/' }[platform], { waitUntil: 'domcontentloaded', timeout: 30_000 })
    if (await confirm() !== true) return false
    saveNativeSession(platform)
    return true
  }, { ...options, login: true })
}

/** Persist only while this process holds the dedicated platform session lock. */
export function saveNativeSession(platform, { authenticated = false } = {}) {
  const lock = nativeSessionLockPath(platform)
  const stat = lstatSync(lock)
  if (!stat.isFile() || stat.nlink !== 1 || readFileSync(lock, 'utf8').trim() !== String(process.pid)) throw new Error('Native session lock not held')
  const owner = readJsonStore(nativeProfileOwnerPath(platform)).doc
  if (owner?.platform !== platform || typeof owner.profile_id !== 'string' || !owner.profile_id) throw new Error('Invalid native profile ownership marker')
  writeFileAtomicPrivate(nativeSessionMarkerPath(platform), JSON.stringify({ schema_version: 1, platform, profile_id: owner.profile_id, revision: randomUUID(), authenticated }))
}
