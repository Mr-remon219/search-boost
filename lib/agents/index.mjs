/**
 * Per-agent install / uninstall / print-config adapters.
 */
import { existsSync } from 'node:fs'
import {
  jsonDeepEqual,
  prunePermissions,
  readJsonFile,
  readTextFile,
  removeMcpServer,
  stripAllowList,
  upsertAllowList,
  upsertMcpServer,
  writeJsonFile,
  writeTextFile,
} from '../json-config.mjs'
import {
  antigravityMcpEntry,
  antigravityPermissions,
  claudePermissions,
  formatPrintConfig,
  grokPermissionTomlBlock,
  jsonMcpEntry,
  MCP_SERVER_ID,
  tomlMcpBlock,
} from '../mcp-entry.mjs'
import {
  injectTomlSection as injectMarkedTomlSection,
  removeTomlSection as removeMarkedTomlSection,
} from '../inject.mjs'
import {
  grokAlwaysApproveMode,
  stripLegacySearchBoostPermission,
} from '../grok-toml.mjs'
import { removeTomlSection, upsertTomlSection } from '../toml.mjs'
import {
  agentConfigured,
  agentDetected,
  antigravityMcpPaths,
  grokInstallPaths,
  grokUninstallScopes,
  PATHS,
  preferredAntigravityMcpPath,
  preferredAntigravitySettingsPath,
  workspaceAgents,
} from '../paths.mjs'
import {
  injectAgentsFile,
  injectAntigravityRule,
  injectGeminiSnippetFile,
  injectOpenaiYaml,
  injectSkill,
  installAntigravityHook,
  loadAgentPrompt,
  removeAgentsBlock,
  removeFileIfExists,
  removeGeminiSnippetBlock,
  uninstallAntigravityHook,
} from './shared.mjs'
import { installCursorSurface, uninstallCursorSurface } from './cursor-family.mjs'
import { getRoute } from '../../agents/router.mjs'
import { applyClaudeNativeSettings, applyCodexNativeToml } from '../native-search.mjs'
import {
  forgetAntigravityWorkspace,
  listAntigravityWorkspaces,
  recordAntigravityWorkspace,
} from '../workspace-marker.mjs'

/**
 * @typedef {{
 *   dryRun?: boolean,
 *   autoAllow?: boolean,
 *   replaceNative?: boolean,
 *   mergeCursorCli?: boolean,
 *   scope?: 'user'|'project',
 *   workspace?: string|null,
 * }} InstallOpts
 */

async function writeClaudePermissions(dryRun) {
  const file = PATHS.claude.settings
  const settings = await readJsonFile(file, {})
  settings.permissions ??= {}
  settings.permissions.allow ??= []
  const before = [...settings.permissions.allow]
  settings.permissions.allow = upsertAllowList(
    settings.permissions.allow,
    claudePermissions(),
    (p) => p.startsWith('mcp__search-boost__'),
  )
  if (jsonDeepEqual(before, settings.permissions.allow)) return file
  if (!dryRun) await writeJsonFile(file, settings)
  return file
}

async function removeClaudePermissions(dryRun) {
  const file = PATHS.claude.settings
  if (!existsSync(file)) return
  const settings = await readJsonFile(file, {})
  let next = applyClaudeNativeSettings(
    { ...settings, permissions: { ...(settings.permissions ?? {}) } },
    false,
  )
  if (Array.isArray(next.permissions?.allow)) {
    next.permissions.allow = stripAllowList(
      next.permissions.allow,
      (p) => p.startsWith('mcp__search-boost__'),
    )
  }
  const cleaned = prunePermissions(next)
  if (jsonDeepEqual(settings, cleaned)) return
  if (!dryRun) await writeJsonFile(file, cleaned)
}

async function writeClaudeNativeDeny(replace, dryRun) {
  const file = PATHS.claude.settings
  const settings = await readJsonFile(file, {})
  const next = applyClaudeNativeSettings(settings, replace)
  if (jsonDeepEqual(settings, next)) return file
  if (!dryRun) await writeJsonFile(file, next)
  return file
}

