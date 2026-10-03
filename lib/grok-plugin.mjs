import { existsSync, readFileSync, realpathSync, readdirSync, lstatSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { grokPluginPayloadMatches } from './grok-payload.mjs'
import { runCommand } from './upgrade/process.mjs'
import { isAbsolute, join, resolve } from 'node:path'
import { commandExists } from './mcp-entry.mjs'
import { PKG_ROOT } from './pkg.mjs'
import { acquireLock } from './upgrade/lock.mjs'
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
  return withGrokLock(opts, () => installGrokPluginUnlocked(opts))
}

async function installGrokPluginUnlocked(opts = {}) {
  const { dryRun = false, skip = false } = opts
  if (skip) return { ok: true, skipped: true }

  const cmdLine = grokPluginInstallCommandLine()
  const pluginDir = resolveGrokPluginDir()
  if (!existsSync(pluginDir)) {
    console.warn(`grok plugin directory missing (${pluginDir}) — install manually:\n  ${cmdLine}`)
    return { ok: false }
  }

  if (dryRun) {
    console.log(`Would install a new Grok plugin with: ${cmdLine}; an existing registration would instead be verified/refreshed without additional trust. Cache reconstruction requires separate consent.`)
    return { ok: true, dryRun: true }
  }

  if (!grokCliAvailable()) {
    console.warn(`grok CLI not found on PATH — install plugin manually:\n  ${cmdLine}`)
    return { ok: true, missingCli: true }
  }

  const run = opts.run ?? runCommand
  // Installing an existing source is rejected by Grok. Reuse the same verified
  // lifecycle as Refresh instead of granting trust/reinstalling on every call.
  let existingPlugin = false
  try {
    const plugins = await grokListing(run)
    if (findInstalledGrokPlugin(plugins)) {
      existingPlugin = true
      const result = await refreshGrokPluginUnlocked({ ...opts, run })
      return { ...result, ok: !['failed', 'unavailable'].includes(result.status) }
    }
    await grokCommand(run, grokPluginInstallArgs(), 'installation')
    const installed = findInstalledGrokPlugin(await grokListing(run))
    if (!installed || !grokPluginSourceMatches(installed.source, pluginDir)
      || !grokPluginPayloadMatches(installed, pluginDir)) throw new Error('Grok installation source/cache payload was not verified.')
  } catch (error) {
    if (existingPlugin) console.warn(error.message)
    else warnInstallFailure(error.message, cmdLine, pluginDir)
    return { ok: false, error: error.message }
  }
  return { ok: true }
}

/**
 * @param {{ dryRun?: boolean, skip?: boolean }} [opts]
 * @returns {{ ok: boolean, skipped?: boolean, dryRun?: boolean, missingCli?: boolean, exitCode?: number|null }}
 */
export async function uninstallGrokPlugin(opts = {}) {
  return withGrokLock(opts, () => uninstallGrokPluginUnlocked(opts))
}

