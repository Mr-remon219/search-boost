import { existsSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { CODEX_WEB_SEARCH_BODY } from './native-search.mjs'
import { MCP_SERVER_ID } from './paths.mjs'
import { PKG_ROOT } from './pkg.mjs'
import { resolveSystemNode } from './system-node.mjs'

const require = createRequire(import.meta.url)

export { MCP_SERVER_ID }

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

export function commandExists(cmd) {
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

/**
 * Resolve MCP launch command. Priority:
 * 1. Global `search-boost` or `search-boost-mcp` bin (npm i -g)
 * 2. `node /abs/path/cli.mjs serve` (local clone, npm link, or node_modules install)
 * 3. `npx -y search-boost-mcp serve` (published package only — last resort)
 */
export function resolveMcpLaunch() {
  for (const bin of pkgBinNames()) {
    if (commandExists(bin)) {
      return { command: bin, args: ['serve'] }
    }
  }

  const cliPath = join(PKG_ROOT, 'cli.mjs')
  if (existsSync(cliPath)) {
    return {
      command: resolveSystemNode(),
      args: [cliPath.replace(/\\/g, '/'), 'serve'],
    }
  }

  const npxBin = pkgBinNames().includes('search-boost-mcp') ? 'search-boost-mcp' : pkgBinNames()[0]
  if (commandExists('npx')) {
    return { command: 'npx', args: ['-y', npxBin, 'serve'] }
  }

  return {
    command: resolveSystemNode(),
    args: [join(PKG_ROOT, 'cli.mjs').replace(/\\/g, '/'), 'serve'],
  }
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
  // Layer is read at runtime from ~/.search-boost-layer.json (see getLayer in layer-config.mjs).
  // Do not bake SEARCH_BOOST_LAYER into agent configs — it blocks search_layer persist.
  return {}
}

/** @param {Record<string, unknown>} entry */
function attachEnv(entry) {
  const env = mcpEnv()
  if (Object.keys(env).length) entry.env = env
  return entry
}

/** Stdio MCP entry for JSON agents (Cursor, Claude, etc.) */
export function jsonMcpEntry() {
  const { command, args } = resolveMcpLaunch()
  return attachEnv({
    type: 'stdio',
    command,
    args,
  })
}

/** Portable MCP entry for shipped grok-plugin (always npx — no machine paths). */
export function pluginMcpEntry() {
  const npxBin = pkgBinNames().includes('search-boost-mcp') ? 'search-boost-mcp' : pkgBinNames()[0]
  return attachEnv({
    type: 'stdio',
    command: 'npx',
    args: ['-y', npxBin, 'serve'],
  })
}

/**
 * Antigravity rejects `type: "stdio"` — omit it (codegraph pattern).
 * Uses absolute command on macOS for GUI PATH issues.
 */
export function antigravityMcpEntry() {
  const { command, args } = resolveAbsoluteCommand()
  return attachEnv({ command, args })
}

/**
 * `approvalAuto` emits Codex's `default_tools_approval_mode` — Codex-only, so it
 * stays opt-in rather than polluting Grok's config.toml with an unknown key.
 * @param {{ approvalAuto?: boolean }} [opts]
 */
export function tomlMcpBlock(opts = {}) {
  const { command, args } = resolveMcpLaunch()
  const argsToml = `[${args.map((a) => `"${a.replace(/\\/g, '/')}"`).join(', ')}]`
  const cmd = command.replace(/\\/g, '/')
  return [
    `command = "${cmd}"`,
    `args = ${argsToml}`,
    'startup_timeout_sec = 60',
    'tool_timeout_sec = 180',
    ...(opts.approvalAuto ? ['default_tools_approval_mode = "auto"'] : []),
  ].join('\n')
}

/**
 * @param {string} agentId
 * @param {string} configPath
 * @param {{ autoAllow?: boolean, replaceNative?: boolean }} [opts]
 */
export function formatPrintConfig(agentId, configPath, opts = {}) {
  const lines = [`# Add to ${configPath}`, '']
  if (agentId === 'codex' || agentId === 'grok') {
    lines.push(`[mcp_servers.${MCP_SERVER_ID}]`)
    lines.push(tomlMcpBlock({ approvalAuto: agentId === 'codex' && !!opts.autoAllow }))
    if (agentId === 'codex' && opts.replaceNative !== false) {
      lines.push('', `# SEARCH_BOOST_WEB_SEARCH_START`, CODEX_WEB_SEARCH_BODY, `# SEARCH_BOOST_WEB_SEARCH_END`)
    }
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

const MCP_TOOL_NAMES = [
  'fused_search',
  'fetch_page',
  'deep_research',
  'x_search',
  'search_layer',
  'search_stats',
]

/** Permissions for Claude Code auto-allow (--auto-allow). */
export function claudePermissions() {
  return ['mcp__search-boost__*']
}

/** Grok Build [permission] allow patterns (--auto-allow). */
export function grokPermissionAllows() {
  return MCP_TOOL_NAMES.map((t) => `MCPTool(search-boost__${t})`)
}

/** TOML body for Grok [permission] allow block. */
export function grokPermissionTomlBlock() {
  const lines = grokPermissionAllows().map((p) => `  "${p}",`)
  return `[permission]\nallow = [\n${lines.join('\n')}\n]`
}

/** Permissions for Antigravity auto-allow (--auto-allow). Wildcard covers all tools. */
export function antigravityPermissions() {
  return ['mcp(search-boost/*)']
}
