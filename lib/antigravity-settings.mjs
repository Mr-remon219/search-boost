import { prunePermissions, stripAllowList } from './json-config.mjs'

/** @param {unknown} perm */
function isSearchBoostPerm(perm) {
  return typeof perm === 'string' && perm.startsWith('mcp(search-boost')
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
