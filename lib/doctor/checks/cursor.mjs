import { existsSync, readFileSync } from 'node:fs'
import { agentConfigured, CURSOR_SURFACE } from '../../paths.mjs'
import { isSearchBoostHook } from '../../hooks-config.mjs'
import { CURSOR_CLI_MCP_ALLOW } from '../../cli-config.mjs'

/** @param {import('../types.mjs').DoctorContext} _ctx */
export function checkCursorHookConfig(_ctx) {
  if (!agentConfigured('cursor')) {
    return {
      id: 'cursor_hook_config',
      category: 'agents',
      status: 'pass',
      message: 'Cursor not configured (N/A)',
    }
  }

  /** @type {string[]} */
  const issues = []
  /** @type {Record<string, unknown>} */
  const details = {}

  let hooksCfg = null
  if (existsSync(CURSOR_SURFACE.hooks)) {
    try {
      hooksCfg = JSON.parse(readFileSync(CURSOR_SURFACE.hooks, 'utf8'))
    } catch {
      issues.push('hooks.json unreadable')
    }
  }

  const sessionStart = Array.isArray(hooksCfg?.hooks?.sessionStart)
    ? hooksCfg.hooks.sessionStart
    : []
  const sbHooks = sessionStart.filter(
    (e) => e && typeof e === 'object' && typeof e.command === 'string' && isSearchBoostHook(e.command),
  )
  details.sessionStartCount = sbHooks.length

  if (sbHooks.length === 0) {
    issues.push('no sessionStart hook')
  } else if (sbHooks.length > 1) {
    return {
      id: 'cursor_hook_config',
      category: 'agents',
      status: 'fail',
      message: `Duplicate sessionStart search-boost hooks (${sbHooks.length})`,
      fix_hint: 'search-boost install -t cursor -y',
      details,
    }
  }

  if (sbHooks.length === 1) {
    if (!existsSync(CURSOR_SURFACE.hookScript)) {
      return {
        id: 'cursor_hook_config',
        category: 'agents',
        status: 'fail',
        message: 'sessionStart hook registered but search-boost-session.mjs missing',
        fix_hint: 'search-boost install -t cursor -y',
        details,
      }
    }
    if (!existsSync(CURSOR_SURFACE.hookInject)) {
      return {
        id: 'cursor_hook_config',
        category: 'agents',
        status: 'fail',
        message: 'sessionStart hook registered but search-boost-inject.md missing',
        fix_hint: 'search-boost install -t cursor -y',
        details,
      }
    }

    const cmd = sbHooks[0].command
    if (/cursor-agent|Cursor/i.test(cmd)) {
      issues.push('hook uses IDE-bundled Node')
      details.hookCommand = cmd
    }
  }

  let cliAllow = null
  if (existsSync(CURSOR_SURFACE.cliConfig)) {
    try {
      const cliCfg = JSON.parse(readFileSync(CURSOR_SURFACE.cliConfig, 'utf8'))
      cliAllow = cliCfg.permissions?.allow
      details.cliConfigExists = true
    } catch {
      details.cliConfigExists = true
      details.cliConfigUnreadable = true
    }
  }

  const hasCliAllow = Array.isArray(cliAllow) && cliAllow.includes(CURSOR_CLI_MCP_ALLOW)
  if (sbHooks.length > 0 && !hasCliAllow) {
    issues.push('cli-config missing Mcp(search-boost:*) auto-allow')
  }

  if (issues.includes('no sessionStart hook')) {
    return {
      id: 'cursor_hook_config',
      category: 'agents',
      status: 'warn',
      message: 'Cursor MCP configured but no sessionStart search-boost hook',
      fix_hint: 'search-boost install -t cursor -y',
      details,
    }
  }

  if (issues.some((i) => i.includes('IDE-bundled'))) {
    return {
      id: 'cursor_hook_config',
      category: 'agents',
      status: 'warn',
      message: 'Cursor sessionStart hook uses IDE-bundled Node (cursor-agent)',
      fix_hint: 'search-boost install -t cursor -y',
      details,
    }
  }

  if (issues.some((i) => i.includes('cli-config'))) {
    return {
      id: 'cursor_hook_config',
      category: 'agents',
      status: 'warn',
      message: 'Cursor hook present but cli-config missing Mcp(search-boost:*) auto-allow',
      fix_hint: 'search-boost install -t cursor -y --auto-allow',
      details,
    }
  }

  return {
    id: 'cursor_hook_config',
    category: 'agents',
    status: 'pass',
    message: 'Cursor hook config OK',
    details,
  }
}
