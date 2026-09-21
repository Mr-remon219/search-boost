import { existsSync, realpathSync } from 'node:fs'
import { runCommand } from './upgrade/process.mjs'
import { join } from 'node:path'
import { commandExists } from './mcp-entry.mjs'
import { PKG_ROOT } from './pkg.mjs'
import { shellArgs } from './shell-args.mjs'

/** Manifest name from grok-plugin/plugin.json (marketplace installs) */
export const GROK_PLUGIN_NAME = 'search-boost'

/** @param {string} p */
function normalizePath(p) {
  return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
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

/**
 * Resolve installed plugin id for uninstall.
 * Local path installs use a slug id (not manifest name); marketplace uses manifest name.
 * @returns {string}
 */
export async function resolveInstalledGrokPluginId() {
  const bundled = normalizePath(tryRealpath(resolveGrokPluginDir()))
  const result = await runCommand('grok', ['plugin', 'list', '--json'], { timeoutMs: 15_000 })
  if (result.code !== 0 || !result.stdout?.trim()) return GROK_PLUGIN_NAME

  /** @type {Array<{ name?: string, repo_key?: string, source?: string }>} */
  let plugins
  try {
    plugins = JSON.parse(result.stdout.trim())
  } catch {
    return GROK_PLUGIN_NAME
  }

  if (!Array.isArray(plugins)) plugins = Array.isArray(plugins?.plugins) ? plugins.plugins : []
  for (const plugin of plugins) {
    if (!plugin.source) continue
    const source = normalizePath(tryRealpath(plugin.source))
    if (source === bundled) return plugin.repo_key ?? plugin.name ?? GROK_PLUGIN_NAME
  }

  const byName = plugins.find((p) => p.name === GROK_PLUGIN_NAME)
  if (byName) return byName.repo_key ?? byName.name ?? GROK_PLUGIN_NAME

  return GROK_PLUGIN_NAME
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

  const result = await runCommand('grok', grokPluginInstallArgs(), { timeoutMs: 60_000 })
  if (result.error) {
    warnInstallFailure(result.error.message, cmdLine, pluginDir)
    return { ok: false, exitCode: result.code ?? null }
  }
  if (result.code !== 0) {
    warnInstallFailure(`exit ${result.code}`, cmdLine, pluginDir)
    return { ok: false, exitCode: result.code ?? null }
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
  return { ok: true }
}