async function writeAntigravityPermissions(dryRun) {
  const file = preferredAntigravitySettingsPath()
  const settings = await readJsonFile(file, {})
  settings.permissions ??= {}
  settings.permissions.allow ??= []
  const before = [...settings.permissions.allow]
  settings.permissions.allow = upsertAllowList(
    settings.permissions.allow,
    antigravityPermissions(),
    (p) => p.startsWith('mcp(search-boost'),
  )
  if (jsonDeepEqual(before, settings.permissions.allow)) return file
  if (!dryRun) await writeJsonFile(file, settings)
  return file
}

async function removeAntigravityPermissions(dryRun) {
  const file = preferredAntigravitySettingsPath()
  if (!existsSync(file)) return
  const settings = await readJsonFile(file, {})
  if (!Array.isArray(settings.permissions?.allow)) return
  const next = { ...settings, permissions: { ...settings.permissions } }
  next.permissions.allow = stripAllowList(
    next.permissions.allow,
    (p) => p.startsWith('mcp(search-boost'),
  )
  prunePermissions(next)
  if (jsonDeepEqual(settings, next)) return
  if (!dryRun) await writeJsonFile(file, next)
}

/** @param {InstallOpts} opts */
async function installAntigravityWorkspace(opts) {
  if (!opts.workspace) return []
  const ws = workspaceAgents(opts.workspace)
  const files = [ws.mcp, ws.skill, ws.rule]
  await upsertMcpServer(ws.mcp, MCP_SERVER_ID, antigravityMcpEntry(), !!opts.dryRun)
  if (!opts.dryRun) {
    await injectSkill('antigravity', ws.skill)
    await injectAntigravityRule(ws.rule)
    const hookFiles = await installAntigravityHook(opts.workspace, !!opts.dryRun)
    files.push(...hookFiles)
    await recordAntigravityWorkspace(opts.workspace, !!opts.dryRun)
  } else {
    files.push(ws.hooks, ws.hookScript)
  }
  return files
}

/** @param {InstallOpts} opts */
async function uninstallAntigravityWorkspace(opts) {
  const roots = opts.workspace
    ? [opts.workspace]
    : await listAntigravityWorkspaces()
  for (const root of roots) {
    const ws = workspaceAgents(root)
    await removeMcpServer(ws.mcp, MCP_SERVER_ID, !!opts.dryRun)
    if (!opts.dryRun) {
      await removeFileIfExists(ws.skill)
      await removeFileIfExists(ws.rule)
      await uninstallAntigravityHook(root, !!opts.dryRun)
      await forgetAntigravityWorkspace(root, !!opts.dryRun)
    }
  }
}

async function cleanupAntigravityLegacy(dryRun) {
  const preferred = preferredAntigravityMcpPath()
  if (preferred !== PATHS.antigravity.mcp) return null
  const legacy = PATHS.antigravity.legacyMcp
  if (!existsSync(legacy)) return null
  const cfg = await readJsonFile(legacy, { mcpServers: {} })
  if (!cfg.mcpServers?.[MCP_SERVER_ID]) return null
  if (!dryRun) {
    delete cfg.mcpServers[MCP_SERVER_ID]
    if (Object.keys(cfg.mcpServers).length === 0) delete cfg.mcpServers
    await writeJsonFile(legacy, cfg)
  }
  return legacy
}

