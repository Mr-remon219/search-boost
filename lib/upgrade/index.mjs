import { t, integrationWarning, pluginUpgradeMessage, pluginUpgradeStatus } from '../installer/i18n.mjs'
/** Current-version integration refresh. Never updates the SearchBoost npm package. */
import { existsSync } from 'node:fs'
import { pool } from '../search/text.js'
import { writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { PATHS } from '../paths.mjs'
import { PKG_ROOT, getVersion, getPackageName } from '../pkg.mjs'
import { searchBoostHome } from '../config-paths.mjs'
import { discoverIntegrations, refreshIntegration, refreshGrokPlugin, integrationResources } from './integrations.mjs'
import { recordedProjectsPath } from './state.mjs'
import { groupUpgradeJobs } from './scheduler.mjs'
import { runCommand, compareVersions } from './process.mjs'
import { verifyReplacement } from './packages.mjs'
import { acquireLock } from './lock.mjs'
import { cachedRuntime } from './delivery.mjs'
import { integrationTargetKey } from './integrations.mjs'

const PACKAGE = 'search-boost'

/** Injectable command runner is used by hermetic tests; production never mocks host execution. */
export async function runRefresh({ dryRun = false, workspace, selected, run = runCommand, log = console.log, confirmGrokRepair, repairGrokCache = false, verbose = false } = {}) {
  const current = getVersion()
  compareVersions(current, current)
  if (getPackageName() !== PACKAGE) throw new Error('Install search-boost with npm before refreshing integrations.')
  if (cachedRuntime()) throw new Error('Install search-boost globally with npm before refreshing; temporary npx paths are not durable integration targets.')
  if (selected !== undefined && (!Array.isArray(selected) || selected.some(key => typeof key !== 'string'))) throw new Error('Invalid selected integration targets')
  const lock = dryRun ? { token: '', release: async () => {} } : await acquireLock()
  try {
    log(t(`Refreshing existing integrations from ${current}; the SearchBoost npm package is unchanged.`, `正在使用 ${current} 刷新已有接入；不更新 SearchBoost npm 软件包。`))
    await verifyReplacement(PKG_ROOT, current)
    const plan = await discoverIntegrations({ workspace })
    const available = new Set(plan.targets.map(integrationTargetKey))
    const pluginAvailable = plan.targets.some(target => target.id === 'grok') || existsSync(dirname(PATHS.grok.config))
    if (pluginAvailable) available.add('grok-plugin')
    const selectionWarnings = selected
      ? selected.filter(key => !available.has(key)).map(key => `Selected integration unavailable: ${key}`)
      : []
    const blockingWarnings = selected ? selectionWarnings : plan.warnings
    // Discovery failures outside an explicit selection are disclosed, but do not
    // change its status. A selected target missing from discovery still blocks.
    for (const warning of plan.warnings) log(`${selected ? t('[skipped]', '[跳过]') : t('[blocked]', '[受阻]')} ${integrationWarning(warning)}`)
    for (const warning of selectionWarnings) log(`${t('[blocked]', '[受阻]')} ${integrationWarning(warning)}`)
    const targets = selected ? plan.targets.filter(target => selected.includes(integrationTargetKey(target))) : plan.targets
    // Stale historical receipts are disclosed but never block the usable
    // integrations, and their entries stay in the user's state file.
    for (const record of plan.skippedRecords) log(`${t('[skipped]', '[跳过]')} ${integrationWarning(record)}`)
    if (plan.skippedRecords.length) log(t(`Skipped ${plan.skippedRecords.length} stale recorded project(s); nothing was deleted. Review or remove those entries in ${recordedProjectsPath()} if they are no longer installed.`, `已跳过 ${plan.skippedRecords.length} 个失效的历史项目记录；未删除任何内容。如这些项目已不再安装，可在 ${recordedProjectsPath()} 中审核或移除对应条目。`))
    // Serialize overlapping backup/write sets, including shared skills/hooks
    // and receipts. Independent hosts still run alongside slow runtime commands.
    const dshCount = targets.filter(target => target.kind === 'dsh').length
    if (dshCount && !verbose) log(`${dryRun ? t('[plan]', '[计划]') : t('[refresh]', '[刷新]')} ${t(`dsh: verifying ${dshCount} profile(s)`, `dsh：核验 ${dshCount} 个配置`)}`)
    const jobs = targets.map((target) => {
      let resources = [], planningError
      try { resources = integrationResources(target) } catch (err) { planningError = err }
      return { resources, run: async () => {
        const startedAt = Date.now()
        const facts = []
        const label = target.id === 'grok' ? target.label.replace(/^grok/, 'Grok MCP') : target.label
        if (target.kind !== 'dsh' || verbose) log(`${dryRun ? t('[plan]', '[计划]') : t('[refresh]', '[刷新]')} ${label}${target.legacy ? t(' (legacy package migration)', '（旧版软件包迁移）') : ''}`)
        try {
          if (planningError) throw planningError
          const backup = await refreshIntegration(target, { dryRun, run, report: (fact) => facts.push(fact) })
          const synced = facts.some(fact => fact.stage === 'dsh' && fact.action === 'already-synced')
          const status = dryRun ? t('planned', '已计划') : synced ? t('current', '已同步') : t('ok', '成功')
          const timing = target.kind === 'dsh' && !verbose ? ` · ${((Date.now() - startedAt) / 1000).toFixed(1)}s` : ''
          log(`[${status}] ${label}${timing}`)
          if (verbose) for (const fact of facts) log(`[timing] ${target.label}: ${fact.stage}=${fact.action}, ${t('host dispatches', '宿主派发')} ${fact.hostDispatches} (${fact.dispatchMs}ms), ${t('verifications', '验证')} ${fact.verifications} (${fact.verificationMs}ms)`)
          return { target: target.label, ok: true, durationMs: Date.now() - startedAt, ...(backup ? { backup } : {}), ...(facts.length ? { facts } : {}) }
        } catch (err) {
          const error = err instanceof Error ? err.message : 'Upgrade failed'
          log(`${t('[failed]', '[失败]')} ${label}: ${error}`)
          return { target: target.label, ok: false, error, durationMs: Date.now() - startedAt }
        }
      } }
    })
    let interactivePluginJob
    if (pluginAvailable && (!selected || selected.includes('grok-plugin'))) {
      const pluginJob = { resources: ['grok'], run: async () => {
        const startedAt = Date.now()
        try {
          const plugin = await refreshGrokPlugin({ dryRun, run, confirmRepair: confirmGrokRepair, repair: repairGrokCache })
          const ok = !['failed', 'unavailable'].includes(plugin.status)
          log(`[${pluginUpgradeStatus(plugin.status)}] ${t('Grok native plugin', 'Grok 原生插件')}: ${pluginUpgradeMessage(plugin.message)}`)
          return { target: 'grok plugin', ok, status: plugin.status, message: plugin.message, durationMs: Date.now() - startedAt }
        } catch (err) {
          const error = err.message || 'Grok plugin refresh failed; no success assumed.'
          log(`${t('[failed]', '[失败]')} ${t('Grok native plugin', 'Grok 原生插件')}: ${error}`)
          return { target: 'grok plugin', ok: false, error, durationMs: Date.now() - startedAt }
        }
      } }
      // Never render an interactive trust prompt while sibling jobs write to the
      // terminal. Non-interactive refreshes retain resource-aware parallelism.
      if (typeof confirmGrokRepair === 'function' && !dryRun && !repairGrokCache) interactivePluginJob = pluginJob
      else jobs.push(pluginJob)
    }
    const results = new Array(jobs.length)
    await pool(groupUpgradeJobs(jobs), 3, async (lane) => {
      for (const job of lane) results[job.index] = await job.run()
    })
    if (interactivePluginJob) results.push(await interactivePluginJob.run())
    const ok = !blockingWarnings.length && results.every((r) => r.ok)
    if (!results.length) log(t('No existing supported integrations found; use Install for a new host.', '未发现支持的已有接入；请使用安装功能接入新宿主。'))
    if (!ok) log(t(`Resume safely with: ${JSON.stringify(process.execPath)} ${JSON.stringify(join(PKG_ROOT, 'cli.mjs'))} refresh -y`, `可安全重试：${JSON.stringify(process.execPath)} ${JSON.stringify(join(PKG_ROOT, 'cli.mjs'))} refresh -y`))
    if (!dryRun) {
      await writeFile(join(searchBoostHome(), 'state', 'last-refresh.json'), `${JSON.stringify({ version: current, at: new Date().toISOString(), ok, skippedRecords: plan.skippedRecords, results }, null, 2)}\n`, { mode: 0o600 })
    }
    log(dryRun ? t('Dry-run only: no package, integration, or credential files changed.', '仅 dry-run：未修改软件包、接入配置或凭据文件。') : ok ? t('Refresh complete. Restart/reload affected hosts; disabled hooks and permission decisions remain unchanged.', '刷新完成。请重启 / 重新加载相关宿主；已停用的 hooks 和权限选择保持不变。') : t('Refresh incomplete: see failed/blocked targets above. Successful targets are retained; retry after resolving blockers.', '刷新未完成：请查看上方失败 / 受阻目标。成功目标已保留；解决问题后可重试。'))
    return { ok, version: current, results, warnings: [...plan.warnings, ...selectionWarnings], skippedRecords: plan.skippedRecords }
  } finally { await lock.release() }
}
