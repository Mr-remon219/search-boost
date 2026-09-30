import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { runCommand } from './upgrade/process.mjs'
import { isAbsolute, join, resolve } from 'node:path'
import { commandExists } from './mcp-entry.mjs'
import { PKG_ROOT } from './pkg.mjs'
import { shellArgs } from './shell-args.mjs'

/** Manifest name from grok-plugin/plugin.json (marketplace installs) */
export const GROK_PLUGIN_NAME = 'search-boost'

/** @param {string} p */
function normalizePath(p) {
  const normalized = resolve(p).replace(/\\/g, '/').replace(/\/+$/, '')
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

/** @param {string} dir */
function tryRealpath(dir) {
  try {
    return realpathSync.native(dir)
  } catch {
    return dir
  }
}

/** @returns {string} Absolute path to bundled grok-plugin/ directory */
export function resolveGrokPluginDir() {
  return join(PKG_ROOT, 'grok-plugin')
}

/** @returns {boolean} Whether `grok` is on PATH */
export function grokCliAvailable() {
  return commandExists('grok')
}

/** @returns {string[]} argv for `grok plugin install … --trust` */
export function grokPluginInstallArgs() {
  return ['plugin', 'install', resolveGrokPluginDir(), '--trust']
}

/** Installed listings vary between a bare array and a { plugins } envelope. */
export function parseGrokPluginList(text) {
  const parsed = JSON.parse(text)
  const plugins = Array.isArray(parsed) ? parsed : parsed?.plugins
  if (!Array.isArray(plugins) || plugins.some(p => !p || typeof p !== 'object' || Array.isArray(p)
    || ['name', 'source', 'path'].some(key => p[key] != null && typeof p[key] !== 'string')
    || (typeof p.name === 'string' && (!p.name.trim() || p.name.startsWith('-') || p.name.includes('\0'))))) {
    throw new Error('Unsupported Grok plugin list format.')
  }
  return plugins
}

export function grokPluginSourceMatches(source, target = resolveGrokPluginDir()) {
  return typeof source === 'string' && isAbsolute(source)
    && normalizePath(tryRealpath(source)) === normalizePath(tryRealpath(target))
}

function declaresSearchBoost(dir) {
  if (typeof dir !== 'string' || !isAbsolute(dir)) return false
  for (const file of ['plugin.json', '.grok-plugin/plugin.json', '.claude-plugin/plugin.json']) {
    try {
      // Old invalid-author installs may be listed under a directory slug. Read
      // identity without asking the host to load that invalid manifest.
      if (JSON.parse(readFileSync(join(dir, file), 'utf8')).name === GROK_PLUGIN_NAME) return true
    } catch { /* missing/invalid manifest is not ownership evidence */ }
  }
  return false
}

/** Find current and legacy registrations; never infer ownership from repo_key. */
export function findInstalledGrokPlugin(plugins) {
  return plugins.find(p => p.name === GROK_PLUGIN_NAME)
    ?? plugins.find(p => grokPluginSourceMatches(p.source) || declaresSearchBoost(p.path) || declaresSearchBoost(p.source))
    ?? null
}

/** The native uninstall argument is the listed plugin name, not repo_key. */
export async function resolveInstalledGrokPluginId() {
  try {
    const result = await runCommand('grok', ['plugin', 'list', '--json'], { timeoutMs: 15_000 })
    if (result.code !== 0 || result.error) return GROK_PLUGIN_NAME
    const plugin = findInstalledGrokPlugin(parseGrokPluginList(result.stdout))
    return plugin ? plugin.name ?? GROK_PLUGIN_NAME : null
  } catch { return GROK_PLUGIN_NAME }
}

/** @param {string} [pluginId] */
export function grokPluginUninstallArgs(pluginId) {
  return ['plugin', 'uninstall', pluginId ?? GROK_PLUGIN_NAME]
}

/** @returns {string} Human-readable grok install command */
export function grokPluginInstallCommandLine() {
  return `grok ${shellArgs(grokPluginInstallArgs())}`
}

/** @param {string} [pluginId] */
export function grokPluginUninstallCommandLine(pluginId) {
  return `grok ${shellArgs(grokPluginUninstallArgs(pluginId))}`
}

/**
 * Diagnostics appended to a failed `grok plugin install`.
 *
 * Windows-only: the grok CLI there answers "no plugins found in the source" when
 * the plugin source path exceeds ~55 characters (a Windows round measured 55
 * working and 56 failing; ASCII and CJK paths behaved identically at the same
 * length, so encoding is not a factor). The same CLI accepts long paths on Linux,
 * so nothing is skipped or pre-checked up front — this only explains a failure
 * that already happened on Windows.
 *
 * @param {string} pluginDir
 * @param {NodeJS.Platform} [platform] injectable so the result is deterministic per OS
 * @returns {string} Hint text, or '' on platforms that cannot hit this.
 */
export function grokInstallFailureHint(pluginDir, platform = process.platform) {
  if (platform !== 'win32') return ''
  const dir = String(pluginDir ?? '')
  return [
    `plugin source: ${dir} (${dir.length} characters)`,
    'on Windows the grok CLI rejects plugin sources whose path exceeds ~55 characters ("no plugins found in the source"); copy grok-plugin to a shorter path (e.g. C:\\sb\\grok-plugin) and run the command above against that copy.',
  ].join('\n  ')
}

/** @param {string} reason @param {string} cmdLine @param {string} pluginDir */
function warnInstallFailure(reason, cmdLine, pluginDir) {
  const hint = grokInstallFailureHint(pluginDir)
  console.warn(`grok plugin install failed (${reason}) — run manually:\n  ${cmdLine}${hint ? `\n  ${hint}` : ''}`)
}

/**
 * @param {{ dryRun?: boolean, skip?: boolean }} [opts]
 * @returns {{ ok: boolean, skipped?: boolean, dryRun?: boolean, missingCli?: boolean, exitCode?: number|null }}
 */
export async function installGrokPlugin(opts = {}) {
  const { dryRun = false, skip = false } = opts
  if (skip) return { ok: true, skipped: true }

  const cmdLine = grokPluginInstallCommandLine()
  const pluginDir = resolveGrokPluginDir()
  if (!existsSync(pluginDir)) {
    console.warn(`grok plugin directory missing (${pluginDir}) — install manually:\n  ${cmdLine}`)
    return { ok: false }
  }

  if (dryRun) {
    console.log(`Would run: ${cmdLine}`)
    return { ok: true, dryRun: true }
  }

  if (!grokCliAvailable()) {
    console.warn(`grok CLI not found on PATH — install plugin manually:\n  ${cmdLine}`)
    return { ok: true, missingCli: true }
  }

  let result
  try {
    result = await runCommand('grok', grokPluginInstallArgs(), { timeoutMs: 60_000 })
  } catch {
    warnInstallFailure('command could not start', cmdLine, pluginDir)
    return { ok: false }
  }
  if (result.error) {
    warnInstallFailure(result.error.message, cmdLine, pluginDir)
    return { ok: false, exitCode: result.code ?? null }
  }
  if (result.code !== 0) {
    warnInstallFailure(`exit ${result.code}`, cmdLine, pluginDir)
    return { ok: false, exitCode: result.code ?? null }
  }
  try {
    const listing = await runCommand('grok', ['plugin', 'list', '--json'], { timeoutMs: 15_000 })
    if (listing.code !== 0 || listing.error || !parseGrokPluginList(listing.stdout)
      .some(p => p.name === GROK_PLUGIN_NAME && grokPluginSourceMatches(p.source, pluginDir))) throw new Error('unverified registration')
  } catch {
    warnInstallFailure('host did not verify the manifest name/current plugin source', cmdLine, pluginDir)
    return { ok: false }
  }
  return { ok: true }
}

/**
 * @param {{ dryRun?: boolean, skip?: boolean }} [opts]
 * @returns {{ ok: boolean, skipped?: boolean, dryRun?: boolean, missingCli?: boolean, exitCode?: number|null }}
 */
export async function uninstallGrokPlugin(opts = {}) {
  const { dryRun = false, skip = false } = opts
  if (skip) return { ok: true, skipped: true }

  const fallbackCmd = `grok plugin uninstall ${GROK_PLUGIN_NAME}`

  if (dryRun) {
    console.log(`Would run: ${fallbackCmd}`)
    return { ok: true, dryRun: true }
  }

  if (!grokCliAvailable()) {
    console.warn(`grok CLI not found on PATH — uninstall plugin manually:\n  ${fallbackCmd}`)
    return { ok: true, missingCli: true }
  }

  const pluginId = await resolveInstalledGrokPluginId()
  if (pluginId === null) return { ok: true, skipped: true }
  const uninstallArgs = grokPluginUninstallArgs(pluginId)
  const cmdLine = grokPluginUninstallCommandLine(pluginId)

  const result = await runCommand('grok', uninstallArgs, { timeoutMs: 60_000 })
  if (result.error) {
    console.warn(`grok plugin uninstall failed (${result.error.message}) — run manually:\n  ${cmdLine}`)
    return { ok: false, exitCode: result.code ?? null }
  }
  if (result.code !== 0) {
    console.warn(`grok plugin uninstall failed (exit ${result.code}) — run manually:\n  ${cmdLine}`)
    return { ok: false, exitCode: result.code ?? null }
  }
  // A zero exit is not removal evidence (including old invalid-author slugs).
  try {
    const listing = await runCommand('grok', ['plugin', 'list', '--json'], { timeoutMs: 15_000 })
    if (listing.code !== 0 || listing.error) throw new Error('unavailable listing')
    const plugins = parseGrokPluginList(listing.stdout)
    if (plugins.some(p => p.name === pluginId) || findInstalledGrokPlugin(plugins)) throw new Error('plugin remains registered')
  } catch {
    console.warn(`grok plugin removal was not verified — inspect the host plugin list and retry:\n  ${cmdLine}`)
    return { ok: false, exitCode: result.code ?? null }
  }
  return { ok: true }
}
