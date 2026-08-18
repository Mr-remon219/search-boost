import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { jsonDeepEqual, prunePermissions, readJsonFile, writeJsonFile, writeJsonOrUnlink } from './json-config.mjs'
import { recordCursorCreatedFile, forgetCursorCreatedFile } from './cursor-install-state.mjs'

export const CURSOR_CLI_MCP_ALLOW = 'Mcp(search-boost:*)'
const SEARCH_BOOST_META_KEY = '_searchBoost'

/**
 * @param {Record<string, unknown>} cfg
 * @returns {string[]}
 */
function ownedAllows(cfg) {
  const meta = /** @type {{ ownedAllows?: string[] }|undefined} */ (cfg[SEARCH_BOOST_META_KEY])
  return Array.isArray(meta?.ownedAllows) ? meta.ownedAllows : []
}

/**
 * @param {Record<string, unknown>} cfg
 * @param {string[]} next
 */
function setOwnedAllows(cfg, next) {
  if (next.length === 0) {
    if (cfg[SEARCH_BOOST_META_KEY]) {
      const meta = { .../** @type {Record<string, unknown>} */ (cfg[SEARCH_BOOST_META_KEY]) }
      delete meta.ownedAllows
      if (Object.keys(meta).length === 0) delete cfg[SEARCH_BOOST_META_KEY]
      else cfg[SEARCH_BOOST_META_KEY] = meta
    }
    return
  }
  cfg[SEARCH_BOOST_META_KEY] = {
    .../** @type {Record<string, unknown>} */ (cfg[SEARCH_BOOST_META_KEY] ?? {}),
    ownedAllows: next,
  }
}

/**
 * @param {string} configPath
 * @param {string} permission
 * @param {boolean} dryRun
 */
export async function mergeCliPermissionAllow(configPath, permission, dryRun) {
  /** @type {{ permissions?: { allow?: string[], deny?: string[] } }} */
  const cfg = await readJsonFile(configPath, {})
  cfg.permissions ??= {}
  cfg.permissions.allow ??= []
  const before = [...cfg.permissions.allow]
  const owned = ownedAllows(cfg)
  const alreadyPresent = cfg.permissions.allow.includes(permission)
  if (!alreadyPresent) {
    cfg.permissions.allow.push(permission)
    if (!owned.includes(permission)) {
      setOwnedAllows(cfg, [...owned, permission])
    }
  }
  if (jsonDeepEqual(before, cfg.permissions.allow) && (alreadyPresent || owned.includes(permission))) {
    return { path: configPath, action: 'unchanged' }
  }
  const action = existsSync(configPath) ? 'updated' : 'created'
  if (!dryRun) {
    await mkdir(dirname(configPath), { recursive: true })
    await writeJsonFile(configPath, cfg)
    if (action === 'created') await recordCursorCreatedFile(configPath, dryRun)
  }
  return { path: configPath, action }
}

/**
 * @param {string} configPath
 * @param {string} permission
 * @param {boolean} dryRun
 */
export async function removeCliPermissionAllow(configPath, permission, dryRun) {
  if (!existsSync(configPath)) return { path: configPath, action: 'not-found' }
  /** @type {{ permissions?: { allow?: string[] } }} */
  const cfg = await readJsonFile(configPath, {})
  if (!Array.isArray(cfg.permissions?.allow)) return { path: configPath, action: 'not-found' }

  const owned = ownedAllows(cfg)
  if (!owned.includes(permission)) {
    return { path: configPath, action: 'not-found' }
  }

  cfg.permissions.allow = cfg.permissions.allow.filter((p) => p !== permission)
  setOwnedAllows(cfg, owned.filter((p) => p !== permission))
  if (cfg.permissions.allow.length === 0) delete cfg.permissions.allow
  prunePermissions(cfg)

  if (!dryRun) {
    await writeJsonOrUnlink(configPath, cfg, dryRun)
    await forgetCursorCreatedFile(configPath, dryRun)
  }
  return { path: configPath, action: 'removed' }
}
