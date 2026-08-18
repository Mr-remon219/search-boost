import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, normalize, resolve } from 'node:path'
import { jsonDeepEqual, readJsonFile, writeJsonFile, writeJsonOrUnlink } from './json-config.mjs'
import { CURSOR_HOOK_SCRIPT_NAME } from '../agents/router.mjs'
import { recordCursorCreatedFile, forgetCursorCreatedFile } from './cursor-install-state.mjs'

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

/** @returns {string} */
export function defaultSearchBoostHookScriptPath() {
  return join(homedir(), '.cursor', 'hooks', CURSOR_HOOK_SCRIPT_NAME)
}

/**
 * @param {string} p
 * @returns {string}
 */
function normalizeHookPath(p) {
  const expanded = p.startsWith('~/')
    ? join(homedir(), p.slice(2))
    : p.startsWith('~\\')
      ? join(homedir(), p.slice(2))
      : p
  return resolve(normalize(expanded.replace(/\\/g, '/')))
}

/**
 * @param {string} command
 * @returns {string|null}
 */
function extractScriptPathFromCommand(command) {
  const quoted = [...command.matchAll(/"([^"]+)"/g)]
  if (quoted.length >= 2) return quoted[quoted.length - 1][1]
  if (quoted.length === 1) return quoted[0][1]
  const parts = command.trim().split(/\s+/)
  const last = parts[parts.length - 1]
  return last ? last.replace(/^"|"$/g, '') : null
}

/**
 * @param {string} command
 * @param {string} [hookScriptPath]
 * @returns {boolean}
 */
export function isSearchBoostHook(command, hookScriptPath = defaultSearchBoostHookScriptPath()) {
  const scriptInCommand = extractScriptPathFromCommand(command)
  if (!scriptInCommand) return false
  return normalizeHookPath(scriptInCommand) === normalizeHookPath(hookScriptPath)
}

/**
 * @param {unknown} entry
 * @returns {entry is HookEntry}
 */
function isHookEntry(entry) {
  return !!entry && typeof entry === 'object' && typeof /** @type {HookEntry} */ (entry).command === 'string'
}

/**
 * @param {string} hooksPath
 * @param {string} command
 * @param {boolean} dryRun
 * @param {string} [hookScriptPath]
 */
export async function upsertSessionStartHook(hooksPath, command, dryRun, hookScriptPath) {
  /** @type {{ version?: number, hooks?: Record<string, HookEntry[]> }} */
  const cfg = await readJsonFile(hooksPath, { version: 1, hooks: {} })
  cfg.hooks ??= {}
  cfg.version ??= 1

  const list = Array.isArray(cfg.hooks.sessionStart) ? [...cfg.hooks.sessionStart] : []
  const idx = list.findIndex((e) => isHookEntry(e) && isSearchBoostHook(e.command, hookScriptPath))
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
    if (action === 'created') await recordCursorCreatedFile(hooksPath, dryRun)
  }
  return { path: hooksPath, action }
}

/**
 * @param {string} hooksPath
 * @param {boolean} dryRun
 * @param {string} [hookScriptPath]
 */
export async function removeSessionStartHook(hooksPath, dryRun, hookScriptPath) {
  if (!existsSync(hooksPath)) return { path: hooksPath, action: 'not-found' }
  /** @type {{ version?: number, hooks?: Record<string, HookEntry[]> }} */
  const cfg = await readJsonFile(hooksPath, { version: 1, hooks: {} })
  if (!Array.isArray(cfg.hooks?.sessionStart)) return { path: hooksPath, action: 'not-found' }

  const before = cfg.hooks.sessionStart.length
  cfg.hooks.sessionStart = cfg.hooks.sessionStart.filter(
    (e) => !(isHookEntry(e) && isSearchBoostHook(e.command, hookScriptPath)),
  )
  if (cfg.hooks.sessionStart.length === before) {
    return { path: hooksPath, action: 'not-found' }
  }
  if (cfg.hooks.sessionStart.length === 0) delete cfg.hooks.sessionStart
  if (cfg.hooks && Object.keys(cfg.hooks).length === 0) delete cfg.hooks

  if (!dryRun) {
    await writeJsonOrUnlink(hooksPath, cfg, dryRun)
    await forgetCursorCreatedFile(hooksPath, dryRun)
  }
  return { path: hooksPath, action: 'removed' }
}
