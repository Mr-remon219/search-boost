import { existsSync, realpathSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { commandExists } from './mcp-entry.mjs'
import { PKG_ROOT } from './pkg.mjs'

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
export function resolveInstalledGrokPluginId() {
  const bundled = normalizePath(tryRealpath(resolveGrokPluginDir()))
  const result = spawnSync('grok', ['plugin', 'list', '--json'], {
    encoding: 'utf8',
    windowsHide: true,
  })
  if (result.status !== 0 || !result.stdout?.trim()) return GROK_PLUGIN_NAME

  /** @type {Array<{ name?: string, repo_key?: string, source?: string }>} */
  let plugins
  try {
    plugins = JSON.parse(result.stdout.trim())
  } catch {
    return GROK_PLUGIN_NAME
  }

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
  return ['plugin', 'uninstall', pluginId ?? resolveInstalledGrokPluginId()]
}

/** @returns {string} Human-readable grok install command */
export function grokPluginInstallCommandLine() {
  return `grok ${grokPluginInstallArgs().join(' ')}`
}

/** @param {string} [pluginId] */
export function grokPluginUninstallCommandLine(pluginId) {
  return `grok ${grokPluginUninstallArgs(pluginId).join(' ')}`
}

/**
 * @param {{ dryRun?: boolean, skip?: boolean }} [opts]
 * @returns {{ ok: boolean, skipped?: boolean, dryRun?: boolean, missingCli?: boolean, exitCode?: number|null }}
 */
export function installGrokPlugin(opts = {}) {
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

  const result = spawnSync('grok', grokPluginInstallArgs(), {
    stdio: 'inherit',
    windowsHide: true,
  })
  if (result.error) {
    console.warn(`grok plugin install failed (${result.error.message}) — run manually:\n  ${cmdLine}`)
    return { ok: true, exitCode: result.status ?? null }
  }
  if (result.status !== 0) {
    console.warn(`grok plugin install failed (exit ${result.status}) — run manually:\n  ${cmdLine}`)
    return { ok: true, exitCode: result.status ?? null }
  }
  return { ok: true }
}

/**
 * @param {{ dryRun?: boolean, skip?: boolean }} [opts]
 * @returns {{ ok: boolean, skipped?: boolean, dryRun?: boolean, missingCli?: boolean, exitCode?: number|null }}
 */
export function uninstallGrokPlugin(opts = {}) {
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

  const pluginId = resolveInstalledGrokPluginId()
  const uninstallArgs = grokPluginUninstallArgs(pluginId)
  const cmdLine = grokPluginUninstallCommandLine(pluginId)

  const result = spawnSync('grok', uninstallArgs, {
    stdio: 'inherit',
    windowsHide: true,
  })
  if (result.error) {
    console.warn(`grok plugin uninstall failed (${result.error.message}) — run manually:\n  ${cmdLine}`)
    return { ok: false, exitCode: result.status ?? null }
  }
  if (result.status !== 0) {
    console.warn(`grok plugin uninstall failed (exit ${result.status}) — run manually:\n  ${cmdLine}`)
    return { ok: false, exitCode: result.status ?? null }
  }
  return { ok: true }
}
