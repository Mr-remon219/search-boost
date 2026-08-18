import { existsSync } from 'node:fs'
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/** @param {unknown} a @param {unknown} b */
export function jsonDeepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b)
}

/**
 * Replace our previous allow entries, then append `want` (deduped).
 * @param {string[]} allow
 * @param {string[]} want
 * @param {(p: string) => boolean} isOurs
 */
export function upsertAllowList(allow, want, isOurs) {
  const next = allow.filter((p) => !isOurs(p))
  for (const perm of want) {
    if (!next.includes(perm)) next.push(perm)
  }
  return next
}

/** @param {string[]} allow @param {(p: string) => boolean} isOurs */
export function stripAllowList(allow, isOurs) {
  return allow.filter((p) => !isOurs(p))
}

/** Drop empty allow/deny/permissions objects. */
export function prunePermissions(settings) {
  if (!settings.permissions) return settings
  if (Array.isArray(settings.permissions.allow) && settings.permissions.allow.length === 0) {
    delete settings.permissions.allow
  }
  if (Array.isArray(settings.permissions.deny) && settings.permissions.deny.length === 0) {
    delete settings.permissions.deny
  }
  if (Object.keys(settings.permissions).length === 0) delete settings.permissions
  return settings
}

/** @param {string} path @param {unknown} fallback */
export async function readJsonFile(path, fallback) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return fallback
  }
}

/** @param {string} path @param {unknown} obj */
export async function writeJsonFile(path, obj) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(obj, null, 2)}\n`, 'utf8')
}

/** True when a JSON config object has no meaningful content left. */
export function isJsonConfigEmpty(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return true
  const keys = Object.keys(obj).filter((k) => k !== '_searchBoost')
  if (keys.length === 0) return true
  if (keys.length === 1 && keys[0] === 'mcpServers') {
    const servers = /** @type {{ mcpServers?: Record<string, unknown> }} */ (obj).mcpServers
    return !servers || Object.keys(servers).length === 0
  }
  if (keys.length === 1 && keys[0] === 'permissions') {
    const perms = /** @type {{ permissions?: Record<string, unknown> }} */ (obj).permissions
    return !perms || Object.keys(perms).length === 0
  }
  if (keys.every((k) => k === 'version' || k === 'hooks')) {
    const hooks = /** @type {{ hooks?: Record<string, unknown> }} */ (obj).hooks
    return !hooks || Object.keys(hooks).length === 0
  }
  return false
}

/**
 * Write JSON config or unlink the file when empty (best-effort).
 * @param {string} path
 * @param {Record<string, unknown>} obj
 * @param {boolean} [dryRun]
 */
export async function writeJsonOrUnlink(path, obj, dryRun = false) {
  if (isJsonConfigEmpty(obj)) {
    if (!dryRun && existsSync(path)) {
      try {
        await unlink(path)
      } catch { /* best effort */ }
    }
    return { path, action: 'removed' }
  }
  if (!dryRun) await writeJsonFile(path, obj)
  return { path, action: 'updated' }
}

/** @param {string} path */
export async function readTextFile(path) {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return ''
  }
}

/** @param {string} path @param {string} content */
export async function writeTextFile(path, content) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content, 'utf8')
}

/**
 * @param {string} path
 * @param {string} serverId
 * @param {Record<string, unknown>} entry
 * @param {boolean} dryRun
 */
export async function upsertMcpServer(path, serverId, entry, dryRun) {
  const existing = await readJsonFile(path, { mcpServers: {} })
  existing.mcpServers ??= {}
  const before = existing.mcpServers[serverId]
  if (jsonDeepEqual(before, entry)) {
    return { path, action: 'unchanged' }
  }
  const action = before ? 'updated' : (existsSync(path) ? 'updated' : 'created')
  if (!dryRun) {
    existing.mcpServers[serverId] = entry
    await writeJsonFile(path, existing)
  }
  return { path, action }
}

/**
 * @param {string} path
 * @param {string} serverId
 * @param {boolean} dryRun
 */
export async function removeMcpServer(path, serverId, dryRun) {
  if (!existsSync(path)) return { path, action: 'not-found' }
  const existing = await readJsonFile(path, { mcpServers: {} })
  if (!existing.mcpServers?.[serverId]) return { path, action: 'not-found' }
  if (!dryRun) {
    delete existing.mcpServers[serverId]
    if (Object.keys(existing.mcpServers).length === 0) delete existing.mcpServers
    return writeJsonOrUnlink(path, existing, dryRun)
  }
  return { path, action: 'removed' }
}
