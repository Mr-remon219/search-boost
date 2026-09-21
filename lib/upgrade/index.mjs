/** TUI/CLI upgrade orchestration. Never writes key/layer/auth files or enables permissions. */
import { existsSync } from 'node:fs'
import { pool } from '../search/text.js'
import { writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { PATHS } from '../paths.mjs'
import { PKG_ROOT, getVersion, getPackageName } from '../pkg.mjs'
import { searchBoostHome } from '../config-paths.mjs'
import { discoverIntegrations, refreshIntegration, refreshGrokPlugin, integrationResources } from './integrations.mjs'
import { groupUpgradeJobs } from './scheduler.mjs'
import { runCommand, compareVersions } from './process.mjs'
import { strictJson } from './config.mjs'
import { verifyReplacement } from './packages.mjs'
import { acquireLock } from './lock.mjs'
import { verifyGlobalCommand } from './bins.mjs'
import { cachedRuntime, restoreCallerCwd, latestVersion, globalPackagePaths, runCachedCommand, installGlobal, syncInstalled } from './delivery.mjs'

const PACKAGE = 'search-boost'

/** Injectable command runner is used by hermetic tests; production never mocks host execution. */
export async function runUpgrade({ dryRun = false, syncOnly = false, workspace, run = runCommand, log = console.log } = {}) {
  restoreCallerCwd()
  const current = getVersion()
  compareVersions(current, current)
  if (getPackageName() !== PACKAGE) throw new Error('Use npx --yes --package=search-boost@latest -- search-boost migrate -y to migrate the old npm package')
  let latest = current
  const lock = dryRun ? { token: '', release: async () => {} } : await acquireLock()
  try {
    if (!syncOnly) {
      log(`Checking npm ${PACKAGE}@latest (running ${current})…`)
      latest = await latestVersion(run)
      const version = compareVersions(current, latest) > 0 ? current : latest
      if (compareVersions(current, latest) < 0 || cachedRuntime()) {
        if (dryRun) log(`Would run ${PACKAGE}@${version} from the npx cache, update the global package, then refresh all installed agents.`)
        else if (!cachedRuntime() || current !== version) {
          await runCachedCommand('upgrade', { version, workspace, run, log, token: lock.token })
          return { ok: true, reloaded: true, version, results: [] }
        } else {
          const paths = await globalPackagePaths(run)
          if (existsSync(join(paths.legacy, 'package.json'))) throw new Error('The old global search-boost-mcp package is still installed. Run npx --yes --package=search-boost@latest -- search-boost migrate -y first.')
          const installed = await strictJson(join(paths.current, 'package.json'))
          if (installed.name === PACKAGE && compareVersions(installed.version, version) > 0) throw new Error(`Installed search-boost ${installed.version} is newer than ${version}; refusing downgrade`)
          log(`Installing ${PACKAGE}@${version} globally from the cached updater…`)
          await installGlobal(run, version)
          await verifyReplacement(paths.current, version)
          await verifyGlobalCommand(paths, version, run)
          await syncInstalled(paths.current, { workspace, run, log, token: lock.token })
          return { ok: true, reloaded: true, version, results: [] }
        }
      } else log(compareVersions(current, latest) > 0 ? `Running ${current} is newer than npm ${latest}; not downgrading. Refreshing all installed agents.` : `Already ${current}; refreshing all installed agents anyway.`)
    } else {
      if (cachedRuntime()) throw new Error('Install search-boost globally before --sync-only; temporary npx paths are not durable integration targets')
      log(`Refreshing all installed agents from ${current} without downloading or changing credentials.`)
    }

    if (getPackageName() === PACKAGE) await verifyReplacement(PKG_ROOT, current)
    const plan = await discoverIntegrations({ workspace })
    for (const warning of plan.warnings) log(`[blocked] ${warning}`)
    // Serialize overlapping backup/write sets, including shared skills/hooks
    // and receipts. Independent hosts still run alongside slow runtime commands.
    const jobs = plan.targets.map((target) => {
      let resources = [], planningError
      try { resources = integrationResources(target) } catch (err) { planningError = err }
      return { resources, run: async () => {
        log(`${dryRun ? '[plan]' : '[upgrade]'} ${target.label}${target.legacy ? ' (legacy package migration)' : ''}`)
        try {
          if (planningError) throw planningError
          const backup = await refreshIntegration(target, { dryRun, run })
          log(`[${dryRun ? 'planned' : 'ok'}] ${target.label}`)
          return { target: target.label, ok: true, ...(backup ? { backup } : {}) }
        } catch (err) {
          const error = err instanceof Error ? err.message : 'Upgrade failed'
          log(`[failed] ${target.label}: ${error}`)
          return { target: target.label, ok: false, error }
        }
      } }
    })
    if (plan.targets.some((t) => t.id === 'grok') || existsSync(dirname(PATHS.grok.config))) {
      jobs.push({ resources: ['grok'], run: async () => {
        try {
          const plugin = await refreshGrokPlugin({ dryRun, run })
          const ok = !['failed', 'unavailable'].includes(plugin.status)
          log(`[${plugin.status}] ${plugin.message}`)
          return { target: 'grok plugin', ok, status: plugin.status }
        } catch (err) {
          log(`[failed] ${err.message}`)
          return { target: 'grok plugin', ok: false }
        }
      } })
    }
    const results = new Array(jobs.length)
    await pool(groupUpgradeJobs(jobs), 3, async (lane) => {
      for (const job of lane) results[job.index] = await job.run()
    })
    const ok = !plan.warnings.length && results.every((r) => r.ok)
    if (!results.length) log('No existing supported integrations found; use Install for a new host.')
    if (!ok) log(`Resume safely with: ${JSON.stringify(process.execPath)} ${JSON.stringify(join(PKG_ROOT, 'cli.mjs'))} upgrade --sync-only -y`)
    if (!dryRun) {
      await writeFile(join(searchBoostHome(), 'state', 'last-upgrade.json'), `${JSON.stringify({ version: current, checkedLatest: latest, at: new Date().toISOString(), ok, results }, null, 2)}\n`, { mode: 0o600 })
    }
    log(dryRun ? 'Dry-run only: no package, integration, or credential files changed.' : ok ? 'Upgrade complete. Restart/reload affected hosts; disabled hooks and permission decisions remain unchanged.' : 'Upgrade incomplete: see failed/blocked targets above. Successful targets are retained; retry after resolving blockers.')
    return { ok, version: current, results, warnings: plan.warnings }
  } finally { await lock.release() }
}
