/**
 * Per-agent install / uninstall / print-config adapters.
 */
import { existsSync } from 'node:fs'
import { dirname } from 'node:path'
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
  grokInstallPaths,
  grokScopeHasArtifacts,
  grokUninstallScopes,
  PATHS,
} from '../paths.mjs'
import {
  injectAgentsFile,
  injectOpenaiYaml,
  injectSkill,
  loadAgentPrompt,
  removeAgentsBlock,
  removeEmptyDirIfExists,
  removeEmptyFileIfExists,
  removeFileIfExists,
  removeSkillIfOwned,
} from './shared.mjs'
import { installCursorSurface, uninstallCursorSurface } from './cursor-family.mjs'
import { getRoute } from '../../agents/router.mjs'
import { applyClaudeNativeSettings, applyCodexNativeToml, migrateLegacyClaudeNativeDeny, noteClaudePreExistingWebSearchDeny } from '../native-search.mjs'
import { stripMarkedWebSearchFromMcpToml, writeCodexConfigOrUnlink } from '../codex-toml.mjs'

/**
 * @typedef {{
 *   dryRun?: boolean,
 *   autoAllow?: boolean,
 *   replaceNative?: boolean,
 *   mergeCursorCli?: boolean,
 *   scope?: 'user'|'project',
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
      toml = stripMarkedWebSearchFromMcpToml(toml, MCP_SERVER_ID)
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
      toml = applyCodexNativeToml(toml, false)
      if (!opts.dryRun) {
        await writeCodexConfigOrUnlink(PATHS.codex.config, toml)
        if (existsSync(PATHS.codex.agents)) {
          await removeAgentsBlock(PATHS.codex.agents)
        }
        await removeSkillIfOwned(PATHS.codex.skill)
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
      if (!opts.dryRun) {
        const settings = await readJsonFile(PATHS.claude.settings, {})
        const noted = noteClaudePreExistingWebSearchDeny(settings)
        if (!jsonDeepEqual(settings, noted)) await writeJsonFile(PATHS.claude.settings, noted)
      }
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
        await removeEmptyFileIfExists(PATHS.claude.agents)
        await removeFileIfExists(PATHS.claude.skill)
        await removeEmptyDirIfExists(dirname(PATHS.claude.skill))
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
        if (!grokScopeHasArtifacts(scope)) continue
        const paths = grokInstallPaths(scope)
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
          await removeFileIfExists(paths.skill)
        }
      }
      uninstallGrokPlugin({ dryRun: !!opts.dryRun, skip: !!opts.skipGrokPlugin })
    },
    printConfig: (opts) =>
      formatPrintConfig('grok', grokInstallPaths(opts.scope ?? 'user').config, opts),
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
