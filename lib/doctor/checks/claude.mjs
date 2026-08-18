import { existsSync, readFileSync } from 'node:fs'
import { agentConfigured, agentDetected, PATHS } from '../../paths.mjs'
import {
  allowRedundant,
  claudeBypassPermissionsMode,
  countSearchBoostAllowEntries,
  hasLegacyGranularAllow,
  isSearchBoostAllow,
} from '../../claude-settings.mjs'
import {
  claudeNativeReplaced,
  claudePriorInstallArtifacts,
} from '../../native-search.mjs'
import { MARKER_START } from '../../inject.mjs'

/** @param {string} path */
function fileHasSearchBoostBlock(path) {
  try {
    return existsSync(path) && readFileSync(path, 'utf8').includes(MARKER_START)
  } catch {
    return false
  }
}

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
  const hasInject = fileHasSearchBoostBlock(PATHS.claude.agents)
  const allow = settings.permissions?.allow ?? []
  const hasAllow = Array.isArray(allow) && allow.some(isSearchBoostAllow)
  const partialArtifacts = hasSettings && (hasAllow || hasSkill || hasInject || claudePriorInstallArtifacts())

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
