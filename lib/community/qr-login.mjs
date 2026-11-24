import { setTimeout as delay } from 'node:timers/promises'
import { withNativeSession, saveNativeSession } from './native-session.mjs'
import { nativeJson, navigate } from './native-reader.mjs'
import { createQrArtifact } from './qr-image.mjs'

// Platform-owned login elements only. Never capture a whole page, ad or arbitrary image.
export const QR_LOGIN_PAGES = Object.freeze({
  xiaohongshu: { url: 'https://www.xiaohongshu.com/explore', selectors: ['.login-container .qrcode-img'], buttons: ['.login-btn'] },
  zhihu: { url: 'https://www.zhihu.com/signin', selectors: ['canvas.Qrcode-qrcode', '.SignFlow-qrcode canvas'], buttons: ['.SignFlow-qrcodeTab'] },
  bilibili: { url: 'https://passport.bilibili.com/login', selectors: ['.login-scan-box img', '.login-scan-box canvas'], buttons: [] },
})
const failure = (kind, message) => Object.assign(new Error(message), { kind })
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9_-]{3,128}$/.test(value)

/** Positive account identity, not cookie presence or the user's "logged in" claim. */
export async function verifyQrLogin(platform, context, page, signal) {
  signal?.throwIfAborted()
  try {
    if (platform === 'bilibili') {
      const account = await nativeJson(context, 'https://api.bilibili.com/x/web-interface/nav', signal)
      return account.isLogin === true && Number.isSafeInteger(Number(account.mid)) && Number(account.mid) > 0
    }
    if (platform === 'zhihu') {
      const account = await nativeJson(context, 'https://www.zhihu.com/api/v4/me', signal)
      return identifier(account.id ?? account.uid) && typeof account.name === 'string' && account.name.length > 0 && account.is_active !== false
    }
    if (platform === 'xiaohongshu') {
      const account = await page.evaluate(() => {
        const state = window.__INITIAL_STATE__?.user?.userInfo
        const user = state?.value ?? state
        return { id: user?.userId ?? user?.user_id, guest: user?.guest,
          accountLink: Boolean(document.querySelector('.main-container .user .link-wrapper .channel')) }
      })
      return account.guest === false && identifier(account.id) && account.accountLink === true
    }
  } catch { signal?.throwIfAborted() }
  return false
}
async function qrElement(page, platform) {
  const definition = QR_LOGIN_PAGES[platform]
  // A login dialog may be in a platform-owned iframe. Routing still guards every request.
  const frames = [page, ...(page.frames?.() ?? []).filter(frame => {
    try { const url = new URL(frame.url()); return url.protocol === 'https:' && (url.hostname === 'passport.bilibili.com' && platform === 'bilibili') } catch { return false }
  })]
  for (const frame of frames) for (const selector of definition.selectors) {
    const element = frame.locator(selector).first()
    if (await element.isVisible().catch(() => false)) return element
  }
  return null
}
async function captureQr(page, platform) {
  const element = await qrElement(page, platform)
  if (!element) return null
  const box = await element.boundingBox()
  if (!box || box.width < 20 || box.height < 20 || box.width > 1024 || box.height > 1024) throw failure('qr_unavailable', 'Platform login QR element invalid')
  return element.screenshot({ type: 'png', timeout: 10_000 })
}
async function prepareQr(page, platform, signal) {
  await navigate(page, QR_LOGIN_PAGES[platform].url, signal)
  for (const selector of QR_LOGIN_PAGES[platform].buttons) {
    if (await qrElement(page, platform)) break
    const button = page.locator(selector).first()
    if (await button.isVisible().catch(() => false)) await button.click({ timeout: 5000 })
  }
}

async function loginIdentityCandidate(platform, context) {
  if (platform === 'xiaohongshu') return true // Identity comes from the loaded page, not an account API.
  const cookie = platform === 'bilibili' ? 'SESSDATA' : 'z_c0'
  const url = platform === 'bilibili' ? 'https://www.bilibili.com/' : 'https://www.zhihu.com/'
  try { return (await context.cookies(url)).some(item => item.name === cookie && item.value) } catch { return false }
}

