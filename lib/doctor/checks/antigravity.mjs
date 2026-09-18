import { existsSync, readFileSync } from 'node:fs'
import { agentConfigured, MCP_SERVER_ID, PATHS } from '../../paths.mjs'
import {
  countSearchBoostPermissions,
  permissionsRedundant,
} from '../../antigravity-settings.mjs'

/** @param {string} path */
function mcpHasSearchBoost(path) {
  if (!existsSync(path)) return false
  try {
    return !!JSON.parse(readFileSync(path, 'utf8')).mcpServers?.[MCP_SERVER_ID]
  } catch {
    return false
  }
}

/** @param {string} path */
function readSettingsAllow(path) {
  if (!existsSync(path)) return null
  try {
    const cfg = JSON.parse(readFileSync(path, 'utf8'))
    return Array.isArray(cfg.permissions?.allow) ? cfg.permissions.allow : []
  } catch {
    return null
  }
}

/** @param {import('../types.mjs').DoctorContext} _ctx */
export function checkAntigravityMcpDuplication(_ctx) {
  const unified = mcpHasSearchBoost(PATHS.antigravity.mcp)
  const legacy = mcpHasSearchBoost(PATHS.antigravity.legacyMcp)

  if (unified && legacy) {
    return {
      id: 'antigravity_mcp_duplication',
      category: 'agents',
      status: 'fail',
      message: 'search-boost in both unified and legacy Antigravity MCP configs',
      fix_hint: 'search-boost install -t antigravity -y',
      details: {
        unified: PATHS.antigravity.mcp,
        legacy: PATHS.antigravity.legacyMcp,
      },
    }
  }

  if (!agentConfigured('antigravity')) {
    return {
      id: 'antigravity_mcp_duplication',
      category: 'agents',
      status: 'pass',
      message: 'Antigravity not configured (N/A)',
    }
  }

  return {
    id: 'antigravity_mcp_duplication',
    category: 'agents',
    status: 'pass',
    message: 'Antigravity MCP paths OK (no duplication)',
  }
}

/** @param {import('../types.mjs').DoctorContext} _ctx */
export function checkAntigravityPermissionConfig(_ctx) {
  if (!agentConfigured('antigravity')) {
    return {
      id: 'antigravity_permission_config',
      category: 'agents',
      status: 'pass',
      message: 'Antigravity not configured (N/A)',
    }
  }

  const cliPath = PATHS.antigravity.settingsCli
  const idePath = PATHS.antigravity.settingsConfig
  const cliAllow = readSettingsAllow(cliPath)
  const ideAllow = readSettingsAllow(idePath)

  /** @type {Array<{ file: string, allow: string[]|null, counts: ReturnType<typeof countSearchBoostPermissions>, redundant: boolean }>} */
  const findings = []

  if (cliAllow !== null) {
    findings.push({
      file: cliPath,
      allow: cliAllow,
      counts: countSearchBoostPermissions(cliAllow),
      redundant: permissionsRedundant(cliAllow),
    })
  }
  if (ideAllow !== null) {
    findings.push({
      file: idePath,
      allow: ideAllow,
      counts: countSearchBoostPermissions(ideAllow),
      redundant: permissionsRedundant(ideAllow),
    })
  }

  const redundant = findings.filter((f) => f.redundant)
  if (redundant.length) {
    return {
      id: 'antigravity_permission_config',
      category: 'agents',
      status: 'warn',
      message: 'Antigravity wildcard + granular search-boost permissions redundant',
      fix_hint: 'search-boost install -t antigravity -y --auto-allow',
      details: { findings: redundant },
    }
  }

  const totalPerms = findings.reduce((n, f) => n + f.counts.total, 0)
  if (totalPerms === 0) {
    return {
      id: 'antigravity_permission_config',
      category: 'agents',
      status: 'warn',
      message: 'Antigravity MCP configured but search-boost permissions missing',
      fix_hint: 'search-boost install -t antigravity -y --auto-allow',
      details: { findings },
    }
  }

  const cliHas = findings.find((f) => f.file === cliPath)
  const ideHas = findings.find((f) => f.file === idePath)
  if (
    existsSync(cliPath)
    && existsSync(idePath)
    && cliHas
    && ideHas
    && cliHas.counts.total > 0
    && ideHas.counts.total === 0
  ) {
    return {
      id: 'antigravity_permission_config',
      category: 'agents',
      status: 'warn',
      message: 'Antigravity permissions only in CLI settings; IDE settings path missing them',
      fix_hint: 'search-boost install -t antigravity -y --auto-allow',
      details: { findings },
    }
  }

  return {
    id: 'antigravity_permission_config',
    category: 'agents',
    status: 'pass',
    message: 'Antigravity permission config OK',
    details: { findings },
  }
}
