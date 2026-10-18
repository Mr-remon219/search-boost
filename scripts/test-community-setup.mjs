#!/usr/bin/env node
import './isolate-tests.mjs'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative } from 'node:path'
import {
  ensureNativeBrowser, installPlaywrightChromium, managedBrowserExecutablePath, managedBrowserRoot,
  managedBrowserStatus, managedRegistryPath, nativeHome, nativeProfileOwnerPath, nativeProfilePath,
  nativeSessionInstalled, nativeSessionLockPath, nativeSessionMarkerPath, nativeSessionRecord,
  nativeSetupState, removeNativeSession, resolveNativeBrowser, systemBrowserCandidates,
} from '../lib/community/native-setup.mjs'
import * as session from '../lib/community/native-session.mjs'

const root = mkdtempSync(join(tmpdir(), 'native-setup-'))
process.env.SEARCH_BOOST_HOME = join(root, 'home')
const fixture = join(root, 'fixtures')
mkdirSync(fixture, { recursive: true })
const executable = join(fixture, process.platform === 'win32' ? 'fake-chromium.exe' : 'fake-chromium')
writeFileSync(executable, 'fixture only', { mode: 0o700 })
const missing = join(fixture, 'missing-browser')
delete process.env.SEARCH_BOOST_BROWSER_EXECUTABLE

const tree = dir => {
  const out = []
  const walk = path => {
    for (const name of readdirSync(path).sort()) {
      const child = join(path, name), stat = lstatSync(child)
      out.push(relative(root, child) + (stat.isDirectory() ? '/' : ''))
      if (stat.isDirectory()) walk(child)
    }
  }
  if (existsSync(dir)) walk(dir)
  return out
}
const settle = () => new Promise(resolve => setImmediate(resolve))

// --- Discovery is read-only and bounded -------------------------------------
const before = tree(root)
const idle = nativeSetupState('xiaohongshu')
assert.deepEqual(Object.keys(idle).sort(), ['browser', 'installed', 'localBrowsers', 'managedBrowser', 'preference', 'session'])
assert.equal(idle.session, false)
assert.equal(idle.installed, false)
assert(['env', 'system', 'managed', 'none'].includes(idle.browser.source))
assert.deepEqual(idle.preference, { source: 'auto' })
assert.equal(idle.managedBrowser.source, 'managed')
assert.equal(typeof idle.managedBrowser.ready, 'boolean')
assert.equal(typeof idle.managedBrowser.installed, 'boolean')
assert(idle.localBrowsers.every(entry => entry.source === 'system' || entry.source === 'env'))
assert.equal(session.nativeSessionState('xiaohongshu'), null)
assert.deepEqual(tree(root), before, 'state reads must not write anything')
assert.equal(session.nativeHome('xiaohongshu'), nativeHome('xiaohongshu'), 'native-session re-exports the shared owned path')

const candidates = systemBrowserCandidates()
assert(candidates.length > 0 && candidates.length <= 12, 'OS discovery uses a bounded fixed list')
assert(candidates.every(candidate => isAbsolute(candidate)), 'only absolute well-known locations are considered')
assert(candidates.every(candidate => /(?:chrome|chromium)/i.test(candidate)), 'only Chrome/Chromium executables are considered')

process.env.SEARCH_BOOST_BROWSER_EXECUTABLE = executable
assert.deepEqual(resolveNativeBrowser(), { ready: true, source: 'env', path: executable })
assert.equal(nativeSetupState('xiaohongshu').browser.path, executable)
process.env.SEARCH_BOOST_BROWSER_EXECUTABLE = missing
assert.deepEqual(resolveNativeBrowser(), { ready: false, source: 'env', path: missing, reason: 'SEARCH_BOOST_BROWSER_EXECUTABLE is not an executable browser file' })
delete process.env.SEARCH_BOOST_BROWSER_EXECUTABLE
assert.deepEqual(resolveNativeBrowser({ candidates: [missing, executable] }), { ready: true, source: 'system', path: executable })
assert.deepEqual(resolveNativeBrowser({ candidates: [], source: 'managed' }).source, 'managed')
assert.equal(resolveNativeBrowser({ candidates: [], source: 'managed' }).ready, false)
assert.equal(resolveNativeBrowser({ candidates: [], manifest: { available: false } }).source, 'none')
const managedExecutable = managedBrowserExecutablePath()
assert.ok(isAbsolute(managedExecutable ?? ''), 'the pinned playwright-core manifest yields an absolute owned browser path')
assert.ok(managedExecutable.startsWith(managedBrowserRoot() + '/'), 'the owned browser lives inside the SearchBoost-owned root')
assert.equal(managedBrowserStatus().installed, false, 'no owned browser is installed in a clean home')
assert.deepEqual(tree(root), before, 'discovery never writes')

