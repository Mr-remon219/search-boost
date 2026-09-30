/** Upgrade-only config edits: preserve credentials, permissions and unknown fields. */
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { upsertTomlSection } from '../toml.mjs'

export async function optionalText(path) {
  try { return await readFile(path, 'utf8') } catch (err) { if (err.code === 'ENOENT') return null; throw err }
}
export async function strictJson(path, fallback = {}) {
  const raw = await optionalText(path)
  if (raw === null) return fallback
  let value
  try { value = JSON.parse(raw) } catch { throw new Error(`Invalid JSON configuration: ${path}; left unchanged`) }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid object configuration: ${path}`)
  return value
}
export async function refreshJsonMcp(path, entry, dryRun) {
  const config = await strictJson(path)
  const previous = config.mcpServers?.['search-boost']
  if (previous?.url) throw new Error(`Remote MCP entry at ${path}; automatic local replacement refused`)
  if (config.mcpServers && (typeof config.mcpServers !== 'object' || Array.isArray(config.mcpServers))) throw new Error(`Invalid MCP configuration: ${path}`)
  config.mcpServers ??= {}
  config.mcpServers['search-boost'] = { ...previous, ...entry }
  if (!dryRun) {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
  }
}

export function refreshTomlMcp(text, launch) {
  return upsertTomlSection(text, 'search-boost', `command = ${JSON.stringify(launch.command)}\nargs = ${JSON.stringify(launch.args)}\n`)
}
