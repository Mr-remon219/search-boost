/**
 * Claude Code settings.json helpers — allow consolidation and bypass mode.
 * Scoped to search-boost install/uninstall/doctor (not a full settings parser).
 */
import { claudePermissions } from './mcp-entry.mjs'

const SEARCH_BOOST_ALLOW_PREFIX = 'mcp__search-boost__'
const WILDCARD = 'mcp__search-boost__*'

/** @param {unknown} p */
export function isSearchBoostAllow(p) {
  return typeof p === 'string' && p.startsWith(SEARCH_BOOST_ALLOW_PREFIX)
}

/**
 * Remove granular mcp__search-boost__* entries; keep wildcard if present.
 * @param {string[]} allow
 */
export function stripLegacySearchBoostAllow(allow) {
  if (!Array.isArray(allow)) return []
  return allow.filter((p) => !isSearchBoostAllow(p) || p === WILDCARD)
}

/**
 * Replace all search-boost allow entries with wildcard mcp__search-boost__*.
 * @param {string[]} allow
 */
export function consolidateSearchBoostAllow(allow) {
  const base = stripLegacySearchBoostAllow(allow ?? [])
  const hadOurs = (allow ?? []).some(isSearchBoostAllow)
  if (!hadOurs) return base
  const next = base.filter((p) => !isSearchBoostAllow(p))
  for (const perm of claudePermissions()) {
    if (!next.includes(perm)) next.push(perm)
  }
  return next
}

/**
 * True when settings use Claude bypassPermissions (Grok always-approve equivalent).
 * @param {Record<string, unknown>} settings
 */
export function claudeBypassPermissionsMode(settings) {
  if (!settings || typeof settings !== 'object') return false
  if (settings.bypassPermissions === true) return true
  const mode = settings.defaultMode ?? settings.permissions?.defaultMode
  if (typeof mode === 'string' && mode.toLowerCase() === 'bypasspermissions') return true
  return false
}

/** @param {string[]} allow */
export function countSearchBoostAllowEntries(allow) {
  if (!Array.isArray(allow)) return 0
  return allow.filter(isSearchBoostAllow).length
}

/**
 * Warn when allow list is redundant (duplicate entries or bypass mode makes it moot).
 * @param {Record<string, unknown>} settings
 */
export function allowRedundant(settings) {
  const allow = settings?.permissions?.allow
  const count = countSearchBoostAllowEntries(allow)
  if (count > 1) return true
  if (count >= 1 && claudeBypassPermissionsMode(settings)) return true
  return false
}

/** @param {string[]} allow */
export function hasLegacyGranularAllow(allow) {
  if (!Array.isArray(allow)) return false
  return allow.some((p) => isSearchBoostAllow(p) && p !== WILDCARD)
}
