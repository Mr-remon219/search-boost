#!/usr/bin/env node
/**
 * search-boost CLI — multi-engine search MCP for coding agents
 *
 *   search-boost                     Interactive onboarding (keys + agents)
 *   search-boost install [opts]      Install MCP + prompts into agents
 *   search-boost uninstall [opts]    Remove from agents
 *   search-boost config keys [opts]  Configure tavily / brave / exa keys
 *   search-boost config layer [opts] Set default search layer (free / api)
 *   search-boost status              Keys + layer + agent detection
 *   search-boost serve               Run MCP stdio server
 */
import {
  AGENT_IDS,
  AGENTS,
  agentStatus,
} from './lib/agents/index.mjs'
import { getLayer, setLayer } from './lib/layer-config.mjs'
import {
  runInstallerWithOptions,
  runInstallPlain,
  runWizard,
  runKeysWizard,
  printKeyStatus,
} from './lib/installer/index.mjs'
import { loadClack, handleCancel } from './lib/installer/ui.mjs'

const argv = process.argv.slice(2)

function parseFlags(args) {
  const flags = {
    target: null,
    yes: false,
    dryRun: false,
    printConfig: null,
    autoAllow: false,
    help: false,
    show: false,
    set: {},
    unset: [],
    layer: null,
  }
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '-y' || a === '--yes') flags.yes = true
    else if (a === '--dry-run') flags.dryRun = true
    else if (a === '-h' || a === '--help') flags.help = true
    else if (a === '--auto-allow') flags.autoAllow = true
    else if (a === '--show') flags.show = true
    else if (a === '-t' || a === '--target') flags.target = args[++i]
    else if (a === '--print-config') flags.printConfig = args[++i]
    else if (a === '--set') {
      const pair = args[++i] ?? ''
      const eq = pair.indexOf('=')
      if (eq > 0) flags.set[pair.slice(0, eq)] = pair.slice(eq + 1)
    } else if (a === '--unset') flags.unset.push(args[++i])
    else if (a === '--layer') flags.layer = args[++i]
  }
  return flags
}

function help() {
  console.log(`search-boost — multi-engine search MCP for coding agents

Usage:
  search-boost                         Interactive setup (keys + agents)
  search-boost install [options]
  search-boost uninstall [options]
  search-boost config keys [options]
  search-boost config layer [options]
  search-boost status
  search-boost agents
  search-boost serve

Install options:
  -t, --target <ids>     cursor,codex,claude,grok,antigravity,cursor-cli | auto | all
  -y, --yes              Non-interactive: --target=auto
  --dry-run              Show actions without writing
  --auto-allow           Claude Code: add mcp__search-boost__* to permissions.allow
  --print-config <id>    Print MCP snippet for one agent and exit

Config keys:
  --show                 Print masked key status
  --set tavily=KEY       Write a key to ~/.dsh-search-boost-keys.json
  --unset brave          Remove a key from the file

Config layer:
  --show                 Print current layer
  --layer free|api       Persist default layer

Agents:
${AGENT_IDS.map((id) => {
    const s = agentStatus(id)
    const tag = s.detected ? 'detected' : '-'
    const cfg = s.configured ? 'configured' : '-'
    return `  ${id.padEnd(14)} ${AGENTS[id].label.padEnd(28)} ${tag} / ${cfg}`
  }).join('\n')}
`)
}

function printStatus() {
  printKeyStatus()
  console.log(`\nLayer: ${getLayer()} (~/.dsh-search-boost-layer.json)`)
  console.log('\nAgents')
  console.log('─'.repeat(72))
  console.log('Agent          Detected  Configured  Label')
  for (const id of AGENT_IDS) {
    const s = agentStatus(id)
    console.log(
      `${id.padEnd(15)}${(s.detected ? 'yes' : 'no').padEnd(10)}${(s.configured ? 'yes' : 'no').padEnd(12)}${s.label}`,
    )
  }
}

async function runConfigKeys(args) {
  const flags = parseFlags(args)
  if (flags.help) {
    help()
    return
  }
  if (flags.yes || flags.show || Object.keys(flags.set).length || flags.unset.length) {
    await runKeysWizard(null, flags)
    return
  }
  const clack = await loadClack()
  await runKeysWizard(clack, flags)
}

async function runConfigLayer(args) {
  const flags = parseFlags(args)
  if (flags.help) {
    help()
    return
  }
  if (flags.show || (flags.yes && !flags.layer)) {
    console.log(`Layer: ${getLayer()}`)
    console.log('File: ~/.dsh-search-boost-layer.json')
    return
  }
  if (flags.layer === 'free' || flags.layer === 'api') {
    setLayer(flags.layer)
    console.log(`Layer set to ${flags.layer}`)
    return
  }
  const clack = await loadClack()
  const layer = await clack.select({
    message: 'Default search layer?',
    options: [
      { value: 'free', label: 'free — keyless engines only' },
      { value: 'api', label: 'api — full pool incl. keyed APIs' },
    ],
    initialValue: getLayer(),
  })
  handleCancel(layer, clack)
  setLayer(/** @type {'free'|'api'} */ (layer))
  clack.outro(`Layer set to ${layer}`)
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

  const opts = {
    target: flags.target,
    yes: flags.yes,
    dryRun: flags.dryRun,
    autoAllow: flags.autoAllow,
    uninstall,
  }

  if (flags.yes || flags.target) {
    await runInstallPlain(opts)
    return
  }

  await runInstallerWithOptions(opts)
}

async function main() {
  if (argv.length === 0) {
    await runWizard()
    return
  }

  const cmd = argv[0]

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
    case 'config': {
      const sub = argv[1]
      if (sub === 'keys') await runConfigKeys(argv.slice(2))
      else if (sub === 'layer') await runConfigLayer(argv.slice(2))
      else {
        console.error('Usage: search-boost config keys|layer\n')
        process.exit(1)
      }
      break
    }
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
