/** Read-only Windows installer metadata. Never execute registry command strings. */
import { spawnSync } from 'node:child_process'
import { win32 } from 'node:path'

const PRODUCT = 'DeepSeek Harness'
// Cache only registry transport data, not expanded paths or existence checks.
// A short TTL avoids repeated blocking PowerShell startups while still finding
// a Desktop installed/moved during an open TUI session. Injected runners isolate
// tests from production state, including negative transport results.
const REGISTRY_CACHE_TTL_MS = 10_000
const registryCache = new WeakMap()
// Fixed script: no registry values, paths or caller arguments enter PowerShell code.
// UTF-8 preserves non-ASCII custom install directories through the output pipe.
const REGISTRY_SCRIPT = `
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$roots = @(
  'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
  'HKCU:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
  'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
  'HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'
)
$entries = @(Get-ItemProperty -Path $roots -ErrorAction SilentlyContinue |
  Where-Object { $_.DisplayName -match '^DeepSeek Harness(?: \\d[0-9A-Za-z.+-]*)?$' } |
  Select-Object DisplayName,InstallLocation,DisplayIcon,UninstallString)
ConvertTo-Json -InputObject $entries -Compress
`

function expandedPath(value, env) {
  if (typeof value !== 'string' || /[\0\r\n]/.test(value)) return null
  const variables = new Map(Object.entries(env).map(([key, val]) => [key.toLowerCase(), val]))
  let unresolved = false
  const path = value.trim().replace(/%([^%]+)%/g, (match, key) => {
    const replacement = variables.get(key.toLowerCase())
    if (replacement === undefined) { unresolved = true; return match }
    return replacement
  })
  return path && !unresolved ? path : null
}

function installLocation(value, env) {
  let path = expandedPath(value, env)
  if (path?.startsWith('"') && path.endsWith('"')) path = path.slice(1, -1)
  return path && !path.includes('"') && /^[a-z]:[\\/]/i.test(path)
    ? win32.normalize(path) : null
}

function executableDirectory(value, name, env, icon = false) {
  const text = expandedPath(value, env)
  if (!text) return null
  // Quoted command strings may have flags; unquoted uninstall paths with spaces
  // are accepted only through the known executable name, never split on spaces.
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = text.startsWith('"')
    ? /^"([^"]+)"(?:\s|,|$)/.exec(text)
    : icon ? /^(.*?)(?:,\s*-?\d+)?$/.exec(text)
      : new RegExp(`^(.*[\\\\/]${escapedName})(?:\\s|$)`, 'i').exec(text)
  const executable = match && installLocation(match[1], env)
  return executable && win32.basename(executable).toLowerCase() === name.toLowerCase()
    ? win32.dirname(executable) : null
}

/** Translate only this product's entries, preferring its explicit install root. */
export function desktopRegistryInstallDirectories(entries, { env = process.env } = {}) {
  if (!Array.isArray(entries)) return []
  const directories = []
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object' || typeof entry.DisplayName !== 'string'
      || !/^DeepSeek Harness(?: \d[0-9A-Za-z.+-]*)?$/i.test(entry.DisplayName)) continue
    const dir = installLocation(entry.InstallLocation, env)
      ?? executableDirectory(entry.DisplayIcon, `${PRODUCT}.exe`, env, true)
      ?? executableDirectory(entry.UninstallString, `Uninstall ${PRODUCT}.exe`, env)
    if (dir) directories.push(dir)
  }
  return directories.filter((dir, index) => directories.findIndex(other => other.toLowerCase() === dir.toLowerCase()) === index)
}

/** Per-user + machine, native + WOW6432Node; unavailable registry is non-fatal. */
export function windowsDesktopInstallDirectories({ platform = process.platform, env = process.env, run = spawnSync, now = Date.now } = {}) {
  if (platform !== 'win32') return []
  const systemRoot = installLocation(env.SystemRoot ?? env.SYSTEMROOT ?? env.WINDIR, env)
  if (!systemRoot) return []
  let cache = registryCache.get(run)
  if (!cache) { cache = new Map(); registryCache.set(run, cache) }
  const key = systemRoot.toLowerCase(), timestamp = now(), cached = cache.get(key)
  if (cached && timestamp < cached.expires) return desktopRegistryInstallDirectories(cached.entries, { env })
  // Cache failures too so blocked/unavailable PowerShell is not retried for
  // every status row. After the TTL the normal discovery query can run again.
  cache.set(key, { entries: [], expires: timestamp + REGISTRY_CACHE_TTL_MS })
  try {
    const result = run(win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', REGISTRY_SCRIPT],
      { encoding: 'utf8', windowsHide: true, shell: false, timeout: 5_000, maxBuffer: 1_048_576 })
    if (result.error || result.status !== 0) return []
    const parsed = JSON.parse(String(result.stdout ?? '').replace(/^\uFEFF/, '').trim())
    const entries = Array.isArray(parsed) ? parsed : [parsed]
    cache.set(key, { entries, expires: now() + REGISTRY_CACHE_TTL_MS })
    return desktopRegistryInstallDirectories(entries, { env })
  } catch { return [] }
}
