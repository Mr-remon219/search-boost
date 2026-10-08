import { installationStatus } from '../installation-status.mjs'
import { t, nativeStateLabel } from './i18n.mjs'
import { AGENT_IDS, AGENTS, agentStatus } from '../agents/index.mjs'
import { hasAnyKey } from '../keys.mjs'
import { getLayer, layerFilePath } from '../layer-config.mjs'
import { nativeSearchStatus } from '../native-search.mjs'
import { formatKeyStatusLines } from './keys-wizard.mjs'
import { formatXAuthStatusLines } from './xauth-wizard.mjs'
import { formatCommunityStatusLines } from './community-wizard.mjs'
import { formatJudgmentStatusLines } from './judgment-wizard.mjs'
import { RULE_WIDE, tildify } from './ui.mjs'

const STATE_LABEL = {
  replaced: 'replaced',
  native: 'native',
  prompt: 'prompt',
  left: 'left',
  unknown: '-',
}

/** @returns {string | null} */
export function layerApiNoKeysWarning() {
  if (getLayer() === 'api' && !hasAnyKey()) {
    return t('Warning: layer is api but no API keys configured -- searches use free engines', '警告：搜索层为 api，但未配置 API Keys — 搜索将使用免费引擎。')
  }
  return null
}

export async function printStatus({ json = false, workspace } = {}) {
  const evidence = await installationStatus({ workspace })
  if (json) { console.log(JSON.stringify(evidence, null, 2)); return evidence }
  for (const line of formatKeyStatusLines()) console.log(line)
  console.log('')
  for (const line of formatCommunityStatusLines()) console.log(line)
  console.log('')
  for (const line of formatXAuthStatusLines()) console.log(line)
  const jevLines = formatJudgmentStatusLines()
  if (jevLines.length) {
    console.log('')
    for (const line of jevLines) console.log(line)
  }
  console.log(`\nLayer: ${getLayer()} (${tildify(layerFilePath())})`)
  const layerWarn = layerApiNoKeysWarning()
  if (layerWarn) console.log(layerWarn)
  console.log('\nAgents')
  console.log(RULE_WIDE)
  console.log(
    `${'Agent'.padEnd(15)}${'Detected'.padEnd(10)}${'Configured'.padEnd(12)}${'Native search'.padEnd(28)}Label`,
  )
  for (const id of AGENT_IDS) {
    const s = agentStatus(id)
    const native = nativeSearchStatus(id)
    const nativeCol = `${STATE_LABEL[native.state] ?? native.state} (${native.name})`
    console.log(
      `${id.padEnd(15)}${(s.detected ? 'yes' : 'no').padEnd(10)}${(s.configured ? 'yes' : 'no').padEnd(12)}${nativeCol.padEnd(28)}${s.label}`,
    )
  }
  console.log(`
Native search states:
  replaced  config/deny switch is on (Codex web_search off, Claude WebSearch denied)
  native    switch is off — built-in search still available
  prompt    no switch; inject prefers search-boost
  left      intentionally untouched (Grok native browse)`)
  console.log('\n' + installationEvidenceLines(evidence).join('\n'))
  return evidence
}

/** @param {import('@clack/prompts').ClackPrompter} clack */
export async function noteStatus(clack, { workspace } = {}) {
  const evidence = await installationStatus({ workspace })
  const agentLines = AGENT_IDS.map((id) => {
    const s = agentStatus(id)
    const native = nativeSearchStatus(id)
    const det = s.detected ? t('in', '已检测到') : '—'
    const cfg = s.configured ? t('on', '已配置') : t('off', '未配置')
    return `${id.padEnd(14)} ${det}/${cfg}  ${nativeStateLabel(native.state)} · ${native.name}`
  })
  const layerWarn = layerApiNoKeysWarning()
  const jevLines = formatJudgmentStatusLines()
  clack.note(
    [
      ...formatKeyStatusLines(),
      '',
      ...formatCommunityStatusLines(),
      '',
      ...formatXAuthStatusLines(),
      ...(jevLines.length ? ['', ...jevLines] : []),
      '',
      t(`Layer: ${getLayer()} (${tildify(layerFilePath())})`, `搜索层：${getLayer()}（${tildify(layerFilePath())}）`),
      layerWarn,
      '',
      t('Agents', "Agent 接入"),
      ...agentLines,
    ].filter(Boolean).join('\n'),
    t('Status', "当前状态"),
  )
  clack.note(installationEvidenceLines(evidence).join('\n'), t('Managed / legacy integrations', '已管理 / 旧版接入'))
  return evidence
}

export { AGENTS }


function installationEvidenceLines(evidence) {
  const payloadLabel = value => ({
    matches_current_package: t('matches current package on disk', '磁盘文件与当前软件包一致'),
    not_verified: t('payload not verified (missing/different/unreadable)', '载荷未核实（缺失、不一致或无法读取）'),
    missing: t('package missing', '软件包缺失'), foreign: t('foreign package', '非本软件包'),
    unreadable: t('package metadata unreadable', '无法读取软件包信息'), unknown: t('source unknown', '来源未知'),
  })[value] ?? t('unknown', '未知')
  const lines = [t(`Current package: v${evidence.package.version} — ${tildify(evidence.package.root)}`, `当前软件包：v${evidence.package.version} — ${tildify(evidence.package.root)}`)]
  for (const agent of evidence.agents) for (const registration of agent.registrations) {
    const sources = registration.sources ?? [registration]
    for (const source of [...sources, ...(registration.legacySources ?? []).map(source => ({ ...source, legacy: true }))]) {
      const location = source.root ? ` — ${tildify(source.root)}` : ''
      const legacy = registration.legacy || source.legacy ? t(' — legacy; refresh via Update', ' — 旧版；请通过更新刷新') : ''
      lines.push(`${registration.scope}${location}${legacy}: ${t('disk version', '磁盘版本')} ${source.installedVersion ?? t('unknown', '未知')}; ${payloadLabel(source.payload)}`)
    }
  }
  lines.push(t('Running host version / reload: unknown. Reopen or reconnect the host; disk evidence does not confirm it has loaded this package.', '运行中宿主版本 / 重载：未知。请重新打开或连接宿主；磁盘证据不能确认其已加载当前软件包。'))
  lines.push(t('DSH owning-host resolution and Grok native plugin cache: not inspected by this read-only status.', '此只读状态不核实 DSH owning-host 解析或 Grok 原生插件缓存。'))
  if (evidence.configurationWarnings) lines.push(t(`${evidence.configurationWarnings} configuration(s) could not be fully inspected; raw diagnostics and values are omitted.`, `${evidence.configurationWarnings} 个配置未能完整检查；不显示原始诊断或配置值。`))
  return lines
}
