/**
 * Minimal TOML helpers for [mcp_servers.*] sections in Codex / Grok configs.
 * Not a full TOML parser — scoped to our install/uninstall use case.
 */

/** @param {string} serverId */
function sectionHeader(serverId) {
  return `[mcp_servers.${serverId}]`
}

/**
 * @param {string} toml
 * @param {string} serverId
 * @param {string} body  Lines inside the section (no header).
 */
export function upsertTomlSection(toml, serverId, body) {
  const header = sectionHeader(serverId)
  const block = `${header}\n${body.trim()}\n`
  const re = new RegExp(`\\n\\[mcp_servers\\.${escapeRegExp(serverId)}\\][\\s\\S]*?(?=\\n\\[|$)`, 'm')
  if (re.test(toml)) {
    return toml.replace(re, `\n${block.trimEnd()}`)
  }
  const trimmed = toml.trimEnd()
  return trimmed ? `${trimmed}\n\n${block}` : `${block}`
}

/**
 * @param {string} toml
 * @param {string} serverId
 */
export function removeTomlSection(toml, serverId) {
  const re = new RegExp(`\\n?\\[mcp_servers\\.${escapeRegExp(serverId)}\\][\\s\\S]*?(?=\\n\\[|$)`, 'm')
  return toml.replace(re, '').trimEnd()
}

/** @param {string} s */
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** @param {string} toml @param {string} serverId */
export function hasTomlSection(toml, serverId) {
  return toml.includes(sectionHeader(serverId))
}
