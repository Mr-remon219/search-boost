import { resolve } from 'node:path'
import { cwd } from 'node:process'
import { AGENT_IDS, AGENTS } from '../agents/index.mjs'

/**
 * @typedef {Object} CliFlags
 * @property {string|null} target
 * @property {boolean} yes
 * @property {boolean} dryRun
 * @property {string|null} printConfig
 * @property {boolean} autoAllow
 * @property {boolean|null} replaceNative
 * @property {boolean} help
 * @property {boolean} show
 * @property {'user'|'project'|'all'} scope
 * @property {Record<string, string>} set
 * @property {string[]} unset
 * @property {string|null} layer
 * @property {string|null} workspace
 */

/**
 * @typedef {Object} DoctorFlags
 * @property {boolean} quick
 * @property {boolean} probe
 * @property {boolean} json
 * @property {boolean} strict
 * @property {string[]} category
 * @property {boolean} verbose
 * @property {boolean} help
 */

/** @param {string[]} args @param {number} i @param {string} flag */
function takeValue(args, i, flag) {
  const v = args[i + 1]
  if (v === undefined || v.startsWith('-')) {
    throw new Error(`${flag} requires a value`)
  }
  return v
}

/** @param {string[]} args */
export function parseFlags(args) {
  /** @type {CliFlags} */
  const flags = {
    target: null,
    yes: false,
    dryRun: false,
    printConfig: null,
    autoAllow: false,
    replaceNative: null,
    help: false,
    show: false,
    scope: 'user',
    set: {},
    unset: [],
    layer: null,
    workspace: null,
  }

  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (!a.startsWith('-')) continue

    if (a === '-y' || a === '--yes') flags.yes = true
    else if (a === '--dry-run') flags.dryRun = true
    else if (a === '-h' || a === '--help') flags.help = true
    else if (a === '--auto-allow') flags.autoAllow = true
    else if (a === '--replace-native') flags.replaceNative = true
    else if (a === '--keep-native') flags.replaceNative = false
    else if (a === '--show') flags.show = true
    else if (a === '--scope') {
      const v = takeValue(args, i, a)
      i += 1
      if (v !== 'user' && v !== 'project' && v !== 'all') {
        throw new Error('--scope must be user, project, or all')
      }
      flags.scope = v
    } else if (a === '-t' || a === '--target') {
      flags.target = takeValue(args, i, a)
      i += 1
    } else if (a === '--print-config') {
      flags.printConfig = takeValue(args, i, a)
      i += 1
    } else if (a === '--workspace') {
      const next = args[i + 1]
      flags.workspace = next && !next.startsWith('-') ? resolve(args[++i]) : resolve(cwd())
    } else if (a === '--set') {
      const pair = takeValue(args, i, a)
      i += 1
      const eq = pair.indexOf('=')
      if (eq <= 0) throw new Error('--set requires name=value')
      flags.set[pair.slice(0, eq)] = pair.slice(eq + 1)
    } else if (a === '--unset') {
      flags.unset.push(takeValue(args, i, a))
      i += 1
    } else if (a === '--layer') {
      const v = takeValue(args, i, a)
      i += 1
      if (v !== 'free' && v !== 'api') throw new Error('--layer must be free or api')
      flags.layer = v
    } else {
      throw new Error(`Unknown flag: ${a}`)
    }
  }

  return flags
}

/** @param {string[]} args */
export function parseDoctorFlags(args) {
  /** @type {DoctorFlags} */
  const flags = {
    quick: true,
    probe: false,
    json: false,
    strict: false,
    category: [],
    verbose: false,
    help: false,
  }

  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (!a.startsWith('-')) continue

    if (a === '-h' || a === '--help') flags.help = true
    else if (a === '--quick') flags.quick = true
    else if (a === '--probe') flags.probe = true
    else if (a === '--json') flags.json = true
    else if (a === '--strict') flags.strict = true
    else if (a === '--verbose') flags.verbose = true
    else if (a === '--category') {
      flags.category.push(takeValue(args, i, a))
      i += 1
    } else {
      throw new Error(`Unknown flag: ${a}`)
    }
  }

  return flags
}

/** @param {CliFlags} flags @param {boolean} [uninstall] */
export function installOpts(flags, uninstall = false) {
  return {
    target: flags.target,
    yes: flags.yes,
    dryRun: flags.dryRun,
    autoAllow: flags.autoAllow,
    replaceNative: flags.replaceNative,
    scope: flags.scope,
    workspace: flags.workspace,
    uninstall,
  }
}

export function help() {
  const agents = AGENT_IDS.map((id) => `  ${id.padEnd(14)} ${AGENTS[id].label}`).join('\n')
  console.log(`search-boost — multi-engine search MCP for coding agents

Usage:
  search-boost                         Interactive TUI
  search-boost setup                   Full onboarding (keys + layer + agents)
  search-boost install [options]
  search-boost uninstall [options]
  search-boost config keys|layer|search|diag
  search-boost print <id>              Print MCP snippet (no writes)
  search-boost status
  search-boost doctor [options]        Health checks: config, agents, engines, MCP
  search-boost agents                  Machine-readable agent list
  search-boost serve
  search-boost plugin sync-grok|build

Install / setup options:
  -t, --target <ids>     cursor,codex,claude,grok,antigravity,cursor-cli | auto | all
  -y, --yes              Non-interactive: skip keys/layer wizards; with install, --target=auto
                         (implies --auto-allow and --replace-native when combined with -t)
  --dry-run              Show actions without writing
  --auto-allow           Pre-approve search-boost MCP tools
  --replace-native       Disable built-in web_search where the agent allows it (default on)
  --keep-native          Leave built-in web_search / WebSearch / browse on
  --scope user|project|all   Grok only: user (~/.grok), project (.grok/ in cwd), or both (uninstall)
  --workspace [dir]      Also inject .agents/ under cwd or dir (Antigravity)

Config keys:
  --show                 Print masked key status
  --set tavily=KEY       Write a key to ~/.search-boost-keys.json
  --set exa=KEY          (also: brave=KEY)
  --unset brave          Remove a key from the file

Config layer:
  --show                 Print current layer
  --layer free|api       Persist default layer

Config search (built-in web search replacement):
  --show                 Print per-agent native-search state (table)
  -t, --target <ids>     Codex (web_search) and/or Claude (WebSearch deny)
  --replace-native       Apply the config/deny switch
  --keep-native          Revert the switch

Doctor:
  --quick                Offline checks only (default)
  --probe                Also run live search + MCP smoke (Phase 2; no-op today)
  --json                 Machine-readable report on stdout
  --strict               Treat warnings as failures (exit 1)
  --category <cat>       Filter by runtime|config|agents|engines|mcp (repeatable)
  --verbose              Print check details

Config diag (deprecated):
  (no flags)             Alias for search-boost doctor — use doctor instead

Agents:
${agents}
`)
}
