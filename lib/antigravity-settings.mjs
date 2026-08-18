/**
 * Antigravity settings.json helpers — permission allow lists.
 * Scoped to search-boost install/uninstall/doctor (not a full settings parser).
 */

const WILDCARD = 'mcp(search-boost/*)'
const GRANULAR_PREFIX = 'mcp(search-boost/'

/** @param {string} p */
export function isSearchBoostPermission(p) {
  return typeof p === 'string' && p.startsWith('mcp(search-boost')
}

/**
 * @param {string[]} allow
 * @returns {{ wildcard: number, granular: number, total: number }}
 */
export function countSearchBoostPermissions(allow) {
  let wildcard = 0
  let granular = 0
  for (const p of allow) {
    if (p === WILDCARD) wildcard++
    else if (typeof p === 'string' && p.startsWith(GRANULAR_PREFIX)) granular++
  }
  return { wildcard, granular, total: wildcard + granular }
}

/** Wildcard plus granular tool entries — granular adds no value when wildcard present. */
export function permissionsRedundant(allow) {
  const { wildcard, granular } = countSearchBoostPermissions(allow)
  return wildcard > 0 && granular > 0
}

/** @param {string[]} allow */
export function stripSearchBoostPermissions(allow) {
  return allow.filter((p) => !isSearchBoostPermission(p))
}

/** Collapsed allow list for reinstall (--auto-allow). */
export function preferredPermissions() {
  return [WILDCARD]
}
