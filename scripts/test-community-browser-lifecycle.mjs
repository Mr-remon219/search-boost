#!/usr/bin/env node
import './isolate-tests.mjs'
// Focused, offline coverage of the isolated browser lifecycle seam:
// injectable discovery, stored preference, owned download/install layout,
// leases, removal safety and symlink handling. No real download and no
// personal browser is executed; the Playwright CLI is replaced by a fake child.
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, posix, sep } from 'node:path'
import {
  acquireManagedBrowserLease, ensureNativeBrowser, installPlaywrightChromium, managedBrowserExecutablePath,
  managedBrowserLeaseDir, managedBrowserLockPath, managedBrowserManifest, managedBrowserOwnerPath,
  managedBrowserRoot, managedBrowserStatus, managedRegistryPath, nativeBrowserPreferencePath,
  nativeSessionLockPath, nativeSetupState, readNativeBrowserPreference, removeManagedBrowser,
  resolveNativeBrowser, scanNativeBrowsers, selectNativeBrowser,
} from '../lib/community/native-setup.mjs'

const root = mkdtempSync(join(tmpdir(), 'browser-lifecycle-'))
process.env.SEARCH_BOOST_HOME = join(root, 'home')
delete process.env.SEARCH_BOOST_BROWSER_EXECUTABLE
delete process.env.PLAYWRIGHT_BROWSERS_PATH

const fixture = join(root, 'fixtures')
const bin = join(root, 'bin')
const outside = join(root, 'outside')
mkdirSync(fixture, { recursive: true }); mkdirSync(bin, { recursive: true }); mkdirSync(outside, { recursive: true })
writeFileSync(join(outside, 'keep.txt'), 'keep', { mode: 0o600 })
const localFixture = join(fixture, 'fake-chromium')
writeFileSync(localFixture, 'fixture only', { mode: 0o700 })
writeFileSync(join(bin, 'chromium'), 'fixture only', { mode: 0o700 })
writeFileSync(join(bin, 'google-chrome-beta'), 'fixture only', { mode: 0o700 })

const settle = () => new Promise(resolve => setImmediate(resolve))
const idsUnique = list => new Set(list.map(entry => entry.id)).size === list.length

/** Fake Playwright CLI child that writes into the owned registry, like the CLI would. */
function fakeSpawn(write, code = 0) {
  return () => {
    const child = new EventEmitter()
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter()
    setImmediate(() => {
      try { write() } catch { /* reported through the exit code */ }
      child.emit('close', code)
    })
    return child
  }
}
const writeManagedTree = () => {
  const executable = managedBrowserExecutablePath()
  mkdirSync(dirname(executable), { recursive: true })
  writeFileSync(executable, 'fake chromium', { mode: 0o700 })
  writeFileSync(join(managedRegistryPath(), managedBrowserManifest().directoryName, 'INSTALLATION_COMPLETE'), 'installed')
  // The real CLI also installs multi-hyphen artifact directories.
  mkdirSync(join(managedRegistryPath(), 'chromium-headless-shell-1248'), { recursive: true })
  mkdirSync(join(managedRegistryPath(), 'ffmpeg-1011'), { recursive: true })
}
const installManagedBrowser = async () => {
  await installPlaywrightChromium({ env: {}, spawnImpl: fakeSpawn(writeManagedTree) })
}

