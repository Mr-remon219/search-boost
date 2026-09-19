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
import { stripSearchBoostPermissions } from '../antigravity-settings.mjs'
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
import { installGrokPlugin, uninstallGrokPlugin } from '../grok-plugin.mjs'
import { removeTomlSection, upsertTomlSection } from '../toml.mjs'
import {
  agentConfigured,
  agentDetected,
  antigravityMcpPaths,
  grokInstallPaths,
  grokScopeHasArtifacts,
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
  installAntigravityHook,
  loadAgentPrompt,
  removeAgentsBlock,
  removeEmptyFileIfExists,
  removeFileIfExists,
  removeGeminiSnippetBlock,
  uninstallAntigravityHook,
} from './shared.mjs'
import { installCursorSurface, uninstallCursorSurface } from './cursor-family.mjs'
import {
  formatDshPrintConfig,
  formatPiPrintConfig,
  installDshBundle,
  installPiExtension,
  uninstallDshBundle,
  uninstallPiExtension,
} from './host-runtime.mjs'
import { getRoute } from '../../agents/router.mjs'
import { installSkillBundle, uninstallSkillBundle } from '../agent-skills.mjs'
import { installStartupHook, uninstallStartupHook, loadStartupSearchPolicy } from '../startup-hooks.mjs'
import { applyClaudeNativeSettings, applyCodexNativeToml, migrateLegacyClaudeNativeDeny, noteClaudePreExistingWebSearchDeny } from '../native-search.mjs'
import { stripMarkedWebSearchFromMcpToml, writeCodexConfigOrUnlink } from '../codex-toml.mjs'
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
  let settings = await readJsonFile(file, {})
  settings = noteClaudePreExistingWebSearchDeny(settings)
  if (replace) {
    const cfg = await readJsonFile(PATHS.claude.config, {})
    const hasMcp = !!cfg.mcpServers?.[MCP_SERVER_ID]
    settings = migrateLegacyClaudeNativeDeny(settings, hasMcp)
  }
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
  const next = stripSearchBoostPermissions(settings)
  if (jsonDeepEqual(settings, next)) return
  if (!dryRun) await writeJsonFile(file, next)
}