/** Headless login: show a fresh QR before polling account APIs. Identity checks
 * are bounded and sparse; cookies only decide WHEN to check, never success.
 */
export async function initializeNativeQrSession(platform, { signal, onQr, onStatus, timeoutMs = 180_000, pollMs = 1500,
  verifyTimeoutMs = 4000, verifyIntervalMs = 5000, identityReady,
  session = withNativeSession, verify = verifyQrLogin, capture = captureQr, prepare = prepareQr,
  persist = saveNativeSession, artifactFactory = createQrArtifact, clock = Date.now, wait = delay, ...driverOptions } = {}) {
  if (!Object.hasOwn(QR_LOGIN_PAGES, platform) || [timeoutMs, pollMs, verifyTimeoutMs, verifyIntervalMs].some(value => !Number.isFinite(value) || value < 1)) throw failure('qr_unavailable', 'Unsupported login request')
  signal?.throwIfAborted()
  const deadline = AbortSignal.timeout(timeoutMs), combined = signal ? AbortSignal.any([signal, deadline]) : deadline
  const candidate = identityReady ?? (verify === verifyQrLogin ? loginIdentityCandidate : async () => true)
  try {
    return await session(platform, async context => {
      const page = await context.newPage()
      let artifact, lastCapture = 0, lastVerify = -Infinity, shown = false
      const start = clock()
      const check = async () => {
        if (!await candidate(platform, context, page)) return false
        lastVerify = clock()
        const timeout = new AbortController()
        const timer = setTimeout(() => timeout.abort(), verifyTimeoutMs)
        const bound = AbortSignal.any([combined, timeout.signal])
        let release
        const stopped = new Promise(resolve => {
          const stop = () => resolve(false)
          release = () => bound.removeEventListener('abort', stop)
          if (bound.aborted) resolve(false)
          else bound.addEventListener('abort', stop, { once: true })
        })
        try { return await Promise.race([verify(platform, context, page, bound), stopped]) === true }
        catch { combined.throwIfAborted(); return false }
        finally { clearTimeout(timer); release?.(); combined.throwIfAborted() }
      }
      const complete = () => { combined.throwIfAborted(); persist(platform, { authenticated: true }); onStatus?.({ phase: 'authenticated' }); return true }
      try {
        onStatus?.({ phase: 'opening' })
        await prepare(page, platform, combined)
        if (await check()) return complete()
        onStatus?.({ phase: 'preparing' })
        artifact = artifactFactory(platform)
        while (clock() - start < timeoutMs) {
          combined.throwIfAborted()
          if (!shown || clock() - lastCapture >= 10_000) {
            const png = await capture(page, platform)
            if (png) {
              const update = artifact.update(png)
              if (update) {
                await onQr?.({ ...update, platform, deadlineAt: start + timeoutMs })
                if (shown) onStatus?.({ phase: 'qr_refreshed' })
              }
              shown = true; lastCapture = clock()
            } else if (!shown && clock() - start >= 30_000) throw failure('qr_unavailable', 'Platform login QR unavailable')
          }
          if (clock() - lastVerify >= verifyIntervalMs && await check()) return complete()
          onStatus?.({ phase: shown ? 'waiting' : 'preparing', remainingSeconds: Math.max(0, Math.ceil((timeoutMs - (clock() - start)) / 1000)) })
          await wait(pollMs, undefined, { signal: combined })
        }
        throw failure('qr_login_timeout', 'QR login timed out; request a new QR')
      } finally { artifact?.remove(); await page.close().catch(() => {}) }
    }, { ...driverOptions, signal: combined, login: true, headless: true })
  } catch (error) {
    signal?.throwIfAborted()
    if (deadline.aborted) throw failure('qr_login_timeout', 'QR login timed out; request a new QR')
    throw failure(error?.kind ?? 'qr_login_failed', 'QR login incomplete; retry')
  }
}