// --- ensureNativeBrowser discovers before it installs -----------------------
let installCalls = 0
process.env.SEARCH_BOOST_BROWSER_EXECUTABLE = executable
const discoveryEvents = []
const discovered = await ensureNativeBrowser({
  onProgress: event => discoveryEvents.push(event),
  install: async () => { installCalls++ },
})
assert.equal(installCalls, 0, 'an existing browser must never trigger a download')
assert.equal(discovered.action, 'discovered')
assert.equal(discovered.browser.path, executable)
assert.deepEqual(discoveryEvents, [{ phase: 'discover' }, { phase: 'ready', source: 'env', action: 'discovered' }])
delete process.env.SEARCH_BOOST_BROWSER_EXECUTABLE

const resolveCalls = []
const phases = []
const readyBrowser = { ready: true, source: 'managed', path: executable }
const installed = await ensureNativeBrowser({
  onProgress: event => phases.push(event.phase),
  resolveBrowser: () => { resolveCalls.push(1); return resolveCalls.length > 1 ? readyBrowser : { ready: false, source: 'none' } },
  install: async ({ onProgress }) => {
    assert.equal(resolveCalls.length, 1, 'the install runs only after discovery failed')
    onProgress({ phase: 'download', percent: 50 })
  },
})
assert.equal(resolveCalls.length, 2, 'the installed browser is re-resolved before it is reported ready')
assert.equal(installed.action, 'installed')
assert.equal(installed.browser, readyBrowser)
assert.deepEqual(phases, ['discover', 'install', 'download', 'verify', 'ready'])
const resilient = await ensureNativeBrowser({ onProgress: () => { throw new Error('progress must not break setup') }, resolveBrowser: () => readyBrowser })
assert.equal(resilient.action, 'discovered')

// --- Failures never report a partial success --------------------------------
await assert.rejects(
  () => ensureNativeBrowser({ resolveBrowser: () => ({ ready: false, source: 'none' }), install: async () => { throw new Error('download failed') } }),
  /download failed/,
)
await assert.rejects(
  () => ensureNativeBrowser({ resolveBrowser: () => ({ ready: false, source: 'none' }), install: async () => {} }),
  { kind: 'browser_install_failed' },
)
const afterFailure = nativeSetupState('zhihu')
assert.equal(afterFailure.browser.ready, idle.browser.ready, 'failed installation does not change detected system browsers')
assert.equal(afterFailure.session, false)
assert.equal(afterFailure.installed, false, 'a failed setup leaves no owned session state behind')
assert.deepEqual(tree(root), before, 'browser setup never creates session state')

