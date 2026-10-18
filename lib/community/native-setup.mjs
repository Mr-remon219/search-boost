// Native community browser setup lifecycle.
//
// The three integrated readers (xiaohongshu, zhihu, bilibili) use a
// SearchBoost-owned session profile and never an external MCP deployment.
// Everything in this module is read-only except the explicitly triggered
// actions:
//   * ensureNativeBrowser / installPlaywrightChromium — the only download path,
//     isolation-scoped to the owned browser root through a PLAYWRIGHT_BROWSERS_PATH
//     override on the spawned Playwright CLI (the process environment is never
//     mutated and the shared Playwright cache is never read or written);
//   * selectNativeBrowser — persists a validated browser choice;
//   * acquireManagedBrowserLease — a lease file that blocks the owned-browser
//     removal while a managed browser is in use;
//   * removeManagedBrowser / removeNativeSession — the only deletion paths.
//
// Browser resolution: SEARCH_BOOST_BROWSER_EXECUTABLE is used in automatic mode.
// A stored `system` path or `managed` choice is authoritative — when it is
// missing, resolution reports that explicit state and never silently switches
// to another local browser or to the shared Playwright cache. Only the stored
// `auto` preference discovers local Chrome/Chromium first and then the owned
// Chromium downloaded by this module.
//
// The owned browser root is <search-boost home>/state/community/browser. Its
// layout mirrors the pinned playwright-core install layout inside a private
// registry subdirectory: ms-playwright/chromium-<revision>/... plus Playwright's
// own .links and __dirlock entries. Playwright itself computes the executable
// from the pinned browsers.json manifest, so upgrades keep working.

import { createRequire } from 'node:module'
import { execFileSync, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  accessSync, closeSync, constants, existsSync, lstatSync, openSync, readFileSync, readdirSync,
  rmdirSync, rmSync, statSync, writeFileSync, realpathSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, posix, resolve as resolvePath, sep } from 'node:path'
import { searchBoostHome } from '../config-paths.mjs'
import { terminateProcessTree } from '../process-tree.mjs'
import { ensurePrivateDir, readJsonStore, writeFileAtomicPrivate } from '../private-file.mjs'

const require = createRequire(import.meta.url)

export const NATIVE_PLATFORMS = ['xiaohongshu', 'zhihu', 'bilibili']

/** Persisted browser choices. `env` is a discovery source, never a choice. */
export const NATIVE_BROWSER_SOURCES = ['auto', 'system', 'managed']

/** Executable override for automatic discovery; explicit source choices remain authoritative. */
export const BROWSER_EXECUTABLE_ENV = 'SEARCH_BOOST_BROWSER_EXECUTABLE'

/** Upper bound on progress events forwarded for one explicit install. */
const MAX_PROGRESS_EVENTS = 100
/** Bounded discovery: at most this many browsers are reported and checked. */
const MAX_BROWSER_LIST = 24
/** Bounded PATH scan: the first entries only. */
const MAX_PATH_ENTRIES = 64
/** Short-lived cache so repeated read-only state renders do not re-probe the OS. */
const SCAN_CACHE_MS = 3_000

const MANAGED_BROWSER_KIND = 'search-boost-managed-browser'
const MANAGED_BROWSER_LEASE_KIND = 'search-boost-managed-browser-lease'
const MANAGED_OWNER_FILE = 'owned.json'
const MANAGED_REGISTRY_DIR = 'ms-playwright'
const MANAGED_LEASE_DIR = 'leases'
const MANAGED_LOCK_FILE = 'setup.lock'
const MANAGED_ROOT_ENTRIES = new Set([MANAGED_OWNER_FILE, MANAGED_REGISTRY_DIR, MANAGED_LEASE_DIR, MANAGED_LOCK_FILE])
const MANAGED_STATE_PARTS = ['state', 'community', 'browser']
const PLAYWRIGHT_BROWSERS_ENV = 'PLAYWRIGHT_BROWSERS_PATH'
const PLAYWRIGHT_MARKER_FILE = 'INSTALLATION_COMPLETE'

/** Playwright's own registry naming; mirrored from the pinned playwright-core. */
const PLAYWRIGHT_BROWSER_PREFIXES = new Set([
  'android', 'chromium', 'chromium-headless-shell', 'chromium-tip-of-tree', 'chromium-tip-of-tree-headless-shell',
  'ffmpeg', 'firefox', 'firefox-beta', 'webkit', 'winldd',
])

/** Executable tokens of chrome for testing, mirroring playwright-core 1.64. */
const PLAYWRIGHT_CHROMIUM_TOKENS = {
  'linux-x64': ['chrome-linux64', 'chrome'],
  'linux-arm64': ['chrome-linux-arm64', 'chrome'],
  'mac-x64': ['chrome-mac-x64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'],
  'mac-arm64': ['chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'],
  'win-x64': ['chrome-win64', 'chrome.exe'],
}

const MANAGED_BROWSER_REASONS = {
  not_installed: 'The SearchBoost-owned Chromium is not installed',
  incomplete: 'The SearchBoost-owned Chromium installation is incomplete; download it again',
  unresolvable: 'playwright-core is not installed; the owned Chromium cannot be resolved',
  unsafe: 'The SearchBoost-owned browser directory is not safe to use',
  not_owned: 'The SearchBoost-owned browser directory is not owned by SearchBoost',
}

const setupError = (kind, message) => Object.assign(new Error(message), { kind })

function pathStat(path) {
  try { return lstatSync(path) } catch (error) { if (error.code === 'ENOENT') return null; throw error }
}

/** True when the file exists and carries the platform's execute permission. */
function defaultExecutableCheck(file, platform = process.platform) {
  if (typeof file !== 'string' || !file || file.includes('\0')) return false
  try {
    if (!statSync(file).isFile()) return false
    accessSync(file, platform === 'win32' ? constants.F_OK : constants.X_OK)
    return true
  } catch { return false }
}

const isUsableBrowser = file => defaultExecutableCheck(file)

function isAbsoluteFor(platform, path) {
  if (platform === 'win32') return /^[A-Za-z]:[\\/]/.test(path) || /^\\\\[^\\]/.test(path)
  return path.startsWith('/')
}

function samePath(a, b, platform = process.platform) {
  return platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

/** True when `path` resolves inside `directory` (never used to follow links). */
function isInsideDirectory(path, directory, platform = process.platform) {
  const normalizedPath = resolvePath(path)
  const normalizedDir = resolvePath(directory)
  const prefix = normalizedDir.endsWith(sep) ? normalizedDir : normalizedDir + sep
  return platform === 'win32'
    ? normalizedPath.toLowerCase().startsWith(prefix.toLowerCase())
    : normalizedPath.startsWith(prefix)
}

/**
 * Walk owned state paths without following symlinks. Any symlinked or
 * non-directory ancestor means the path is not ours; never follow it.
 */
function walkOwnedState(parts, { create = false, kind = 'native_setup_unsafe', label = 'SearchBoost state' } = {}) {
  let path = searchBoostHome()
  const root = pathStat(path)
  if (root && (!root.isDirectory() || root.isSymbolicLink())) throw setupError(kind, `${label} home is not an owned directory`)
  for (const part of parts) {
    path = join(path, part)
    const stat = pathStat(path)
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw setupError(kind, `${label} ancestor is not an owned directory`)
    if (create) ensurePrivateDir(path)
  }
  return path
}

export const nativeHome = platform => {
  if (!NATIVE_PLATFORMS.includes(platform)) throw new Error('Unsupported native community platform')
  return join(searchBoostHome(), 'state', 'community', 'sessions', platform)
}
export const nativeProfilePath = platform => join(nativeHome(platform), 'profile')
export const nativeProfileOwnerPath = platform => join(nativeHome(platform), 'profile-owner.json')
export const nativeSessionMarkerPath = platform => join(nativeHome(platform), 'session.json')
export const nativeSessionLockPath = platform => join(nativeHome(platform), 'browser.lock')

/** Walk the owned state tree down to the platform directory. */
function ownedPlatformDir(platform, create = false) {
  nativeHome(platform) // Validate before any path creation.
  return walkOwnedState(['state', 'community', 'sessions', platform], { create })
}

/** Create the owned platform directory for an explicit login or launch. */
export function ensureNativeSessionHome(platform) {
  return ownedPlatformDir(platform, true)
}

/**
 * A profile is disposable only while it is a plain owned tree: no symlinks and
 * no multiply-linked files. A missing profile is not an error.
 */
export function assertOwnedProfile(profile) {
  if (!existsSync(profile)) return false
  const pending = [profile]; let count = 0
  while (pending.length) {
    const path = pending.pop(), stat = lstatSync(path)
    if (++count > 20_000 || stat.isSymbolicLink() || !stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1)) throw setupError('native_setup_unsafe', 'Native profile contains non-owned paths')
    if (stat.isDirectory()) for (const name of readdirSync(path)) pending.push(join(path, name))
  }
  return true
}

