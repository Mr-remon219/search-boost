import { AGENT_IDS, AGENTS, agentStatus } from '../agents/index.mjs'
import { getLayer, layerFilePath } from '../layer-config.mjs'
import { nativeSearchStatus } from '../native-search.mjs'
import { printKeyStatus } from './keys-wizard.mjs'

const STATE_LABEL = {
  replaced: 'replaced',
  native: 'native',
  prompt: 'prompt',
  left: 'left',
  unknown: '—',
}

export function printStatus() {
  printKeyStatus()
  console.log(`\nLayer: ${getLayer()} (${layerFilePath()})`)
  console.log('\nAgents')
  console.log('─'.repeat(96))
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
  const lines = AGENT_IDS.map((id) => {
    const s = agentStatus(id)
    const native = nativeSearchStatus(id)
    const det = s.detected ? 'in' : '—'
    const cfg = s.configured ? 'on' : 'off'
    return `${id.padEnd(14)} ${det}/${cfg}  ${STATE_LABEL[native.state]} · ${native.name}`
  })
  clack.note(
    [`layer ${getLayer()}`, '', ...lines].join('\n'),
    'Status',
  )
}

export { AGENTS }
