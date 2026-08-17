/**
 * Shared install / uninstall for Cursor IDE + Cursor CLI surfaces.
 */
import { copyFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { upsertMcpServer, removeMcpServer } from '../json-config.mjs'
import { CURSOR_CLI_MCP_ALLOW, mergeCliPermissionAllow, removeCliPermissionAllow } from '../cli-config.mjs'
import { buildSessionStartCommand, removeSessionStartHook, upsertSessionStartHook } from '../hooks-config.mjs'
import { jsonMcpEntry, MCP_SERVER_ID } from '../mcp-entry.mjs'
import { CURSOR_SURFACE } from '../paths.mjs'
import { getRoute, hookScriptPath } from '../../agents/router.mjs'
import {
  injectSkill,
  loadAgentPrompt,
  loadCursorMergedPrompt,
  removeAgentsBlock,
  removeFileIfExists,
} from './shared.mjs'
import { writeTextFile } from '../json-config.mjs'
import { resolveSystemNode } from '../system-node.mjs'

/**
 * @param {{ mergeCursorCli?: boolean, skillAgentId?: string }} opts
 */
async function loadHookInjectBody(opts) {
  if (opts.mergeCursorCli) return loadCursorMergedPrompt(true)
  const id = opts.skillAgentId ?? 'cursor'
  return loadAgentPrompt(id)
}

/** @param {string} routeId */
function cursorMcpEntry(routeId) {
  const route = getRoute(routeId)
  const entry = {
    ...jsonMcpEntry(),
    ...(route.mcp?.serverUseInstructions
      ? { serverUseInstructions: route.mcp.serverUseInstructions }
      : {}),
  }
  return entry
}

/**
 * @typedef {Object} CursorInstallOpts
 * @property {boolean} [dryRun]
 * @property {boolean} [autoAllow]
 * @property {boolean} [mergeCursorCli]
 * @property {string} [skillAgentId] cursor | cursor-cli
 */

/**
 * @param {CursorInstallOpts} opts
 * @returns {Promise<string[]>}
 */
export async function installCursorSurface(opts) {
  const files = []
  const skillId = opts.skillAgentId ?? (opts.mergeCursorCli ? 'cursor' : 'cursor')
  const routeId = skillId === 'cursor-cli' ? 'cursor-cli' : 'cursor'

  const mcpResult = await upsertMcpServer(
    CURSOR_SURFACE.mcp,
    MCP_SERVER_ID,
    cursorMcpEntry(routeId),
    !!opts.dryRun,
  )
  files.push(mcpResult.path)

  if (!opts.dryRun) {
    await injectSkill(skillId, CURSOR_SURFACE.skill)
  }
  files.push(CURSOR_SURFACE.skill)

  const injectBody = await loadHookInjectBody({
    mergeCursorCli: opts.mergeCursorCli,
    skillAgentId: skillId,
  })
  if (!opts.dryRun) {
    await mkdir(CURSOR_SURFACE.hookScript.replace(/[/\\][^/\\]+$/, ''), { recursive: true })
    await writeTextFile(CURSOR_SURFACE.hookInject, `${injectBody.trim()}\n`)
    await copyFile(hookScriptPath('cursor-cli'), CURSOR_SURFACE.hookScript)
  }
  files.push(CURSOR_SURFACE.hookInject, CURSOR_SURFACE.hookScript)

  const hookCmd = buildSessionStartCommand(resolveSystemNode(), CURSOR_SURFACE.hookScript)
  const hookResult = await upsertSessionStartHook(CURSOR_SURFACE.hooks, hookCmd, !!opts.dryRun)
  files.push(hookResult.path)

  if (opts.autoAllow) {
    const permResult = await mergeCliPermissionAllow(
      CURSOR_SURFACE.cliConfig,
      CURSOR_CLI_MCP_ALLOW,
      !!opts.dryRun,
    )
    files.push(permResult.path)
  }

  return files
}

/**
 * @param {{ dryRun?: boolean }} opts
 */
export async function uninstallCursorSurface(opts) {
  await removeMcpServer(CURSOR_SURFACE.mcp, MCP_SERVER_ID, !!opts.dryRun)
  if (!opts.dryRun) {
    await removeFileIfExists(CURSOR_SURFACE.skill)
    await removeFileIfExists(CURSOR_SURFACE.hookScript)
    await removeFileIfExists(CURSOR_SURFACE.hookInject)
    if (existsSync(CURSOR_SURFACE.agents)) {
      await removeAgentsBlock(CURSOR_SURFACE.agents)
    }
  }
  await removeSessionStartHook(CURSOR_SURFACE.hooks, !!opts.dryRun)
  await removeCliPermissionAllow(CURSOR_SURFACE.cliConfig, CURSOR_CLI_MCP_ALLOW, !!opts.dryRun)
}
