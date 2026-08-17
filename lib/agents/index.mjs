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
  claudePermissions,
  formatPrintConfig,
  jsonMcpEntry,
  MCP_SERVER_ID,
  tomlMcpBlock,
} from '../mcp-entry.mjs'
import { removeTomlSection, upsertTomlSection } from '../toml.mjs'
import {
  agentConfigured,
  agentDetected,
  antigravityMcpPaths,
  MCP_SERVER_ID as PATH_MCP_ID,
  PATHS,
  preferredAntigravityMcpPath,
} from '../paths.mjs'
import {
  injectAgentsFile,
  injectSkill,
  loadAgentPrompt,
  removeAgentsBlock,
  removeFileIfExists,
} from './shared.mjs'
import { installCursorSurface, uninstallCursorSurface } from './cursor-family.mjs'
import { getRoute } from '../../agents/router.mjs'

/** @typedef {{ dryRun?: boolean, autoAllow?: boolean, mergeCursorCli?: boolean }} InstallOpts */

async function writeClaudePermissions(dryRun) {
  const file = PATHS.claude.settings
  const settings = await readJsonFile(file, {})
  settings.permissions ??= {}
  settings.permissions.allow ??= []
  const want = claudePermissions()
  const before = [...settings.permissions.allow]
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
    printConfig: () => formatPrintConfig('cursor', PATHS.cursor.mcp),
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
    printConfig: () => formatPrintConfig('cursor-cli', PATHS['cursor-cli'].mcp),
  },

  codex: {
    id: 'codex',
    label: getRoute('codex').label,
    async install(opts) {
      const files = [PATHS.codex.config, PATHS.codex.agents]
      let toml = await readTextFile(PATHS.codex.config)
      toml = upsertTomlSection(toml, MCP_SERVER_ID, tomlMcpBlock())
      if (!opts.dryRun) {
        await writeTextFile(PATHS.codex.config, `${toml.trim()}\n`)
        await injectAgentsFile(PATHS.codex.agents, 'codex')
      }
      return files
    },
    async uninstall(opts) {
      let toml = await readTextFile(PATHS.codex.config)
      toml = removeTomlSection(toml, MCP_SERVER_ID)
      if (!opts.dryRun) {
        await writeTextFile(PATHS.codex.config, toml ? `${toml.trim()}\n` : '')
        await removeAgentsBlock(PATHS.codex.agents)
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
      const files = [PATHS.grok.config, PATHS.grok.rule, PATHS.grok.skill]
      let toml = await readTextFile(PATHS.grok.config)
      toml = upsertTomlSection(toml, MCP_SERVER_ID, tomlMcpBlock())
      const rule = await loadAgentPrompt('grok')
      if (!opts.dryRun) {
        await writeTextFile(PATHS.grok.config, `${toml.trim()}\n`)
        await writeTextFile(PATHS.grok.rule, `${rule.trim()}\n`)
        await injectSkill('grok', PATHS.grok.skill)
      }
      return files
    },
    async uninstall(opts) {
      let toml = await readTextFile(PATHS.grok.config)
      toml = removeTomlSection(toml, MCP_SERVER_ID)
      if (!opts.dryRun) {
        await writeTextFile(PATHS.grok.config, toml ? `${toml.trim()}\n` : '')
        await removeFileIfExists(PATHS.grok.rule)
      }
    },
    printConfig: () => formatPrintConfig('grok', PATHS.grok.config),
  },

  antigravity: {
    id: 'antigravity',
    label: getRoute('antigravity').label,
    async install(opts) {
      const mcpPath = preferredAntigravityMcpPath()
      const files = [mcpPath, PATHS.antigravity.agents, PATHS.antigravity.skill]
      await upsertMcpServer(mcpPath, MCP_SERVER_ID, antigravityMcpEntry(), !!opts.dryRun)
      const legacy = await cleanupAntigravityLegacy(!!opts.dryRun)
      if (legacy) files.push(legacy)
      if (!opts.dryRun) {
        await injectAgentsFile(PATHS.antigravity.agents, 'antigravity')
        await injectSkill('antigravity', PATHS.antigravity.skill)
      }
      return files
    },
    async uninstall(opts) {
      for (const mcpPath of antigravityMcpPaths()) {
        await removeMcpServer(mcpPath, MCP_SERVER_ID, !!opts.dryRun)
      }
      if (!opts.dryRun) await removeAgentsBlock(PATHS.antigravity.agents)
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