/** The validated owned-session marker for one platform, or null. */
export function nativeSessionRecord(platform) {
  try {
    ownedPlatformDir(platform)
    const profile = nativeProfilePath(platform)
    if (!existsSync(profile) || !lstatSync(profile).isDirectory() || lstatSync(profile).isSymbolicLink()) return null
    const ownerStat = pathStat(nativeProfileOwnerPath(platform))
    if (!ownerStat?.isFile() || ownerStat.isSymbolicLink() || ownerStat.nlink !== 1) return null
    const owner = readJsonStore(nativeProfileOwnerPath(platform)).doc
    const file = nativeSessionMarkerPath(platform)
    if (!existsSync(file) || !lstatSync(file).isFile() || lstatSync(file).nlink !== 1) return null
    const marker = readJsonStore(file).doc
    return marker?.schema_version === 1 && marker.platform === platform && typeof marker.revision === 'string'
      && owner?.platform === platform && typeof owner.profile_id === 'string' && marker.profile_id === owner.profile_id ? marker : null
  } catch { return null }
}

/**
 * True when the SearchBoost-owned platform directory holds anything (profile,
 * markers or Chromium state) — including a partial profile left by a cancelled
 * or failed login, which uninstall must still be able to remove.
 */
export function nativeSessionInstalled(platform) {
  try {
    const home = ownedPlatformDir(platform)
    if (!existsSync(home)) return false
    const stat = lstatSync(home)
    return stat.isDirectory() && !stat.isSymbolicLink() && readdirSync(home).length > 0
  } catch { return false }
}

// --- Local browser discovery -------------------------------------------------

const BROWSER_CHANNELS = [
  { id: 'chrome-canary', label: 'Google Chrome Canary', pattern: /chrome[ _-]?sxs|chrome[ _-]?canary/i },
  { id: 'chrome-beta', label: 'Google Chrome Beta', pattern: /chrome[ _-]?beta|google-chrome-beta/i },
  { id: 'chrome-dev', label: 'Google Chrome Dev', pattern: /chrome[ _-]?dev|google-chrome-unstable|google-chrome-dev/i },
  { id: 'chrome-for-testing', label: 'Chrome for Testing', pattern: /chrome for testing/i },
  { id: 'chromium', label: 'Chromium', pattern: /chromium/i },
  { id: 'chrome', label: 'Google Chrome', pattern: /chrome/i },
]

/**
 * Channel of an executable from its own name plus the nearest meaningful path
 * segments (bundle name, install directory), so a home directory that merely
 * contains the word "chromium" does not relabel the browser.
 */
function channelForPath(path) {
  const parts = String(path).replace(/\\/g, '/').split('/').filter(Boolean)
  const bundle = [...parts].reverse().find(part => /\.app$/i.test(part)) ?? ''
  const haystack = [parts.at(-1) ?? '', parts.at(-2) ?? '', parts.at(-3) ?? '', bundle].join(' ')
  return BROWSER_CHANNELS.find(channel => channel.pattern.test(haystack)) ?? BROWSER_CHANNELS.at(-1)
}

/** Windows paths joined with backslashes even when scanned from another OS. */
const winJoin = (platform, ...parts) => (platform === 'win32' ? parts.join('\\') : join(...parts))

