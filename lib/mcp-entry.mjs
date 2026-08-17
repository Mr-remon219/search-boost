import { existsSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { getLayer } from './layer-config.mjs'

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)

export const MCP_SERVER_ID = 'search-boost'

const BIN_CANDIDATES = ['search-boost', 'search-boost-mcp']

function pkgBinNames() {
  try {
    const pkg = require(join(PKG_ROOT, 'package.json'))
    const bins = Object.keys(pkg.bin ?? {})
    const ordered = BIN_CANDIDATES.filter((b) => bins.includes(b))
    return ordered.length > 0 ? ordered : ['search-boost-mcp']
  } catch {
    return ['search-boost-mcp']
  }
}

function commandExists(cmd) {
  try {
    execSync(process.platform === 'win32' ? `where ${cmd}` : `which ${cmd}`, {
      stdio: 'ignore',
      windowsHide: true,
    })
    return true
  } catch {
    return false
  }
}

/** Resolve system Node, excluding IDE-bundled node.exe from cursor-agent. */
function resolveSystemNode() {
  let node = process.execPath.replace(/\\/g, '/')
  try {
    const found = execSync(process.platform === 'win32' ? 'where node' : 'which node', {
      encoding: 'utf8',
      windowsHide: true,
    }).split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
    const pick = found.find((p) => !/cursor-agent|Cursor/i.test(p)) ?? found[0]
    if (pick) node = pick.replace(/\\/g, '/')
  } catch { /* use execPath */ }
  return node
}

/**
 * Resolve MCP launch command. Priority:
 * 1. Global `search-boost` or `search-boost-mcp` bin (npm i -g)
 * 2. `npx -y search-boost-mcp serve` (npm package, no global install)
 * 3. `node /abs/path/cli.mjs serve` (local dev from repo)
 */
export function resolveMcpLaunch() {
  for (const bin of pkgBinNames()) {
    if (commandExists(bin)) {
      return { command: bin, args: ['serve'] }
    }
  }

  const npxBin = pkgBinNames().includes('search-boost-mcp') ? 'search-boost-mcp' : pkgBinNames()[0]
  if (commandExists('npx')) {
    return { command: 'npx', args: ['-y', npxBin, 'serve'] }
  }

  const cliPath = join(PKG_ROOT, 'cli.mjs').replace(/\\/g, '/')
  return { command: resolveSystemNode(), args: [cliPath, 'serve'] }
}

/** Absolute command path for macOS GUI apps (Antigravity Dock launch). */
export function resolveAbsoluteCommand() {
  const { command, args } = resolveMcpLaunch()
  if (process.platform !== 'darwin') return { command, args }

  if (command.includes('/') && existsSync(command)) {
    return { command, args }
  }

  try {
    const resolved = execSync(`command -v ${command} || which ${command}`, {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      shell: '/bin/bash',
      windowsHide: true,
    }).trim()
    if (resolved && existsSync(resolved)) {
      return { command: resolved, args }
    }
  } catch { /* fall through */ }

  return { command, args }
}

export function mcpEnv() {
  return {
    SEARCH_BOOST_LAYER: process.env.SEARCH_BOOST_LAYER ?? getLayer(),
  }
}

/** Stdio MCP entry for JSON agents (Cursor, Claude, etc.) */
export function jsonMcpEntry() {
  const { command, args } = resolveMcpLaunch()
  return {
    type: 'stdio',
    command,
    args,
    env: { ...mcpEnv() },
  }
}

/**
 * Antigravity rejects `type: "stdio"` — omit it (codegraph pattern).
 * Uses absolute command on macOS for GUI PATH issues.
 */
export function antigravityMcpEntry() {
  const { command, args } = resolveAbsoluteCommand()
  return {
    command,
    args,
    env: { ...mcpEnv() },
  }
}

export function tomlMcpBlock() {
  const { command, args } = resolveMcpLaunch()
  const layer = mcpEnv().SEARCH_BOOST_LAYER
  const argsToml = `[${args.map((a) => `"${a.replace(/\\/g, '/')}"`).join(', ')}]`
  const cmd = command.replace(/\\/g, '/')
  return [
    `command = "${cmd}"`,
    `args = ${argsToml}`,
    `env = { SEARCH_BOOST_LAYER = "${layer}" }`,
    'startup_timeout_sec = 60',
    'tool_timeout_sec = 180',
  ].join('\n')
}

/** @param {string} agentId @param {string} configPath */
export function formatPrintConfig(agentId, configPath) {
  const lines = [`# Add to ${configPath}`, '']
  if (agentId === 'codex' || agentId === 'grok') {
    lines.push(`[mcp_servers.${MCP_SERVER_ID}]`)
    lines.push(tomlMcpBlock())
  } else if (agentId === 'antigravity') {
    lines.push(JSON.stringify({ mcpServers: { [MCP_SERVER_ID]: antigravityMcpEntry() } }, null, 2))
  } else {
    lines.push(JSON.stringify({ mcpServers: { [MCP_SERVER_ID]: jsonMcpEntry() } }, null, 2))
  }
  return lines.join('\n')
}

export function pkgRoot() {
  return PKG_ROOT
}

export function dshLibCandidates() {
  const candidates = [
    process.env.SEARCH_BOOST_DSH_ROOT,
    join(PKG_ROOT, '..', 'dsh-search-boost'),
    join(PKG_ROOT, 'node_modules', 'dsh-search-boost'),
  ].filter(Boolean)
  return candidates.map((p) => join(p, 'lib', 'engines.js')).filter((p) => existsSync(p)).map((p) => dirname(dirname(p)))
}

/** Permissions for Claude Code auto-allow (--auto-allow). */
export function claudePermissions() {
  return [
    'mcp__search-boost__fused_search',
    'mcp__search-boost__fetch_page',
    'mcp__search-boost__deep_research',
    'mcp__search-boost__x_search',
    'mcp__search-boost__search_layer',
    'mcp__search-boost__search_stats',
  ]
}

/** Permissions for Antigravity auto-allow (--auto-allow). */
export function antigravityPermissions() {
  return [
    'mcp(search-boost/*)',
    'mcp(search-boost/fused_search)',
    'mcp(search-boost/fetch_page)',
    'mcp(search-boost/deep_research)',
    'mcp(search-boost/x_search)',
    'mcp(search-boost/search_layer)',
    'mcp(search-boost/search_stats)',
  ]
}
