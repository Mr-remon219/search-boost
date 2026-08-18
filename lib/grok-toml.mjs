/**
 * Grok config.toml helpers — permission blocks and [ui] permission_mode.
 * Scoped to search-boost install/uninstall/doctor (not a full TOML parser).
 */
import { grokPermissionAllows } from './mcp-entry.mjs'

const PERMISSION_HEADER = '[permission]'
const SEARCH_BOOST_TOOL = 'MCPTool(search-boost__'

/** @param {string} body — [permission] body without header */
function isEmptyPermissionBody(body) {
  const trimmed = body.trim()
  if (!trimmed) return true
  const allow = trimmed.match(/allow\s*=\s*\[([\s\S]*?)\]/m)
  if (!allow) return false
  return allow[1].trim() === ''
}

/** @param {string} toml */
function permissionSectionRe() {
  return /(?:^|\n)\[permission\][\s\S]*?(?=\n\[[^\]]+\]|$)/g
}

const MARKED_PERMISSION_START = '# SEARCH_BOOST_permission_START'
const MARKED_PERMISSION_END = '# SEARCH_BOOST_permission_END'

/** True when block index falls inside a marked permission region (marker may precede [permission]). */
function inMarkedPermissionRegion(toml, blockIndex) {
  const start = toml.indexOf(MARKED_PERMISSION_START)
  if (start < 0) return false
  const end = toml.indexOf(MARKED_PERMISSION_END, start)
  if (end < 0) return false
  return blockIndex >= start && blockIndex <= end + MARKED_PERMISSION_END.length
}

/** @param {string} toml */
export function countPermissionSections(toml) {
  return (toml.match(/^(\[permission\])/gm) || []).length
}

/**
 * Remove unmarked [permission] blocks whose allow list includes search-boost MCP tools.
 * Marked blocks are removed separately via removeMarkedTomlSection.
 * @param {string} toml
 */
export function stripLegacySearchBoostPermission(toml) {
  if (!toml.includes(PERMISSION_HEADER)) return toml
  let changed = false
  const next = toml.replace(permissionSectionRe(), (block) => {
    if (block.includes('SEARCH_BOOST_permission_START')) return block
    if (!block.includes(SEARCH_BOOST_TOOL)) return block
    const lines = block.split('\n')
    const filtered = lines.filter((line) => {
      if (line.includes(SEARCH_BOOST_TOOL)) {
        changed = true
        return false
      }
      return true
    })
    const body = filtered.join('\n').replace(/^\[permission\]\s*\n?/, '')
    if (isEmptyPermissionBody(body)) {
      changed = true
      return ''
    }
    if (filtered.length !== lines.length) changed = true
    return filtered.join('\n')
  })
  if (!changed) return toml
  return next.replace(/\n{3,}/g, '\n\n').trimEnd()
}

/**
 * True when [ui] permission_mode is always-approve (or Claude-compatible bypassPermissions).
 * Legacy yolo=true is treated the same way.
 * @param {string} toml
 */
export function grokAlwaysApproveMode(toml) {
  const ui = toml.match(/(?:^|\n)\[ui\][\s\S]*?(?=\n\[[^\]]+\]|$)/)
  if (!ui) return false
  const body = ui[0]
  const mode = body.match(/permission_mode\s*=\s*["']?([^"'\n]+)["']?/i)?.[1]?.trim().toLowerCase()
  if (mode === 'always-approve' || mode === 'bypasspermissions') return true
  const yolo = body.match(/^\s*yolo\s*=\s*(true)/im)
  return !!yolo
}

/** @param {string} toml */
export function hasMarkedSearchBoostPermission(toml) {
  return toml.includes('SEARCH_BOOST_permission_START')
}

/**
 * True when an unmarked [permission] block contains our MCP allow patterns.
 * @param {string} toml
 */
export function hasLegacySearchBoostPermission(toml) {
  const re = permissionSectionRe()
  let match
  while ((match = re.exec(toml)) !== null) {
    const block = match[0]
    if (block.includes('SEARCH_BOOST_permission_START')) continue
    if (inMarkedPermissionRegion(toml, match.index)) continue
    if (block.includes(SEARCH_BOOST_TOOL)) return true
  }
  return false
}

/** @param {string} toml — warn when marked block exists but always-approve makes it redundant */
export function grokPermissionBlockRedundant(toml) {
  return grokAlwaysApproveMode(toml)
    && (hasMarkedSearchBoostPermission(toml) || hasLegacySearchBoostPermission(toml))
}

/** All MCPTool(search-boost__*) patterns we inject. */
export function searchBoostPermissionPatterns() {
  return grokPermissionAllows()
}