// --- Injectable discovery (Windows / macOS / Linux) --------------------------
const windowsEnv = {
  PROGRAMFILES: 'C:\\Program Files',
  'PROGRAMFILES(X86)': 'C:\\Program Files (x86)',
  LOCALAPPDATA: 'C:\\Users\\tester\\AppData\\Local',
}
const windowsAllowed = new Set([
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Users\\tester\\AppData\\Local\\Google\\Chrome SxS\\Application\\chrome.exe',
  'D:\\ChromeSxS\\Application\\chrome.exe',
  'D:\\Chromium\\Application\\chrome.exe',
])
const registryCalls = []
const windows = scanNativeBrowsers({
  platform: 'win32', env: windowsEnv, homeDir: 'C:\\Users\\tester', cache: false,
  probes: {
    isExecutable: path => windowsAllowed.has(path),
    execFileSync: (command, args) => {
      registryCalls.push({ command, args })
      if (!command.endsWith('\\System32\\reg.exe')) return ''
      const key = args[1]
      if (args.includes('/reg:32') && key.startsWith('HKCU') && key.endsWith('chrome.exe')) {
        return 'HKEY_CURRENT_USER\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe\r\n    (Default)    REG_SZ    D:\\ChromeSxS\\Application\\chrome.exe\r\n'
      }
      if (args.includes('/reg:64') && key.startsWith('HKLM') && key.endsWith('chromium.exe')) {
        return 'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chromium.exe\r\n    (Default)    REG_SZ    D:\\Chromium\\Application\\chrome.exe\r\n'
      }
      return ''
    },
  },
})
assert.equal(windows.length, 4, 'well-known roots and both registry views are discovered once each')
assert(idsUnique(windows))
assert(windows.every(entry => entry.source === 'system' && /^[A-Za-z]:[\\/]/.test(entry.path)))
assert.equal(windows.find(entry => entry.path.includes('Chrome SxS'))?.label, 'Google Chrome Canary')
assert.equal(windows.find(entry => entry.path.startsWith('D:\\ChromeSxS'))?.label, 'Google Chrome Canary')
assert.equal(windows.find(entry => entry.path.startsWith('D:\\Chromium'))?.label, 'Chromium')
assert.equal(registryCalls.length, 8, 'App Paths lookup is bounded to 2 hives x 2 views x 2 names')
assert(registryCalls.every(call => call.command.endsWith('\\System32\\reg.exe') && call.args.includes('/ve')))
assert(registryCalls.some(call => call.args.includes('/reg:32')) && registryCalls.some(call => call.args.includes('/reg:64')))
assert(registryCalls.some(call => call.args[1].startsWith('HKCU')) && registryCalls.some(call => call.args[1].startsWith('HKLM')))

