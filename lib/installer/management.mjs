import { existsSync } from 'node:fs'
import { dirname } from 'node:path'
import { PATHS } from '../paths.mjs'
import { discoverIntegrations, integrationTargetKey } from '../upgrade/integrations.mjs'
import { runRefresh } from '../upgrade/index.mjs'
import { t, integrationWarning } from './i18n.mjs'
import { handleCancel } from './ui.mjs'
import { confirmGrokCacheRepair } from './grok-consent.mjs'

/** Select exact existing scopes/profiles; newly discovered targets never expand consent. */
export async function runRefreshTui(clack, opts = {}, refresh = runRefresh) {
  const plan = await discoverIntegrations({ workspace: opts.workspace })
  const options = plan.targets.map(target => ({ value: integrationTargetKey(target), label: target.id === 'grok' ? target.label.replace(/^grok/, 'Grok MCP') : target.label }))
  if (plan.targets.some(target => target.id === 'grok') || existsSync(dirname(PATHS.grok.config))) {
    options.push({ value: 'grok-plugin', label: t('Grok native plugin — verify existing registration', 'Grok 原生插件 — 核验已有登记') })
  }
  for (const warning of plan.warnings) clack.log.warn(integrationWarning(warning))
  // Execution discloses exact paths once and persists them in last-refresh.json.
  if (plan.skippedRecords.length) clack.log.info(t(`[skipped] ${plan.skippedRecords.length} unavailable historical project(s); records retained.`, `[跳过] ${plan.skippedRecords.length} 个失效的历史项目；登记保留。`))
  if (!options.length) {
    clack.log.info(t('No existing integrations found. Use Install integrations for a new host.', '未找到已有接入。新宿主请使用“安装接入”。'))
    if (plan.warnings.length) process.exitCode = 1
    return { ok: !plan.warnings.length, results: [] }
  }
  const selected = await clack.multiselect({
    message: t('Which existing integrations should be refreshed?', '刷新哪些已有接入？'),
    options, initialValues: options.map(option => option.value), required: false,
  })
  handleCancel(selected, clack)
  if (!Array.isArray(selected) || selected.some(key => !options.some(option => option.value === key))) throw new Error('Invalid selected integration target')
  if (!selected.length) {
    clack.log.info(t('No integrations selected; nothing was changed.', '未选择接入，未做任何修改。'))
    return { ok: true, results: [] }
  }
  clack.note(t('Uses the current SearchBoost package only. Credentials, permissions and disabled states are preserved. Software updates are performed separately with npm.', '仅使用当前 SearchBoost 软件包。保留凭据、权限与禁用状态；软件包版本由用户另外通过 npm 更新。'), t('Refresh scope', '刷新范围'))
  const result = await refresh({ dryRun: !!opts.dryRun, workspace: opts.workspace, selected,
    log: message => clack.log.info(message), confirmGrokRepair: plan => confirmGrokCacheRepair(clack, plan) })
  if (!result.ok) process.exitCode = 1
  return result
}