// --- The real installer spawns playwright-core's CLI without a shell --------
const spawnCalls = [], progress = []
const fakeSpawn = script => {
  const child = new EventEmitter()
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  setImmediate(() => script(child))
  return child
}
await installPlaywrightChromium({
  env: {},
  onProgress: event => progress.push(event),
  spawnImpl: (command, args, options) => {
    spawnCalls.push({ command, args, options })
    return fakeSpawn(child => {
      child.stdout.emit('data', 'Downloading Chromium 156.0.8078.4 (playwright chromium v1248) from https://cdn.playwright.dev/dbazure/download/playwright/SECRET-TOKEN\n')
      child.stdout.emit('data', '|■■■■■■■■                    |  42% of 153.2 MiB\n')
      child.stdout.emit('data', '|■■■■■■■■■■■■■■■■■■■■        | 100% of 153.2 MiB\n')
      child.emit('close', 0)
    })
  },
})
assert.deepEqual(progress, [{ phase: 'download', percent: 42 }, { phase: 'download', percent: 100 }])
assert.doesNotMatch(JSON.stringify(progress), /SECRET|playwright\.dev|MiB/, 'progress is sanitized')
assert.equal(spawnCalls.length, 1)
assert.equal(spawnCalls[0].command, process.execPath)
assert.equal(spawnCalls[0].options.shell, false, 'no shell interpolation')
assert.deepEqual(spawnCalls[0].args.slice(1), ['install', 'chromium'])
assert.ok(isAbsolute(spawnCalls[0].args[0]) && existsSync(spawnCalls[0].args[0]), 'the resolved playwright-core CLI is an absolute existing file')
assert.equal(spawnCalls[0].options.env.PLAYWRIGHT_BROWSERS_PATH, managedRegistryPath(), 'the download is isolated to the SearchBoost-owned registry')
assert.equal(process.env.PLAYWRIGHT_BROWSERS_PATH, undefined, 'the process environment is never mutated')
assert(existsSync(join(managedBrowserRoot(), 'owned.json')), 'the owned root is claimed before the download')

const bounded = []
await installPlaywrightChromium({
  env: {},
  onProgress: event => bounded.push(event),
  spawnImpl: () => fakeSpawn(child => {
    for (let percent = 0; percent <= 120; percent++) child.stdout.emit('data', `|■■                          | ${String(percent).padStart(3)}% of 10.0 MiB\n`)
    child.emit('close', 0)
  }),
})
assert(bounded.length <= 100, 'progress events are bounded')
assert(bounded.every(event => event.phase === 'download' && Number.isInteger(event.percent) && event.percent >= 0 && event.percent <= 100))
for (const [script, pattern] of [
  [child => { child.stderr.emit('data', 'SECRET raw failure https://cdn.playwright.dev/profile\n'); child.emit('close', 1) }, /exit code 1/],
  [child => { child.emit('error', new Error('SECRET spawn failure')) }, /Could not start/],
]) {
  await assert.rejects(
    () => installPlaywrightChromium({ env: {}, spawnImpl: () => fakeSpawn(script) }),
    error => error.kind === 'browser_install_failed' && pattern.test(error.message) && !/SECRET|playwright\.dev/.test(error.message),
  )
}

// Cancellation propagates into the download subprocess; no raw output escapes.
const aborted = new AbortController(), stopped = []
let downloading
const download = installPlaywrightChromium({ signal: aborted.signal,
  spawnImpl: () => { downloading = fakeSpawn(() => {}); return downloading },
  terminate: (child, signal) => { stopped.push(signal); setImmediate(() => child.emit('close', null)) },
})
aborted.abort()
await assert.rejects(download, { kind: 'browser_install_cancelled' })
assert.deepEqual(stopped, ['SIGTERM'])
let timedChild
await assert.rejects(installPlaywrightChromium({ timeoutMs: 5,
  spawnImpl: () => { timedChild = fakeSpawn(() => {}); return timedChild },
  terminate: child => setImmediate(() => child.emit('close', null)),
}), /timed out/)
let badOverrideDownloads = 0
await assert.rejects(ensureNativeBrowser({ resolveBrowser: () => ({ ready: false, source: 'env' }), install: async () => { badOverrideDownloads++ } }), /SEARCH_BOOST_BROWSER_EXECUTABLE/)
assert.equal(badOverrideDownloads, 0)

