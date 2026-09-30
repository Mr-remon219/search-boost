import { t, nativeStateLabel } from './i18n.mjs'
import { AGENT_IDS, AGENTS, agentStatus } from '../agents/index.mjs'
import { hasAnyKey } from '../keys.mjs'
import { getLayer, layerFilePath } from '../layer-config.mjs'
import { nativeSearchStatus } from '../native-search.mjs'
import { formatKeyStatusLines } from './keys-wizard.mjs'
import { formatXAuthStatusLines } from './xauth-wizard.mjs'
import { formatJevStatusLines } from './jev-wizard.mjs'
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

export function printStatus() {
  for (const line of formatKeyStatusLines()) console.log(line)
  console.log('')
  for (const line of formatXAuthStatusLines()) console.log(line)
  const jevLines = formatJevStatusLines()
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
}

/** @param {import('@clack/prompts').ClackPrompter} clack */
export function noteStatus(clack) {
  const agentLines = AGENT_IDS.map((id) => {
    const s = agentStatus(id)
    const native = nativeSearchStatus(id)
    const det = s.detected ? t('in', '已检测到') : '—'
    const cfg = s.configured ? t('on', '已配置') : t('off', '未配置')
    return `${id.padEnd(14)} ${det}/${cfg}  ${nativeStateLabel(native.state)} · ${native.name}`
  })
  const layerWarn = layerApiNoKeysWarning()
  const jevLines = formatJevStatusLines()
  clack.note(
    [
      ...formatKeyStatusLines(),
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
}

export { AGENTS }