/** @type {Record<string, import('./types').AgentAdapter>} */
export const AGENTS = {
  cursor: {
    id: 'cursor',
    label: getRoute('cursor').label,
    async install(opts) {
      return installCursorSurface({
        dryRun: opts.dryRun,
        autoAllow: opts.autoAllow,
        mergeCursorCli: !!opts.mergeCursorCli,
        skillAgentId: 'cursor',
      })
    },
    async uninstall(opts) {
      await uninstallCursorSurface(opts)
    },
    printConfig: (opts) => formatPrintConfig('cursor', PATHS.cursor.mcp, opts),
  },

  'cursor-cli': {
    id: 'cursor-cli',
    label: getRoute('cursor-cli').label,
    async install(opts) {
      if (opts.mergeCursorCli) return []
      return installCursorSurface({
        dryRun: opts.dryRun,
        autoAllow: opts.autoAllow,
        mergeCursorCli: false,
        skillAgentId: 'cursor-cli',
      })
    },
    async uninstall(opts) {
      if (opts.mergeCursorCli) return
      await uninstallCursorSurface(opts)
    },
    printConfig: (opts) => formatPrintConfig('cursor-cli', PATHS['cursor-cli'].mcp, opts),
  },

  codex: {
    id: 'codex',
    label: getRoute('codex').label,
    async install(opts) {
      const files = [
        PATHS.codex.config,
        PATHS.codex.agents,
        PATHS.codex.skill,
        PATHS.codex.openaiYaml,
      ]
      let toml = await readTextFile(PATHS.codex.config)
      toml = upsertTomlSection(toml, MCP_SERVER_ID, tomlMcpBlock({ approvalAuto: !!opts.autoAllow }))
      toml = applyCodexNativeToml(toml, opts.replaceNative !== false)
      if (!opts.dryRun) {
        await writeTextFile(PATHS.codex.config, `${toml.trim()}\n`)
        await injectAgentsFile(PATHS.codex.agents, 'codex')
        await injectSkill('codex', PATHS.codex.skill)
        await injectOpenaiYaml('codex', PATHS.codex.openaiYaml)
      }
      return files
    },
    async uninstall(opts) {
      let toml = await readTextFile(PATHS.codex.config)
      toml = removeTomlSection(toml, MCP_SERVER_ID)
      toml = removeMarkedTomlSection(toml, 'WEB_SEARCH')
      if (!opts.dryRun) {
        await writeTextFile(PATHS.codex.config, toml ? `${toml.trim()}\n` : '')
        await removeAgentsBlock(PATHS.codex.agents)
        await removeFileIfExists(PATHS.codex.skill)
        await removeFileIfExists(PATHS.codex.openaiYaml)
      }
    },
    printConfig: (opts) => formatPrintConfig('codex', PATHS.codex.config, opts),
  },

  claude: {
    id: 'claude',
    label: getRoute('claude').label,
    async install(opts) {
      const files = [PATHS.claude.config, PATHS.claude.agents, PATHS.claude.skill]
      await upsertMcpServer(PATHS.claude.config, MCP_SERVER_ID, jsonMcpEntry(), !!opts.dryRun)
      if (opts.autoAllow) {
        await writeClaudePermissions(!!opts.dryRun)
        files.push(PATHS.claude.settings)
      }
      if (opts.replaceNative !== false) {
        const denyFile = await writeClaudeNativeDeny(true, !!opts.dryRun)
        if (denyFile && !files.includes(denyFile)) files.push(denyFile)
      } else {
        await writeClaudeNativeDeny(false, !!opts.dryRun)
      }
      if (!opts.dryRun) {
        await injectAgentsFile(PATHS.claude.agents, 'claude')
        await injectSkill('claude', PATHS.claude.skill)
      }
      return files
    },
    async uninstall(opts) {
      await removeMcpServer(PATHS.claude.config, MCP_SERVER_ID, !!opts.dryRun)
      await removeClaudePermissions(!!opts.dryRun)
      if (!opts.dryRun) {
        await removeAgentsBlock(PATHS.claude.agents)
        await removeFileIfExists(PATHS.claude.skill)
      }
    },
    printConfig: (opts) => formatPrintConfig('claude', PATHS.claude.config, opts),
  },

  grok: {
    id: 'grok',
    label: getRoute('grok').label,
    async install(opts) {
      const paths = grokInstallPaths(opts.scope ?? 'user')
      const files = [paths.config, paths.rule, paths.skill]
      let toml = await readTextFile(paths.config)
      toml = upsertTomlSection(toml, MCP_SERVER_ID, tomlMcpBlock())
      toml = removeMarkedTomlSection(toml, 'permission')
      toml = stripLegacySearchBoostPermission(toml)
      if (opts.autoAllow && !grokAlwaysApproveMode(toml)) {
        toml = injectMarkedTomlSection(toml, 'permission', grokPermissionTomlBlock())
      }
      const rule = await loadAgentPrompt('grok')
      if (!opts.dryRun) {
        await writeTextFile(paths.config, `${toml.trim()}\n`)
        await writeTextFile(paths.rule, `${rule.trim()}\n`)
        await injectSkill('grok', paths.skill)
      }
      return files
    },
    async uninstall(opts) {
      for (const scope of grokUninstallScopes(opts.scope ?? 'user')) {
        const paths = grokInstallPaths(scope)
        let toml = await readTextFile(paths.config)
        toml = removeTomlSection(toml, MCP_SERVER_ID)
        toml = removeMarkedTomlSection(toml, 'permission')
        toml = stripLegacySearchBoostPermission(toml)
        if (!opts.dryRun) {
          await writeTextFile(paths.config, toml ? `${toml.trim()}\n` : '')
          await removeFileIfExists(paths.rule)
          await removeFileIfExists(paths.skill)
        }
      }
    },
    printConfig: (opts) =>
      formatPrintConfig('grok', grokInstallPaths(opts.scope ?? 'user').config, opts),
  },

  antigravity: {
    id: 'antigravity',
    label: getRoute('antigravity').label,
    async install(opts) {
      const mcpPath = preferredAntigravityMcpPath()
      const files = [mcpPath, PATHS.antigravity.agents, PATHS.antigravity.gemini, PATHS.antigravity.skill]
      await upsertMcpServer(mcpPath, MCP_SERVER_ID, antigravityMcpEntry(), !!opts.dryRun)
      const legacy = await cleanupAntigravityLegacy(!!opts.dryRun)
      if (legacy) files.push(legacy)
      if (opts.autoAllow) {
        const permPath = await writeAntigravityPermissions(!!opts.dryRun)
        if (permPath) files.push(permPath)
      }
      if (!opts.dryRun) {
        await injectAgentsFile(PATHS.antigravity.agents, 'antigravity')
        await injectGeminiSnippetFile(PATHS.antigravity.gemini, 'antigravity')
        await injectSkill('antigravity', PATHS.antigravity.skill)
      }
      const wsFiles = await installAntigravityWorkspace(opts)
      files.push(...wsFiles)
      return files
    },
    async uninstall(opts) {
      for (const mcpPath of antigravityMcpPaths()) {
        await removeMcpServer(mcpPath, MCP_SERVER_ID, !!opts.dryRun)
      }
      await removeAntigravityPermissions(!!opts.dryRun)
      if (!opts.dryRun) {
        await removeAgentsBlock(PATHS.antigravity.agents)
        await removeGeminiSnippetBlock(PATHS.antigravity.gemini)
        await removeFileIfExists(PATHS.antigravity.skill)
      }
      await uninstallAntigravityWorkspace(opts)
    },
    printConfig: (opts) => formatPrintConfig('antigravity', preferredAntigravityMcpPath(), opts),
  },
}

