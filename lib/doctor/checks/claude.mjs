import { existsSync, readFileSync } from 'node:fs'
import { MARKER_START } from '../../inject.mjs'
import {
  allowRedundant,
  claudeBypassPermissionsMode,
  countSearchBoostAllowEntries,
  hasLegacyGranularAllow,
  isSearchBoostAllow,
} from '../../claude-settings.mjs'
import {
  claudeNativeReplaced,
  claudeOwnedWebSearchDeny,
  claudePriorInstallArtifacts,
  CLAUDE_WEB_SEARCH_DENY,
} from '../../native-search.mjs'
import { agentConfigured, agentDetected, PATHS } from '../../paths.mjs'

/** @param {import('../types.mjs').DoctorContext} _ctx */
export function checkClaudePermissionConfig(_ctx) {
  if (!agentDetected('claude')) {
    return {
      id: 'claude_permission_config',
      category: 'agents',
      status: 'pass',
      message: 'Claude not detected (N/A)',
    }
  }

  const settingsPath = PATHS.claude.settings
  const hasMcp = agentConfigured('claude')
  const hasSettings = existsSync(settingsPath)
  /** @type {Record<string, unknown>} */
  let settings = {}
  if (hasSettings) {
    try {
      settings = JSON.parse(readFileSync(settingsPath, 'utf8'))
    } catch {
      return {
        id: 'claude_permission_config',
        category: 'agents',
        status: 'fail',
        message: `Cannot parse ${settingsPath}`,
        fix_hint: 'search-boost install -t claude -y --auto-allow --replace-native',
      }
    }
  }

  const hasSkill = existsSync(PATHS.claude.skill)
  let hasInject = false
  try {
    hasInject = existsSync(PATHS.claude.agents)
      && readFileSync(PATHS.claude.agents, 'utf8').includes(MARKER_START)
  } catch { /* unreadable */ }
  const allow = settings.permissions?.allow ?? []
  const hasAllow = Array.isArray(allow) && allow.some(isSearchBoostAllow)
  const partialArtifacts = hasSettings && (hasAllow || hasSkill || hasInject || claudePriorInstallArtifacts().mcpConfigured)

  if (partialArtifacts && !hasMcp) {
    return {
      id: 'claude_permission_config',
      category: 'agents',
      status: 'fail',
      message: 'Partial Claude install: settings/skill/inject present but MCP missing in ~/.claude.json',
      fix_hint: 'search-boost install -t claude -y --auto-allow --replace-native',
      details: { hasMcp, hasAllow, hasSkill, hasInject, settingsPath },
    }
  }

  if (hasLegacyGranularAllow(allow)) {
    return {
      id: 'claude_permission_config',
      category: 'agents',
      status: 'warn',
      message: 'Legacy granular mcp__search-boost__ allow entries (re-install to consolidate to wildcard)',
      fix_hint: 'search-boost install -t claude -y --auto-allow',
      details: { allow: allow.filter(isSearchBoostAllow) },
    }
  }

  if (countSearchBoostAllowEntries(allow) > 1) {
    return {
      id: 'claude_permission_config',
      category: 'agents',
      status: 'warn',
      message: 'Duplicate mcp__search-boost allow entries in Claude settings',
      fix_hint: 'search-boost install -t claude -y --auto-allow',
      details: { allow: allow.filter(isSearchBoostAllow) },
    }
  }

  if (allowRedundant(settings)) {
    return {
      id: 'claude_permission_config',
      category: 'agents',
      status: 'warn',
      message: 'Claude bypassPermissions mode makes search-boost allow redundant',
      fix_hint: 'search-boost install -t claude -y --auto-allow (skips allow when bypass) or remove allow manually',
      details: { bypass: claudeBypassPermissionsMode(settings), allow: allow.filter(isSearchBoostAllow) },
    }
  }

  return {
    id: 'claude_permission_config',
    category: 'agents',
    status: 'pass',
    message: 'Claude permission config OK',
    details: {
      hasMcp,
      nativeReplaced: claudeNativeReplaced(settings),
      bypass: claudeBypassPermissionsMode(settings),
    },
  }
}

