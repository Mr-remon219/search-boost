/**
 * Minimal TOML helpers for [mcp_servers.*] sections in Codex / Grok configs.
 * Not a full TOML parser — scoped to our install/uninstall use case.
 */

/** @param {string} serverId */
function sectionHeader(serverId) {
  return `[mcp_servers.${serverId}]`
}

/** Match a full [mcp_servers.id] section (header + body until next section or EOF). */
function sectionPattern(serverId) {
  return new RegExp(
    `(?:^|\\n)\\[mcp_servers\\.${escapeRegExp(serverId)}\\][\\s\\S]*?(?=\\n\\[|$)`,
  )
}

/**
 * @param {string} toml
 * @param {string} serverId
 * @param {string} body  Lines inside the section (no header).
 */
export function upsertTomlSection(toml, serverId, body) {
  const header = sectionHeader(serverId)
  const block = `${header}\n${body.trim()}\n`
  const re = sectionPattern(serverId)
  if (re.test(toml)) {
    return toml.replace(re, `\n${block.trimEnd()}`).replace(/^\n+/, '')
  }
  const trimmed = toml.trimEnd()
  return trimmed ? `${trimmed}\n\n${block}` : `${block}`
}

/**
 * @param {string} toml
 * @param {string} serverId
 */
export function removeTomlSection(toml, serverId) {
  const re = sectionPattern(serverId)
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
