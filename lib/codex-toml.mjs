/**
 * Codex config.toml helpers — top-level web_search placement.
 * Scoped to search-boost install/uninstall/doctor (not a full TOML parser).
 */

export const CODEX_WEB_SEARCH_BODY = 'web_search = "disabled"'
export const CODEX_WEB_SEARCH_MARKER = 'SEARCH_BOOST_WEB_SEARCH_START'

const MCP_SEARCH_BOOST = '[mcp_servers.search-boost]'

/** @param {string} toml */
function mcpSearchBoostSectionRe() {
  return /(?:^|\n)\[mcp_servers\.search-boost\][\s\S]*?(?=\n\[[^\]]+\]|$)/g
}

/** @param {string} body */
function stripWebSearchFromSectionBody(body) {
  let next = body.replace(
    /\n# SEARCH_BOOST_WEB_SEARCH_START[\s\S]*?# SEARCH_BOOST_WEB_SEARCH_END\s*/g,
    '\n',
  )
  next = next.replace(/^\s*web_search\s*=.*$/gm, '')
  return next.replace(/\n{3,}/g, '\n\n').trimEnd()
}

/**
 * True when our web_search marker or key appears inside [mcp_servers.search-boost].
 * @param {string} toml
 */
export function webSearchInsideMcpSection(toml) {
  if (!toml.includes(MCP_SEARCH_BOOST)) return false
  for (const block of toml.match(mcpSearchBoostSectionRe()) ?? []) {
    if (block.includes(CODEX_WEB_SEARCH_MARKER)) return true
    const body = block.slice(block.indexOf('\n') + 1)
    if (/^\s*web_search\s*=/m.test(body)) return true
  }
  return false
}

/**
 * Remove misplaced web_search keys and SEARCH_BOOST markers from the MCP section body.
 * @param {string} toml
 */
export function stripMisplacedCodexWebSearch(toml) {
  if (!webSearchInsideMcpSection(toml)) return toml
  let changed = false
  const next = toml.replace(mcpSearchBoostSectionRe(), (block) => {
    const nl = block.indexOf('\n')
    if (nl === -1) return block
    const header = block.slice(0, nl)
    const body = block.slice(nl + 1)
    const cleaned = stripWebSearchFromSectionBody(body)
    if (cleaned === body.trimEnd()) return block
    changed = true
    return cleaned ? `${header}\n${cleaned}` : header
  })
  if (!changed) return toml
  return next.replace(/\n{3,}/g, '\n\n').trimEnd()
}

/**
 * Strip nested web_search before top-level native-search injection / MCP upsert.
 * @param {string} toml
 */
export function migrateCodexWebSearch(toml) {
  return stripMisplacedCodexWebSearch(toml)
}

/**
 * True when SEARCH_BOOST marker and web_search = "disabled" sit outside [mcp_servers.*].
 * @param {string} toml
 */
export function codexWebSearchTopLevel(toml) {
  const topLevel = toml.replace(/(?:^|\n)\[mcp_servers\.[^\]]+\][\s\S]*?(?=\n\[[^\]]+\]|$)/g, '')
  return topLevel.includes(CODEX_WEB_SEARCH_MARKER)
    && /(?:^|\n)\s*web_search\s*=\s*"disabled"/m.test(topLevel)
}

/** @param {string} toml */
export function codexWebSearchEffective(toml) {
  return codexWebSearchTopLevel(toml)
}