/** @param {import('../types.mjs').DoctorContext} ctx */
export function checkClaudeOrphanDeny(ctx) {
  if (!agentDetected('claude')) {
    return {
      id: 'claude_orphan_deny',
      category: 'agents',
      status: 'pass',
      message: 'Claude not detected (N/A)',
    }
  }

  if (agentConfigured('claude')) {
    return {
      id: 'claude_orphan_deny',
      category: 'agents',
      status: 'pass',
      message: 'Claude MCP configured',
    }
  }

  /** @type {{ permissions?: { deny?: string[] }, searchBoost?: Record<string, unknown> }} */
  let settings = {}
  try {
    if (existsSync(PATHS.claude.settings)) {
      settings = JSON.parse(readFileSync(PATHS.claude.settings, 'utf8'))
    }
  } catch {
    return {
      id: 'claude_orphan_deny',
      category: 'agents',
      status: 'warn',
      message: 'Claude settings.json unreadable',
      fix_hint: 'search-boost uninstall -t claude -y',
    }
  }

  const deny = settings.permissions?.deny ?? []
  const hasDeny = deny.includes(CLAUDE_WEB_SEARCH_DENY)
  const owned = claudeOwnedWebSearchDeny(settings)

  if (!hasDeny) {
    return {
      id: 'claude_orphan_deny',
      category: 'agents',
      status: 'pass',
      message: 'No orphan WebSearch deny',
    }
  }

  return {
    id: 'claude_orphan_deny',
    category: 'agents',
    status: 'warn',
    message: owned
      ? 'WebSearch still denied after search-boost MCP removed'
      : 'WebSearch denied but search-boost MCP not configured',
    fix_hint: 'search-boost uninstall -t claude -y  (or remove WebSearch from ~/.claude/settings.json deny)',
    details: { owned, hasDeny },
  }
}

/** @param {import('../types.mjs').DoctorContext} ctx */
export function checkClaudePartialInstall(ctx) {
  if (!agentDetected('claude')) {
    return {
      id: 'claude_partial_install',
      category: 'agents',
      status: 'pass',
      message: 'Claude not detected (N/A)',
    }
  }

  const homeDir = ctx.homeDir
  const artifacts = homeDir ? claudePriorInstallArtifacts(homeDir) : claudePriorInstallArtifacts()
  const parts = [
    ['mcp', artifacts.mcpConfigured],
    ['agents block', artifacts.agentsBlock],
    ['skill', artifacts.skillInstalled],
    ['allow', artifacts.allowConfigured],
  ]
  const present = parts.filter(([, ok]) => ok)
  const missing = parts.filter(([, ok]) => !ok)

  if (present.length === 0) {
    return {
      id: 'claude_partial_install',
      category: 'agents',
      status: 'pass',
      message: 'No Claude search-boost artifacts',
    }
  }

  if (present.length === parts.length) {
    return {
      id: 'claude_partial_install',
      category: 'agents',
      status: 'pass',
      message: 'Claude search-boost install complete',
      details: { artifacts },
    }
  }

  // Skill prose mentions SEARCH_BOOST — must not count as agents block (marker-only).
  let falseAgentsBlock = false
  try {
    if (existsSync(PATHS.claude.agents)) {
      const md = readFileSync(PATHS.claude.agents, 'utf8')
      falseAgentsBlock = md.includes('SEARCH_BOOST') && !md.includes(MARKER_START)
    }
  } catch { /* unreadable */ }

  return {
    id: 'claude_partial_install',
    category: 'agents',
    status: 'warn',
    message: `Partial Claude install: has ${present.map(([n]) => n).join(', ')}; missing ${missing.map(([n]) => n).join(', ')}`,
    fix_hint: 'search-boost install -t claude -y --auto-allow  or  search-boost uninstall -t claude -y',
    details: { artifacts, present: present.map(([n]) => n), missing: missing.map(([n]) => n), falseAgentsBlock },
  }
}
