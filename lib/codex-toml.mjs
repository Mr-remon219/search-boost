/**
 * Codex config.toml helpers — web_search marker cleanup scoped to MCP sections.
 * Not a full TOML parser; scoped to search-boost install/uninstall/doctor.
 */
import { unlink } from 'node:fs/promises'
import { removeMarked } from './inject.mjs'
import { CODEX_WEB_SEARCH_MARKER } from './native-search.mjs'
import { writeTextFile } from './json-config.mjs'

export const CODEX_WEB_SEARCH_SECTION_MARKER_START = `# ${CODEX_WEB_SEARCH_MARKER}`
export const CODEX_WEB_SEARCH_SECTION_MARKER_END = '# SEARCH_BOOST_WEB_SEARCH_END'

/** @param {string} s */
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** @param {string} serverId */
function mcpSectionRe(serverId) {
  return new RegExp(
    `(^|\\n)(\\[mcp_servers\\.${escapeRegExp(serverId)}\\][\\s\\S]*?)(?=\\n\\[|$)`,
  )
}

/**
 * Remove SEARCH_BOOST-marked web_search blocks from a section body only.
 * Bare `web_search = ...` lines (user config) are preserved.
 * @param {string} body
 */
export function stripWebSearchFromSectionBody(body) {
  if (!body.includes('SEARCH_BOOST_WEB_SEARCH')) return body
  return removeMarked(
    body,
    CODEX_WEB_SEARCH_SECTION_MARKER_START,
    CODEX_WEB_SEARCH_SECTION_MARKER_END,
  )
}

/**
 * Strip marked web_search blocks mistakenly placed inside [mcp_servers.*] only.
 * Top-level user web_search is never touched.
 * @param {string} toml
 * @param {string} serverId
 */
export function stripMarkedWebSearchFromMcpToml(toml, serverId) {
  if (!toml.includes(`[mcp_servers.${serverId}]`)) return toml
  return toml.replace(mcpSectionRe(serverId), (full, prefix, section) => {
    const nl = section.indexOf('\n')
    if (nl === -1) return prefix + section
    const header = section.slice(0, nl + 1)
    const body = section.slice(nl + 1)
    const cleaned = stripWebSearchFromSectionBody(body)
    if (cleaned === body) return prefix + section
    const trimmedBody = cleaned.trimEnd()
    return prefix + header + (trimmedBody ? `${trimmedBody}\n` : '')
  })
}

/**
 * Write config.toml or unlink when uninstall leaves nothing meaningful.
 * Avoids creating empty config files that did not exist before install.
 * @param {string} path
 * @param {string} toml
 */
export async function writeCodexConfigOrUnlink(path, toml) {
  const trimmed = toml.trim()
  if (!trimmed) {
    try {
      await unlink(path)
    } catch {
      /* absent */
    }
    return
  }
  await writeTextFile(path, `${trimmed}\n`)
}
