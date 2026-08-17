import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { jsonDeepEqual, readJsonFile, writeJsonFile } from './json-config.mjs'

export const CURSOR_CLI_MCP_ALLOW = 'Mcp(search-boost:*)'

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
  if (!cfg.permissions.allow.includes(permission)) {
    cfg.permissions.allow.push(permission)
  }
  if (jsonDeepEqual(before, cfg.permissions.allow)) {
    return { path: configPath, action: 'unchanged' }
  }
  const action = existsSync(configPath) ? 'updated' : 'created'
  if (!dryRun) {
    await mkdir(dirname(configPath), { recursive: true })
    await writeJsonFile(configPath, cfg)
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

  const before = cfg.permissions.allow.length
  cfg.permissions.allow = cfg.permissions.allow.filter((p) => p !== permission)
  if (cfg.permissions.allow.length === before) {
    return { path: configPath, action: 'not-found' }
  }
  if (cfg.permissions.allow.length === 0) delete cfg.permissions.allow
  if (cfg.permissions && Object.keys(cfg.permissions).length === 0) delete cfg.permissions

  if (!dryRun) await writeJsonFile(configPath, cfg)
  return { path: configPath, action: 'removed' }
}
