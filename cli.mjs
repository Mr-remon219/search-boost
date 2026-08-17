#!/usr/bin/env node
/**
 * search-boost-mcp CLI
 *
 *   search-boost-mcp serve              Run MCP stdio server
 *   search-boost-mcp install [opts]     Install into agents (interactive)
 *   search-boost-mcp uninstall [opts]   Remove from agents
 *   search-boost-mcp agents             List supported agents
 *   search-boost-mcp status             Detection + config status
 */
import { createInterface } from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'
import {
  AGENT_IDS,
  AGENTS,
  agentStatus,
  normalizeTargets,
  parseTargetSpec,
} from './lib/agents/index.mjs'

const argv = process.argv.slice(2)
const cmd = argv[0] ?? 'serve'

function parseFlags(args) {
  const flags = {
    target: null,
    yes: false,
    dryRun: false,
    printConfig: null,
    autoAllow: false,
    help: false,
  }
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '-y' || a === '--yes') flags.yes = true
    else if (a === '--dry-run') flags.dryRun = true
    else if (a === '-h' || a === '--help') flags.help = true
    else if (a === '--auto-allow') flags.autoAllow = true
    else if (a === '-t' || a === '--target') flags.target = args[++i]
    else if (a === '--print-config') flags.printConfig = args[++i]
  }
  return flags
}

function help() {
  console.log(`search-boost-mcp — multi-engine search MCP for coding agents

Usage:
  search-boost-mcp serve
  search-boost-mcp install [options]
  search-boost-mcp uninstall [options]
  search-boost-mcp agents
  search-boost-mcp status

Install options:
  -t, --target <ids>     cursor,codex,claude,grok,antigravity,cursor-cli | auto | all
  -y, --yes              Non-interactive: --target=auto
  --dry-run              Show actions without writing
  --auto-allow           Claude Code: add mcp__search-boost__* to permissions.allow
  --print-config <id>    Print MCP snippet for one agent and exit

Agents:
${AGENT_IDS.map((id) => {
    const s = agentStatus(id)
    const tag = s.detected ? 'detected' : '-'
    const cfg = s.configured ? 'configured' : '-'
    return `  ${id.padEnd(14)} ${AGENTS[id].label.padEnd(28)} ${tag} / ${cfg}`
  }).join('\n')}
`)
}

async function pickTargetsInteractive() {
  console.log('\nSelect agents (comma-separated ids, or "all"):\n')
  for (const id of AGENT_IDS) {
    const s = agentStatus(id)
    const det = s.detected ? '✓ detected' : '  '
    const cfg = s.configured ? '✓ configured' : ''
    console.log(`  ${id.padEnd(14)} ${AGENTS[id].label}  ${det} ${cfg}`)
  }
  console.log('')
  const rl = createInterface({ input, output })
  try {
    const ans = (await rl.question('Targets [auto]: ')).trim()
    if (!ans) return parseTargetSpec('auto')
    return parseTargetSpec(ans === 'all' ? 'all' : ans)
  } finally {
    rl.close()
  }
}

function printStatus() {
  console.log('Agent          Detected  Configured  Label')
  console.log('─'.repeat(72))
  for (const id of AGENT_IDS) {
    const s = agentStatus(id)
    console.log(
      `${id.padEnd(15)}${(s.detected ? 'yes' : 'no').padEnd(10)}${(s.configured ? 'yes' : 'no').padEnd(12)}${s.label}`,
    )
  }
}

async function runInstall(uninstall = false) {
  const flags = parseFlags(argv.slice(1))
  if (flags.help) {
    help()
    return
  }
  if (flags.printConfig) {
    const a = AGENTS[flags.printConfig]
    if (!a) {
      console.error(`Unknown agent: ${flags.printConfig}`)
      process.exit(1)
    }
    console.log(a.printConfig())
    return
  }

  let rawTargets = flags.target ? parseTargetSpec(flags.target) : null
  if (!rawTargets) {
    if (flags.yes) rawTargets = parseTargetSpec('auto')
    else rawTargets = await pickTargetsInteractive()
  }

  if (rawTargets.length === 0) {
    console.log('No agents selected.')
    return
  }

  const { targets, mergeCursorCli } = normalizeTargets(rawTargets)
  const mergeNote = mergeCursorCli ? ' (cursor + cursor-cli merged)' : ''

  console.log(
    `${uninstall ? 'Uninstall' : 'Install'} search-boost → ${rawTargets.join(', ')}${mergeNote}${flags.dryRun ? ' (dry-run)' : ''}\n`,
  )

  const installOpts = {
    dryRun: flags.dryRun,
    autoAllow: flags.autoAllow,
    mergeCursorCli,
  }

  for (const id of targets) {
    const agent = AGENTS[id]
    if (!agent) {
      console.warn(`  skip unknown: ${id}`)
      continue
    }
    try {
      if (uninstall) {
        await agent.uninstall(installOpts)
        console.log(`  ✓ ${id}`)
      } else {
        const files = await agent.install(installOpts)
        console.log(`  ✓ ${id}`)
        for (const f of files) console.log(`      → ${f}`)
      }
    } catch (err) {
      console.error(`  ✗ ${id}: ${err instanceof Error ? err.message : err}`)
    }
  }

  if (!uninstall && !flags.dryRun) {
    console.log('\nRestart your agent(s) to load the search-boost MCP server.')
  }
}

async function main() {
  switch (cmd) {
    case 'serve':
    case 'mcp':
      await import('./server.mjs')
      break
    case 'install':
      await runInstall(false)
      break
    case 'uninstall':
      await runInstall(true)
      break
    case 'agents':
      for (const id of AGENT_IDS) {
        const s = agentStatus(id)
        console.log(`${id}\t${AGENTS[id].label}\t${s.detected ? 'detected' : '-'}\t${s.configured ? 'configured' : '-'}`)
      }
      break
    case 'status':
      printStatus()
      break
    case '-h':
    case '--help':
    case 'help':
      help()
      break
    default:
      console.error(`Unknown command: ${cmd}\n`)
      help()
      process.exit(1)
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