export const AGENT_IDS = Object.keys(AGENTS)

/** @param {string} spec */
export function parseTargetSpec(spec) {
  if (!spec || spec === 'auto') {
    return AGENT_IDS.filter((id) => agentDetected(id))
  }
  if (spec === 'all') return [...AGENT_IDS]
  if (spec === 'none') return []
  const ids = spec.split(',').map((s) => s.trim()).filter(Boolean)
  const unknown = ids.filter((id) => !AGENT_IDS.includes(id))
  if (unknown.length) {
    throw new Error(`Unknown agent(s): ${unknown.join(', ')}. Expected: ${AGENT_IDS.join(', ')} | auto | all`)
  }
  return ids
}

/**
 * When both cursor + cursor-cli are selected, install once via cursor adapter (merged hook inject).
 * @param {string[]} targets
 */
export function normalizeTargets(targets) {
  const set = new Set(targets)
  const mergeCursorCli = set.has('cursor') && set.has('cursor-cli')
  const out = targets.filter((id) => !(id === 'cursor-cli' && mergeCursorCli))
  return { targets: out, mergeCursorCli }
}

/** @param {string} id */
export function agentStatus(id) {
  return {
    id,
    label: AGENTS[id]?.label ?? id,
    detected: agentDetected(id),
    configured: agentConfigured(id),
  }
}