/** @param {InstallOpts} opts */
async function installAntigravityWorkspace(opts) {
  if (!opts.workspace) return []
  const ws = workspaceAgents(opts.workspace)
  const files = [ws.mcp, ws.rule, ...await installSkillBundle('antigravity', ws.skill, opts)]
  await upsertMcpServer(ws.mcp, MCP_SERVER_ID, antigravityMcpEntry(), !!opts.dryRun)
  if (!opts.dryRun) {
    await injectAntigravityRule(ws.rule)
    const hookFiles = await installAntigravityHook(opts.workspace, !!opts.dryRun)
    files.push(...hookFiles)
    await recordAntigravityWorkspace(opts.workspace, !!opts.dryRun)
  } else {
    files.push(ws.hooks, ws.hookScript, ws.hookInject)
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
    await uninstallSkillBundle('antigravity', ws.skill, opts)
    await removeMcpServer(ws.mcp, MCP_SERVER_ID, !!opts.dryRun)
    if (!opts.dryRun) {
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
        ...await installSkillBundle('codex', PATHS.codex.skill, opts),
        ...await installStartupHook(PATHS.codex, { dryRun: !!opts.dryRun }),
      ]
      let toml = await readTextFile(PATHS.codex.config)
      toml = stripMarkedWebSearchFromMcpToml(toml, MCP_SERVER_ID)
      toml = upsertTomlSection(toml, MCP_SERVER_ID, tomlMcpBlock({ approvalAuto: !!opts.autoAllow }))
      toml = applyCodexNativeToml(toml, opts.replaceNative !== false)
      if (!opts.dryRun) {
        await writeTextFile(PATHS.codex.config, `${toml.trim()}\n`)
        await injectAgentsFile(PATHS.codex.agents, 'codex')
      }
      return files
    },
    async uninstall(opts) {
      await uninstallSkillBundle('codex', PATHS.codex.skill, opts)
      await uninstallStartupHook(PATHS.codex, { dryRun: !!opts.dryRun })
      let toml = await readTextFile(PATHS.codex.config)
      toml = removeTomlSection(toml, MCP_SERVER_ID)
      toml = applyCodexNativeToml(toml, false)
      if (!opts.dryRun) {
        await writeCodexConfigOrUnlink(PATHS.codex.config, toml)
        if (existsSync(PATHS.codex.agents)) {
          await removeAgentsBlock(PATHS.codex.agents)
        }
      }
    },
    printConfig: (opts) => formatPrintConfig('codex', PATHS.codex.config, opts),
  },

  claude: {
    id: 'claude',
    label: getRoute('claude').label,
    async install(opts) {
      const files = [
        PATHS.claude.config, PATHS.claude.agents,
        ...await installSkillBundle('claude', PATHS.claude.skill, opts),
        ...await installStartupHook(PATHS.claude, { dryRun: !!opts.dryRun }),
      ]
      await upsertMcpServer(PATHS.claude.config, MCP_SERVER_ID, jsonMcpEntry(), !!opts.dryRun)
      if (!opts.dryRun) {
        const settings = await readJsonFile(PATHS.claude.settings, {})
        const noted = noteClaudePreExistingWebSearchDeny(settings)
        if (!jsonDeepEqual(settings, noted)) await writeJsonFile(PATHS.claude.settings, noted)
      }
      if (opts.autoAllow) {
        await writeClaudePermissions(!!opts.dryRun)
        if (!files.includes(PATHS.claude.settings)) files.push(PATHS.claude.settings)
      }
      if (opts.replaceNative !== false) {
        const denyFile = await writeClaudeNativeDeny(true, !!opts.dryRun)
        if (denyFile && !files.includes(denyFile)) files.push(denyFile)
      } else {
        await writeClaudeNativeDeny(false, !!opts.dryRun)
      }
      if (!opts.dryRun) {
        await injectAgentsFile(PATHS.claude.agents, 'claude')
      }
      return files
    },
    async uninstall(opts) {
      await uninstallSkillBundle('claude', PATHS.claude.skill, opts)
      await uninstallStartupHook(PATHS.claude, { dryRun: !!opts.dryRun })
      await removeMcpServer(PATHS.claude.config, MCP_SERVER_ID, !!opts.dryRun)
      await removeClaudePermissions(!!opts.dryRun)
      if (!opts.dryRun) {
        await removeAgentsBlock(PATHS.claude.agents)
        await removeEmptyFileIfExists(PATHS.claude.agents)
      }
    },
    printConfig: (opts) => formatPrintConfig('claude', PATHS.claude.config, opts),
  },

  grok: {
    id: 'grok',
    label: getRoute('grok').label,
    async install(opts) {
      installGrokPlugin({ dryRun: !!opts.dryRun, skip: !!opts.skipGrokPlugin })
      const paths = grokInstallPaths(opts.scope ?? 'user')
      const files = [paths.config, paths.rule, ...await installSkillBundle('grok', paths.skill, opts)]
      let toml = await readTextFile(paths.config)
      toml = upsertTomlSection(toml, MCP_SERVER_ID, tomlMcpBlock())
      toml = removeMarkedTomlSection(toml, 'permission')
      toml = stripLegacySearchBoostPermission(toml)
      if (opts.autoAllow && !grokAlwaysApproveMode(toml)) {
        toml = injectMarkedTomlSection(toml, 'permission', grokPermissionTomlBlock())
      }
      // Grok ignores stdout for passive hooks, including SessionStart.
      const rule = `${await loadStartupSearchPolicy()}\n\n${await loadAgentPrompt('grok')}`
      if (!opts.dryRun) {
        await writeTextFile(paths.config, `${toml.trim()}\n`)
        await writeTextFile(paths.rule, `${rule.trim()}\n`)
      }
      return files
    },
    async uninstall(opts) {
      for (const scope of grokUninstallScopes(opts.scope ?? 'user')) {
        if (!grokScopeHasArtifacts(scope)) continue
        const paths = grokInstallPaths(scope)
        await uninstallSkillBundle('grok', paths.skill, opts)
        const configExisted = existsSync(paths.config)
        let toml = configExisted ? await readTextFile(paths.config) : ''
        toml = removeTomlSection(toml, MCP_SERVER_ID)
        toml = removeMarkedTomlSection(toml, 'permission')
        toml = stripLegacySearchBoostPermission(toml)
        if (!opts.dryRun) {
          const trimmed = toml.trim()
          if (trimmed) {
            await writeTextFile(paths.config, `${trimmed}\n`)
          } else if (configExisted) {
            await removeFileIfExists(paths.config)
          }
          await removeFileIfExists(paths.rule)
        }
      }
      uninstallGrokPlugin({ dryRun: !!opts.dryRun, skip: !!opts.skipGrokPlugin })
    },
    printConfig: (opts) =>
      formatPrintConfig('grok', grokInstallPaths(opts.scope ?? 'user').config, opts),
  },

  antigravity: {
    id: 'antigravity',
    label: getRoute('antigravity').label,
    async install(opts) {
      const mcpPath = preferredAntigravityMcpPath()
      const files = [
        mcpPath, PATHS.antigravity.agents, PATHS.antigravity.gemini,
        ...await installSkillBundle('antigravity', PATHS.antigravity.skill, opts),
        ...await installStartupHook(PATHS.antigravity, { dryRun: !!opts.dryRun, kind: 'antigravity' }),
      ]
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
      }
      const wsFiles = await installAntigravityWorkspace(opts)
      files.push(...wsFiles)
      return files
    },
    async uninstall(opts) {
      await uninstallSkillBundle('antigravity', PATHS.antigravity.skill, opts)
      await uninstallStartupHook(PATHS.antigravity, { dryRun: !!opts.dryRun, kind: 'antigravity' })
      for (const mcpPath of antigravityMcpPaths()) {
        await removeMcpServer(mcpPath, MCP_SERVER_ID, !!opts.dryRun)
      }
      await removeAntigravityPermissions(!!opts.dryRun)
      if (!opts.dryRun) {
        if (existsSync(PATHS.antigravity.agents)) {
          await removeAgentsBlock(PATHS.antigravity.agents)
        }
        if (existsSync(PATHS.antigravity.gemini)) {
          await removeGeminiSnippetBlock(PATHS.antigravity.gemini)
        }
      }
      await uninstallAntigravityWorkspace(opts)
    },
    printConfig: (opts) => formatPrintConfig('antigravity', preferredAntigravityMcpPath(), opts),
  },

  // Host-runtime agents: no MCP entry — the adapter runs inside the host process.
  pi: {
    id: 'pi',
    label: getRoute('pi').label,
    async install(opts) {
      return installPiExtension({ dryRun: !!opts.dryRun })
    },
    async uninstall(opts) {
      await uninstallPiExtension({ dryRun: !!opts.dryRun })
    },
    printConfig: () => formatPiPrintConfig(),
  },

  dsh: {
    id: 'dsh',
    label: getRoute('dsh').label,
    async install(opts) {
      return installDshBundle({ dryRun: !!opts.dryRun, profile: opts.profile })
    },
    async uninstall(opts) {
      await uninstallDshBundle({ dryRun: !!opts.dryRun, profile: opts.profile })
    },
    printConfig: (opts) => formatDshPrintConfig(opts?.profile),
  },
}

export const AGENT_IDS = Object.keys(AGENTS)

export { removeClaudePermissions }

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
