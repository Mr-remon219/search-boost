/** Startup context for MCP hosts (respects host hook-disable settings and trust). */
import { readFile, unlink } from 'node:fs/promises'
import { STARTUP_SEARCH_POLICY, SESSION_START_SCRIPT, hooksScriptPath } from '../agents/router.mjs'
import { jsonDeepEqual, writeJsonFile, writeTextFile } from './json-config.mjs'
import { buildSessionStartCommand, isSearchBoostHook } from './hooks-config.mjs'
import { resolveSystemNode } from './system-node.mjs'

export const STARTUP_HOOK_KEY = 'search-boost-reminder'
const SCRIPT_MARKER = 'search-boost: startup-hook'
const POLICY_MARKER = 'search-boost: startup-policy'

export async function loadStartupSearchPolicy() {
  return (await readFile(STARTUP_SEARCH_POLICY, 'utf8')).trim()
}

async function readOptional(path) {
  try { return await readFile(path, 'utf8') } catch (err) {
    if (err.code === 'ENOENT') return null
    throw err
  }
}

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

// Do not turn a malformed user config into an empty config and overwrite it.
async function readConfig(path, kind) {
  const raw = await readOptional(path)
  const config = raw === null ? {} : JSON.parse(raw)
  if (!object(config)) throw new Error(`Invalid hook config: ${path}`)
  if (kind === 'session') {
    if (config.hooks !== undefined && !object(config.hooks)) throw new Error(`Invalid hooks: ${path}`)
    if (config.hooks?.SessionStart !== undefined && !Array.isArray(config.hooks.SessionStart)) {
      throw new Error(`Invalid SessionStart hooks: ${path}`)
    }
  }
  return config
}

function ownedHandler(handler, paths) {
  return handler?.type === 'command' && typeof handler.command === 'string'
    && isSearchBoostHook(handler.command, paths.hookScript)
}

function stripSessionHook(groups, paths) {
  return groups.flatMap((group) => {
    if (!Array.isArray(group?.hooks)) return [group]
    const hooks = group.hooks.filter((hook) => !ownedHandler(hook, paths))
    if (hooks.length === group.hooks.length) return [group]
    return hooks.length ? [{ ...group, hooks }] : []
  })
}

function ownedAntigravityEntry(entry, paths) {
  return Array.isArray(entry?.PreInvocation) && entry.PreInvocation.some((h) =>
    ownedHandler(h, paths)
    // Legacy workspace install used a customization-directory-relative command.
    || h?.command === 'node ./hooks/search-boost-pre-invocation.mjs')
}

async function checkOwnedAsset(path, marker, legacy = false) {
  const current = await readOptional(path)
  if (current !== null && !current.includes(marker)
    && !(legacy && current.includes('Antigravity PreInvocation hook'))) {
    throw new Error(`Refusing to overwrite non-search-boost hook asset: ${path}`)
  }
}

/** paths: { hooks, hookScript, hookInject }; kind: session | antigravity */
export async function installStartupHook(paths, { dryRun = false, kind = 'session' } = {}) {
  const config = await readConfig(paths.hooks, kind)
  const before = structuredClone(config)
  const handler = {
    type: 'command',
    command: buildSessionStartCommand(resolveSystemNode(), paths.hookScript),
    timeout: 5,
  }
  if (kind === 'antigravity') {
    const prior = config[STARTUP_HOOK_KEY]
    if (prior !== undefined && !ownedAntigravityEntry(prior, paths)) {
      throw new Error(`Hook name already in use: ${paths.hooks} (${STARTUP_HOOK_KEY})`)
    }
    // Preserve a user's disabled state and any other event handlers in this entry.
    config[STARTUP_HOOK_KEY] = {
      ...prior,
      enabled: prior?.enabled ?? true,
      PreInvocation: [
        ...(prior?.PreInvocation ?? []).filter((h) => !ownedHandler(h, paths)
          && h?.command !== 'node ./hooks/search-boost-pre-invocation.mjs'),
        handler,
      ],
    }
  } else {
    config.hooks ??= {}
    config.hooks.SessionStart = [
      ...stripSessionHook(config.hooks.SessionStart ?? [], paths),
      { hooks: [handler] }, // No matcher: startup, resume, clear, compact, future sources.
    ]
  }
  await checkOwnedAsset(paths.hookScript, SCRIPT_MARKER, kind === 'antigravity')
  await checkOwnedAsset(paths.hookInject, POLICY_MARKER)
  const script = await readFile(kind === 'antigravity' ? hooksScriptPath('antigravity') : SESSION_START_SCRIPT, 'utf8')
  const policy = await loadStartupSearchPolicy()
  if (!dryRun) {
    await writeTextFile(paths.hookScript, script)
    await writeTextFile(paths.hookInject, `${policy}\n`)
    if (!jsonDeepEqual(before, config)) await writeJsonFile(paths.hooks, config)
  }
  return [paths.hooks, paths.hookScript, paths.hookInject]
}

export async function uninstallStartupHook(paths, { dryRun = false, kind = 'session' } = {}) {
  const config = await readConfig(paths.hooks, kind)
  const before = structuredClone(config)
  if (kind === 'antigravity') {
    const entry = config[STARTUP_HOOK_KEY]
    if (ownedAntigravityEntry(entry, paths)) {
      entry.PreInvocation = entry.PreInvocation.filter((h) => !ownedHandler(h, paths)
        && h?.command !== 'node ./hooks/search-boost-pre-invocation.mjs')
      if (!entry.PreInvocation.length) delete entry.PreInvocation
      if (Object.keys(entry).every((key) => key === 'enabled')) delete config[STARTUP_HOOK_KEY]
    }
  } else if (Array.isArray(config.hooks?.SessionStart)) {
    const next = stripSessionHook(config.hooks.SessionStart, paths)
    if (!jsonDeepEqual(next, config.hooks.SessionStart)) {
      config.hooks.SessionStart = next
      if (!next.length) delete config.hooks.SessionStart
      if (!Object.keys(config.hooks).length) delete config.hooks
    }
  }
  if (dryRun) return
  if (!jsonDeepEqual(before, config)) {
    if (Object.keys(config).length) await writeJsonFile(paths.hooks, config)
    else await unlink(paths.hooks)
  }
  for (const [path, marker] of [[paths.hookScript, SCRIPT_MARKER], [paths.hookInject, POLICY_MARKER]]) {
    const text = await readOptional(path)
    if (text?.includes(marker)
      || (kind === 'antigravity' && path === paths.hookScript && text?.includes('Antigravity PreInvocation hook'))) {
      await unlink(path)
    }
  }
}
