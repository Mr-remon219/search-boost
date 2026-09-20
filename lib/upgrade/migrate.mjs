/** One-time GLOBAL npm rename only. Pi/DSH legacy adapters belong to normal Update. */
import { existsSync } from 'node:fs'
import { join, resolve, relative, isAbsolute } from 'node:path'
import { getPackageName, getVersion } from '../pkg.mjs'
import { strictJson } from './config.mjs'
import { recordRetiredPackage } from '../package-sources.mjs'
import { acquireLock } from './lock.mjs'
import { runCommand, checkedCommand, compareVersions } from './process.mjs'
import { verifyReplacement } from './packages.mjs'
import { cachedRuntime, restoreCallerCwd, latestVersion, globalPackagePaths, runCachedCommand, installGlobal } from './delivery.mjs'
import { withLegacyBinParked, verifyGlobalCommand, rebuildGlobalCommand } from './bins.mjs'
import { parseUpgradeArgs } from './cli.mjs'
import { handleCancel, loadClack } from '../installer/ui.mjs'

export async function runMigration({ dryRun = false, workspace, run = runCommand, log = console.log } = {}) {
  restoreCallerCwd()
  if (getPackageName() !== 'search-boost') throw new Error('Run npx --yes --package=search-boost@latest -- search-boost migrate -y; no legacy transition release is needed')
  const lock = dryRun ? { token: '', release: async () => {} } : await acquireLock()
  try {
    const paths = await globalPackagePaths(run)
    const old = await strictJson(join(paths.legacy, 'package.json'))
    const installed = await strictJson(join(paths.current, 'package.json'))
    if (!old.name) {
      if (installed.name !== 'search-boost') throw new Error('No global search-boost-mcp installation found in this npm prefix. For a new installation, install search-boost and open its TUI.')
      await verifyReplacement(paths.current, installed.version)
      // Idempotent recovery if the previous process stopped after old-package removal.
      if (!dryRun) await rebuildGlobalCommand(paths, installed.version, run)
      log('Already migrated. Open search-boost and choose Update to refresh all installed agents.')
      return { ok: true, alreadyMigrated: true, version: installed.version }
    }
    if (old.name !== 'search-boost-mcp') throw new Error('Unexpected package at the legacy npm path; nothing removed')
    compareVersions(old.version, old.version)
    if (installed.name && installed.name !== 'search-boost') throw new Error('Unexpected package at the new npm path; nothing changed')
    const latest = await latestVersion(run)
    if (dryRun) {
      log(`Would run search-boost@${latest} from the npx cache, install/verify the new global package, then uninstall global search-boost-mcp and verify the new command.`)
      log('Agent configuration and credentials remain unchanged. After migration, open search-boost and choose Update to refresh all installed agents, including legacy Pi/DSH. No changes made.')
      return { ok: true }
    }
    if (!cachedRuntime() || getVersion() !== latest) {
      await runCachedCommand('migrate', { version: latest, workspace, run, log, token: lock.token })
      return { ok: true, reloaded: true, version: latest }
    }
    // Package names are different release streams; never compare the legacy
    // version to the new version. An already newer NEW package is not downgraded.
    const version = installed.name === 'search-boost' && compareVersions(installed.version, latest) > 0 ? installed.version : latest
    log(`Installing and verifying search-boost@${version}; keeping the old package until the replacement is verified…`)
    await withLegacyBinParked(paths, async () => {
      if (installed.name !== 'search-boost' || installed.version !== version) await installGlobal(run, version)
      else await rebuildGlobalCommand(paths, version, run)
      await verifyReplacement(paths.current, version)
      await verifyGlobalCommand(paths, version, run)
    })
    // Keep native registrations recognizable after the global directory goes
    // away, WITHOUT editing any agent's settings. TUI Update does that later.
    const declared = [...(Array.isArray(old.pi?.extensions) ? old.pi.extensions : []), 'index.js', 'index.ts']
      .filter((entry) => typeof entry === 'string' && !/[*!?\[]/.test(entry))
      .map((entry) => resolve(paths.legacy, entry))
      .filter((entry) => { const rel = relative(paths.legacy, entry); return !rel.startsWith('..') && !isAbsolute(rel) && existsSync(entry) })
    recordRetiredPackage(paths.legacy, old.version, declared)
    log('New package verified. Removing the old global search-boost-mcp package; agent configuration is unchanged…')
    let removalError
    try {
      await checkedCommand(run, 'npm', ['uninstall', '--global', '--ignore-scripts', '--force=false', '--no-audit', '--no-fund', 'search-boost-mcp'], { timeoutMs: 180_000 })
      if (existsSync(paths.legacy)) throw new Error('Legacy global package remains after npm uninstall')
    } catch (err) { removalError = err }
    // npm uninstall may remove a formerly shared bin. Always relink/verify it,
    // including partial uninstall failures; cached migration code is unaffected.
    await rebuildGlobalCommand(paths, version, run)
    if (removalError) throw new Error('New package is ready, but old-package cleanup failed. Retry the same npx migrate command; configuration is retained.')
    log('Migration complete. Run search-boost and choose Update to refresh all installed agents, including legacy Pi/DSH, before restarting them. User configuration is retained.')
    return { ok: true, version, removed: 'search-boost-mcp' }
  } finally { await lock.release() }
}

export async function runMigrationCli(args, { run, log } = {}) {
  const { options, yes, help } = parseUpgradeArgs(args, { command: 'search-boost migrate', allowSyncOnly: false })
  if (help) {
    console.log(`npx --yes --package=search-boost@latest -- search-boost migrate [-y] [--dry-run] [--workspace PATH]
One-time migration of the global search-boost-mcp package to search-boost; no transition release required.
Installs/verifies the new package, then removes the old global package. Agent settings are not edited.
User configuration, credentials, permissions and disabled state are preserved.
Next, open search-boost and choose Update for ALL installed agents (including legacy Pi/DSH adapters).`)
    return
  }
  if (!yes && !options.dryRun) {
    const clack = await loadClack()
    const confirmed = await clack.confirm({ message: 'Replace global search-boost-mcp with search-boost and remove the old package? Agent settings and user configuration are preserved.', initialValue: true })
    handleCancel(confirmed, clack)
    if (!confirmed) return
  }
  const result = await runMigration({ ...options, ...(run ? { run } : {}), ...(log ? { log } : {}) })
  if (!result.ok) process.exitCode = 1
  return result
}
