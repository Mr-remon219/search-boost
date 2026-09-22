import { prunePermissions, stripAllowList } from './json-config.mjs'

const WILDCARD_PERM = 'mcp(search-boost/*)'
const GRANULAR_PERM_PREFIX = 'mcp(search-boost/'

/** @param {unknown} perm */
function isSearchBoostPerm(perm) {
  return typeof perm === 'string' && perm.startsWith('mcp(search-boost')
}

/**
 * Count search-boost allow entries by shape (wildcard vs per-tool granular).
 * @param {unknown} allow
 * @returns {{ wildcard: number, granular: number, total: number }}
 */
export function countSearchBoostPermissions(allow) {
  let wildcard = 0
  let granular = 0
  for (const perm of Array.isArray(allow) ? allow : []) {
    if (perm === WILDCARD_PERM) wildcard++
    else if (typeof perm === 'string' && perm.startsWith(GRANULAR_PERM_PREFIX)) granular++
  }
  return { wildcard, granular, total: wildcard + granular }
}

/** Wildcard plus granular tool entries — granular adds nothing when wildcard present. */
export function permissionsRedundant(allow) {
  const { wildcard, granular } = countSearchBoostPermissions(allow)
  return wildcard > 0 && granular > 0
}

/**
 * Remove search-boost MCP allow entries and prune empty permission objects.
 * @param {Record<string, unknown>} settings
 */
export function stripSearchBoostPermissions(settings) {
  if (!Array.isArray(settings.permissions?.allow)) return settings
  const next = { ...settings, permissions: { ...settings.permissions } }
  next.permissions.allow = stripAllowList(next.permissions.allow, isSearchBoostPerm)
  return prunePermissions(next)
}