async function uninstallGrokPluginUnlocked(opts = {}) {
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


const pluginDisabled = plugin => plugin.enabled === false || plugin.disabled === true || plugin.status === 'disabled'

async function grokCommand(run, args, stage) {
  const result = await run('grok', args, { timeoutMs: args[1] === 'list' ? 15_000 : 60_000 })
  if (result.error || result.code !== 0) throw new Error(`Grok plugin ${stage} failed (exit ${result.code ?? 'unavailable'}); no success assumed.`)
  return result.stdout
}

async function grokListing(run) {
  return parseGrokPluginList(await grokCommand(run, ['plugin', 'list', '--json'], 'discovery'))
}

/** Bounded, secret-free digest binds consent to the exact source and cache. */
function pluginFingerprint(root) {
  if (!lstatSync(root).isDirectory()) throw new Error('Grok payload root is missing or an unsupported alias; cache reconstruction is refused.')
  let entries = 0
  const rows = []
  const walk = (dir, relative = '') => {
    for (const name of readdirSync(dir).sort()) {
      if (name === '.git') continue
      if (++entries > 2048) throw new Error('Grok payload tree exceeds the verification limit.')
      const path = join(dir, name), rel = join(relative, name), stat = lstatSync(path)
      if (stat.isSymbolicLink()) throw new Error('Grok payload contains an unsupported alias; automatic cache reconstruction is refused.')
      if (stat.isDirectory()) walk(path, rel)
      else if (stat.isFile() && stat.size <= 16 * 1024 * 1024) rows.push([rel, createHash('sha256').update(readFileSync(path)).digest('hex')])
      else throw new Error('Grok payload entry cannot be safely verified.')
    }
  }
  walk(root)
  return createHash('sha256').update(JSON.stringify([realpathSync(root), rows])).digest('hex')
}

/** Native-only cache recovery. Trust/reinstallation is a separate explicit consent. */
export async function refreshGrokPlugin(opts = {}) {
  return withGrokLock(opts, () => refreshGrokPluginUnlocked(opts))
}

async function refreshGrokPluginUnlocked({ dryRun = false, run = runCommand, confirmRepair, repair = false, pluginDir = resolveGrokPluginDir() } = {}) {
  let plugins
  try { plugins = await grokListing(run) } catch { return { status: 'unavailable', message: 'Grok plugin discovery failed; no success assumed.' } }
  const existing = findInstalledGrokPlugin(plugins)
  if (!existing) return { status: 'absent', message: 'No existing Grok plugin; not installing a new one.' }
  if (pluginDisabled(existing)) return { status: 'disabled', message: 'Grok plugin is disabled; registration left unchanged, not re-enabled.' }
  if (dryRun) return { status: 'planned', message: 'Would verify/refresh the existing Grok plugin without changing trust.' }
  if (!grokPluginSourceMatches(existing.source, pluginDir)) throw new Error('Grok plugin source differs from the current package; inspect the source before any cache reconstruction. No trust or reinstall was attempted.')
  if (grokPluginPayloadMatches(existing, pluginDir)) return { status: 'current', message: 'Grok plugin source and cached payload already match; no host update was needed.' }
  await grokCommand(run, ['plugin', 'update', existing.name ?? GROK_PLUGIN_NAME], 'refresh')
  let current = findInstalledGrokPlugin(await grokListing(run))
  if (!current || !grokPluginSourceMatches(current.source, pluginDir)) throw new Error('Grok plugin registration/source changed during refresh; no reconstruction was attempted.')
  if (pluginDisabled(current)) return { status: 'disabled', message: 'Grok plugin is disabled; registration left unchanged, not re-enabled.' }
  if (grokPluginPayloadMatches(current, pluginDir)) return { status: 'updated', message: 'Grok plugin source and cached payload verified; restart the host to reload.' }
  const failure = 'Grok plugin cache payload remains stale or cannot be verified after the native update. No uninstall/reinstall or trust was granted. Fully quit Grok, then use Manage agent integrations → Refresh, or explicitly approve cache reconstruction with search-boost refresh -y --repair-grok-cache.'
  if (repair !== true && typeof confirmRepair !== 'function') throw new Error(failure)
  // A shared repository may contain more than SearchBoost. Native uninstall can
  // remove all of them: refuse rather than interpreting one consent as a wider scope.
  if (typeof current.repo_key !== 'string' || !current.repo_key.trim()) throw new Error('Grok repository identity cannot be verified; automatic cache reconstruction is refused.')
  if (plugins.some(p => p !== existing && p.repo_key && p.repo_key === existing.repo_key)) throw new Error('Grok repository contains other plugins; automatic cache reconstruction is refused.')
  if (!current.path || !isAbsolute(current.path) || realpathSync(current.path) === realpathSync(pluginDir)) throw new Error('Grok cache does not have an independent verifiable directory; reconstruction is refused.')
  const manifest = JSON.parse(readFileSync(join(pluginDir, 'plugin.json'), 'utf8'))
  if (manifest.name !== GROK_PLUGIN_NAME || !manifest.author || typeof manifest.author !== 'object' || Array.isArray(manifest.author)) throw new Error('Current Grok source manifest is not valid for cache reconstruction.')
  const plan = Object.freeze({ name: current.name ?? GROK_PLUGIN_NAME, repoKey: current.repo_key, source: pluginDir, path: current.path, version: manifest.version,
    sourceDigest: pluginFingerprint(pluginDir), cacheDigest: pluginFingerprint(current.path) })
  const consent = repair === true || await confirmRepair(plan)
  if (consent !== true) throw new Error(`${failure} Cache reconstruction was cancelled.`)
  await grokCommand(run, ['plugin', 'validate', pluginDir], 'source validation')
  plugins = await grokListing(run)
  current = findInstalledGrokPlugin(plugins)
  if (!current || current.name !== plan.name || current.path !== plan.path || current.repo_key !== plan.repoKey || !grokPluginSourceMatches(current.source, plan.source)
    || pluginDisabled(current) || pluginFingerprint(pluginDir) !== plan.sourceDigest || pluginFingerprint(current.path) !== plan.cacheDigest
    || plugins.some(p => p !== current && p.repo_key && p.repo_key === current.repo_key)) throw new Error('Grok plugin/source/cache changed after the preview; consent no longer applies. Nothing was uninstalled.')
  await grokCommand(run, ['plugin', 'uninstall', plan.name, '--keep-data'], 'cache removal')
  if (findInstalledGrokPlugin(await grokListing(run))) throw new Error('Grok plugin removal was not verified; reinstallation was not started. Persistent data was requested to be retained.')
  try {
    if (pluginFingerprint(pluginDir) !== plan.sourceDigest) throw new Error('Grok source changed after removal; reinstallation was not started.')
    await grokCommand(run, ['plugin', 'install', pluginDir, '--trust'], 'cache reinstallation')
    const installed = findInstalledGrokPlugin(await grokListing(run))
    if (!installed || pluginDisabled(installed) || !grokPluginSourceMatches(installed.source, pluginDir)
      || !grokPluginPayloadMatches(installed, pluginDir)) throw new Error('Grok cache reinstallation source/payload was not verified.')
  } catch (error) {
    throw new Error(`${error.message} Native removal already succeeded with --keep-data requested; the plugin may be absent or partially registered. Inspect the source and host plugin list, then use Manage agent integrations → Install (or search-boost install -t grok) only if you still trust that source. Refresh does not install an absent plugin.`)
  }
  return { status: 'updated', message: 'Grok plugin cache rebuilt by the host with data retained and explicit source trust; payload verified. Restart Grok.' }
}

async function withGrokLock(opts, action) {
  if (opts.dryRun || opts.skip) return action()
  const lock = await acquireLock({ name: 'grok-plugin.lock', inherit: false })
  try { return await action() } finally { await lock.release() }
}
