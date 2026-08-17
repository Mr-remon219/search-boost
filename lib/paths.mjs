import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { cwd } from 'node:process'
import { join } from 'node:path'

export const HOME = homedir()
export const MCP_SERVER_ID = 'search-boost'

const GEMINI_CONFIG = join(HOME, '.gemini', 'config')
const GEMINI_LEGACY = join(HOME, '.gemini', 'antigravity')

export const PATHS = {
  cursor: {
    mcp: join(HOME, '.cursor', 'mcp.json'),
    agents: join(HOME, '.cursor', 'AGENTS.md'),
    skill: join(HOME, '.cursor', 'skills', 'search-boost', 'SKILL.md'),
  },
  'cursor-cli': {
    mcp: join(HOME, '.cursor', 'mcp.json'),
    agents: join(HOME, '.cursor', 'AGENTS.md'),
    skill: join(HOME, '.cursor', 'skills', 'search-boost', 'SKILL.md'),
  },
  codex: {
    config: join(HOME, '.codex', 'config.toml'),
    agents: join(HOME, '.codex', 'AGENTS.md'),
    skill: join(HOME, '.agents', 'skills', 'search-boost', 'SKILL.md'),
    openaiYaml: join(HOME, '.agents', 'skills', 'search-boost', 'agents', 'openai.yaml'),
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
  'grok-project': {
    config: join(cwd(), '.grok', 'config.toml'),
    skill: join(cwd(), '.grok', 'skills', 'search-boost', 'SKILL.md'),
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

/** @param {'user'|'project'} [scope] */
export function grokInstallPaths(scope = 'user') {
  if (scope === 'project') {
    return {
      config: PATHS['grok-project'].config,
      rule: PATHS.grok.rule,
      skill: PATHS.grok.skill,
    }
  }
  return PATHS.grok
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
      case 'codex': {
        const path = PATHS.codex.config
        const toml = readFileSync(path, 'utf8')
        return toml.includes(`[mcp_servers.${MCP_SERVER_ID}]`)
          && existsSync(PATHS.codex.skill)
      }
      case 'grok': {
        const toml = readFileSync(PATHS.grok.config, 'utf8')
        return toml.includes(`[mcp_servers.${MCP_SERVER_ID}]`)
      }
      default:
        return false
    }
  } catch {
    return false
  }
}
