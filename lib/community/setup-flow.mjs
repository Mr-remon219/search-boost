import { assertNotSymlink, withFileLock, writeFileAtomicPrivate } from '../private-file.mjs'
import { communityConfigPath, readCommunityConfig, planCommunityPlatformChange, applyCommunityPlatformPlan } from './config.mjs'
import { NATIVE_PLATFORMS, initializeNativeSession } from './native-session.mjs'
import { nativeSetupState, ensureNativeBrowser, removeNativeSession, selectNativeBrowser, removeManagedBrowser } from './native-setup.mjs'
import { initializeNativeQrSession } from './qr-login.mjs'

export const nativeSetupServices = { nativeSetupState, ensureNativeBrowser, initializeNativeSession, initializeNativeQrSession, removeNativeSession, selectNativeBrowser, removeManagedBrowser }
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

/** One free native integration per platform. Older adapter records remain readable. */
export function nativeEnablePlan(platform) {
  if (!NATIVE_PLATFORMS.includes(platform)) throw new Error('Unsupported native community platform')
  const doc = readCommunityConfig()
  const existing = doc.backends.find(row => row.provider === `${platform}-native` && row.enabled)
    ?? doc.backends.find(row => row.provider === `${platform}-native`)
  let id = `native-${platform}`, suffix = 2
  while (!existing && doc.backends.some(row => row.id === id)) id = `native-${platform}-${suffix++}`
  return planCommunityPlatformChange(platform, { action: 'select', backend: existing ?? { id, provider: `${platform}-native`, enabled: false, config: {} } })
}

/** Consent is handled by the caller; cancellation never activates the native source. */
export async function installNativePlatform(platform, confirmLogin, { services = nativeSetupServices, onProgress, signal, loginMode = 'manual', browserChoice, onQr, onStatus } = {}) {
  const plan = nativeEnablePlan(platform)
  signal?.throwIfAborted()
  await services.ensureNativeBrowser({ onProgress, signal, source: browserChoice?.source, executable: browserChoice?.path })
  if (browserChoice) {
    const preference = services.nativeSetupState(platform).preference
    if (preference?.source !== browserChoice.source || preference?.path !== browserChoice.path) services.selectNativeBrowser(browserChoice)
  }
  signal?.throwIfAborted()
  let promptError
  const completed = loginMode === 'qr'
    ? await services.initializeNativeQrSession(platform, { signal, onQr, onStatus })
    : await services.initializeNativeSession(platform, async () => {
      try { return await confirmLogin() } catch (error) { promptError = error; return false }
    }, { signal })
  // Preserve navigation/interrupt errors after the browser has safely closed.
  if (promptError) throw promptError
  if (completed !== true) return { installed: false, cancelled: true }
  signal?.throwIfAborted()
  applyCommunityPlatformPlan(plan, { allowUnrelatedChanges: true })
  return { installed: true, cancelled: false }
}

/** Session removal and configuration removal share the configuration lock.
 * Validate the preview first, then remove only owned local state. No fallback is enabled.
 */
export function uninstallNativePlatform(plan, { services = nativeSetupServices, dryRun = false } = {}) {
  if (plan.change.action !== 'uninstall-native' || !NATIVE_PLATFORMS.includes(plan.platform)) throw new Error('Invalid native uninstall plan')
  const commit = () => {
    const fresh = planCommunityPlatformChange(plan.platform, plan.change)
    if (!same(fresh.before, plan.before) || !same(fresh.after, plan.after)) throw new Error('Community configuration changed')
    if (dryRun) return { removed: false }
    assertNotSymlink(communityConfigPath())
    services.removeNativeSession(plan.platform)
    if (fresh.changed) writeFileAtomicPrivate(communityConfigPath(), `${JSON.stringify(fresh.after, null, 2)}\n`)
    return { removed: true }
  }
  return dryRun ? commit() : withFileLock(communityConfigPath(), commit)
}
