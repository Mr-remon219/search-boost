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
import { existsSync, lstatSync, readFileSync, readlinkSync, realpathSync, rmdirSync, unlinkSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { piSubagentTemplatePaths, piWorkflowPromptPaths } from '../../agents/router.mjs'
import { packageIdentity } from '../package-identity.mjs'
import { migratePiSubagentSettings } from '../pi-subagent-config.mjs'
import { strictJson } from '../upgrade/config.mjs'
import { runCommand } from '../upgrade/process.mjs'
import { renderResearchTemplate } from '../search/parallel-contract.mjs'
import { commandExists } from '../mcp-entry.mjs'
import { readTextFile, writeTextFile } from '../json-config.mjs'
import { shellArgs } from '../shell-args.mjs'
import { DSH_PACKAGE_NAME, PATHS, PI_OWNED_MARKER, PI_SHIM_MARKER, dshProfilesWithBundleEntry, dshProfilesWithSearchBoost, piRegistersLegacyPackage } from '../paths.mjs'
import { DESKTOP_PROFILE, desktopLaunchCommand, desktopPathLauncher, isDesktopProfile, isDesktopProfileDirectory } from '../dsh-desktop.mjs'
import { PKG_ROOT, getVersion } from '../pkg.mjs'
import { verifyDshRuntime } from '../dsh-runtime.mjs'
import { dshDependencies, dshRegistersBundle } from '../dsh-manifest.mjs'
import { verifyDshPayload } from '../dsh-payload.mjs'
import { assertDshRecoveryReady } from '../dsh-recovery.mjs'
import { removeEmptyDirIfExists, removeFileIfExists } from './shared.mjs'

export const DEFAULT_DSH_PROFILE = 'web'

/** Patch every installed and verified DSH bundle declares. */
const DSH_BUNDLE_PATCH = './adapters/dsh/cordis.patch.yml'

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
 * Reuse this exact durable package, including local tarballs installed under
 * node_modules. Version equality cannot identify an unpublished build.
 * npm-exec caches must not become persistent links; their registry replacement
 * is accepted only after comparing the full shipped payload.
 */
export function dshPackageSpec(root = PKG_ROOT, version = getVersion()) {
  return /[\\/]_npx[\\/]/.test(root) ? `${DSH_PACKAGE_NAME}@${version}` : root
}

/** Desktop can reuse a durable local package, but never an npm-exec cache. */
export function dshDesktopPackageSpec(root = PKG_ROOT, version = getVersion()) {
  // An npm-exec cache is not a durable installation to link into Desktop.
  return /[\\/]_npx[\\/]/.test(root) ? `${DSH_PACKAGE_NAME}@${version}` : root
}

/** @param {'add'|'remove'} verb @param {string} profile */
export function dshPluginArgs(verb, profile = DEFAULT_DSH_PROFILE) {
  validateDshProfile(profile)
  // Both surfaces reuse a durable installed package rather than substituting
  // registry code with the same version.
  const spec = verb === 'add' ? (profile === DESKTOP_PROFILE ? dshDesktopPackageSpec() : dshPackageSpec()) : DSH_PACKAGE_NAME
  return ['plugin', '--profile', profile, verb, spec]
}

export function validateDshProfile(profile) {
  if (typeof profile !== 'string' || !profile.trim() || profile.trim() !== profile || profile.startsWith('-') || /[. ]$/.test(profile) || /[\\/\\\\\0\r\n<>:"|?*]/.test(profile)) {
    throw new Error('DSH profile must be a single directory name, not a path.')
  }
  if (profile.toLowerCase() === DESKTOP_PROFILE && profile !== DESKTOP_PROFILE) throw new Error('Use the canonical desktop profile name; it is reserved for Desktop.')
  return profile
}

/** Expand surfaces before executing, so a failure is reported per profile. */
export function dshOperationProfiles(opts = {}) {
  const surface = opts.dshSurface
  if (surface != null && !['cli', 'desktop', 'all'].includes(surface)) throw new Error('DSH surface must be desktop, cli, or all.')
  const profile = opts.profile ? validateDshProfile(opts.profile) : null
  if (surface === 'desktop' && profile && profile !== DESKTOP_PROFILE) throw new Error('--dsh-surface desktop cannot be combined with a CLI --profile.')
  if ((surface === 'cli' || surface === 'all') && profile === DESKTOP_PROFILE) throw new Error('The desktop profile requires the Desktop surface; --profile selects a CLI profile when using all.')
  if (surface === 'desktop' || (!surface && profile === DESKTOP_PROFILE)) return [DESKTOP_PROFILE]
  if (opts.uninstall) {
    const existing = dshUninstallProfiles()
    const cli = profile ? [profile] : existing.filter((name) => name !== DESKTOP_PROFILE)
    if (surface === 'cli') return cli
    if (surface === 'all') return [...new Set([...cli, ...(existing.includes(DESKTOP_PROFILE) ? [DESKTOP_PROFILE] : [])])]
    return profile ? [profile] : existing
  }
  const cli = profile ?? DEFAULT_DSH_PROFILE
  return surface === 'all' ? [...new Set([cli, DESKTOP_PROFILE])] : [cli]
}

/**
 * Profiles an unrestricted uninstall must sweep: live registrations plus the
 * `node_modules/search-boost` entries a host-managed unregister left behind,
 * so a repeated uninstall still cleans its own residue.
 */
export function dshUninstallProfiles() {
  return [...new Set([...dshProfilesWithSearchBoost(), ...dshProfilesWithBundleEntry()])]
}

function samePath(left, right) {
  try {
    if (realpathSync(left) === realpathSync(right)) return true
  } catch { /* a missing side can only be compared literally */ }
  return resolve(left) === resolve(right)
}

function registeredLinkTarget(dir, spec) {
  if (typeof spec !== 'string') return null
  if (isAbsolute(spec)) return resolve(spec)
  if (spec.startsWith('file://')) {
    try { return fileURLToPath(spec) } catch { return null }
  }
  const local = spec.match(/^(?:link|file):(.+)$/)
  return local ? resolve(dir, local[1]) : null
}

export function prunedPnpmSearchBoostTarget(dir, target, pathApi = { join, relative, isAbsolute }) {
  const path = pathApi.relative(pathApi.join(dir, 'node_modules', '.pnpm'), target).replace(/\\/g, '/')
  return !pathApi.isAbsolute(path) && /^search-boost@\d+\.\d+\.\d+(?:[-+][\w.-]+)?(?:_[^/]+)?\/node_modules\/search-boost$/.test(path)
}

/**
 * What a profile's `node_modules/search-boost` entry is, and whether this
 * package owns it.
 *
 * Ownership is decided from the entry's own evidence, never from its name:
 * a live link is ours when its target carries our package name and bundle
 * marker (or is this package root). A dangling link must point at this package
 * root, the exact local spec removed in this call, or a canonical pnpm package
 * path in this profile. Registration/name/version alone are not ownership.
 * Anything else is left in place and reported by the caller.
 * @returns {{ path: string, type: 'link'|'dangling-link'|'directory'|'file', target?: string, owned: boolean, reason: string }|null}
 */
export function dshBundleEntryStatus(dir, { root = PKG_ROOT, registeredSpec = null } = {}) {
  const path = join(dir, 'node_modules', DSH_PACKAGE_NAME)
  let stat
  try { stat = lstatSync(path) } catch (error) { if (error.code === 'ENOENT') return null; throw error }
  if (!stat.isSymbolicLink()) {
    return { path, type: stat.isDirectory() ? 'directory' : 'file', owned: false, reason: 'not a link created by SearchBoost' }
  }
  const target = resolve(dirname(path), readlinkSync(path))
  let manifest = null
  try { manifest = JSON.parse(readFileSync(join(target, 'package.json'), 'utf8')) } catch { /* dangling or unreadable */ }
  if (manifest) {
    const owned = manifest.name === DSH_PACKAGE_NAME
      && (manifest.dsh?.bundle?.patch === DSH_BUNDLE_PATCH || samePath(target, root))
    return { path, type: 'link', target, owned,
      reason: owned ? 'link target is the SearchBoost package' : 'link target is a different package' }
  }
  const registeredTarget = registeredLinkTarget(dir, registeredSpec)
  const owned = samePath(target, root) || prunedPnpmSearchBoostTarget(dir, target)
    || (registeredTarget !== null && samePath(target, registeredTarget))
  return { path, type: 'dangling-link', target, owned,
    reason: owned ? 'link target is the removed SearchBoost dependency' : 'link target is missing and cannot be attributed to SearchBoost' }
}

/** Remove the entry itself: a link target is never followed or deleted. */
export function removeDshBundleEntry(path, expectedTarget) {
  // Recheck immediately before unlinking so a replaced file/foreign link is
  // not deleted based only on the earlier classification.
  if (!lstatSync(path).isSymbolicLink() || resolve(dirname(path), readlinkSync(path)) !== expectedTarget) {
    throw new Error(`DSH dependency entry changed during cleanup: ${path}; left in place.`)
  }
  try { unlinkSync(path) } catch (error) {
    // Windows junctions are directories to the filesystem but links to Node.
    if (!['EPERM', 'EISDIR', 'ERR_FS_EISDIR'].includes(error.code)) throw error
    rmdirSync(path)
  }
}

function entryPresent(path) {
  try { lstatSync(path); return true } catch (error) { if (error.code === 'ENOENT') return false; throw error }
}

/**
 * Clean the entry a DSH unregister left behind. A foreign or unattributable
 * entry is kept and reported instead of deleted.
 * @param {string} dir profile directory
 * @param {{ dryRun?: boolean, registeredSpec?: string|null, root?: string }} [opts]
 * @returns {{ status: object|null, removed: boolean, action: 'none'|'kept'|'would-remove'|'removed', report: string }}
 */
export function cleanDshBundleEntry(dir, opts = {}) {
  const status = dshBundleEntryStatus(dir, opts)
  if (!status) return { status: null, removed: false, action: 'none', report: '' }
  if (!status.owned) return { status, removed: false, action: 'kept',
    report: `${status.path} left in place: ${status.reason}. Remove it with the DSH host or its package manager if it is stale.` }
  if (opts.dryRun) return { status, removed: false, action: 'would-remove',
    report: `would remove the leftover link ${status.path} (${status.reason})` }
  removeDshBundleEntry(status.path, status.target)
  if (entryPresent(status.path)) throw new Error(`DSH leftover link could not be removed: ${status.path}. Check ownership and remove it explicitly; uninstall was not verified.`)
  return { status, removed: true, action: 'removed', report: `removed the leftover link ${status.path} (${status.reason})` }
}

/** npm exec is npx's portable equivalent; no global DSH/pnpm install is needed. */
export function dshLaunchCommand(args, {
  dshAvailable = dshCliAvailable(),
  pnpmAvailable = commandExists('pnpm'),
  npmAvailable = commandExists('npm'),
  desktopCliCommand = desktopPathLauncher(),
} = {}) {
  const index = args.indexOf('--profile')
  const profile = validateDshProfile(index >= 0 ? args[index + 1] : DEFAULT_DSH_PROFILE)
  if (profile === DESKTOP_PROFILE) throw new Error('The desktop profile requires its Desktop bundled command, not the CLI/npm launcher.')
  // A CLI-named symlink/junction must not let npm mutate Electron's profile.
  if (isDesktopProfile(profile, PATHS.dsh.profiles)) throw new Error('This CLI profile aliases Desktop; use the canonical desktop profile and its bundled command.')
  // npm exec also reaches cmd.exe, even when npm itself runs through node.
  if (process.platform === 'win32' && args.some((arg) => /["%!^&|<>\r\n]/.test(arg))) {
    throw new Error('Unsupported Windows command path characters; use a path without shell metacharacters.')
  }
  // Only the Desktop launcher actually selected on PATH qualifies. A separate
  // detected app must not replace an unrelated global CLI.
  if (dshAvailable && desktopCliCommand) return { command: desktopCliCommand, args }
  if (dshAvailable && pnpmAvailable) return { command: 'dsh', args }
  if (!npmAvailable) {
    throw new Error('DSH requires dsh and pnpm on PATH, or npm for npx-style execution — no DSH installation changed.')
  }
  return {
    command: 'npm',
    args: ['exec', '--yes',
      ...(!dshAvailable ? ['--package', '@deepseek-ai/dsh'] : []),
      ...(!pnpmAvailable ? ['--package', 'pnpm'] : []),
      '--', 'dsh', ...args],
  }
}

export function dshProfileLaunchCommand(args, { dryRun = false } = {}) {
  const index = args.indexOf('--profile')
  const profile = validateDshProfile(index >= 0 ? args[index + 1] : DEFAULT_DSH_PROFILE)
  return profile === DESKTOP_PROFILE
    ? desktopLaunchCommand(args, { dryRun })
    : dshLaunchCommand(args, dryRun ? { npmAvailable: true } : {})
}

async function runDsh(args, dryRun) {
  const launch = dshProfileLaunchCommand(args, { dryRun })
  const shown = `${launch.command} ${shellArgs(launch.args)}`
  if (dryRun) {
    console.log(`  (dry-run) ${shown}`)
    return true
  }
  // The shared execution layer handles npm's JS entry and DSH .cmd launchers
  // on Windows; no raw npx.cmd spawn or interpolated user arguments.
  const result = await runCommand(launch.command, launch.args, { timeoutMs: 300_000 })
  // Host/package-manager output can contain credentials. Do not echo raw
  // stdout/stderr into TUI logs, CI artifacts or user-facing exception stacks.
  if (result.code !== 0) {
    throw new Error(`DSH plugin operation failed (exit ${result.code ?? '?'}) — inspect diagnostics locally via the host command; installation was not verified.`)
  }
  return launch
}

/** @param {{ dryRun?: boolean, profile?: string, enableDshBundle?: boolean, onDshStatus?: Function }} opts */
export async function installDshBundle(opts) {
  const profile = opts.profile || DEFAULT_DSH_PROFILE
  const args = dshPluginArgs('add', profile)
  const launch = dshProfileLaunchCommand(args, { dryRun: !!opts.dryRun })
  const dir = join(PATHS.dsh.profiles, profile)
  const manifest = join(dir, 'package.json')
  if (opts.dryRun) await runDsh(args, true)
  else {
    assertDshRecoveryReady(dir)
    const status = await verifyDshRuntime(dir, launch, {
      root: join(dir, 'node_modules', DSH_PACKAGE_NAME), version: getVersion(),
      installSpec: args.at(-1), sourceRoot: PKG_ROOT, profile,
      enable: !!opts.enableDshBundle, desktop: profile === DESKTOP_PROFILE,
    })
    if (opts.onDshStatus) opts.onDshStatus(status)
    else if (!status.enabled) console.warn(`DSH search-boost installed and verified, but disabled in ${profile}. Enable it in the host plugin manager, or repeat install with --enable-dsh-bundle.`)
  }
  return [manifest]
}

/** Do not report success solely because a launcher exited zero. */
export async function verifyDshBundle(dir, { launch, enable = false, profile: profileName = basename(dir) } = {}) {
  assertDshRecoveryReady(dir)
  const profile = await strictJson(join(dir, 'package.json'))
  const spec = dshDependencies(profile)[DSH_PACKAGE_NAME]
  if (typeof spec !== 'string' || !Array.isArray(profile.dsh?.profile?.bundles) || profile.dsh.profile.bundles.some(name => typeof name !== 'string')) {
    throw new Error('DSH profile did not register search-boost; installation was not verified.')
  }
  const root = join(dir, 'node_modules', DSH_PACKAGE_NAME)
  const pkg = await strictJson(join(root, 'package.json'))
  if (pkg.name !== DSH_PACKAGE_NAME || pkg.version !== getVersion() || pkg.dsh?.bundle?.patch !== DSH_BUNDLE_PATCH) {
    throw new Error('DSH installed bundle identity/version mismatch; installation was not verified.')
  }
  if (isDesktopProfileDirectory(dir, join(PATHS.dsh.profiles, DESKTOP_PROFILE)) && dshDesktopPackageSpec() === PKG_ROOT && realpathSync(root) !== realpathSync(PKG_ROOT)) {
    throw new Error('Desktop bundle does not resolve to the local search-boost installation; installation was not verified.')
  }
  for (const file of ['adapters/dsh/index.js', 'adapters/dsh/schema.js', 'adapters/dsh/cordis.patch.yml']) {
    if (!existsSync(join(root, file))) throw new Error(`DSH installed bundle is missing ${file}; installation was not verified.`)
  }
  verifyDshPayload(root, PKG_ROOT)
  const runtime = await verifyDshRuntime(dir, launch ?? dshProfileLaunchCommand(dshPluginArgs('add', profileName)), {
    root, version: getVersion(), enable, desktop: profileName === DESKTOP_PROFILE,
  })
  const after = await strictJson(join(dir, 'package.json'))
  const enabled = after.dsh?.profile?.bundles?.includes(DSH_PACKAGE_NAME) === true
  if (enable && !enabled) throw new Error('DSH bundle enable was not verified.')
  return { ...runtime, enabled }
}

/** @param {{ dryRun?: boolean, profile?: string }} opts */
export async function uninstallDshBundle(opts) {
  const profiles = opts.profile ? [opts.profile] : dshUninstallProfiles()
  const failures = []
  for (const profile of profiles) {
    try {
      validateDshProfile(profile)
      const dir = join(PATHS.dsh.profiles, profile)
      const file = join(dir, 'package.json')
      if (!opts.dryRun) assertDshRecoveryReady(dir)
      // DSH initializes absent CLI profiles even for `remove`. A no-op uninstall
      // must not create a new profile, or require an absent Desktop launcher.
      if (!existsSync(file)) continue
      const before = await strictJson(file)
      const registered = dshManifestRegistersBundle(before)
      const registeredSpec = ['dependencies', 'devDependencies', 'optionalDependencies']
        .map(field => before[field]?.[DSH_PACKAGE_NAME]).find(spec => typeof spec === 'string') ?? null
      // Both registrations can already be gone (native unregister, repeated
      // uninstall) while our dependency link still sits in the profile.
      if (registered) {
        const launch = await runDsh(dshPluginArgs('remove', profile), !!opts.dryRun)
        if (!opts.dryRun) {
          if (!existsSync(file)) throw new Error('DSH profile manifest disappeared; removal was not verified.')
          const after = await strictJson(file)
          if (!['dependencies', 'devDependencies', 'optionalDependencies'].some(field => Object.hasOwn(after[field] ?? {}, DSH_PACKAGE_NAME))
            && after.dsh?.profile?.bundles?.includes(DSH_PACKAGE_NAME)) {
            await verifyDshRuntime(dir, launch, { cleanupRemoved: true, desktop: profile === DESKTOP_PROFILE })
          }
          if (dshManifestRegistersBundle(await strictJson(file))) throw new Error('DSH still registers search-boost; removal was not verified.')
        }
      } else if (!opts.dryRun && isDesktopProfileDirectory(dir, join(PATHS.dsh.profiles, DESKTOP_PROFILE))
        && (existsSync(join(dir, 'lock')) || existsSync(join(PATHS.dsh.profiles, DESKTOP_PROFILE, 'lock')))) {
        // Aliases may share only a manifest or node_modules; their local lock
        // path need not be the application's canonical lock. Check both owners
        // before directly removing a dependency entry without a host command.
        throw new Error('DeepSeek Harness Desktop is running; quit it (including its tray) and retry. The leftover dependency link was not removed.')
      }
      const cleaned = cleanDshBundleEntry(dir, { registeredSpec, dryRun: !!opts.dryRun })
      if (cleaned.action === 'kept') console.warn(`  ${cleaned.report}`)
      else if (cleaned.report) console.log(`  ${opts.dryRun ? '(dry-run) ' : ''}${cleaned.report}`)
    } catch (error) { failures.push(`${profile}: ${error.message}`) }
  }
  if (failures.length) throw new Error(failures.join('\n'))
}

function dshManifestRegistersBundle(pkg) {
  return dshRegistersBundle(pkg, DSH_PACKAGE_NAME)
}

/** Snippet for `search-boost print dsh`. */
export function formatDshPrintConfig(profile = DEFAULT_DSH_PROFILE) {
  if (profile === DESKTOP_PROFILE) return [
    '# Start Desktop once, then fully quit it (including its tray) before running:',
    '# Use Desktop resources/runtime/cli/bin/dsh (dsh.cmd on Windows), NOT npm DSH.',
    `dsh ${shellArgs(dshPluginArgs('add', profile))}`,
    '',
    '# Or, while Desktop is running: Plugins → Add plugin → enter search-boost',
    '# (npm registry install), or this absolute local package path to reuse it:',
    PKG_ROOT,
    '',
    `# remove with the same Desktop launcher: dsh ${shellArgs(dshPluginArgs('remove', profile))}`,
  ].join('\n')
  return [
    `# DSH bundle plugin — installs into ${join(PATHS.dsh.profiles, profile)} via pnpm:`,
    `dsh ${shellArgs(dshPluginArgs('add', profile))}`,
    '',
    '# or from npm without a global dsh:',
    `npx --yes --package @deepseek-ai/dsh --package pnpm -- dsh ${shellArgs(['plugin', '--profile', profile, 'add', `${DSH_PACKAGE_NAME}@${getVersion()}`])}`,
    '',
    '# verify: web.searchProvider / fetchProvider → search-boost',
    `dsh --profile ${shellArgs([profile])} --dump-config`,
    '',
    `# remove: dsh ${shellArgs(dshPluginArgs('remove', profile))}`,
  ].join('\n')
}
