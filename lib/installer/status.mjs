import { AGENT_IDS, AGENTS, agentStatus } from '../agents/index.mjs'
import { hasAnyKey } from '../keys.mjs'
import { getLayer, layerFilePath } from '../layer-config.mjs'
import { nativeSearchStatus } from '../native-search.mjs'
import { formatKeyStatusLines } from './keys-wizard.mjs'
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
    return 'Warning: layer is api but no API keys configured -- searches use free engines'
  }
  return null
}

export function printStatus() {
  for (const line of formatKeyStatusLines()) console.log(line)
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
    const det = s.detected ? 'in' : '—'
    const cfg = s.configured ? 'on' : 'off'
    return `${id.padEnd(14)} ${det}/${cfg}  ${STATE_LABEL[native.state]} · ${native.name}`
  })
  const layerWarn = layerApiNoKeysWarning()
  clack.note(
    [
      ...formatKeyStatusLines(),
      '',
      `Layer: ${getLayer()} (${tildify(layerFilePath())})`,
      layerWarn,
      '',
      'Agents',
      ...agentLines,
    ].filter(Boolean).join('\n'),
    'Status',
  )
}

export { AGENTS }
