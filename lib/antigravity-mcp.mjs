import { existsSync, realpathSync } from 'node:fs'
import { PATHS, preferredAntigravityMcpPath } from './paths.mjs'
import { readJsonFile, writeJsonFile } from './json-config.mjs'
import { backupFiles } from './upgrade/state.mjs'

/** Move only our entry. Preserve unrelated servers, credentials and disabled flags. */
export async function refreshAntigravityMcp(entry, { mode, dryRun = false, write = writeJsonFile } = {}) {
  const selected = preferredAntigravityMcpPath(mode)
  const other = selected === PATHS.antigravity.mcp ? PATHS.antigravity.legacyMcp : PATHS.antigravity.mcp
  if (existsSync(selected) && existsSync(other) && realpathSync(selected) === realpathSync(other)) throw new Error('Antigravity config paths alias one file; left unchanged')
  const current = await readJsonFile(selected, {})
  const previous = await readJsonFile(other, {})
  const original = JSON.stringify(current)
  for (const doc of [current, previous]) {
    if (doc.mcpServers != null && (typeof doc.mcpServers !== 'object' || Array.isArray(doc.mcpServers))) throw new Error('Invalid Antigravity MCP servers; left unchanged')
    const server = doc.mcpServers?.['search-boost']
    if (server != null && (typeof server !== 'object' || Array.isArray(server) || server.url)) throw new Error('Antigravity SearchBoost entry requires manual migration; left unchanged')
  }
  current.mcpServers ??= {}
  // The destination choice does not change conflict precedence: modern
  // preferences win over stale legacy fields, as in the default migration.
  const modernEntry = (selected === PATHS.antigravity.mcp ? current : previous).mcpServers?.['search-boost']
  const legacyEntry = (selected === PATHS.antigravity.legacyMcp ? current : previous).mcpServers?.['search-boost']
  current.mcpServers['search-boost'] = { ...legacyEntry, ...modernEntry, ...entry }
  if (legacyEntry?.env && modernEntry?.env && typeof legacyEntry.env === 'object' && typeof modernEntry.env === 'object'
    && !Array.isArray(legacyEntry.env) && !Array.isArray(modernEntry.env)) {
    current.mcpServers['search-boost'].env = { ...legacyEntry.env, ...modernEntry.env, ...entry.env }
  }
  const removing = Boolean(previous.mcpServers?.['search-boost'])
  if (removing) {
    delete previous.mcpServers['search-boost']
    if (!Object.keys(previous.mcpServers).length) delete previous.mcpServers
  }
  if (!dryRun && (removing || JSON.stringify(current) !== original)) {
    const files = [selected, ...(removing ? [other] : [])].map(file => existsSync(file) ? realpathSync(file) : file)
    const backup = await backupFiles(files)
    try {
      await write(selected, current)
      if (removing) await write(other, previous)
    } catch {
      try { await backup.rollback() } catch { throw new Error('Antigravity MCP migration failed; rollback incomplete; inspect private backups') }
      throw new Error('Antigravity MCP migration failed; previous configurations restored')
    }
  }
  return [selected, ...(removing ? [other] : [])]
}