// --- Owned session state sees partial profiles ------------------------------
process.env.SEARCH_BOOST_BROWSER_EXECUTABLE = executable
const xhs = 'xiaohongshu'
assert.equal(nativeSessionInstalled(xhs), false)
mkdirSync(nativeProfilePath(xhs), { recursive: true })
assert.equal(nativeSessionRecord(xhs), null)
assert.equal(nativeSetupState(xhs).session, false, 'a partial profile is not a confirmed session')
assert.equal(nativeSetupState(xhs).installed, true, 'a cancelled or failed login leaves removable owned state')
const owner = { platform: xhs, profile_id: 'fixture-profile' }
writeFileSync(nativeProfileOwnerPath(xhs), JSON.stringify(owner), { mode: 0o600 })
writeFileSync(nativeSessionMarkerPath(xhs), JSON.stringify({ schema_version: 1, platform: xhs, profile_id: 'fixture-profile', revision: 'fixture-revision' }), { mode: 0o600 })
assert.equal(nativeSessionRecord(xhs)?.revision, 'fixture-revision')
assert.equal(nativeSetupState(xhs).session, true)
assert.equal(nativeSetupState(xhs).installed, true)
assert.deepEqual(session.nativeAvailability(xhs), { ready: true, reason: 'Owned session and browser found; actual access/coverage not verified' })

// The launch uses the same resolved executable as availability.
let launched
const chromium = {
  launchPersistentContext: async (profile, options) => {
    launched = { profile, options }
    return { setDefaultTimeout() {}, routeWebSocket: async () => {}, route: async () => {}, cookies: async () => [], close: async () => {} }
  },
}
assert.equal(await session.withNativeSession(xhs, async () => 42, { chromium }), 42)
assert.equal(launched.profile, nativeProfilePath(xhs))
assert.equal(launched.options.executablePath, executable, 'launch uses the resolved browser executable')

// initializeNativeSession writes the shared marker path.
const login = { launchPersistentContext: async () => ({ setDefaultTimeout() {}, routeWebSocket: async () => {}, route: async () => {}, cookies: async () => [], newPage: async () => ({ goto: async () => {} }), close: async () => {} }) }
assert.equal(await session.initializeNativeSession('zhihu', async () => true, { chromium: login }), true)
assert.equal(session.nativeSessionState('zhihu')?.revision !== undefined, true)
delete process.env.SEARCH_BOOST_BROWSER_EXECUTABLE

// --- Removal is limited to the owned platform directory ---------------------
assert.deepEqual(removeNativeSession(xhs), { removed: true })
assert.equal(existsSync(nativeHome(xhs)), false)
assert.equal(nativeSetupState(xhs).installed, false)
assert.equal(nativeSessionRecord(xhs), null)
assert.equal(removeNativeSession(xhs).removed, false)
assert.equal(removeNativeSession(xhs).reason, 'absent')
assert.equal(existsSync(nativeHome('zhihu')), true, 'other platforms are untouched')
assert.equal(nativeSetupState('zhihu').session, true)
assert.throws(() => removeNativeSession('not-a-platform'), { kind: 'native_setup_invalid' })

// A cancelled login removes its partial profile even though no session was confirmed.
mkdirSync(nativeProfilePath('bilibili'), { recursive: true })
writeFileSync(join(nativeProfilePath('bilibili'), 'Local State'), 'partial', { mode: 0o600 })
writeFileSync(nativeProfileOwnerPath('bilibili'), JSON.stringify({ platform: 'bilibili', profile_id: 'partial-owned' }), { mode: 0o600 })
assert.deepEqual(removeNativeSession('bilibili'), { removed: true })
assert.equal(existsSync(nativeHome('bilibili')), false)

// A plain but non-owned non-empty profile is not disposable.
mkdirSync(nativeProfilePath('bilibili'), { recursive: true })
writeFileSync(join(nativeProfilePath('bilibili'), 'Login Data'), 'not-owned')
assert.throws(() => removeNativeSession('bilibili'), { kind: 'native_setup_unsafe' })
assert.equal(readFileSync(join(nativeProfilePath('bilibili'), 'Login Data'), 'utf8'), 'not-owned')
assert(!existsSync(nativeSessionLockPath('bilibili')), 'failed uninstall releases only its own lock')
rmSync(nativeHome('bilibili'), { recursive: true })

// Live/unknown locks are never removed.
mkdirSync(nativeProfilePath('bilibili'), { recursive: true })
writeFileSync(nativeSessionLockPath('bilibili'), String(process.pid))
assert.throws(() => removeNativeSession('bilibili'), { kind: 'session_busy' })
assert.equal(existsSync(nativeProfilePath('bilibili')), true, 'a refused removal deletes nothing')
assert.equal(readFileSync(nativeSessionLockPath('bilibili'), 'utf8'), String(process.pid))
rmSync(nativeHome('bilibili'), { recursive: true })

