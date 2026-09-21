/**
 * Install helpers for host-runtime agents (pi, dsh) — agents whose search
 * tools run in the host process through adapters/pi and adapters/dsh instead
 * of the MCP server.
 *
 *  pi  → write ~/.pi/agent/extensions/search-boost.js, a one-line shim that
 *        re-exports adapters/pi/index.js from this package (pi auto-discovers
 *        extensions/*.js), plus owned searcher/summarizer and slash-prompt
 *        copies under ~/.pi/agent/{agents,prompts}. Uninstall removes only
 *        files we wrote.
 *  dsh → forward to `dsh plugin --profile <name> add|remove` (pnpm in the
 *        profile dir); DSH wires the bundle via package.json `dsh.bundle`.
 */
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { piSubagentTemplatePaths, piWorkflowPromptPaths } from '../../agents/router.mjs'
import { packageIdentity } from '../package-identity.mjs'
import { migratePiSubagentSettings } from '../pi-subagent-config.mjs'
import { strictJson } from '../upgrade/config.mjs'
import { runCommand } from '../upgrade/process.mjs'
import { renderResearchTemplate } from '../search/parallel-contract.mjs'
import { commandExists } from '../mcp-entry.mjs'
import { readTextFile, writeTextFile } from '../json-config.mjs'
import { shellArg, shellArgs } from '../shell-args.mjs'
import { DSH_PACKAGE_NAME, PATHS, PI_OWNED_MARKER, PI_SHIM_MARKER, dshProfilesWithSearchBoost, piRegistersLegacyPackage } from '../paths.mjs'
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
  if (existsSync(join(dir, 'index.ts')) || existsSync(join(dir, 'index.js'))) return true
  // A legacy *package* (npm:pi-search-boost@0.1.3) registers the same tools, so the
  // duplicate-tools warning must fire for it too, not only for a hand-copied dir.
  return piRegistersLegacyPackage()
}

/** Source template → injected dest under ~/.pi/agent/{agents,prompts}. */
export function piInjectPairs() {
  /** @type {{ src: string, dest: string }[]} */
  const pairs = []
  for (const src of piSubagentTemplatePaths()) {
    pairs.push({ src, dest: join(PATHS.pi.agentsDir, basename(src)) })
  }
  for (const src of piWorkflowPromptPaths()) {
    pairs.push({ src, dest: join(PATHS.pi.promptsDir, basename(src)) })
  }
  return pairs
}

/**
 * Write a package template to dest when dest is missing or already ours.
 * Never overwrite a user-owned file that lacks PI_OWNED_MARKER.
 * @param {string} src
 * @param {string} dest
 * @param {boolean} dryRun
 */
async function injectOwnedMarkdown(src, dest, dryRun) {
  const body = renderResearchTemplate(await readTextFile(src))
  if (!body.includes(PI_OWNED_MARKER)) {
    throw new Error(`pi template missing ownership marker: ${src}`)
  }
  if (existsSync(dest)) {
    const current = await readTextFile(dest)
    if (!current.includes(PI_OWNED_MARKER)) return false
    if (current === body) return true
  }
  if (!dryRun) await writeTextFile(dest, body)
  return true
}

/** @param {{ dryRun?: boolean }} opts */
export async function installPiExtension(opts) {
  const dryRun = !!opts.dryRun
  const file = PATHS.pi.extension
  const settingsPath = join(PATHS.pi.agentDir, 'settings.json')
  const settings = await strictJson(settingsPath)
  const childMigration = migratePiSubagentSettings(settings, PATHS.pi.agentDir, piAdapterEntry())
  const packageRegistered = ['packages', 'extensions'].some((field) => Array.isArray(settings[field]) && settings[field].some((entry) =>
    packageIdentity(typeof entry === 'string' ? entry : entry?.source, PATHS.pi.agentDir) === DSH_PACKAGE_NAME))
  const priorShim = existsSync(file) ? await readTextFile(file) : null
  if (!packageRegistered && priorShim !== null && !priorShim.includes(PI_SHIM_MARKER)) {
    throw new Error(`User-owned Pi extension at ${file}; left unchanged. Move it explicitly before installing SearchBoost.`)
  }
  // A package registration already loads this adapter. Retain custom files, but
  // remove our old shim so pi install + CLI install cannot double-register tools.
  if (packageRegistered && priorShim?.includes(PI_SHIM_MARKER) && !dryRun) await removeFileIfExists(file)
  const written = packageRegistered ? [] : [file]
  if (!dryRun && !packageRegistered) {
    const current = existsSync(file) ? await readTextFile(file) : ''
    const next = piShimSource()
    if (current !== next) await writeTextFile(file, next)
  }
  for (const { src, dest } of piInjectPairs()) {
    const ok = await injectOwnedMarkdown(src, dest, dryRun)
    if (ok) written.push(dest)
  }
  if (childMigration.changes.length) {
    if (!dryRun) await writeTextFile(settingsPath, `${JSON.stringify(childMigration.settings, null, 2)}\n`)
    written.push(settingsPath)
  }
  if (piLegacyExtensionPresent()) {
    console.warn(
      `Note: legacy pi-search-boost copy found at ${PATHS.pi.legacyExtensionDir} — remove it (and \`pi remove pi-search-boost\` if installed as a package) to avoid duplicate tools.`,
    )
  }
  return written
}

