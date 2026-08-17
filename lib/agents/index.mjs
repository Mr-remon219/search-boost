/**
 * Per-agent install / uninstall / print-config adapters.
 */
import { existsSync, readFileSync } from 'node:fs'
import {
  jsonDeepEqual,
  readJsonFile,
  readTextFile,
  removeMcpServer,
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
import { removeTomlSection, upsertTomlSection } from '../toml.mjs'
import {
  agentConfigured,
  agentDetected,
  antigravityMcpPaths,
  grokInstallPaths,
  MCP_SERVER_ID as PATH_MCP_ID,
  PATHS,
  preferredAntigravityMcpPath,
  preferredAntigravitySettingsPath,
  workspaceAgents,
} from '../paths.mjs'
import {
  injectAgentsBody,
  injectAgentsFile,
  injectAntigravityRule,
  injectGeminiSnippetFile,
  injectOpenaiYaml,
  injectSkill,
  installAntigravityHook,
  loadAgentPrompt,
  loadCursorMergedPrompt,
  removeAgentsBlock,
  removeFileIfExists,
  removeGeminiSnippetBlock,
  uninstallAntigravityHook,
} from './shared.mjs'
import { getRoute } from '../../agents/router.mjs'

/**
 * @typedef {{
 *   dryRun?: boolean,
 *   autoAllow?: boolean,
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
  const want = claudePermissions()
  const before = [...settings.permissions.allow]
  settings.permissions.allow = settings.permissions.allow.filter(
    (p) => !p.startsWith('mcp__search-boost__'),
  )
  for (const perm of want) {
    if (!settings.permissions.allow.includes(perm)) settings.permissions.allow.push(perm)
  }
  if (jsonDeepEqual(before, settings.permissions.allow)) return
  if (!dryRun) await writeJsonFile(file, settings)
}

async function removeClaudePermissions(dryRun) {
  const file = PATHS.claude.settings
  if (!existsSync(file)) return
  const settings = await readJsonFile(file, {})
  if (!Array.isArray(settings.permissions?.allow)) return
  const before = settings.permissions.allow.length
  settings.permissions.allow = settings.permissions.allow.filter((p) => !p.startsWith('mcp__search-boost__'))
  if (settings.permissions.allow.length === before) return
  if (settings.permissions.allow.length === 0) delete settings.permissions.allow
  if (settings.permissions && Object.keys(settings.permissions).length === 0) delete settings.permissions
  if (!dryRun) await writeJsonFile(file, settings)
}

async function writeAntigravityPermissions(dryRun) {
  const file = preferredAntigravitySettingsPath()
  const settings = await readJsonFile(file, {})
  settings.permissions ??= {}
  settings.permissions.allow ??= []
  const want = antigravityPermissions()
  const before = [...settings.permissions.allow]
  for (const perm of want) {
    if (!settings.permissions.allow.includes(perm)) settings.permissions.allow.push(perm)
  }
  if (jsonDeepEqual(before, settings.permissions.allow)) return file
  if (!dryRun) await writeJsonFile(file, settings)
  return file
}

async function removeAntigravityPermissions(dryRun) {
  const file = preferredAntigravitySettingsPath()
  if (!existsSync(file)) return
  const settings = await readJsonFile(file, {})
  if (!Array.isArray(settings.permissions?.allow)) return
  const before = settings.permissions.allow.length
  settings.permissions.allow = settings.permissions.allow.filter(
    (p) => !p.startsWith('mcp(search-boost'),
  )
  if (settings.permissions.allow.length === before) return
  if (settings.permissions.allow.length === 0) delete settings.permissions.allow
  if (settings.permissions && Object.keys(settings.permissions).length === 0) delete settings.permissions
  if (!dryRun) await writeJsonFile(file, settings)
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
  } else {
    files.push(ws.hooks, ws.hookScript)
  }
  return files
}

/** @param {InstallOpts} opts */
async function uninstallAntigravityWorkspace(opts) {
  if (!opts.workspace) return
  const ws = workspaceAgents(opts.workspace)
  await removeMcpServer(ws.mcp, MCP_SERVER_ID, !!opts.dryRun)
  if (!opts.dryRun) {
    await removeFileIfExists(ws.skill)
    await removeFileIfExists(ws.rule)
    await uninstallAntigravityHook(opts.workspace, !!opts.dryRun)
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
      const files = []
      const route = getRoute('cursor')
      const entry = {
        ...jsonMcpEntry(),
        ...(route.mcp?.serverUseInstructions
          ? { serverUseInstructions: route.mcp.serverUseInstructions }
          : {}),
      }
      const r = await upsertMcpServer(PATHS.cursor.mcp, MCP_SERVER_ID, entry, !!opts.dryRun)
      files.push(r.path)
      const body = await loadCursorMergedPrompt(!!opts.mergeCursorCli)
      if (!opts.dryRun) await injectAgentsBody(PATHS.cursor.agents, body)
      files.push(PATHS.cursor.agents)
      if (!opts.dryRun) await injectSkill('cursor', PATHS.cursor.skill)
      files.push(PATHS.cursor.skill)
      return files
    },
    async uninstall(opts) {
      await removeMcpServer(PATHS.cursor.mcp, MCP_SERVER_ID, !!opts.dryRun)
      if (!opts.dryRun) await removeAgentsBlock(PATHS.cursor.agents)
    },
    printConfig: () => formatPrintConfig('cursor', PATHS.cursor.mcp),
  },

  'cursor-cli': {
    id: 'cursor-cli',
    label: getRoute('cursor-cli').label,
    async install(opts) {
      const files = []
      if (!opts.mergeCursorCli) {
        const r = await upsertMcpServer(PATHS['cursor-cli'].mcp, MCP_SERVER_ID, jsonMcpEntry(), !!opts.dryRun)
        files.push(r.path)
        if (!opts.dryRun) await injectAgentsFile(PATHS['cursor-cli'].agents, 'cursor-cli')
        files.push(PATHS['cursor-cli'].agents)
      }
      return files
    },
    async uninstall(opts) {
      if (!opts.dryRun && !opts.mergeCursorCli) {
        await removeAgentsBlock(PATHS['cursor-cli'].agents)
      }
    },
    printConfig: () => formatPrintConfig('cursor-cli', PATHS['cursor-cli'].mcp),
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
      toml = injectMarkedTomlSection(toml, 'WEB_SEARCH', 'web_search = "disabled"')
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
    printConfig: () => formatPrintConfig('codex', PATHS.codex.config),
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
      if (!opts.dryRun) {
        await injectAgentsFile(PATHS.claude.agents, 'claude')
        await injectSkill('claude', PATHS.claude.skill)
      }
      return files
    },
    async uninstall(opts) {
      await removeMcpServer(PATHS.claude.config, MCP_SERVER_ID, !!opts.dryRun)
      await removeClaudePermissions(!!opts.dryRun)
      if (!opts.dryRun) await removeAgentsBlock(PATHS.claude.agents)
    },
    printConfig: () => formatPrintConfig('claude', PATHS.claude.config),
  },

  grok: {
    id: 'grok',
    label: getRoute('grok').label,
    async install(opts) {
      const paths = grokInstallPaths(opts.scope ?? 'user')
      const files = [paths.config, paths.rule, paths.skill]
      let toml = await readTextFile(paths.config)
      toml = upsertTomlSection(toml, MCP_SERVER_ID, tomlMcpBlock())
      if (opts.autoAllow) {
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
      const paths = grokInstallPaths(opts.scope ?? 'user')
      let toml = await readTextFile(paths.config)
      toml = removeTomlSection(toml, MCP_SERVER_ID)
      toml = removeMarkedTomlSection(toml, 'permission')
      if (!opts.dryRun) {
        await writeTextFile(paths.config, toml ? `${toml.trim()}\n` : '')
        if ((opts.scope ?? 'user') === 'user') {
          await removeFileIfExists(paths.rule)
        }
      }
    },
    printConfig: () => formatPrintConfig('grok', PATHS.grok.config),
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
    printConfig: () => formatPrintConfig('antigravity', preferredAntigravityMcpPath()),
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
  return spec.split(',').map((s) => s.trim()).filter(Boolean)
}

/**
 * When both cursor + cursor-cli are selected, install once with merged AGENTS.md.
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
    configured: isAgentConfigured(id),
  }
}

/** @param {string} id */
function isAgentConfigured(id) {
  if (id === 'cursor-cli') {
    try {
      return !!JSON.parse(readFileSync(PATHS.cursor.mcp, 'utf8')).mcpServers?.[PATH_MCP_ID]
    } catch {
      return false
    }
  }
  if (id === 'antigravity') {
    for (const p of antigravityMcpPaths()) {
      try {
        if (JSON.parse(readFileSync(p, 'utf8')).mcpServers?.[PATH_MCP_ID]) return true
      } catch { /* next */ }
    }
    return false
  }
  return agentConfigured(id)
}
