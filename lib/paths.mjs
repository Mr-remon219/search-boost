import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const HOME = homedir()
export const MCP_SERVER_ID = 'search-boost'

const GEMINI_CONFIG = join(HOME, '.gemini', 'config')
const GEMINI_LEGACY = join(HOME, '.gemini', 'antigravity')

/** Shared Cursor IDE + CLI surface paths. */
export const CURSOR_SURFACE = {
  mcp: join(HOME, '.cursor', 'mcp.json'),
  /** Legacy — uninstall sweeps only; install no longer writes here. */
  agents: join(HOME, '.cursor', 'AGENTS.md'),
  skill: join(HOME, '.cursor', 'skills', 'search-boost', 'SKILL.md'),
  hooks: join(HOME, '.cursor', 'hooks.json'),
  hookScript: join(HOME, '.cursor', 'hooks', 'search-boost-session.mjs'),
  hookInject: join(HOME, '.cursor', 'hooks', 'search-boost-inject.md'),
  cliConfig: join(HOME, '.cursor', 'cli-config.json'),
}

export const PATHS = {
  cursor: { ...CURSOR_SURFACE },
  'cursor-cli': { ...CURSOR_SURFACE },
  codex: {
    config: join(HOME, '.codex', 'config.toml'),
    agents: join(HOME, '.codex', 'AGENTS.md'),
  },
  claude: {
    config: join(HOME, '.claude.json'),
    settings: join(HOME, '.claude', 'settings.json'),
    agents: join(HOME, '.claude', 'CLAUDE.md'),
    skill: join(HOME, '.claude', 'skills', 'search-boost', 'SKILL.md'),
  },
  grok: {
    config: join(HOME, '.grok', 'config.toml'),
    rule: join(HOME, '.grok', 'rules', 'search-boost.md'),
    skill: join(HOME, '.grok', 'skills', 'search-boost', 'SKILL.md'),
  },
  antigravity: {
    /** Resolved at runtime via preferredAntigravityMcpPath() */
    mcp: join(GEMINI_CONFIG, 'mcp_config.json'),
    legacyMcp: join(GEMINI_LEGACY, 'mcp_config.json'),
    migratedMarker: join(GEMINI_CONFIG, '.migrated'),
    agents: join(HOME, '.gemini', 'AGENTS.md'),
    /** Cross-platform skill path (AGY IDE + AGY CLI + Gemini CLI) */
    skill: join(GEMINI_CONFIG, 'skills', 'search-boost', 'SKILL.md'),
  },
}

/** Antigravity unified vs legacy MCP config path (codegraph-compatible). */
export function preferredAntigravityMcpPath() {
  if (existsSync(PATHS.antigravity.migratedMarker)) return PATHS.antigravity.mcp
  if (existsSync(PATHS.antigravity.mcp)) return PATHS.antigravity.mcp
  return PATHS.antigravity.legacyMcp
}

/** All Antigravity MCP paths to sweep on uninstall. */
export function antigravityMcpPaths() {
  const preferred = preferredAntigravityMcpPath()
  const other = preferred === PATHS.antigravity.mcp
    ? PATHS.antigravity.legacyMcp
    : PATHS.antigravity.mcp
  return preferred === other ? [preferred] : [preferred, other]
}

/** @param {string} id */
export function agentDetected(id) {
  switch (id) {
    case 'cursor':
    case 'cursor-cli':
      return existsSync(join(HOME, '.cursor'))
    case 'codex':
      return existsSync(join(HOME, '.codex'))
    case 'claude':
      return existsSync(join(HOME, '.claude')) || existsSync(PATHS.claude.config)
    case 'grok':
      return existsSync(join(HOME, '.grok'))
    case 'antigravity':
      return (
        existsSync(join(HOME, '.gemini'))
        || existsSync(join(HOME, '.antigravity'))
        || existsSync(GEMINI_CONFIG)
        || existsSync(GEMINI_LEGACY)
      )
    default:
      return false
  }
}

/** @param {string} id */
export function agentConfigured(id) {
  try {
    switch (id) {
      case 'cursor':
      case 'cursor-cli':
      case 'claude':
      case 'antigravity': {
        const path = id === 'claude'
          ? PATHS.claude.config
          : id === 'antigravity'
            ? preferredAntigravityMcpPath()
            : PATHS.cursor.mcp
        const cfg = JSON.parse(readFileSync(path, 'utf8'))
        return !!cfg.mcpServers?.[MCP_SERVER_ID]
      }
      case 'codex':
      case 'grok': {
        const path = id === 'codex' ? PATHS.codex.config : PATHS.grok.config
        const toml = readFileSync(path, 'utf8')
        return toml.includes(`[mcp_servers.${MCP_SERVER_ID}]`)
      }
      default:
        return false
    }
  } catch {
    return false
  }
}
