import { t, integrationWarning, pluginUpgradeMessage, pluginUpgradeStatus } from '../installer/i18n.mjs'
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
      log(t(`Checking npm ${PACKAGE}@latest (running ${current})…`, `正在检查 npm ${PACKAGE}@latest（当前 ${current}）…`))
      latest = await latestVersion(run)
      const version = compareVersions(current, latest) > 0 ? current : latest
      if (compareVersions(current, latest) < 0 || cachedRuntime()) {
        if (dryRun) log(t(`Would run ${PACKAGE}@${version} from the npx cache, update the global package, then refresh all installed agents.`, `将从 npx 缓存运行 ${PACKAGE}@${version}，更新全局软件包，然后刷新所有已安装 Agent 接入。`))
        else if (!cachedRuntime() || current !== version) {
          await runCachedCommand('upgrade', { version, workspace, run, log, token: lock.token })
          return { ok: true, reloaded: true, version, results: [] }
        } else {
          const paths = await globalPackagePaths(run)
          if (existsSync(join(paths.legacy, 'package.json'))) throw new Error('The old global search-boost-mcp package is still installed. Run npx --yes --package=search-boost@latest -- search-boost migrate -y first.')
          const installed = await strictJson(join(paths.current, 'package.json'))
          if (installed.name === PACKAGE && compareVersions(installed.version, version) > 0) throw new Error(`Installed search-boost ${installed.version} is newer than ${version}; refusing downgrade`)
          log(t(`Installing ${PACKAGE}@${version} globally from the cached updater…`, `正在通过缓存更新器全局安装 ${PACKAGE}@${version}…`))
          await installGlobal(run, version)
          await verifyReplacement(paths.current, version)
          await verifyGlobalCommand(paths, version, run)
          await syncInstalled(paths.current, { workspace, run, log, token: lock.token })
          return { ok: true, reloaded: true, version, results: [] }
        }
      } else log(compareVersions(current, latest) > 0 ? t(`Running ${current} is newer than npm ${latest}; not downgrading. Refreshing all installed agents.`, `当前 ${current} 比 npm ${latest} 更新；不降级，将刷新所有已安装 Agent 接入。`) : t(`Already ${current}; refreshing all installed agents anyway.`, `已是 ${current}；仍将刷新所有已安装 Agent 接入。`))
    } else {
      if (cachedRuntime()) throw new Error('Install search-boost globally before --sync-only; temporary npx paths are not durable integration targets')
      log(t(`Refreshing all installed agents from ${current} without downloading or changing credentials.`, `正在使用 ${current} 刷新所有已安装 Agent 接入，不下载软件包或更改凭据。`))
    }

    if (getPackageName() === PACKAGE) await verifyReplacement(PKG_ROOT, current)
    const plan = await discoverIntegrations({ workspace })
    for (const warning of plan.warnings) log(`${t('[blocked]', '[受阻]')} ${integrationWarning(warning)}`)
    // Serialize overlapping backup/write sets, including shared skills/hooks
    // and receipts. Independent hosts still run alongside slow runtime commands.
    const jobs = plan.targets.map((target) => {
      let resources = [], planningError
      try { resources = integrationResources(target) } catch (err) { planningError = err }
      return { resources, run: async () => {
        log(`${dryRun ? t('[plan]', '[计划]') : t('[upgrade]', '[更新]')} ${target.label}${target.legacy ? t(' (legacy package migration)', '（旧版软件包迁移）') : ''}`)
        try {
          if (planningError) throw planningError
          const backup = await refreshIntegration(target, { dryRun, run })
          log(`[${dryRun ? t('planned', '已计划') : t('ok', '成功')}] ${target.label}`)
          return { target: target.label, ok: true, ...(backup ? { backup } : {}) }
        } catch (err) {
          const error = err instanceof Error ? err.message : 'Upgrade failed'
          log(`${t('[failed]', '[失败]')} ${target.label}: ${error}`)
          return { target: target.label, ok: false, error }
        }
      } }
    })
    if (plan.targets.some((t) => t.id === 'grok') || existsSync(dirname(PATHS.grok.config))) {
      jobs.push({ resources: ['grok'], run: async () => {
        try {
          const plugin = await refreshGrokPlugin({ dryRun, run })
          const ok = !['failed', 'unavailable'].includes(plugin.status)
          log(`[${pluginUpgradeStatus(plugin.status)}] ${pluginUpgradeMessage(plugin.message)}`)
          return { target: 'grok plugin', ok, status: plugin.status }
        } catch (err) {
          log(`${t('[failed]', '[失败]')} ${err.message}`)
          return { target: 'grok plugin', ok: false }
        }
      } })
    }
    const results = new Array(jobs.length)
    await pool(groupUpgradeJobs(jobs), 3, async (lane) => {
      for (const job of lane) results[job.index] = await job.run()
    })
    const ok = !plan.warnings.length && results.every((r) => r.ok)
    if (!results.length) log(t('No existing supported integrations found; use Install for a new host.', '未发现支持的已有接入；请使用安装功能接入新宿主。'))
    if (!ok) log(t(`Resume safely with: ${JSON.stringify(process.execPath)} ${JSON.stringify(join(PKG_ROOT, 'cli.mjs'))} upgrade --sync-only -y`, `可安全重试：${JSON.stringify(process.execPath)} ${JSON.stringify(join(PKG_ROOT, 'cli.mjs'))} upgrade --sync-only -y`))
    if (!dryRun) {
      await writeFile(join(searchBoostHome(), 'state', 'last-upgrade.json'), `${JSON.stringify({ version: current, checkedLatest: latest, at: new Date().toISOString(), ok, results }, null, 2)}\n`, { mode: 0o600 })
    }
    log(dryRun ? t('Dry-run only: no package, integration, or credential files changed.', '仅 dry-run：未修改软件包、接入配置或凭据文件。') : ok ? t('Upgrade complete. Restart/reload affected hosts; disabled hooks and permission decisions remain unchanged.', '更新完成。请重启 / 重新加载相关宿主；已停用的 hooks 和权限选择保持不变。') : t('Upgrade incomplete: see failed/blocked targets above. Successful targets are retained; retry after resolving blockers.', '更新未完成：请查看上方失败 / 受阻目标。成功目标已保留；解决问题后可重试。'))
    return { ok, version: current, results, warnings: plan.warnings }
  } finally { await lock.release() }
}