// Symlinked profiles, unsupported markers and shared caches are refused/kept.
const personal = join(root, 'personal-profile')
mkdirSync(personal)
writeFileSync(join(personal, 'Login Data'), 'personal', { mode: 0o600 })
mkdirSync(nativeHome('bilibili'), { recursive: true })
symlinkSync(personal, nativeProfilePath('bilibili'), 'dir')
assert.throws(() => removeNativeSession('bilibili'), { kind: 'native_setup_unsafe' })
assert.equal(readFileSync(join(personal, 'Login Data'), 'utf8'), 'personal', 'a symlinked personal profile is never followed')
rmSync(nativeHome('bilibili'), { recursive: true })

const foreign = join(root, 'foreign-sessions')
mkdirSync(foreign)
symlinkSync(foreign, nativeHome('bilibili'), 'dir')
assert.throws(() => removeNativeSession('bilibili'), { kind: 'native_setup_unsafe' })
assert.equal(existsSync(foreign), true)
rmSync(nativeHome('bilibili'))

mkdirSync(nativeProfilePath('bilibili'), { recursive: true })
writeFileSync(nativeProfileOwnerPath('bilibili'), JSON.stringify({ platform: 'zhihu', profile_id: 'x' }), { mode: 0o600 })
assert.throws(() => removeNativeSession('bilibili'), { kind: 'native_setup_unsafe' }, 'a marker for another platform is not ours')
rmSync(nativeHome('bilibili'), { recursive: true })

mkdirSync(nativeProfilePath('bilibili'), { recursive: true })
writeFileSync(nativeSessionMarkerPath('bilibili'), JSON.stringify({ schema_version: 1, platform: 'bilibili', profile_id: 'p', revision: 'r' }), { mode: 0o600 })
let hardlinked = true
try { linkSync(nativeSessionMarkerPath('bilibili'), join(root, 'marker-copy')) } catch { hardlinked = false }
if (hardlinked) assert.throws(() => removeNativeSession('bilibili'), { kind: 'native_setup_unsafe' }, 'multiply-linked markers are not owned files')
rmSync(nativeHome('bilibili'), { recursive: true })
rmSync(join(root, 'marker-copy'), { force: true })

const realHome = process.env.SEARCH_BOOST_HOME, homeLink = join(root, 'home-link')
symlinkSync(realHome, homeLink, process.platform === 'win32' ? 'junction' : 'dir')
process.env.SEARCH_BOOST_HOME = homeLink
assert.throws(() => removeNativeSession('zhihu'), { kind: 'native_setup_unsafe' })
assert.equal(nativeSetupState('zhihu').session, false)
process.env.SEARCH_BOOST_HOME = realHome
rmSync(homeLink)
await assert.rejects(session.withNativeSession('../invalid', async () => {}, { login: true }), /Unsupported/)

const sharedCache = join(root, 'shared-playwright-cache')
mkdirSync(join(sharedCache, 'chromium-1248'), { recursive: true })
writeFileSync(join(sharedCache, 'chromium-1248', 'chrome'), 'shared binary')
mkdirSync(nativeProfilePath('bilibili'), { recursive: true })
assert.deepEqual(removeNativeSession('bilibili'), { removed: true })
assert.equal(readFileSync(join(sharedCache, 'chromium-1248', 'chrome'), 'utf8'), 'shared binary', 'shared browser caches are never removed')
assert.equal(existsSync(join(personal, 'Login Data')), true)
assert.equal(existsSync(join(root, 'home', 'state', 'community', 'sessions')), true, 'the shared sessions parent stays')

assert.deepEqual(removeNativeSession('zhihu'), { removed: true })
assert.equal(session.nativeSessionState('zhihu'), null)
rmSync(root, { recursive: true })
console.log('ok: native browser setup discovers before installing, fails closed, and removes only owned session state')