/** Bounded list of well-known Chrome/Chromium executables for one OS. */
function wellKnownBrowserPaths({ platform, env, homeDir }) {
  if (platform === 'win32') {
    const programFiles = env.PROGRAMFILES || 'C:\\Program Files'
    const programFilesX86 = env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)'
    const local = env.LOCALAPPDATA || winJoin(platform, homeDir, 'AppData', 'Local')
    return [
      winJoin(platform, programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      winJoin(platform, programFiles, 'Google', 'Chrome Beta', 'Application', 'chrome.exe'),
      winJoin(platform, programFiles, 'Google', 'Chrome Dev', 'Application', 'chrome.exe'),
      winJoin(platform, local, 'Google', 'Chrome SxS', 'Application', 'chrome.exe'),
      winJoin(platform, programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      winJoin(platform, local, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      winJoin(platform, programFiles, 'Chromium', 'Application', 'chrome.exe'),
      winJoin(platform, local, 'Chromium', 'Application', 'chrome.exe'),
    ]
  }
  if (platform === 'darwin') {
    return ['/Applications', posix.join(homeDir, 'Applications')].flatMap(root => [
      posix.join(root, 'Google Chrome.app', 'Contents', 'MacOS', 'Google Chrome'),
      posix.join(root, 'Google Chrome Beta.app', 'Contents', 'MacOS', 'Google Chrome Beta'),
      posix.join(root, 'Google Chrome Dev.app', 'Contents', 'MacOS', 'Google Chrome Dev'),
      posix.join(root, 'Google Chrome Canary.app', 'Contents', 'MacOS', 'Google Chrome Canary'),
      posix.join(root, 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
    ])
  }
  return [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome-beta',
    '/usr/bin/google-chrome-unstable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
    '/opt/google/chrome/chrome',
  ]
}

/**
 * Bounded list of well-known Chrome/Chromium executables for this OS. This is a
 * fixed list, not a PATH or filesystem scan (legacy read-only helper; the
 * injectable scanner below is the discovery entry point).
 * @param {{ env?: NodeJS.ProcessEnv, homeDir?: string, platform?: string }} [options]
 */
export function systemBrowserCandidates(options = {}) {
  const platform = options.platform ?? process.platform
  return wellKnownBrowserPaths({ platform, env: options.env ?? process.env, homeDir: options.homeDir ?? homedir() })
    .filter(path => isAbsoluteFor(platform, path))
}

const WINDOWS_APP_PATHS_KEY = 'SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths'
const WINDOWS_APP_PATH_NAMES = ['chrome.exe', 'chromium.exe']

/** First REG_SZ value of a `reg query ... /ve` result, or null. */
function parseRegDefaultValue(raw) {
  for (const line of String(raw ?? '').split(/\r?\n/)) {
    if (!/REG_(?:EXPAND_)?SZ/i.test(line)) continue
    const value = line.replace(/^.*?REG_(?:EXPAND_)?SZ\s*/i, '').replace(/^"(.*)"$/, '$1').trim()
    if (value) return value
  }
  return null
}

/**
 * Registry App Paths for both registry views and both hives. Read-only
 * `reg.exe query ... /ve /reg:32|64`; bounded to 8 queries.
 */
function windowsRegistryBrowserPaths({ platform, env, probes, isExecutable }) {
  const found = []
  const reg = winJoin(platform, env.SystemRoot || env.SYSTEMROOT || env.WINDIR || 'C:\\Windows', 'System32', 'reg.exe')
  for (const hive of ['HKCU', 'HKLM']) {
    for (const view of ['32', '64']) {
      for (const name of WINDOWS_APP_PATH_NAMES) {
        const key = `${hive}\\${WINDOWS_APP_PATHS_KEY}\\${name}`
        const rawValue = parseRegDefaultValue(probes.execFileSync(reg, ['query', key, '/ve', `/reg:${view}`]))
        const value = rawValue?.replace(/%([A-Za-z0-9_]+)%/g, (match, name) => env[Object.keys(env).find(key => key.toLowerCase() === name.toLowerCase())] ?? match)
        if (!value || !/\.exe$/i.test(value) || !isAbsoluteFor(platform, value)) continue
        if (isExecutable(value)) found.push(value)
      }
    }
  }
  return found
}

/** Bounded Spotlight lookup (`mdfind`) for Chrome/Chromium bundles. */
function macSpotlightBrowserPaths({ homeDir, probes, isExecutable }) {
  const found = []
  const roots = ['/Applications', posix.join(homeDir, 'Applications')].filter(root => probes.existsSync(root))
  if (!roots.length) return found
  const queries = ['kMDItemCFBundleIdentifier == "com.google.Chrome*"', 'kMDItemCFBundleIdentifier == "org.chromium.Chromium"']
  for (const query of queries) {
    const raw = probes.execFileSync('/usr/bin/mdfind', [...roots.flatMap(root => ['-onlyin', root]), query])
    for (const line of String(raw ?? '').split('\n')) {
      const bundlePath = line.trim()
      if (!/\.app$/i.test(bundlePath)) continue
      for (const executable of ['Google Chrome', 'Google Chrome Beta', 'Google Chrome Dev', 'Google Chrome Canary', 'Google Chrome for Testing', 'Chromium']) {
        const path = posix.join(bundlePath, 'Contents', 'MacOS', executable)
        if (isExecutable(path)) { found.push(path); break }
      }
      if (found.length >= MAX_BROWSER_LIST) return found
    }
  }
  return found
}

const LINUX_PATH_NAMES = ['google-chrome', 'google-chrome-stable', 'google-chrome-beta', 'google-chrome-unstable', 'chromium', 'chromium-browser']

/** Bounded PATH candidates (the known absolute locations are checked separately). */
function linuxPathCandidates({ env, isExecutable }) {
  const found = []
  const directories = [...new Set(String(env.PATH ?? '').split(':').filter(part => part.startsWith('/')).slice(0, MAX_PATH_ENTRIES))]
  for (const directory of directories) {
    for (const name of LINUX_PATH_NAMES) {
      const path = posix.join(directory, name)
      if (isExecutable(path)) found.push(path)
    }
  }
  return found
}

const browserScanCache = new Map()

/**
 * Synchronous, read-only, bounded local Chrome/Chromium discovery.
 *
 * Windows: App Paths in HKCU/HKLM for both registry views (32/64) plus
 * well-known install roots for every Chrome channel and Chromium. macOS:
 * system and user Applications, all Chrome channels, plus a bounded Spotlight
 * lookup. Linux: known absolute locations plus bounded PATH candidates.
 *
 * @param {{
 *   platform?: string, env?: NodeJS.ProcessEnv, homeDir?: string,
 *   cache?: boolean,
 *   probes?: { isExecutable?: (path: string) => boolean, execFileSync?: (command: string, args: string[]) => string, existsSync?: (path: string) => boolean },
 * }} [options] injectable platform/env/probes (cross-platform tests)
 * @returns {Array<{ id: string, label: string, path: string, source: 'system'|'env' }>}
 */
export function scanNativeBrowsers(options = {}) {
  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  const homeDir = options.homeDir ?? homedir()
  const quick = options.quick === true
  const deadline = Date.now() + Math.max(1, Math.min(3000, options.budgetMs ?? 1200))
  const useCache = options.cache !== false && !options.probes && options.env === undefined && options.homeDir === undefined
  const cacheKey = useCache ? `${platform}\0${homeDir}\0${env.PATH ?? ''}\0${env[BROWSER_EXECUTABLE_ENV] ?? ''}\0${quick ? 'quick' : 'full'}` : null
  if (cacheKey) {
    const cached = quick ? browserScanCache.get(cacheKey.replace(/quick$/, 'full')) ?? browserScanCache.get(cacheKey) : browserScanCache.get(cacheKey)
    if (cached && Date.now() - cached.at < SCAN_CACHE_MS) return cached.list.map(entry => ({ ...entry }))
  }
  const injected = options.probes ?? {}
  const executableProbe = injected.isExecutable ?? (path => defaultExecutableCheck(path, platform))
  const isExecutable = path => { try { return Boolean(executableProbe(path)) } catch { return false } }
  const probes = {
    isExecutable,
    execFileSync: (command, args) => {
      const remaining = deadline - Date.now()
      if (remaining <= 0) return ''
      try {
        return (injected.execFileSync ?? execFileSync)(command, args, { encoding: 'utf8', timeout: Math.min(400, remaining), maxBuffer: 64_000, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
      } catch { return '' }
    },
    existsSync: injected.existsSync ?? existsSync,
  }

  const discovered = [...systemBrowserCandidates({ platform, env, homeDir })]
  if (!quick && platform === 'win32') discovered.push(...windowsRegistryBrowserPaths({ platform, env, probes, isExecutable }))
  else if (!quick && platform === 'darwin') discovered.push(...macSpotlightBrowserPaths({ homeDir, probes, isExecutable }))
  else if (platform !== 'win32' && platform !== 'darwin') discovered.push(...linuxPathCandidates({ env, isExecutable }))

  const overridePath = typeof env[BROWSER_EXECUTABLE_ENV] === 'string' ? env[BROWSER_EXECUTABLE_ENV].trim() : ''
  const seen = new Set()
  const usedIds = new Map()
  const list = []
  const add = (path, source) => {
    if (typeof path !== 'string' || !path || path.includes('\0') || !isAbsoluteFor(platform, path)) return
    const key = platform === 'win32' ? path.toLowerCase() : path
    if (seen.has(key)) return
    seen.add(key)
    const channel = channelForPath(path)
    const baseId = source === 'env' ? 'env' : channel.id
    const count = (usedIds.get(baseId) ?? 0) + 1
    usedIds.set(baseId, count)
    list.push({
      id: count === 1 ? baseId : `${baseId}-${count}`,
      label: source === 'env' ? 'Chrome / Chromium (SEARCH_BOOST_BROWSER_EXECUTABLE)' : channel.label,
      path,
      source,
    })
  }
  for (const path of discovered) {
    if (list.length >= MAX_BROWSER_LIST) break
    if (isExecutable(path)) add(path, 'system')
  }
  if (overridePath && isExecutable(overridePath)) add(overridePath, 'env')
  if (cacheKey) {
    if (browserScanCache.size > 8) browserScanCache.clear()
    browserScanCache.set(cacheKey, { at: Date.now(), list })
  }
  return list.map(entry => ({ ...entry }))
}

// --- Owned (managed) Chromium ------------------------------------------------

export const managedBrowserRoot = (options = {}) => join(searchBoostHome(options), ...MANAGED_STATE_PARTS)
export const managedRegistryPath = (options = {}) => join(managedBrowserRoot(options), MANAGED_REGISTRY_DIR)
export const managedBrowserLeaseDir = (options = {}) => join(managedBrowserRoot(options), MANAGED_LEASE_DIR)
export const managedBrowserLockPath = (options = {}) => join(managedBrowserRoot(options), MANAGED_LOCK_FILE)
export const managedBrowserOwnerPath = (options = {}) => join(managedBrowserRoot(options), MANAGED_OWNER_FILE)

function playwrightShortPlatform(platform, arch) {
  if (platform === 'win32') return 'win-x64'
  if (platform === 'darwin') return arch === 'arm64' ? 'mac-arm64' : 'mac-x64'
  return arch === 'arm64' ? 'linux-arm64' : 'linux-x64'
}

function readPlaywrightChromiumManifest(platform, arch) {
  const tokens = PLAYWRIGHT_CHROMIUM_TOKENS[playwrightShortPlatform(platform, arch)]
  if (!tokens) return { available: false, reason: 'The pinned playwright-core does not support this platform' }
  try {
    const packageJsonPath = require.resolve('playwright-core/package.json')
    const packageRoot = dirname(packageJsonPath)
    const browsers = JSON.parse(readFileSync(join(packageRoot, 'browsers.json'), 'utf8'))?.browsers
    const chromium = Array.isArray(browsers) ? browsers.find(browser => browser.name === 'chromium') : null
    if (!chromium || typeof chromium.revision !== 'string' || !/^\d+$/.test(chromium.revision)) {
      return { available: false, reason: 'The pinned playwright-core does not declare a Chromium revision' }
    }
    return {
      available: true,
      version: JSON.parse(readFileSync(packageJsonPath, 'utf8')).version ?? null,
      revision: chromium.revision,
      browserVersion: chromium.browserVersion ?? null,
      directoryName: `chromium-${chromium.revision}`,
      executableTokens: tokens,
      markerName: PLAYWRIGHT_MARKER_FILE,
    }
  } catch {
    return { available: false, reason: 'playwright-core is not installed; the owned Chromium cannot be resolved' }
  }
}

const manifestCache = new Map()

/**
 * Chromium descriptor of the pinned playwright-core installation (version,
 * revision, registry directory name and executable tokens), read from the
 * installed package's own browsers.json.
 * @param {{ platform?: string, arch?: string, manifest?: object }} [options]
 */
export function managedBrowserManifest(options = {}) {
  if (options.manifest) return options.manifest
  const platform = options.platform ?? process.platform
  const arch = options.arch ?? process.arch
  const key = `${platform}:${arch}`
  if (!manifestCache.has(key)) manifestCache.set(key, readPlaywrightChromiumManifest(platform, arch))
  return manifestCache.get(key)
}

/** Executable path inside the owned registry, or null without a manifest. */
export function managedBrowserExecutablePath(options = {}) {
  if (typeof options.managedExecutable === 'string' && options.managedExecutable) return options.managedExecutable
  const manifest = managedBrowserManifest(options)
  if (!manifest.available) return null
  return join(managedRegistryPath(options), manifest.directoryName, ...manifest.executableTokens)
}

function managedOwnerRecord(options = {}) {
  const file = managedBrowserOwnerPath(options)
  const stat = pathStat(file)
  if (!stat) return { present: false }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) return { present: true, invalid: true }
  const { doc, error } = readJsonStore(file)
  if (error || doc?.schema_version !== 1 || doc.kind !== MANAGED_BROWSER_KIND || typeof doc.root !== 'string' || !samePath(resolvePath(doc.root), resolvePath(managedBrowserRoot(options)))) return { present: true, invalid: true }
  return { present: true, doc }
}

/**
 * Create the owned browser root and its ownership marker. An existing
 * directory without a valid marker is never adopted: it may be user data.
 */
function ensureManagedOwner(options = {}) {
  const root = walkOwnedState(MANAGED_STATE_PARTS, { create: true, kind: 'managed_browser_unsafe', label: 'Managed browser' })
  const owner = managedOwnerRecord(options)
  if (owner.present && !owner.invalid) return root
  if (owner.invalid) throw setupError('managed_browser_unsafe', 'Managed browser directory is not owned by SearchBoost; refusing to use it')
  let entries = []
  try { entries = readdirSync(root) } catch { entries = [] }
  if (entries.length) throw setupError('managed_browser_unsafe', 'Managed browser directory already contains data not created by SearchBoost; refusing to adopt it')
  writeFileAtomicPrivate(managedBrowserOwnerPath(options), `${JSON.stringify({ schema_version: 1, kind: MANAGED_BROWSER_KIND, root, created_at: new Date().toISOString() }, null, 2)}\n`)
  return root
}

/**
 * Read-only state of the owned Chromium. `installed` means the owned root
 * holds data to remove (including a partial download), not that it is usable.
 * @returns {{ ready: boolean, installed: boolean, source: 'managed', path?: string, reason?: string }}
 */
export function managedBrowserStatus(options = {}) {
  const base = { source: 'managed' }
  const root = managedBrowserRoot(options)
  try { walkOwnedState(MANAGED_STATE_PARTS, { kind: 'managed_browser_unsafe', label: 'Managed browser' }) } catch { return { ...base, ready: false, installed: false, reason: 'unsafe' } }
  const rootStat = pathStat(root)
  if (!rootStat) return { ...base, ready: false, installed: false, reason: 'not_installed' }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) return { ...base, ready: false, installed: false, reason: 'unsafe' }
  const owner = managedOwnerRecord(options)
  if (!owner.present || owner.invalid) return { ...base, ready: false, installed: false, reason: 'not_owned' }
  const registry = managedRegistryPath(options)
  const registryStat = pathStat(registry)
  if (registryStat && (registryStat.isSymbolicLink() || !registryStat.isDirectory())) return { ...base, ready: false, installed: false, reason: 'unsafe' }
  if (!registryStat) return { ...base, ready: false, installed: true, reason: 'not_installed' }
  const manifest = managedBrowserManifest(options)
  const executable = managedBrowserExecutablePath(options)
  if (!manifest.available || !executable) return { ...base, ready: false, installed: true, reason: 'unresolvable' }
  // A browser counts as ready only when Playwright marked the download complete:
  // an interrupted download leaves an executable that must not be launched.
  const browserDirectory = join(managedRegistryPath(options), manifest.directoryName)
  const browserDirectoryStat = pathStat(browserDirectory)
  const markerStat = pathStat(join(browserDirectory, manifest.markerName))
  const complete = Boolean(browserDirectoryStat && browserDirectoryStat.isDirectory() && !browserDirectoryStat.isSymbolicLink()
    && markerStat && markerStat.isFile() && !markerStat.isSymbolicLink() && markerStat.nlink === 1)
  let safeExecutable = false
  try { safeExecutable = isInsideDirectory(realpathSync(executable), realpathSync(registry)) } catch { /* incomplete download */ }
  if (!complete || !safeExecutable || !isUsableBrowser(executable)) return { ...base, ready: false, installed: true, path: executable, reason: 'incomplete' }
  return { ...base, ready: true, installed: true, path: executable }
}

/** Active / dead / invalid state of a PID lock file. Never throws on a race. */
function lockFileState(file) {
  const stat = pathStat(file)
  if (!stat) return { state: 'absent' }
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) return { state: 'invalid' }
  let pid
  try { pid = Number(readFileSync(file, 'utf8').trim()) } catch (error) { return { state: error?.code === 'ENOENT' ? 'absent' : 'invalid' } }
  if (!Number.isSafeInteger(pid) || pid <= 0) return { state: 'invalid' }
  try {
    process.kill(pid, 0)
    return { state: 'active', pid }
  } catch (error) {
    return { state: error?.code === 'ESRCH' ? 'dead' : 'active', pid }
  }
}

/** Exclusive PID lock file; only a demonstrably dead PID is recovered. */
function takeOwnedLock(lockPath, message) {
  const attempt = () => {
    try { return openSync(lockPath, 'wx', 0o600) } catch (error) { if (error.code === 'EEXIST') return null; throw error }
  }
  let fd = attempt()
  if (fd === null) {
    const before = pathStat(lockPath)
    if (!before || before.isSymbolicLink() || !before.isFile() || before.nlink !== 1) throw setupError('managed_browser_unsafe', `${message}: the lock is not an owned file`)
    let pid
    try { pid = Number(readFileSync(lockPath, 'utf8').trim()) } catch { throw setupError('browser_busy', `${message}: the lock changed while checking`) }
    if (!Number.isSafeInteger(pid) || pid <= 0 || lockFileState(lockPath).state !== 'dead') throw setupError('browser_busy', `${message}: the lock is active`)
    const after = pathStat(lockPath)
    if (!after || after.ino !== before.ino || after.dev !== before.dev) throw setupError('browser_busy', `${message}: the lock changed while checking`)
    rmSync(lockPath, { force: true })
    fd = attempt()
    if (fd === null) throw setupError('browser_busy', `${message}: the lock was taken by another process`)
  }
  try { writeFileSync(fd, String(process.pid)) } catch {
    try { closeSync(fd) } catch { /* already closed */ }
    rmSync(lockPath, { force: true })
    throw setupError('managed_browser_unsafe', `${message}: could not write the lock`)
  }
  let released = false
  return () => {
    if (released) return
    released = true
    try { closeSync(fd) } catch { /* already closed */ }
    try { rmSync(lockPath, { force: true }) } catch { /* best effort */ }
  }
}

/** Hold the shared managed-browser setup lock (leases, install, removal). */
function withManagedSetupLock(options, fn) {
  const release = takeOwnedLock(managedBrowserLockPath(options), 'Managed browser setup is in progress')
  try { return fn() } finally { release() }
}

const LEASE_FILE_PATTERN = /^\d+-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/i

function managedLeaseState(options = {}) {
  const directory = managedBrowserLeaseDir(options)
  const stat = pathStat(directory)
  if (!stat) return { present: false, unsafe: false, active: [], stale: [], unknown: [] }
  if (stat.isSymbolicLink() || !stat.isDirectory()) return { present: true, unsafe: true, active: [], stale: [], unknown: [] }
  const active = [], stale = [], unknown = []
  for (const name of readdirSync(directory)) {
    const file = join(directory, name)
    const entry = pathStat(file)
    if (!LEASE_FILE_PATTERN.test(name) || !entry || entry.isSymbolicLink() || !entry.isFile() || entry.nlink !== 1) { unknown.push(name); continue }
    const { doc, error } = readJsonStore(file)
    if (error || doc?.schema_version !== 1 || doc.kind !== MANAGED_BROWSER_LEASE_KIND || !Number.isSafeInteger(doc.pid) || doc.pid <= 0) { unknown.push(name); continue }
    let alive = true
    try { process.kill(doc.pid, 0) } catch (failure) { alive = failure?.code !== 'ESRCH' }
    if (alive) active.push(file)
    else stale.push(file)
  }
  return { present: true, unsafe: false, active, stale, unknown }
}

/**
 * Take a cross-process lease on an active managed browser so
 * removeManagedBrowser refuses to delete it. Local choices (any other source)
 * return a safe no-op release function. A managed browser that is not ready
 * throws instead of allowing an unleased launch. The lease file is created
 * under the same shared setup lock removal takes, so no lease can be created
 * between the removal checks and the deletion. Lease validation depends only on
 * the owned-browser root marker and the executable; it never reads a platform
 * session profile marker.
 * @param {{ source?: string, path?: string }} browser resolved browser result
 * @param {{ env?: NodeJS.ProcessEnv }} [options]
 * @returns {() => void} idempotent release function
 */
export function acquireManagedBrowserLease(browser, options = {}) {
  if (!browser || browser.source !== 'managed') return () => {}
  if (browser.ready === false) throw setupError('browser_unavailable', 'The owned browser is not ready; reinstall before use')
  const path = typeof browser.path === 'string' ? browser.path : ''
  if (!path) throw setupError('browser_unavailable', 'The SearchBoost-owned Chromium is not ready; no launch lease can be acquired')
  if (!isInsideDirectory(path, managedRegistryPath(options))) {
    throw setupError('managed_browser_unsafe', 'Managed browser lease requested for a path outside the SearchBoost-owned browser directory')
  }
  walkOwnedState(MANAGED_STATE_PARTS, { kind: 'managed_browser_unsafe', label: 'Managed browser' })
  return withManagedSetupLock(options, () => {
    const owner = managedOwnerRecord(options)
    if (!owner.present || owner.invalid) throw setupError('managed_browser_unsafe', 'Managed browser directory is not owned by SearchBoost')
    if (!isUsableBrowser(path)) throw setupError('browser_unavailable', 'Owned browser executable is missing; reinstall the owned browser')
    const directory = managedBrowserLeaseDir(options)
    const stat = pathStat(directory)
    if (stat && (stat.isSymbolicLink() || !stat.isDirectory())) throw setupError('managed_browser_unsafe', 'Managed browser lease directory is not an owned directory')
    if (!stat) ensurePrivateDir(directory)
    const file = join(directory, `${process.pid}-${randomUUID()}.json`)
    writeFileAtomicPrivate(file, `${JSON.stringify({ schema_version: 1, kind: MANAGED_BROWSER_LEASE_KIND, pid: process.pid, created_at: new Date().toISOString(), path }, null, 2)}\n`)
    let released = false
    return () => {
      if (released) return
      released = true
      try {
        walkOwnedState(MANAGED_STATE_PARTS, { kind: 'managed_browser_unsafe', label: 'Managed browser' })
        const directoryStat = pathStat(directory), fileStat = pathStat(file)
        if (!directoryStat?.isDirectory() || directoryStat.isSymbolicLink() || !fileStat?.isFile() || fileStat.isSymbolicLink() || fileStat.nlink !== 1) return
        const { doc } = readJsonStore(file)
        if (doc?.kind !== MANAGED_BROWSER_LEASE_KIND || doc.pid !== process.pid || doc.path !== path) return
        rmSync(file)
      } catch { return /* Never release a lease through a changed/foreign path. */ }
      try { rmdirSync(directory) } catch { /* other leases or unknown files remain */ }
    }
  })
}

/** Playwright's own browser-directory naming, mirrored from the pinned source. */
function isPlaywrightBrowserDirectory(name) {
  const match = /^(.+)-(\d+)$/.exec(String(name))
  return Boolean(match && PLAYWRIGHT_BROWSER_PREFIXES.has(match[1]))
}

/**
 * Remove only the SearchBoost-owned browser root: the managed Chromium registry
 * (including a partial download), stale lease files and the ownership marker.
 * Synchronous so a caller can run it inside one guarded transaction.
 *
 * Refuses, before deleting anything: an unowned or symlinked root/ancestor, any
 * active platform browser.lock, any active managed-browser lease (race-guarded
 * by the shared setup lock) and any unrecognized data inside the owned root.
 * Symlinks inside the registry (macOS app bundles contain them) are unlinked,
 * never followed, and nothing outside the owned root is deleted.
 * @param {{ env?: NodeJS.ProcessEnv }} [options]
 * @returns {{ removed: boolean, reason?: string }}
 */
export function removeManagedBrowser(options = {}) {
  const root = managedBrowserRoot(options)
  walkOwnedState(MANAGED_STATE_PARTS, { kind: 'managed_browser_unsafe', label: 'Managed browser' })
  const rootStat = pathStat(root)
  if (!rootStat) return { removed: false, reason: 'absent' }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw setupError('managed_browser_unsafe', 'Managed browser path is not an owned directory')

  withManagedSetupLock(options, () => {
    const owner = managedOwnerRecord(options)
    if (!owner.present || owner.invalid) throw setupError('managed_browser_unsafe', 'Managed browser directory is not owned by SearchBoost; refusing to delete it')
    const unrecognized = readdirSync(root).find(name => !MANAGED_ROOT_ENTRIES.has(name))
    if (unrecognized) throw setupError('managed_browser_unsafe', 'Managed browser directory contains unrecognized data; refusing to delete it')
    for (const platform of NATIVE_PLATFORMS) {
      const lock = lockFileState(nativeSessionLockPath(platform))
      if (lock.state === 'active' || lock.state === 'invalid') throw setupError('browser_busy', `Platform ${platform} session is busy; refusing to remove the owned browser`)
    }
    const leases = managedLeaseState(options)
    if (leases.unsafe) throw setupError('managed_browser_unsafe', 'Managed browser lease directory is not an owned directory')
    if (leases.unknown.length) throw setupError('managed_browser_unsafe', 'Managed browser lease directory contains unrecognized data; refusing to delete it')
    if (leases.active.length) throw setupError('browser_busy', 'The owned browser is in use by another process; refusing to remove it')

    const registry = managedRegistryPath(options)
    const registryStat = pathStat(registry)
    if (registryStat && (registryStat.isSymbolicLink() || !registryStat.isDirectory())) throw setupError('managed_browser_unsafe', 'Managed browser registry is not an owned directory')
    if (registryStat) {
      const bad = readdirSync(registry).find(name => !isPlaywrightBrowserDirectory(name) && name !== '.links' && name !== '__dirlock')
      if (bad) throw setupError('managed_browser_unsafe', 'Managed browser registry contains unrecognized data; refusing to delete it')
      // fs.rm never follows symlinks: macOS bundle links are unlinked, not resolved.
      rmSync(registry, { recursive: true, force: false })
    }
    if (leases.present) rmSync(managedBrowserLeaseDir(options), { recursive: true, force: false })
    rmSync(managedBrowserOwnerPath(options), { force: false })
  })
  try { rmdirSync(root) } catch (error) {
    if (!['ENOTEMPTY', 'EEXIST', 'ENOENT'].includes(error.code)) throw error
  }
  return { removed: true }
}

// --- Preference and resolution ----------------------------------------------

export const nativeBrowserPreferencePath = (options = {}) => join(searchBoostHome(options), 'state', 'community', 'browser-preference.json')

/**
 * Stored browser choice, or `{ source: 'auto' }`. Read-only and resilient: a
 * missing preference uses `auto`; damaged/linked/unsupported preferences fail
 * closed instead of silently changing browser provenance.
 * @returns {{ source: 'auto'|'system'|'managed', path?: string }}
 */
export function readNativeBrowserPreference(options = {}) {
  const { exists, doc, error } = readJsonStore(nativeBrowserPreferencePath(options))
  if (!exists) return { source: 'auto' }
  const stat = pathStat(nativeBrowserPreferencePath(options))
  if (error || !stat?.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || doc?.schema_version !== 1 || !NATIVE_BROWSER_SOURCES.includes(doc.source)) throw setupError('browser_preference_invalid', 'Browser preference unreadable or invalid; repair browser-preference.json before changing source')
  if (doc.source === 'system') {
    if (typeof doc.path !== 'string' || !isAbsoluteFor(options.platform ?? process.platform, doc.path)) throw setupError('browser_preference_invalid', 'Stored local browser path invalid; repair browser-preference.json')
    return { source: 'system', path: doc.path }
  }
  return { source: doc.source }
}

/**
 * Persist a validated browser choice. A system path must be one of the local
 * browsers this module discovers; `managed` requires an installed owned
 * Chromium; `auto` clears the explicit choice. An invalid choice throws
 * `browser_selection_invalid` and writes nothing.
 * @param {{ source: 'auto'|'system'|'managed', path?: string }} choice
 * @param {{ env?: NodeJS.ProcessEnv, platform?: string, probes?: object }} [options]
 * @returns {ReturnType<typeof readNativeBrowserPreference>}
 */
export function selectNativeBrowser(choice = {}, options = {}) {
  readNativeBrowserPreference(options) // Refuse to overwrite damaged preference state.
  const source = choice?.source
  if (!NATIVE_BROWSER_SOURCES.includes(source)) throw setupError('browser_selection_invalid', 'Choose auto, system or managed')
  const record = { schema_version: 1, source, selected_at: new Date().toISOString() }
  if (source === 'system') {
    const path = choice.path
    if (typeof path !== 'string' || !path.trim() || path.includes('\0')) throw setupError('browser_selection_invalid', 'A local browser path is required')
    const platform = options.platform ?? process.platform
    const matches = entry => samePath(entry.path, path, platform)
    const match = scanNativeBrowsers({ ...options, quick: true }).find(matches) ?? scanNativeBrowsers(options).find(matches)
    if (!match) throw setupError('browser_selection_invalid', 'The selected browser is not one of the discovered local Chrome/Chromium installations')
    record.path = match.path
    record.id = match.id
  } else if (source === 'managed' && !managedBrowserStatus(options).ready) {
    throw setupError('browser_selection_invalid', 'The SearchBoost-owned Chromium is not installed yet; download it before selecting it')
  }
  walkOwnedState(['state', 'community'], { create: true, kind: 'browser_preference_invalid', label: 'Browser preference' })
  writeFileAtomicPrivate(nativeBrowserPreferencePath(options), `${JSON.stringify(record, null, 2)}\n`)
  return readNativeBrowserPreference(options)
}

/**
 * Resolve the single browser executable used by availability and launch.
 * Read-only: never installs, downloads or writes. Honours the stored
 * preference, an explicit `options.source`/`options.executable`, and the
 * SEARCH_BOOST_BROWSER_EXECUTABLE override (which always wins in `auto`).
 * @param {{ source?: 'auto'|'system'|'managed', executable?: string, env?: NodeJS.ProcessEnv,
 *           platform?: string, candidates?: string[], managedExecutable?: string, manifest?: object,
 *           preference?: { source: string, path?: string } }} [options]
 * @returns {{ ready: boolean, source: 'env'|'system'|'managed'|'none', path?: string, reason?: string }}
 */
export function resolveNativeBrowser(options = {}) {
  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  const executableProbe = options.probes?.isExecutable ?? (path => defaultExecutableCheck(path, platform))
  const usable = path => { try { return Boolean(executableProbe(path)) } catch { return false } }
  const preference = options.preference ?? readNativeBrowserPreference(options)
  const preferenceSource = NATIVE_BROWSER_SOURCES.includes(preference?.source) ? preference.source : 'auto'
  const preferencePath = preferenceSource === 'system' && typeof preference.path === 'string' && preference.path ? preference.path : null
  const requested = options.source ?? preferenceSource
  if (!NATIVE_BROWSER_SOURCES.includes(requested)) throw setupError('browser_selection_invalid', `Unknown browser source: ${String(requested)}`)

  const envPath = typeof env[BROWSER_EXECUTABLE_ENV] === 'string' ? env[BROWSER_EXECUTABLE_ENV].trim() : ''
  const unavailable = reason => ({ ready: false, source: requested, reason })
  const exact = (source, path) => usable(path)
    ? { ready: true, source, path }
    : {
        ready: false, source, path,
        reason: source === 'env' ? `${BROWSER_EXECUTABLE_ENV} is not an executable browser file`
          : source === 'managed' ? 'The SearchBoost-owned Chromium executable is missing'
            : 'The selected local browser is not an executable file',
      }
  const resolvedManaged = () => {
    const status = managedBrowserStatus(options)
    return status.ready
      ? { ready: true, source: 'managed', path: status.path }
      : {
          ready: false, source: 'managed',
          ...(status.path ? { path: status.path } : {}),
          reason: MANAGED_BROWSER_REASONS[status.reason] ?? 'The SearchBoost-owned Chromium is not usable',
        }
  }
  const resolvedSystem = () => {
    const candidates = options.candidates ?? scanNativeBrowsers(options).filter(entry => entry.source === 'system').map(entry => entry.path)
    for (const candidate of candidates) if (usable(candidate)) return { ready: true, source: 'system', path: candidate }
    return { ready: false, source: 'system', reason: 'No local Chrome or Chromium browser was found' }
  }

  if (options.executable !== undefined) {
    if (typeof options.executable !== 'string' || !options.executable) throw setupError('browser_selection_invalid', 'options.executable must be a browser executable path')
    const source = options.source !== undefined && options.source !== 'auto' ? options.source
      : envPath && samePath(options.executable, envPath, platform) ? 'env'
        : isInsideDirectory(options.executable, managedRegistryPath(options), platform) ? 'managed' : 'system'
    return exact(source, options.executable)
  }
  if (requested === 'env') {
    if (!envPath) return unavailable(`${BROWSER_EXECUTABLE_ENV} is not set`)
    return exact('env', envPath)
  }
  if (requested === 'system') {
    // A stored local path is honoured strictly: a path that stopped existing is
    // reported, not replaced by a different browser.
    if (preferencePath) return exact('system', preferencePath)
    return resolvedSystem()
  }
  if (requested === 'managed') return resolvedManaged()

  if (envPath) return exact('env', envPath)
  const system = resolvedSystem()
  if (system.ready) return system
  const managed = resolvedManaged()
  if (managed.ready) return managed
  return managedBrowserManifest(options).available
    ? {
        ready: false, source: 'managed',
        ...(managed.path ? { path: managed.path } : {}),
        reason: 'No local Chrome or Chromium browser was found; run the explicit browser setup to download the SearchBoost-owned Chromium',
      }
    : { ready: false, source: 'none', reason: 'No compatible Chromium browser found; run the explicit browser setup or set SEARCH_BOOST_BROWSER_EXECUTABLE' }
}

/**
 * Synchronous, read-only setup state for one platform. `session` means an
 * owned browser session was confirmed; `installed` means the owned session
 * directory holds something to remove (including a partial profile), not that
 * the browser or the session is ready.
 * @param {string} platform
 * @param {{ browser?: ReturnType<typeof resolveNativeBrowser>,
 *           localBrowsers?: ReturnType<typeof scanNativeBrowsers>,
 *           managedBrowser?: ReturnType<typeof managedBrowserStatus>,
 *           preference?: ReturnType<typeof readNativeBrowserPreference>,
 *           scanOptions?: object }} [options] pre-resolved values (test seams)
 */
export function nativeSetupState(platform, options = {}) {
  const scanOptions = options.scanOptions ?? { ...options, quick: options.discover !== true }
  let browser, preference
  try {
    preference = options.preference ?? readNativeBrowserPreference(scanOptions)
    browser = options.browser ?? resolveNativeBrowser({ ...scanOptions, preference })
  } catch { preference = { source: 'invalid' }; browser = { ready: false, source: 'none', reason: 'Browser preference unreadable; repair browser-preference.json' } }
  return {
    browser,
    session: nativeSessionRecord(platform) !== null,
    installed: nativeSessionInstalled(platform),
    localBrowsers: options.localBrowsers ?? scanNativeBrowsers(scanOptions),
    managedBrowser: options.managedBrowser ?? managedBrowserStatus(scanOptions),
    preference,
  }
}

/** Chromium executable path of the pinned playwright-core install layout. */
export function playwrightChromiumPath() {
  return managedBrowserExecutablePath()
}

// --- Explicit install --------------------------------------------------------

/** Resolve playwright-core's own CLI; the install never goes through a shell. */
function playwrightCliPath() {
  try {
    const cli = join(dirname(require.resolve('playwright-core/package.json')), 'cli.js')
    return existsSync(cli) ? cli : null
  } catch { return null }
}

/** Progress lines look like `|■■  | 42% of 153.2 MiB`; anything else is ignored. */
function downloadPercent(line) {
  const match = /(\d{1,3})%\s+of\s+[\d.]+\s*MiB/.exec(line)
  if (!match) return null
  const percent = Number(match[1])
  return Number.isFinite(percent) ? Math.min(100, Math.max(0, Math.trunc(percent))) : null
}

/**
 * Explicitly download the pinned Playwright Chromium (and its headless shell)
 * through playwright-core's own CLI — its documented install entry point for
 * 1.64.0, where `install chromium` covers both binaries headless retrieval
 * needs. The download is isolated: the child process gets an explicit
 * PLAYWRIGHT_BROWSERS_PATH pointing at the SearchBoost-owned registry, so the
 * shared Playwright cache and any global environment are never touched. The
 * owned root and its ownership marker are claimed first, and the shared setup
 * lock is held for the whole download. No shell is involved, progress is
 * reduced to integer percentages, and errors never echo raw download output.
 * @param {{ onProgress?: (event: { phase: string, percent?: number }) => void,
 *           env?: NodeJS.ProcessEnv, spawnImpl?: typeof spawn,
 *           signal?: AbortSignal, timeoutMs?: number, terminate?: typeof terminateProcessTree }} [options]
 */
export async function installPlaywrightChromium({ onProgress, env = process.env, spawnImpl = spawn, signal, timeoutMs = 600_000, terminate = terminateProcessTree } = {}) {
  signal?.throwIfAborted()
  const cli = playwrightCliPath()
  if (!cli) throw setupError('browser_unavailable', 'playwright-core is not installed; install a Chromium browser manually or set SEARCH_BOOST_BROWSER_EXECUTABLE')
  const registry = managedRegistryPath()
  ensureManagedOwner()
  const releaseSetupLock = takeOwnedLock(managedBrowserLockPath(), 'Another browser setup is in progress')
  try {
    // Copy the caller's environment; the process environment is never mutated and
    // any inherited PLAYWRIGHT_BROWSERS_PATH is overridden for this child only.
    const childEnv = { ...env, [PLAYWRIGHT_BROWSERS_ENV]: registry }
    await new Promise((resolve, reject) => {
      let settled = false, lastPercent = -1, events = 0, buffer = '', child, pendingError, deadline, escalation
      const finish = error => {
        if (settled) return
        settled = true
        clearTimeout(deadline); clearTimeout(escalation)
        signal?.removeEventListener('abort', abort)
        if (error) reject(error)
        else resolve()
      }
      const emit = event => {
        if (events >= MAX_PROGRESS_EVENTS) return
        events++
        try { onProgress?.(event) } catch { /* progress is advisory */ }
      }
      const consume = chunk => {
        buffer = (buffer + chunk).slice(-8192)
        const lines = buffer.split(/\r?\n/)
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          const percent = downloadPercent(line)
          if (percent === null || percent === lastPercent) continue
          lastPercent = percent
          emit({ phase: 'download', percent })
        }
      }
      const stop = error => {
        if (settled || pendingError) return
        pendingError = error
        terminate(child, 'SIGTERM')
        escalation = setTimeout(() => { terminate(child, 'SIGKILL'); finish(error) }, 2000)
      }
      const abort = () => stop(setupError('browser_install_cancelled', 'Chromium download cancelled'))
      try {
        child = spawnImpl(process.execPath, [cli, 'install', 'chromium'], { env: childEnv, shell: false, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
      } catch { finish(setupError('browser_install_failed', 'Could not start the Playwright Chromium download')); return }
      deadline = setTimeout(() => stop(setupError('browser_install_failed', 'Chromium download timed out')), timeoutMs)
      signal?.addEventListener('abort', abort, { once: true })
      if (signal?.aborted) abort()
      child.stdout?.on('data', consume)
      child.stderr?.on('data', consume)
      child.on?.('error', () => finish(setupError('browser_install_failed', 'Could not start the Playwright Chromium download')))
      child.on?.('close', code => finish(pendingError ?? (code === 0 ? null
        : setupError('browser_install_failed', `Playwright Chromium download failed (exit code ${Number.isInteger(code) ? code : 'unknown'})`))))
    })
  } finally {
    releaseSetupLock()
  }
}

/**
 * Explicitly user-triggered browser setup: discover a local browser for `auto`
 * (or the explicitly requested source) and download the owned Chromium only
 * when a download is the selected path. Fails closed — a failed download
 * throws and this never reports a ready browser.
 * @param {{ source?: 'auto'|'system'|'managed', executable?: string,
 *           onProgress?: (event: { phase: 'discover'|'install'|'download'|'verify'|'ready', percent?: number, source?: string, action?: string }) => void,
 *           signal?: AbortSignal, env?: NodeJS.ProcessEnv,
 *           resolveBrowser?: typeof resolveNativeBrowser,
 *           preference?: ReturnType<typeof readNativeBrowserPreference>,
 *           install?: (context: { onProgress?: (event: any) => void, signal?: AbortSignal, env?: NodeJS.ProcessEnv }) => Promise<void> }} [options]
 * @returns {Promise<{ browser: ReturnType<typeof resolveNativeBrowser>, action: 'discovered'|'installed' }>}
 */
export async function ensureNativeBrowser(options = {}) {
  options.signal?.throwIfAborted()
  const onProgress = options.onProgress
  const report = event => { try { onProgress?.(event) } catch { /* progress is advisory */ } }
  const preference = options.preference ?? readNativeBrowserPreference(options)
  const requested = options.source ?? preference.source ?? 'auto'
  if (!NATIVE_BROWSER_SOURCES.includes(requested)) throw setupError('browser_selection_invalid', `Unknown browser source: ${String(requested)}`)
  const resolveBrowser = options.resolveBrowser ?? resolveNativeBrowser
  report({ phase: 'discover' })
  const found = resolveBrowser({ ...options, preference, source: requested })
  if (found.ready) {
    report({ phase: 'ready', source: found.source, action: 'discovered' })
    return { browser: found, action: 'discovered' }
  }
  if (found.source === 'env') throw setupError('browser_unavailable', 'Fix SEARCH_BOOST_BROWSER_EXECUTABLE before browser setup; no download started')
  if (requested === 'system') throw setupError('browser_unavailable', 'No local Chrome or Chromium browser was found; install one or choose the SearchBoost-owned Chromium download')
  report({ phase: 'install', source: 'managed' })
  const install = options.install ?? (context => installPlaywrightChromium(context))
  await install({ onProgress: report, signal: options.signal, ...(options.env ? { env: options.env } : {}) })
  options.signal?.throwIfAborted()
  report({ phase: 'verify' })
  const installed = resolveBrowser({ ...options, preference, source: 'managed', executable: undefined })
  if (!installed.ready) throw setupError('browser_install_failed', 'Playwright Chromium download did not produce a usable browser')
  report({ phase: 'ready', source: installed.source, action: 'installed' })
  return { browser: installed, action: 'installed' }
}

/**
 * Remove only the SearchBoost-owned session directory for one platform
 * (profile, ownership marker, session marker) and nothing else. Synchronous so
 * a caller can run it inside one guarded configuration transaction.
 *
 * Refuses, before deleting anything: an unsupported platform, a symlinked or
 * non-directory ancestor/profile, a live or unresolved browser.lock, a
 * non-owned profile tree, and a marker belonging to another platform. It never
 * touches an OS browser installation, a personal browser profile or the shared
 * Playwright browser cache. The owned Chromium is removed by
 * removeManagedBrowser instead.
 * @param {string} platform
 * @returns {{ removed: boolean, reason?: string }}
 */
export function removeNativeSession(platform) {
  if (!NATIVE_PLATFORMS.includes(platform)) throw setupError('native_setup_invalid', 'Unsupported native community platform')
  const home = ownedPlatformDir(platform)
  if (!existsSync(home)) return { removed: false, reason: 'absent' }
  const stat = lstatSync(home)
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw setupError('native_setup_unsafe', 'Native session path is not an owned directory')
  const lock = nativeSessionLockPath(platform)
  let fd
  try { fd = openSync(lock, 'wx', 0o600) } catch (error) {
    if (error.code === 'EEXIST') throw setupError('session_busy', 'Native platform session is busy or holds an unresolved browser.lock; never remove an active lock')
    throw setupError('native_setup_unsafe', 'Cannot lock owned platform state for removal')
  }
  try {
    writeFileSync(fd, String(process.pid))
    const allowed = new Set(['profile', 'profile-owner.json', 'session.json', 'browser.lock'])
    if (readdirSync(home).some(name => !allowed.has(name))) throw setupError('native_setup_unsafe', 'Native session directory contains unrecognized data; refusing to delete it')
    const profile = nativeProfilePath(platform), profileStat = pathStat(profile)
    if (profileStat && (!profileStat.isDirectory() || profileStat.isSymbolicLink())) throw setupError('native_setup_unsafe', 'Native profile path is not an owned directory')
    if (profileStat) assertOwnedProfile(profile)
    const ownerPath = nativeProfileOwnerPath(platform), ownerStat = pathStat(ownerPath)
    if (ownerStat && (!ownerStat.isFile() || ownerStat.nlink !== 1 || ownerStat.isSymbolicLink())) throw setupError('native_setup_unsafe', 'Native ownership marker is not an owned file')
    const { doc: owner, error: ownerError } = readJsonStore(ownerPath)
    if (ownerStat && (ownerError || owner?.platform !== platform || typeof owner.profile_id !== 'string' || !owner.profile_id)) throw setupError('native_setup_unsafe', 'Native ownership marker is invalid')
    if (!ownerStat && profileStat && readdirSync(profile).length) throw setupError('native_setup_unsafe', 'Refusing to delete a non-empty profile without an ownership marker')
    const markerPath = nativeSessionMarkerPath(platform), markerStat = pathStat(markerPath)
    if (markerStat) {
      if (!markerStat.isFile() || markerStat.nlink !== 1 || markerStat.isSymbolicLink()) throw setupError('native_setup_unsafe', 'Native session marker is not an owned file')
      const { doc, error } = readJsonStore(markerPath)
      if (error || !owner || doc?.schema_version !== 1 || doc.platform !== platform || doc.profile_id !== owner.profile_id) throw setupError('native_setup_unsafe', 'Native session marker does not match the owned profile')
    }
    // Keep browser.lock held while removing profile data. Never recursively
    // remove the parent after unlocking: a fresh login may have started there.
    if (profileStat) rmSync(profile, { recursive: true, force: false })
    if (markerStat) rmSync(markerPath)
    if (ownerStat) rmSync(ownerPath)
    return { removed: true }
  } finally {
    closeSync(fd)
    rmSync(lock, { force: true })
    try { rmdirSync(home) } catch (error) {
      if (!['ENOTEMPTY', 'EEXIST', 'ENOENT'].includes(error.code)) throw error
    }
  }
}
