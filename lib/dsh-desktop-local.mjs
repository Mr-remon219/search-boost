/** Observe Desktop-owned local installation without writing/booting its profile. */
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dshDesktopStatus } from './dsh-desktop.mjs'
import { dshDependencies } from './dsh-manifest.mjs'
import { dshRecoveryPending } from './dsh-recovery.mjs'
import { verifyDshPayload } from './dsh-payload.mjs'
import { verifyDshRuntime } from './dsh-runtime.mjs'
import { PKG_ROOT, getVersion } from './pkg.mjs'

export function dshDesktopLocalSource(root = PKG_ROOT, version = getVersion()) {
  const physical = realpathSync(root)
  if (/[\\/]_npx[\\/]/i.test(physical)) {
    throw new Error('The current SearchBoost directory is a temporary npm-exec cache. Install this version into a durable directory, then rerun local Desktop setup; no temporary path was registered.')
  }
  const pkg = JSON.parse(readFileSync(join(physical, 'package.json'), 'utf8'))
  if (pkg.name !== 'search-boost' || pkg.version !== version || pkg.dsh?.bundle?.patch !== './adapters/dsh/cordis.patch.yml'
    || !['index.js', 'schema.js', 'cordis.patch.yml'].every(file => existsSync(join(physical, 'adapters', 'dsh', file)))) {
    throw new Error('The current local SearchBoost package identity/version is invalid.')
  }
  return physical
}

function sameSource(spec, dir, source) {
  if (typeof spec !== 'string') return false
  try {
    const local = spec.startsWith('file://') ? fileURLToPath(spec)
      : /^(?:file|link):/.test(spec) ? spec.replace(/^(?:file|link):/, '').replace(/^~(?=$|[\\/])/, homedir())
        : isAbsolute(spec) ? spec : null
    return local !== null && realpathSync(resolve(dir, local)) === source
  } catch { return false }
}

function busy(dir) {
  // The application's `lock` is expected while the user installs through its UI.
  // Its package write lock/run record and our interrupted transaction are not.
  if (dshRecoveryPending(dir)) return true
  try { lstatSync(join(dir, 'package.json.lock')); return true }
  catch (error) { if (error.code === 'ENOENT') return false; throw error }
}

/** Disk evidence is not proof of activation or of the running process's modules. */
export function inspectDshDesktopLocal({ dir, source, version = getVersion(), requireEnabled = false } = {}) {
  try {
    if (busy(dir)) return { ready: false, state: 'busy' }
    const manifestText = readFileSync(join(dir, 'package.json'), 'utf8')
    const profile = JSON.parse(manifestText)
    if (!sameSource(dshDependencies(profile)['search-boost'], dir, source)) return { ready: false, state: 'source' }
    const root = realpathSync(join(dir, 'node_modules', 'search-boost'))
    const packageText = readFileSync(join(root, 'package.json'), 'utf8')
    const pkg = JSON.parse(packageText)
    if (pkg.name !== 'search-boost' || pkg.version !== version
      || pkg.dsh?.bundle?.patch !== './adapters/dsh/cordis.patch.yml') return { ready: false, state: 'payload' }
    if (!['index.js', 'schema.js', 'cordis.patch.yml'].every(file => existsSync(join(root, 'adapters', 'dsh', file)))) {
      return { ready: false, state: 'payload' }
    }
    const bundles = profile.dsh?.profile?.bundles
    if (!Array.isArray(bundles) || bundles.some(name => typeof name !== 'string')) return { ready: false, state: 'manifest' }
    const enabled = bundles.includes('search-boost')
    verifyDshPayload(root, source)
    if (busy(dir) || readFileSync(join(dir, 'package.json'), 'utf8') !== manifestText
      || readFileSync(join(root, 'package.json'), 'utf8') !== packageText) return { ready: false, state: 'busy' }
    if (requireEnabled && !enabled) return { ready: false, state: 'disabled' }
    const fingerprint = createHash('sha256').update(manifestText).update(packageText).update(root).digest('hex')
    return { ready: true, state: enabled ? 'enabled' : 'installed', fingerprint, root, version, enabled }
  } catch (error) {
    return { ready: false, state: error.code === 'ENOENT' ? 'waiting' : 'payload' }
  }
}

function sleep(ms, signal) {
  return new Promise(resolve => {
    if (signal?.aborted) return resolve()
    const done = () => { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve() }
    const timer = setTimeout(done, ms)
    signal?.addEventListener('abort', done, { once: true })
  })
}

/** Two stable observations, then an optional owning-runtime, strictly read-only probe. */
export async function waitForDshDesktopLocal({ source, dir, version = getVersion(), requireEnabled = false,
  signal, timeoutMs = 900_000, intervalMs = 1_000, onState = () => {} } = {},
{ inspect = inspectDshDesktopLocal, desktopStatus = dshDesktopStatus, verifyRuntime = verifyDshRuntime,
  now = Date.now, delay = sleep } = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || !Number.isFinite(intervalMs) || intervalMs <= 0) throw new Error('Invalid Desktop wait interval/deadline')
  const deadline = now() + timeoutMs
  let previous = null, runtimePending = null
  while (now() < deadline) {
    if (signal?.aborted) return { ok: false, pending: true, cancelled: true }
    const sample = inspect({ dir, source, version, requireEnabled })
    if (!sample.ready || sample.fingerprint !== runtimePending) runtimePending = null
    onState(runtimePending ? 'runtime' : sample.state)
    if (sample.ready && sample.fingerprint === previous) {
      let runtime
      const command = desktopStatus().command
      if (command) {
        try {
          runtime = await verifyRuntime(dir, { command, args: ['plugin', '--profile', 'desktop', 'add', source] },
            { root: sample.root, version, desktop: true, signal,
              timeoutMs: Math.min(30_000, Math.max(1, deadline - now())) })
        } catch {
          // Do not silently accept a resolver mismatch/shadowed bundle. Upstream
          // diagnostics can contain secrets, so only a bounded state is displayed.
          previous = null
          runtimePending = sample.fingerprint
          if (signal?.aborted) return { ok: false, pending: true, cancelled: true }
          onState('runtime')
          await delay(Math.min(intervalMs, Math.max(1, deadline - now())), signal)
          continue
        }
      }
      if (signal?.aborted) return { ok: false, pending: true, cancelled: true }
      const final = inspect({ dir, source, version, requireEnabled })
      if (final.ready && final.fingerprint === sample.fingerprint && now() < deadline) {
        return { ok: true, files: [join(dir, 'package.json')], dsh: { ...runtime,
          root: final.root, version, enabled: final.enabled, manual: true,
          verification: runtime ? 'runtime' : 'disk' } }
      }
      previous = null
    } else previous = sample.ready ? sample.fingerprint : null
    await delay(Math.min(intervalMs, Math.max(1, deadline - now())), signal)
  }
  return { ok: false, pending: true, timedOut: true }
}
