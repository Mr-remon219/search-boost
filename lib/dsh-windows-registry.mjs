/** Read-only Windows installer metadata. Never execute registry command strings. */
import { spawnSync } from 'node:child_process'
import { win32 } from 'node:path'

const PRODUCT = 'DeepSeek Harness'
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
  const path = value.trim().replace(/%([^%]+)%/g, (match, key) => variables.get(key.toLowerCase()) ?? match)
  return path && !path.includes('%') ? path : null
}

function installLocation(value, env) {
  let path = expandedPath(value, env)
  if (path?.startsWith('"') && path.endsWith('"')) path = path.slice(1, -1)
  return path && !path.includes('"') && win32.isAbsolute(path) && !/^[\\/](?![\\/])/.test(path)
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
export function windowsDesktopInstallDirectories({ platform = process.platform, env = process.env, run = spawnSync } = {}) {
  if (platform !== 'win32') return []
  const systemRoot = installLocation(env.SystemRoot ?? env.SYSTEMROOT ?? env.WINDIR, env)
  if (!systemRoot) return []
  try {
    const result = run(win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', REGISTRY_SCRIPT],
      { encoding: 'utf8', windowsHide: true, shell: false, timeout: 5_000, maxBuffer: 1_048_576 })
    if (result.error || result.status !== 0) return []
    const parsed = JSON.parse(String(result.stdout ?? '').replace(/^\uFEFF/, '').trim())
    return desktopRegistryInstallDirectories(Array.isArray(parsed) ? parsed : [parsed], { env })
  } catch { return [] }
}
