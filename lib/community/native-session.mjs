import { createRequire } from 'node:module'
import { existsSync, lstatSync, openSync, closeSync, rmSync, writeFileSync, readFileSync, readdirSync, accessSync, constants } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { searchBoostHome } from '../config-paths.mjs'
import { ensurePrivateDir, readJsonStore, writeFileAtomicPrivate } from '../private-file.mjs'
import { assertPublicHttpUrl, assertStaticHttpUrl } from '../search/ssrf.js'
import { fulfillNativeRequest } from './native-transport.mjs'

const require = createRequire(import.meta.url)
export const NATIVE_PLATFORMS = ['xiaohongshu', 'zhihu', 'bilibili']
export const nativeHome = platform => {
  if (!NATIVE_PLATFORMS.includes(platform)) throw new Error('Unsupported native community platform')
  return join(searchBoostHome(), 'state', 'community', 'sessions', platform)
}
const markerPath = platform => join(nativeHome(platform), 'session.json')
function ownedPaths(platform, create = false) {
  let path = searchBoostHome()
  for (const part of ['state', 'community', 'sessions', platform]) {
    path = join(path, part)
    if (existsSync(path) && (!lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink())) throw new Error('Native session ancestor is not an owned directory')
    if (create) ensurePrivateDir(path)
  }
  return path
}
function checkProfile(profile) {
  if (!existsSync(profile)) return false
  const pending = [profile]; let count = 0
  while (pending.length) {
    const path = pending.pop(), stat = lstatSync(path)
    if (++count > 20_000 || stat.isSymbolicLink() || !stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1)) throw new Error('Native profile contains non-owned paths')
    if (stat.isDirectory()) for (const name of readdirSync(path)) pending.push(join(path, name))
  }
  return true
}
export function nativeSessionState(platform) {
  try {
    const home = ownedPaths(platform)
    const profile = join(home, 'profile')
    if (!existsSync(profile) || !lstatSync(profile).isDirectory() || lstatSync(profile).isSymbolicLink()) return null
    const owner = readJsonStore(join(home, 'profile-owner.json')).doc
    const file = markerPath(platform)
    if (!existsSync(file) || !lstatSync(file).isFile() || lstatSync(file).nlink !== 1) return null
    const marker = readJsonStore(file).doc
    return marker?.schema_version === 1 && marker.platform === platform && typeof marker.revision === 'string'
      && owner?.platform === platform && typeof owner.profile_id === 'string' && marker.profile_id === owner.profile_id ? marker : null
  } catch { return null }
}
export function nativeAvailability(platform) {
  try {
    const executable = process.env.SEARCH_BOOST_BROWSER_EXECUTABLE || require('playwright-core').chromium.executablePath()
    if (!lstatSync(executable).isFile()) throw new Error('Missing browser')
    accessSync(executable, process.platform === 'win32' ? constants.F_OK : constants.X_OK)
  } catch { return { ready: false, reason: 'Browser binary missing; install Chromium explicitly or set SEARCH_BOOST_BROWSER_EXECUTABLE' } }
  return nativeSessionState(platform) ? { ready: true, reason: 'Owned session and browser found; actual access/coverage not verified' }
    : { ready: false, reason: 'Run community-login for this platform to initialize an owned browser session' }
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

/** One owned profile per platform, never the user's personal Chrome profile or a server. */
export async function withNativeSession(platform, work, { signal, login = false, chromium, validateUrl = assertPublicHttpUrl } = {}) {
  signal?.throwIfAborted()
  if (!login && !nativeSessionState(platform)) throw Object.assign(new Error('Run search-boost community-login for this platform first'), { kind: 'session_required' })
  const home = ownedPaths(platform, true)
  const profile = join(home, 'profile')
  if (existsSync(profile) && (!lstatSync(profile).isDirectory() || lstatSync(profile).isSymbolicLink())) throw new Error('Native profile path is not an owned directory')
  ensurePrivateDir(profile)
  const lock = join(home, 'browser.lock')
  let fd
  try { fd = openSync(lock, 'wx', 0o600) } catch (error) {
    // Recover only a demonstrably dead PID, never a time-based live lock.
    if (error.code !== 'EEXIST') throw error
    const before = lstatSync(lock)
    if (!before.isFile() || before.nlink !== 1) throw new Error('Invalid native session lock')
    const pid = Number(readFileSync(lock, 'utf8'))
    let dead = false
    if (Number.isSafeInteger(pid) && pid > 0) try { process.kill(pid, 0) } catch (failure) { dead = failure.code === 'ESRCH' }
    const after = lstatSync(lock)
    if (!dead || before.ino !== after.ino || before.dev !== after.dev) throw Object.assign(new Error('Native platform session is busy; no second writer was started'), { kind: 'session_busy' })
    rmSync(lock)
    try { fd = openSync(lock, 'wx', 0o600) } catch { throw Object.assign(new Error('Native session lock changed during recovery'), { kind: 'session_busy' }) }
  }
  let context, closing
  const close = () => closing ??= Promise.resolve().then(() => context?.close()).catch(() => {})
  const abort = () => { void close() }
  try {
    writeFileSync(fd, String(process.pid))
    checkProfile(profile)
    const ownerPath = join(home, 'profile-owner.json')
    let owner = readJsonStore(ownerPath).doc
    if (!owner) {
      if (!login || readdirSync(profile).length) throw new Error('Refusing to adopt a pre-existing browser profile')
      owner = { platform, profile_id: randomUUID() }
      writeFileAtomicPrivate(ownerPath, JSON.stringify(owner))
    }
    if (owner.platform !== platform || typeof owner.profile_id !== 'string') throw new Error('Invalid native profile ownership marker')
    const env = { ...process.env }
    const options = { headless: !login, acceptDownloads: false, serviceWorkers: 'block', timeout: 30_000,
      args: ['--disable-background-networking', '--disable-component-update', '--no-proxy-server'],
      ...(process.env.SEARCH_BOOST_BROWSER_EXECUTABLE ? { executablePath: process.env.SEARCH_BOOST_BROWSER_EXECUTABLE } : {}) }
    const driver = chromium ?? (await import('playwright-core')).chromium
    context = await driver.launchPersistentContext(profile, options)
    signal?.throwIfAborted()
    signal?.addEventListener('abort', abort, { once: true })
    context.setDefaultTimeout(20_000)
    await context.routeWebSocket('**/*', websocket => websocket.close())
    const diagnostics = { aborted_by_policy: 0, blocked_redirects: 0 }
    await context.route('**/*', async intercepted => {
      try {
        await fulfillNativeRequest(intercepted, { signal, env, validateUrl, login, cookiesFor: url => context.cookies(url), allow: (value, method) => {
          const parsed = assertStaticHttpUrl(value)
          const allowed = allowedNativeRequest(platform, value, method) || login && parsed.protocol === 'https:' && !parsed.port
            && roots[platform].some(root => parsed.hostname === root || parsed.hostname.endsWith('.' + root))
            && method === 'POST' && /\/(?:login|signin|sign_in|oauth|passport(?:-login)?|qrcode|sms|verify|captcha|send_code)(?:\/|$)/i.test(parsed.pathname)
          if (!allowed) diagnostics.aborted_by_policy++
          return allowed
        } })
      } catch (error) {
        if (error.kind === 'redirect_blocked') diagnostics.blocked_redirects++
        else diagnostics.aborted_by_policy++
        await intercepted.abort().catch(() => {})
      }
    })
    const result = await work(context)
    signal?.throwIfAborted()
    if (result && typeof result === 'object') result.diagnostics = { ...result.diagnostics, ...diagnostics }
    return result
  } catch (error) {
    signal?.throwIfAborted()
    // Never echo browser errors containing profile paths, requests, cookie or signed URLs.
    throw Object.assign(new Error(login ? 'Native browser login failed; check browser installation/display' : 'Native browser retrieval failed; check browser installation/session'), { kind: error?.kind ?? 'retrieval_failed' })
  } finally {
    signal?.removeEventListener('abort', abort)
    await close()
    closeSync(fd); rmSync(lock, { force: true })
  }
}
export async function initializeNativeSession(platform, confirm, options = {}) {
  return withNativeSession(platform, async context => {
    const page = await context.newPage()
    await page.goto({ xiaohongshu: 'https://www.xiaohongshu.com/', zhihu: 'https://www.zhihu.com/', bilibili: 'https://www.bilibili.com/' }[platform], { waitUntil: 'domcontentloaded', timeout: 30_000 })
    if (await confirm() !== true) return false
    const owner = readJsonStore(join(nativeHome(platform), 'profile-owner.json')).doc
    writeFileAtomicPrivate(markerPath(platform), JSON.stringify({ schema_version: 1, platform, profile_id: owner.profile_id, revision: randomUUID() }))
    return true
  }, { ...options, login: true })
}