/** @param {{ dryRun?: boolean }} opts */
export async function uninstallPiExtension(opts) {
  const settingsPath = join(PATHS.pi.agentDir, 'settings.json')
  const settings = await strictJson(settingsPath)
  let settingsChanged = false
  for (const field of ['packages', 'extensions']) {
    if (!Array.isArray(settings[field])) continue
    const next = settings[field].filter((entry) => packageIdentity(typeof entry === 'string' ? entry : entry?.source, PATHS.pi.agentDir) !== DSH_PACKAGE_NAME)
    if (next.length !== settings[field].length) { settings[field] = next; settingsChanged = true }
  }
  if (settingsChanged && !opts.dryRun) await writeTextFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`)

  const file = PATHS.pi.extension
  if (existsSync(file)) {
    let content = ''
    try {
      content = await readFile(file, 'utf8')
    } catch {
      content = ''
    }
    if (content.includes(PI_SHIM_MARKER) && !opts.dryRun) {
      await removeFileIfExists(file)
      await removeEmptyDirIfExists(dirname(file))
    }
  }
  for (const { dest } of piInjectPairs()) {
    if (!existsSync(dest)) continue
    const content = await readTextFile(dest)
    if (!content.includes(PI_OWNED_MARKER)) continue
    if (!opts.dryRun) await removeFileIfExists(dest)
  }
  if (!opts.dryRun) {
    await removeEmptyDirIfExists(PATHS.pi.agentsDir)
    await removeEmptyDirIfExists(PATHS.pi.promptsDir)
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
    `# Injected subagents: ${piSubagentTemplatePaths().map((p) => basename(p)).join(', ')} → ${PATHS.pi.agentsDir}`,
    `# Slash prompts:      ${piWorkflowPromptPaths().map((p) => `/${basename(p, '.md')}`).join(' ')} → ${PATHS.pi.promptsDir}`,
    '',
    '# Or install as a pi package instead (no shim / no injected prompts):',
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

async function runDsh(args, dryRun) {
  const shown = `dsh ${shellArgs(args)}`
  if (dryRun) {
    console.log(`  (dry-run) ${shown}`)
    return true
  }
  if (!dshCliAvailable()) {
    throw new Error(`dsh CLI not found on PATH — no DSH installation changed. Run manually: npx --yes @deepseek-ai/dsh ${shellArgs(args)}`)
  }
  // Same execution layer npm and grok use: on Windows `dsh` is a .cmd shim, which
  // Node cannot spawn directly, and that layer also quotes the arguments and
  // rejects shell metacharacters before cmd.exe sees them.
  const result = await runCommand('dsh', args, { timeoutMs: 300_000 })
  if (result.stdout) process.stdout.write(result.stdout)
  if (result.stderr) process.stderr.write(result.stderr)
  if (result.code !== 0) {
    throw new Error(`${shown} failed (exit ${result.code ?? '?'}) — dsh plugin needs pnpm (npm i -g pnpm)`)
  }
  return true
}

/** @param {{ dryRun?: boolean, profile?: string }} opts */
export async function installDshBundle(opts) {
  const profile = opts.profile || DEFAULT_DSH_PROFILE
  await runDsh(dshPluginArgs('add', profile), !!opts.dryRun)
  return [join(PATHS.dsh.profiles, profile, 'package.json')]
}

/** @param {{ dryRun?: boolean, profile?: string }} opts */
export async function uninstallDshBundle(opts) {
  const profiles = opts.profile ? [opts.profile] : dshProfilesWithSearchBoost()
  for (const profile of profiles) {
    await runDsh(dshPluginArgs('remove', profile), !!opts.dryRun)
  }
}

/** Snippet for `search-boost print dsh`. */
export function formatDshPrintConfig(profile = DEFAULT_DSH_PROFILE) {
  return [
    `# DSH bundle plugin — installs into ${join(PATHS.dsh.profiles, profile)} via pnpm:`,
    `dsh ${shellArgs(dshPluginArgs('add', profile))}`,
    '',
    '# or from npm without a global dsh:',
    `npx --yes @deepseek-ai/dsh plugin --profile ${profile} add ${shellArg(DSH_PACKAGE_NAME)}`,
    '',
    '# verify: web.searchProvider / fetchProvider → search-boost',
    `dsh --profile ${profile} --dump-config | grep -E 'searchProvider|search-boost'`,
    '',
    `# remove: dsh ${shellArgs(dshPluginArgs('remove', profile))}`,
  ].join('\n')
}