const macAllowed = new Set([
  posix.join('/Applications', 'Google Chrome Beta.app', 'Contents', 'MacOS', 'Google Chrome'),
  posix.join('/Users/tester', 'Applications', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
  posix.join('/Volumes/External', 'Google Chrome Dev.app', 'Contents', 'MacOS', 'Google Chrome'),
])
const spotlightCalls = []
const mac = scanNativeBrowsers({
  platform: 'darwin', env: {}, homeDir: '/Users/tester', cache: false,
  probes: {
    isExecutable: path => macAllowed.has(path),
    existsSync: () => true,
    execFileSync: (command, args) => {
      spotlightCalls.push({ command, args })
      if (command !== '/usr/bin/mdfind') return ''
      if (args.at(-1).includes('com.google.Chrome')) return '/Volumes/External/Google Chrome Dev.app\n/Applications/Google Chrome Beta.app\n'
      if (args.at(-1).includes('org.chromium')) return '/Users/tester/Applications/Chromium.app\n'
      return ''
    },
  },
})
assert.deepEqual(mac.map(entry => entry.label).sort(), ['Chromium', 'Google Chrome Beta', 'Google Chrome Dev'])
assert(mac.every(entry => entry.source === 'system' && idsUnique(mac)))
assert.equal(spotlightCalls.length, 2, 'Spotlight lookup is bounded to the Chrome and Chromium bundle ids')
assert(spotlightCalls.every(call => call.command === '/usr/bin/mdfind' && call.args.includes('-onlyin') && call.args.includes('/Applications')))

// Virtual POSIX probes must not discover the runner's preinstalled browsers or
// depend on the host's path syntax (this suite also runs on Windows/macOS).
const linuxBin = '/fixture/chromium-bin'
const linuxExecutables = new Set([`${linuxBin}/chromium`, `${linuxBin}/google-chrome-beta`])
const linuxProbes = { isExecutable: path => linuxExecutables.has(path) }
const linux = scanNativeBrowsers({ platform: 'linux', env: { PATH: `${linuxBin}:${linuxBin}:/nonexistent-path` }, homeDir: '/fixture', cache: false, probes: linuxProbes })
assert.equal(linux.length, 2, 'PATH candidates are deduplicated and host executables are excluded')
assert.equal(linux.find(entry => entry.path === `${linuxBin}/chromium`)?.label, 'Chromium')
assert.equal(linux.find(entry => entry.path === `${linuxBin}/google-chrome-beta`)?.label, 'Google Chrome Beta')
assert(linux.every(entry => entry.path.startsWith('/') && entry.source === 'system'))

const deduped = scanNativeBrowsers({ platform: 'linux', env: { PATH: linuxBin, SEARCH_BOOST_BROWSER_EXECUTABLE: `${linuxBin}/chromium` }, homeDir: '/fixture', cache: false, probes: linuxProbes })
assert.equal(deduped.find(entry => entry.path === `${linuxBin}/chromium`)?.source, 'system', 'a path discovered locally keeps its system source')
assert.equal(deduped.some(entry => entry.source === 'env'), false, 'the override adds nothing when it resolves to an already discovered browser')
const envOnlyPath = '/fixture/env-only-chromium'
const envOnly = scanNativeBrowsers({ platform: 'linux', env: { PATH: '', SEARCH_BOOST_BROWSER_EXECUTABLE: envOnlyPath }, homeDir: '/fixture', cache: false, probes: { isExecutable: path => path === envOnlyPath } })
assert.deepEqual(envOnly, [{
  id: 'env',
  label: 'Chrome / Chromium (SEARCH_BOOST_BROWSER_EXECUTABLE)',
  path: envOnlyPath,
  source: 'env',
}])

const realScan = scanNativeBrowsers()
assert(Array.isArray(realScan) && realScan.every(entry => isAbsolute(entry.path) && ['system', 'env'].includes(entry.source)))

// --- Preference: validated writes, no silent source switching ----------------
const localPreferenceFixture = process.platform === 'win32'
  ? join(root, 'local', 'Google', 'Chrome', 'Application', 'chrome.exe')
  : process.platform === 'darwin'
    ? join(root, 'Applications', 'Chromium.app', 'Contents', 'MacOS', 'Chromium')
    : join(bin, 'chromium')
mkdirSync(dirname(localPreferenceFixture), { recursive: true })
writeFileSync(localPreferenceFixture, 'fixture only', { mode: 0o700 })
// Preference/managed lifecycle tests use the real host platform. Overriding it
// to Linux would resolve Linux managed executables on Windows/macOS.
const scanOptions = {
  env: { ...process.env, PATH: bin, LOCALAPPDATA: join(root, 'local') }, homeDir: root, cache: false,
  probes: { isExecutable: path => path === localPreferenceFixture && existsSync(path), execFileSync: () => '' },
}
assert.deepEqual(readNativeBrowserPreference(), { source: 'auto' })
assert.deepEqual(resolveNativeBrowser(scanOptions).source, 'system', 'auto discovers the local fixture')
assert.deepEqual(selectNativeBrowser({ source: 'system', path: localPreferenceFixture }, scanOptions), { source: 'system', path: localPreferenceFixture })
assert.deepEqual(readNativeBrowserPreference(), { source: 'system', path: localPreferenceFixture })
assert.deepEqual(resolveNativeBrowser(scanOptions), { ready: true, source: 'system', path: localPreferenceFixture })
const preferenceState = nativeSetupState('zhihu', scanOptions)
assert.equal(preferenceState.preference.source, 'system')
assert.equal(preferenceState.browser.source, 'system')
assert(Array.isArray(preferenceState.localBrowsers) && typeof preferenceState.session === 'boolean' && typeof preferenceState.installed === 'boolean')
assert.equal(preferenceState.managedBrowser.source, 'managed')

// The stored choice is authoritative even when the selected executable vanished.
rmSync(localPreferenceFixture)
assert.deepEqual(resolveNativeBrowser({ ...scanOptions, candidates: [localFixture] }), {
  ready: false, source: 'system', path: localPreferenceFixture, reason: 'The selected local browser is not an executable file',
}, 'a missing stored local browser is reported, never replaced by another one')
let downloads = 0
await assert.rejects(ensureNativeBrowser({ ...scanOptions, install: async () => { downloads++ } }), { kind: 'browser_unavailable' })
assert.equal(downloads, 0, 'a missing stored local choice never silently downloads or switches source')

const storedPreference = readFileSync(nativeBrowserPreferencePath(), 'utf8')
assert.throws(() => selectNativeBrowser({ source: 'system', path: join(bin, 'missing') }, scanOptions), { kind: 'browser_selection_invalid' })
assert.throws(() => selectNativeBrowser({ source: 'managed' }, scanOptions), { kind: 'browser_selection_invalid' })
assert.throws(() => selectNativeBrowser({ source: 'elsewhere' }, scanOptions), { kind: 'browser_selection_invalid' })
assert.equal(readFileSync(nativeBrowserPreferencePath(), 'utf8'), storedPreference, 'an invalid or cancelled choice writes nothing')
assert.deepEqual(selectNativeBrowser({ source: 'auto' }, scanOptions), { source: 'auto' })
writeFileSync(nativeBrowserPreferencePath(), '{ not json')
assert.throws(() => readNativeBrowserPreference(), { kind: 'browser_preference_invalid' }, 'a corrupt preference must not silently switch source')
assert.equal(nativeSetupState('zhihu').browser.ready, false)
assert.throws(() => selectNativeBrowser({ source: 'auto' }, scanOptions), { kind: 'browser_preference_invalid' })
assert.equal(readFileSync(nativeBrowserPreferencePath(), 'utf8'), '{ not json')
rmSync(nativeBrowserPreferencePath())

// --- Owned install: isolated registry, manifest-based path -------------------
const manifest = managedBrowserManifest()
assert.equal(manifest.available, true)
assert(managedBrowserExecutablePath().startsWith(managedRegistryPath() + sep), 'the executable resolves inside the owned registry')
const sharedCache = join(root, 'shared-cache')
mkdirSync(join(sharedCache, 'chromium-1248'), { recursive: true })
writeFileSync(join(sharedCache, 'chromium-1248', 'chrome'), 'shared binary', { mode: 0o700 })

let spawnedEnv
await installPlaywrightChromium({
  env: { PLAYWRIGHT_BROWSERS_PATH: sharedCache, KEEP: '1' },
  spawnImpl: (command, args, options) => {
    spawnedEnv = options.env
    return fakeSpawn(writeManagedTree)()
  },
})
assert.equal(spawnedEnv.PLAYWRIGHT_BROWSERS_PATH, managedRegistryPath(), 'the CLI child receives the owned registry, not the shared cache')
assert.equal(spawnedEnv.KEEP, '1', 'unrelated caller environment is preserved')
assert.equal(process.env.PLAYWRIGHT_BROWSERS_PATH, undefined, 'the process environment is never mutated')
assert.equal(readFileSync(join(sharedCache, 'chromium-1248', 'chrome'), 'utf8'), 'shared binary', 'the shared Playwright cache is never written')
assert.equal(JSON.parse(readFileSync(managedBrowserOwnerPath(), 'utf8')).kind, 'search-boost-managed-browser')
assert.equal(existsSync(managedBrowserLockPath()), false, 'the setup lock is released after install')
assert.deepEqual(managedBrowserStatus(), { source: 'managed', ready: true, installed: true, path: managedBrowserExecutablePath() })
assert.deepEqual(resolveNativeBrowser({ source: 'managed' }), { ready: true, source: 'managed', path: managedBrowserExecutablePath() })

// --- Leases: local no-op, managed blocks removal -----------------------------
const leaseDirPresent = existsSync(managedBrowserLeaseDir())
const releaseLocal = acquireManagedBrowserLease({ source: 'system', path: localFixture })
releaseLocal(); releaseLocal()
assert.equal(existsSync(managedBrowserLeaseDir()), leaseDirPresent, 'a local browser lease is a safe no-op')
assert.throws(() => acquireManagedBrowserLease({ source: 'managed', path: localFixture }), { kind: 'managed_browser_unsafe' })
assert.throws(() => acquireManagedBrowserLease({ source: 'managed' }), { kind: 'browser_unavailable' }, 'a not-ready managed browser cannot be leased for launch')

assert.deepEqual(selectNativeBrowser({ source: 'managed' }), { source: 'managed' })
assert.deepEqual(resolveNativeBrowser({ ...scanOptions, candidates: [localFixture] }), {
  ready: true, source: 'managed', path: managedBrowserExecutablePath(),
}, 'the stored managed choice wins over a discovered local browser')

const managedBrowser = resolveNativeBrowser()
const releaseLease = acquireManagedBrowserLease(managedBrowser)
assert(existsSync(managedBrowserLeaseDir()))
assert.throws(() => removeManagedBrowser(), { kind: 'browser_busy' }, 'an active lease blocks removal in this process')
assert.equal(existsSync(managedBrowserExecutablePath()), true, 'a refused removal deletes nothing')

// A live platform session lock also blocks removal.
const platformHome = dirname(nativeSessionLockPath('zhihu'))
mkdirSync(platformHome, { recursive: true })
writeFileSync(nativeSessionLockPath('zhihu'), String(process.pid))
assert.throws(() => removeManagedBrowser(), { kind: 'browser_busy' })
rmSync(nativeSessionLockPath('zhihu'))

releaseLease(); releaseLease()
assert.equal(existsSync(managedBrowserLeaseDir()), false, 'releasing the lease removes it once')

// A lease held by another live process blocks removal across processes.
const moduleUrl = new URL('../lib/community/native-setup.mjs', import.meta.url).href
const holderSource = [
  `const { resolveNativeBrowser, acquireManagedBrowserLease } = await import(${JSON.stringify(moduleUrl)})`,
  "const browser = resolveNativeBrowser({ source: 'managed' })",
  "if (!browser.ready) { console.error('not-ready'); process.exit(2) }",
  'const release = acquireManagedBrowserLease(browser)',
  "console.log('leased')",
  'process.on("SIGTERM", () => { release(); process.exit(0) })',
  'setTimeout(() => { release(); process.exit(0) }, 60000)',
].join('\n')
const holder = spawn(process.execPath, ['--input-type=module', '-e', holderSource], { stdio: ['ignore', 'pipe', 'pipe'] })
let holderOutput = ''
await new Promise((resolve, reject) => {
  holder.stdout.on('data', chunk => { holderOutput += chunk; if (holderOutput.includes('leased')) resolve() })
  holder.stderr.on('data', chunk => { holderOutput += chunk })
  holder.on('exit', () => reject(new Error(`lease holder exited early: ${holderOutput}`)))
})
assert.throws(() => removeManagedBrowser(), { kind: 'browser_busy' }, 'a cross-process lease blocks removal')
holder.kill('SIGKILL')
await new Promise(resolve => holder.on('exit', resolve))
await settle()
assert.deepEqual(removeManagedBrowser(), { removed: true }, 'a lease from a dead process is stale, not permanent')
assert.equal(readFileSync(join(outside, 'keep.txt'), 'utf8'), 'keep')

// Removal keeps the stored managed choice and reports the explicit missing state.
assert.deepEqual(readNativeBrowserPreference(), { source: 'managed' })
assert.deepEqual(resolveNativeBrowser({ ...scanOptions, candidates: [localFixture] }), {
  ready: false, source: 'managed', reason: 'The SearchBoost-owned Chromium is not installed',
}, 'removal never silently switches to a local browser or the shared cache')
const removedState = nativeSetupState('zhihu', { ...scanOptions, candidates: [localFixture] })
assert.equal(removedState.preference.source, 'managed')
assert.equal(removedState.browser.source, 'managed')
assert.equal(removedState.managedBrowser.installed, false)
assert.equal(removedState.managedBrowser.ready, false)
assert.equal(existsSync(managedBrowserRoot()), false)
assert.equal(existsSync(join(sharedCache, 'chromium-1248', 'chrome')), true, 'the shared cache survives managed removal')

// A dead platform lock is stale, so it blocks nothing; its file is not ours to remove.
const dead = spawn(process.execPath, ['-e', 'process.exit(0)'])
const deadPid = dead.pid
await new Promise(resolve => dead.on('exit', resolve))
mkdirSync(platformHome, { recursive: true })
writeFileSync(nativeSessionLockPath('zhihu'), String(deadPid))
await installManagedBrowser()
assert.deepEqual(removeManagedBrowser(), { removed: true })
assert.equal(existsSync(nativeSessionLockPath('zhihu')), true, 'managed removal never touches platform session state')
rmSync(join(process.env.SEARCH_BOOST_HOME, 'state', 'community', 'sessions'), { recursive: true })

// --- ensureNativeBrowser: explicit sources and the offline install flow -------
let installCalls = 0
await assert.rejects(ensureNativeBrowser({
  source: 'system', candidates: [join(fixture, 'missing')], install: async () => { installCalls++ },
}), { kind: 'browser_unavailable' })
assert.equal(installCalls, 0, 'an explicit local choice never downloads')
const localEnsured = await ensureNativeBrowser({ source: 'system', candidates: [localFixture], install: async () => { installCalls++ } })
assert.deepEqual(localEnsured, { browser: { ready: true, source: 'system', path: localFixture }, action: 'discovered' })
assert.equal(installCalls, 0)
const explicitEnsured = await ensureNativeBrowser({ source: 'system', executable: localFixture, install: async () => { installCalls++ } })
assert.deepEqual(explicitEnsured.browser, { ready: true, source: 'system', path: localFixture })
const aborted = new AbortController()
aborted.abort()
await assert.rejects(
  ensureNativeBrowser({ signal: aborted.signal, install: async () => { installCalls++ } }),
  error => error.name === 'AbortError',
)
assert.equal(installCalls, 0, 'an aborted request never installs')

const ensurePhases = []
const ensured = await ensureNativeBrowser({
  source: 'managed',
  env: {},
  onProgress: event => ensurePhases.push(event.phase),
  install: async () => { await installPlaywrightChromium({ env: {}, spawnImpl: fakeSpawn(writeManagedTree) }) },
})
assert.equal(ensured.action, 'installed')
assert.deepEqual(ensured.browser, { ready: true, source: 'managed', path: managedBrowserExecutablePath() })
assert.deepEqual(ensurePhases, ['discover', 'install', 'verify', 'ready'])
assert.deepEqual(selectNativeBrowser({ source: 'managed' }), { source: 'managed' })
assert.deepEqual(resolveNativeBrowser({ source: 'system', candidates: [localFixture] }), { ready: true, source: 'system', path: localFixture })
assert.deepEqual(resolveNativeBrowser({ executable: localFixture }), { ready: true, source: 'system', path: localFixture }, 'options.executable is honoured as an explicit path')
assert.deepEqual(resolveNativeBrowser({ source: 'managed', executable: managedBrowserExecutablePath() }), { ready: true, source: 'managed', path: managedBrowserExecutablePath() })
const releaseAfterInstall = acquireManagedBrowserLease(resolveNativeBrowser())
releaseAfterInstall()
assert.deepEqual(removeManagedBrowser(), { removed: true })

// --- Post-install failure and cancellation -----------------------------------
await assert.rejects(installPlaywrightChromium({
  env: {},
  spawnImpl: fakeSpawn(() => {
    const executable = managedBrowserExecutablePath()
    mkdirSync(dirname(executable), { recursive: true })
    writeFileSync(executable, 'partial download', { mode: 0o700 })
  }, 1),
}), { kind: 'browser_install_failed' })
assert.deepEqual(managedBrowserStatus().ready, false)
assert.equal(managedBrowserStatus().installed, true, 'a partial download is still removable owned data')
assert.equal(readFileSync(join(sharedCache, 'chromium-1248', 'chrome'), 'utf8'), 'shared binary')
assert.deepEqual(removeManagedBrowser(), { removed: true }, 'a failed install is uninstallable')

let heldChild
const controller = new AbortController()
const cancelled = installPlaywrightChromium({
  env: {},
  signal: controller.signal,
  spawnImpl: () => { heldChild = fakeSpawn(() => {}, 0)(); return heldChild },
  terminate: (child, signal) => { setImmediate(() => child.emit('close', null)) },
})
controller.abort()
await assert.rejects(cancelled, { kind: 'browser_install_cancelled' })
assert.equal(existsSync(managedBrowserLockPath()), false, 'a cancelled install releases the setup lock')

// --- Unknown roots and symlinks are refused, never adopted -------------------
assert.deepEqual(removeManagedBrowser(), { removed: true }, 'a cancelled install leaves only removable owned state')
mkdirSync(managedBrowserRoot(), { recursive: true })
writeFileSync(join(managedBrowserRoot(), 'personal-notes.txt'), 'mine', { mode: 0o600 })
assert.equal(managedBrowserStatus().reason, 'not_owned')
assert.throws(() => removeManagedBrowser(), { kind: 'managed_browser_unsafe' }, 'an unowned root is never adopted or deleted')
assert.equal(readFileSync(join(managedBrowserRoot(), 'personal-notes.txt'), 'utf8'), 'mine')
await assert.rejects(installPlaywrightChromium({ env: {}, spawnImpl: () => { throw new Error('must not spawn') } }), { kind: 'managed_browser_unsafe' })
rmSync(managedBrowserRoot(), { recursive: true })

await installManagedBrowser()
const registry = managedRegistryPath()
rmSync(registry, { recursive: true })
symlinkSync(outside, registry, 'dir')
assert.equal(managedBrowserStatus().reason, 'unsafe', 'a symlinked registry is not resolved as a ready browser')
assert.throws(() => removeManagedBrowser(), { kind: 'managed_browser_unsafe' })
assert.equal(readFileSync(join(outside, 'keep.txt'), 'utf8'), 'keep', 'a symlinked registry target is never followed')
rmSync(registry, { force: true })

// Unknown entries inside the registry refuse removal without deleting anything.
await installManagedBrowser()
mkdirSync(join(registry, 'personal-data'), { recursive: true })
writeFileSync(join(registry, 'personal-data', 'keep.txt'), 'keep', { mode: 0o600 })
assert.throws(() => removeManagedBrowser(), { kind: 'managed_browser_unsafe' })
assert.equal(readFileSync(join(registry, 'personal-data', 'keep.txt'), 'utf8'), 'keep')
rmSync(join(registry, 'personal-data'), { recursive: true })

// Playwright's own .links entry is a symlink to an external browser cache: it may
// be unlinked, never followed into the shared cache.
const linksTarget = join(sharedCache, 'package-link-target')
mkdirSync(linksTarget, { recursive: true })
writeFileSync(join(linksTarget, 'marker.txt'), 'linked', { mode: 0o600 })
mkdirSync(join(registry, '.links'), { recursive: true })
symlinkSync(linksTarget, join(registry, '.links', 'abcdef012345'), 'dir')
// macOS app bundles legitimately contain symlinks; an escaping link inside the
// browser directory must be unlinked, not resolved.
const browserDir = join(registry, managedBrowserManifest().directoryName)
mkdirSync(join(browserDir, 'Frameworks'), { recursive: true })
symlinkSync(outside, join(browserDir, 'Frameworks', 'escape'), 'dir')
assert.deepEqual(removeManagedBrowser(), { removed: true })
assert.equal(readFileSync(join(linksTarget, 'marker.txt'), 'utf8'), 'linked', 'a .links target outside the root survives')
assert.equal(readFileSync(join(outside, 'keep.txt'), 'utf8'), 'keep', 'an escaping bundle symlink is unlinked, never followed')

// Symlinked lease directories refuse lease creation and removal.
await installManagedBrowser()
symlinkSync(outside, managedBrowserLeaseDir(), 'dir')
assert.throws(() => acquireManagedBrowserLease(resolveNativeBrowser()), { kind: 'managed_browser_unsafe' })
assert.throws(() => removeManagedBrowser(), { kind: 'managed_browser_unsafe' })
assert.equal(readFileSync(join(outside, 'keep.txt'), 'utf8'), 'keep')
rmSync(managedBrowserLeaseDir(), { force: true })

// A symlinked SearchBoost home is never treated as an owned browser root.
const homeLink = join(root, 'home-link')
symlinkSync(process.env.SEARCH_BOOST_HOME, homeLink, 'dir')
const realHome = process.env.SEARCH_BOOST_HOME
process.env.SEARCH_BOOST_HOME = homeLink
assert.equal(managedBrowserStatus().reason, 'unsafe')
assert.throws(() => removeManagedBrowser(), { kind: 'managed_browser_unsafe' })
assert.equal(nativeSetupState('zhihu').managedBrowser.reason, 'unsafe')
assert.deepEqual(resolveNativeBrowser(), {
  ready: false, source: 'managed', reason: 'The SearchBoost-owned browser directory is not safe to use',
})
assert.throws(() => selectNativeBrowser({ source: 'managed' }), { kind: 'browser_selection_invalid' })
process.env.SEARCH_BOOST_HOME = realHome
rmSync(homeLink, { force: true })

rmSync(root, { recursive: true })
console.log('ok: browser lifecycle discovers locally, isolates the owned download, leases launches, and refuses unsafe removal')
