/**
 * Codex config.toml helpers — web_search marker cleanup scoped to MCP sections.
 * Not a full TOML parser; scoped to search-boost install/uninstall/doctor.
 */
import { unlink, lstat } from 'node:fs/promises'
import { removeMarked } from './inject.mjs'
import { CODEX_WEB_SEARCH_MARKER } from './native-search.mjs'
import { writeTextFile } from './json-config.mjs'
import { mcpTomlSections } from './toml.mjs'

export const CODEX_WEB_SEARCH_SECTION_MARKER_START = `# ${CODEX_WEB_SEARCH_MARKER}`
export const CODEX_WEB_SEARCH_SECTION_MARKER_END = '# SEARCH_BOOST_WEB_SEARCH_END'

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
  for (const section of mcpTomlSections(toml, serverId).reverse()) {
    const body = toml.slice(section.bodyStart, section.end)
    const cleaned = stripWebSearchFromSectionBody(body)
    if (cleaned !== body) toml = toml.slice(0, section.bodyStart) + cleaned + toml.slice(section.end)
  }
  return toml
}

/**
 * Locate ineffective web_search content inside [mcp_servers.<serverId>]:
 * a SearchBoost-marked block (legacy v0.2.0 placement) or a bare
 * `web_search = ...` line. Codex only reads the root key, so both are ignored.
 * @param {string} toml
 * @param {string} [serverId]
 * @returns {{ marker: boolean, bare: boolean } | null}
 */
export function findMisplacedCodexWebSearch(toml, serverId = 'search-boost') {
  let marker = false
  let bare = false
  for (const section of mcpTomlSections(toml, serverId)) {
    const body = toml.slice(section.bodyStart, section.end)
    if (body.includes('SEARCH_BOOST_WEB_SEARCH')) marker = true
    if (/^\s*web_search\s*=/m.test(body)) bare = true
  }
  return marker || bare ? { marker, bare } : null
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
      if ((await lstat(path)).isSymbolicLink()) await writeTextFile(path, '')
      else await unlink(path)
    } catch (err) {
      if (err.code !== 'ENOENT') throw err
    }
    return
  }
  await writeTextFile(path, `${trimmed}\n`)
}
