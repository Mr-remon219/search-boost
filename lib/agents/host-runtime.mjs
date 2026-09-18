/**
 * Install helpers for host-runtime agents (pi, dsh) — agents whose search
 * tools run in the host process through adapters/pi and adapters/dsh instead
 * of the MCP server.
 *
 *  pi  → write ~/.pi/agent/extensions/search-boost.js, a one-line shim that
 *        re-exports adapters/pi/index.js from this package (pi auto-discovers
 *        extensions/*.js). Uninstall removes only a shim we wrote.
 *  dsh → forward to `dsh plugin --profile <name> add|remove` (pnpm in the
 *        profile dir); DSH wires the bundle via package.json `dsh.bundle`.
 */
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { commandExists } from '../mcp-entry.mjs'
import { readTextFile, writeTextFile } from '../json-config.mjs'
import { DSH_PACKAGE_NAME, PATHS, PI_SHIM_MARKER, dshProfilesWithSearchBoost } from '../paths.mjs'
import { PKG_ROOT } from '../pkg.mjs'
import { removeEmptyDirIfExists, removeFileIfExists } from './shared.mjs'

export const DEFAULT_DSH_PROFILE = 'web'

/** Absolute pi adapter entry inside this package. */
export function piAdapterEntry() {
  return join(PKG_ROOT, 'adapters', 'pi', 'index.js')
}

/** Contents of the pi extension shim (pi loads extensions/*.js via jiti). */
export function piShimSource() {
  const url = pathToFileURL(piAdapterEntry()).href
  return [
    `// ${PI_SHIM_MARKER} — written by \`search-boost install -t pi\`; safe to delete.`,
    '// Loads the SearchBoost pi host adapter from the installed search-boost package.',
    `export { default } from '${url}'`,
    '',
  ].join('\n')
}

/** True when the legacy pi-search-boost extension copy is still present (double registration). */
export function piLegacyExtensionPresent() {
  const dir = PATHS.pi.legacyExtensionDir
  return existsSync(join(dir, 'index.ts')) || existsSync(join(dir, 'index.js'))
}

/** @param {{ dryRun?: boolean }} opts */
export async function installPiExtension(opts) {
  const file = PATHS.pi.extension
  if (!opts.dryRun) {
    const current = existsSync(file) ? await readTextFile(file) : ''
    const next = piShimSource()
    if (current !== next) await writeTextFile(file, next)
  }
  if (piLegacyExtensionPresent()) {
    console.warn(
      `Note: legacy pi-search-boost copy found at ${PATHS.pi.legacyExtensionDir} — remove it (and \`pi remove pi-search-boost\` if installed as a package) to avoid duplicate tools.`,
    )
  }
  return [file]
}

/** @param {{ dryRun?: boolean }} opts */
export async function uninstallPiExtension(opts) {
  const file = PATHS.pi.extension
  if (!existsSync(file)) return
  let content = ''
  try {
    content = await readFile(file, 'utf8')
  } catch {
    return
  }
  if (!content.includes(PI_SHIM_MARKER)) return // not ours
  if (!opts.dryRun) {
    await removeFileIfExists(file)
    await removeEmptyDirIfExists(dirname(file))
  }
}

/** Snippet for `search-boost print pi`. */
export function formatPiPrintConfig() {
  return [
    `# pi loads extensions from ${PATHS.pi.agentDir}/extensions/*.js — write this shim:`,
    `# ${PATHS.pi.extension}`,
    '',
    piShimSource().trim(),
    '',
    '# Or install as a pi package instead (no shim needed):',
    `#   pi install npm:${DSH_PACKAGE_NAME}`,
    `#   pi -e ${piAdapterEntry()}   # one-off`,
  ].join('\n')
}

export function dshCliAvailable() {
  return commandExists('dsh')
}

/**
 * Package spec `dsh plugin add` receives. A checkout / npm-linked install
 * points at PKG_ROOT (pnpm links it); a published install uses the npm name.
 */
export function dshPackageSpec() {
  const inNodeModules = /[\\/]node_modules[\\/]/.test(PKG_ROOT)
  return inNodeModules ? DSH_PACKAGE_NAME : PKG_ROOT
}

/** @param {'add'|'remove'} verb @param {string} profile */
export function dshPluginArgs(verb, profile = DEFAULT_DSH_PROFILE) {
  const spec = verb === 'add' ? dshPackageSpec() : DSH_PACKAGE_NAME
  return ['plugin', '--profile', profile, verb, spec]
}

function runDsh(args, dryRun) {
  const shown = `dsh ${args.join(' ')}`
  if (dryRun) {
    console.log(`  (dry-run) ${shown}`)
    return true
  }
  if (!dshCliAvailable()) {
    console.warn(`dsh CLI not found on PATH — run manually:\n  npx --yes @deepseek-ai/dsh ${args.join(' ')}`)
    return false
  }
  const result = spawnSync('dsh', args, { stdio: 'inherit', windowsHide: true })
  if (result.status !== 0) {
    throw new Error(`${shown} failed (exit ${result.status ?? '?'}) — dsh plugin needs pnpm (npm i -g pnpm)`)
  }
  return true
}

/** @param {{ dryRun?: boolean, profile?: string }} opts */
export async function installDshBundle(opts) {
  const profile = opts.profile || DEFAULT_DSH_PROFILE
  runDsh(dshPluginArgs('add', profile), !!opts.dryRun)
  return [join(PATHS.dsh.profiles, profile, 'package.json')]
}

/** @param {{ dryRun?: boolean, profile?: string }} opts */
export async function uninstallDshBundle(opts) {
  const profiles = opts.profile ? [opts.profile] : dshProfilesWithSearchBoost()
  for (const profile of profiles) {
    runDsh(dshPluginArgs('remove', profile), !!opts.dryRun)
  }
}

/** Snippet for `search-boost print dsh`. */
export function formatDshPrintConfig(profile = DEFAULT_DSH_PROFILE) {
  return [
    `# DSH bundle plugin — installs into ${join(PATHS.dsh.profiles, profile)} via pnpm:`,
    `dsh ${dshPluginArgs('add', profile).join(' ')}`,
    '',
    '# or from npm without a global dsh:',
    `npx --yes @deepseek-ai/dsh plugin --profile ${profile} add ${DSH_PACKAGE_NAME}`,
    '',
    '# verify: web.searchProvider / fetchProvider → search-boost',
    `dsh --profile ${profile} --dump-config | grep -E 'searchProvider|search-boost'`,
    '',
    `# remove: dsh ${dshPluginArgs('remove', profile).join(' ')}`,
  ].join('\n')
}
