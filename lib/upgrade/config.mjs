/** Upgrade-only config edits: preserve credentials, permissions and unknown fields. */
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'

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
  const header = /^\[mcp_servers\.(?:search-boost|"search-boost"|'search-boost')\][^\n]*(?:\n|$)/m
  const match = header.exec(text)
  const assignments = `command = ${JSON.stringify(launch.command)}\nargs = ${JSON.stringify(launch.args)}\n`
  if (!match) return `${text.trimEnd()}\n\n[mcp_servers.search-boost]\n${assignments}`
  const from = match.index + match[0].length
  const next = text.slice(from).search(/^\s*\[/m)
  const end = next < 0 ? text.length : from + next
  let body = text.slice(from, end)
  // Only our launch assignments are replaced; env subtables, approval flags,
  // enabled=false, timeouts, headers, native search and unrelated tables stay intact.
  for (const key of ['command', 'args']) {
    const re = new RegExp(`^([ \\t]*)${key}[ \\t]*=[ \\t]*`, 'm')
    const hit = re.exec(body)
    if (!hit) continue
    let i = hit.index + hit[0].length, quote = '', depth = 0, escape = false, comment = false
    for (; i < body.length; i++) {
      const c = body[i]
      if (comment) { if (c === '\n') { comment = false; if (!depth) break }; continue }
      if (quote) {
        if (escape) { escape = false; continue }
        if (c === '\\' && quote === '"') { escape = true; continue }
        if (c === quote) quote = ''
        continue
      }
      if (c === '"' || c === "'") {
        if (body.slice(i, i + 3) === c.repeat(3)) throw new Error('Multiline TOML launch strings require manual migration')
        quote = c
      } else if (c === '#') comment = true
      else if (c === '[') depth++
      else if (c === ']') depth--
      else if (c === '\n' && depth === 0) break
    }
    if (quote || depth !== 0) throw new Error('Malformed TOML launch assignment; left unchanged')
    body = body.slice(0, hit.index) + body.slice(i < body.length ? i + 1 : i)
    if (re.test(body)) throw new Error('Duplicate TOML launch assignment; left unchanged')
  }
  return text.slice(0, from) + assignments + body + text.slice(end)
}
