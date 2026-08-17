import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { jsonDeepEqual, readJsonFile, writeJsonFile } from './json-config.mjs'
import { CURSOR_HOOK_COMMAND_MARKER } from '../agents/router.mjs'

/** @typedef {{ command: string, timeout?: number }} HookEntry */

/**
 * Build the sessionStart hook command for search-boost.
 * @param {string} nodeExe
 * @param {string} scriptPath Absolute path to search-boost-session.mjs
 */
export function buildSessionStartCommand(nodeExe, scriptPath) {
  const node = nodeExe.replace(/\\/g, '/')
  const script = scriptPath.replace(/\\/g, '/')
  if (/[\s"]/.test(node)) return `"${node}" "${script}"`
  return `${node} "${script}"`
}

/**
 * @param {unknown} entry
 * @returns {entry is HookEntry}
 */
function isHookEntry(entry) {
  return !!entry && typeof entry === 'object' && typeof /** @type {HookEntry} */ (entry).command === 'string'
}

/**
 * @param {string} command
 * @returns {boolean}
 */
export function isSearchBoostHook(command) {
  return command.includes(CURSOR_HOOK_COMMAND_MARKER)
}

/**
 * @param {string} hooksPath
 * @param {string} command
 * @param {boolean} dryRun
 */
export async function upsertSessionStartHook(hooksPath, command, dryRun) {
  /** @type {{ version?: number, hooks?: Record<string, HookEntry[]> }} */
  const cfg = await readJsonFile(hooksPath, { version: 1, hooks: {} })
  cfg.hooks ??= {}
  cfg.version ??= 1

  const list = Array.isArray(cfg.hooks.sessionStart) ? [...cfg.hooks.sessionStart] : []
  const idx = list.findIndex((e) => isHookEntry(e) && isSearchBoostHook(e.command))
  const entry = { command, timeout: 10 }
  const next = idx >= 0
    ? list.map((e, i) => (i === idx ? entry : e))
    : [...list, entry]

  if (jsonDeepEqual(cfg.hooks.sessionStart, next)) {
    return { path: hooksPath, action: 'unchanged' }
  }

  cfg.hooks.sessionStart = next
  const action = existsSync(hooksPath) ? 'updated' : 'created'
  if (!dryRun) {
    await mkdir(dirname(hooksPath), { recursive: true })
    await writeJsonFile(hooksPath, cfg)
  }
  return { path: hooksPath, action }
}

/**
 * @param {string} hooksPath
 * @param {boolean} dryRun
 */
export async function removeSessionStartHook(hooksPath, dryRun) {
  if (!existsSync(hooksPath)) return { path: hooksPath, action: 'not-found' }
  /** @type {{ version?: number, hooks?: Record<string, HookEntry[]> }} */
  const cfg = await readJsonFile(hooksPath, { version: 1, hooks: {} })
  if (!Array.isArray(cfg.hooks?.sessionStart)) return { path: hooksPath, action: 'not-found' }

  const before = cfg.hooks.sessionStart.length
  cfg.hooks.sessionStart = cfg.hooks.sessionStart.filter(
    (e) => !(isHookEntry(e) && isSearchBoostHook(e.command)),
  )
  if (cfg.hooks.sessionStart.length === before) {
    return { path: hooksPath, action: 'not-found' }
  }
  if (cfg.hooks.sessionStart.length === 0) delete cfg.hooks.sessionStart
  if (cfg.hooks && Object.keys(cfg.hooks).length === 0) delete cfg.hooks

  if (!dryRun) await writeJsonFile(hooksPath, cfg)
  return { path: hooksPath, action: 'removed' }
}
