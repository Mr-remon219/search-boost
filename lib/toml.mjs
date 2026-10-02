/** Scoped, lossless MCP TOML edits. This is not a general TOML value parser. */

function dottedKeys(raw) {
  const keys = []
  let i = 0
  while (i < raw.length) {
    while (/\s/.test(raw[i] ?? '') && i < raw.length) i++
    let key = ''
    if (raw[i] === '"' || raw[i] === "'") {
      const quote = raw[i++]
      let closed = false
      for (; i < raw.length; i++) {
        const c = raw[i]
        if (c === quote) { i++; closed = true; break }
        if (c === '\\' && quote === '"') {
          const escape = raw[++i]
          const basic = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', '"': '"', '\\': '\\' }
          if (escape === 'u' || escape === 'U') {
            const width = escape === 'u' ? 4 : 8, hex = raw.slice(i + 1, i + 1 + width)
            if (!new RegExp(`^[a-fA-F0-9]{${width}}$`).test(hex)) return null
            const code = parseInt(hex, 16)
            if (code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return null
            key += String.fromCodePoint(code); i += width
          } else if (Object.hasOwn(basic, escape)) key += basic[escape]
          else return null
        } else key += c
      }
      if (!closed) return null
    } else {
      const bare = /^[A-Za-z0-9_-]+/.exec(raw.slice(i))
      if (!bare) return null
      key = bare[0]; i += key.length
    }
    keys.push(key)
    while (i < raw.length && /\s/.test(raw[i])) i++
    if (i === raw.length) return keys
    if (raw[i++] !== '.') return null
    if (i === raw.length) return null
  }
  return keys.length ? keys : null
}

// TOML allows one or two content quotes just before a triple-quote closing
// delimiter. Consume the entire 3–5 quote run, not a phantom new string.
function multilineQuoteEnd(line, start, quote) {
  let end = start + 3
  while (line[end] === quote) end++
  if (end - start > 5) throw new Error('Malformed TOML string; left unchanged')
  return end - 1
}

/** Locate real headers, not header-looking text inside multiline values. */
export function tomlSections(text) {
  const sections = []
  let offset = 0, multiline = null, depth = 0
  for (const line of text.match(/[^\n]*(?:\n|$)/g) ?? []) {
    if (!line) continue
    if (!multiline && depth === 0) {
      const header = /^[ \t]*\[(\[?)(.*?)(\]?)\][ \t]*(?:#[^\r\n]*)?\r?\n?$/.exec(line)
      if (header && Boolean(header[1]) === Boolean(header[3])) {
        const keys = dottedKeys(header[2].trim())
        if (keys) {
          sections.push({ keys, array: Boolean(header[1]), start: offset, bodyStart: offset + line.length })
          offset += line.length
          continue // Header brackets are not value-container delimiters.
        }
      }
    }
    let quote = null
    for (let i = 0; i < line.length; i++) {
      if (multiline) {
        if (line.slice(i, i + 3) === multiline) { i = multilineQuoteEnd(line, i, multiline[0]); multiline = null }
        else if (line[i] === '\\' && multiline === '"""') i++
      } else if (quote) {
        if (line[i] === '\\' && quote === '"') i++
        else if (line[i] === quote) quote = null
      } else if (line[i] === '#') break
      else if (line[i] === '"' || line[i] === "'") {
        if (line.slice(i, i + 3) === line[i].repeat(3)) { multiline = line[i].repeat(3); i += 2 }
        else quote = line[i]
      } else if (line[i] === '[' || line[i] === '{') depth++
      else if (line[i] === ']' || line[i] === '}') depth--
    }
    offset += line.length
  }
  return sections.map((section, i) => ({ ...section, end: sections[i + 1]?.start ?? text.length }))
}

export function mcpTomlSections(text, serverId, descendants = false) {
  return tomlSections(text).filter(({ keys }) => keys[0] === 'mcp_servers' && keys[1] === serverId && (descendants || keys.length === 2))
}

/** Locate top-level assignments, not examples inside strings or arrays. */
function tomlAssignments(body) {
  const out = []
  let offset = 0, quote = null, multiline = false, depth = 0, current = null
  for (const line of body.match(/[^\n]*(?:\n|$)/g) ?? []) {
    if (!line) continue
    if (!quote && !depth) {
      const key = '(?:[A-Za-z0-9_-]+|"(?:[^"\\\\]|\\\\.)*"|\'[^\']*\')'
      const match = new RegExp(`^[ \\t]*(${key}(?:[ \\t]*\\.[ \\t]*${key})*)[ \\t]*=`).exec(line)
      const keys = match && dottedKeys(match[1])
      if (keys) current = { keys, key: keys.length === 1 ? keys[0] : null, start: offset, valueStart: offset + match[0].length }
    }
    let comment = false
    for (let i = 0; i < line.length; i++) {
      const c = line[i]
      if (comment) break
      if (quote) {
        if (c === '\\' && quote === '"') { i++; continue }
        if (multiline ? line.slice(i, i + 3) === quote.repeat(3) : c === quote) {
          if (multiline) i = multilineQuoteEnd(line, i, quote)
          quote = null; multiline = false
        }
      } else if (c === '#') comment = true
      else if (c === '"' || c === "'") {
        quote = c; multiline = line.slice(i, i + 3) === c.repeat(3)
        if (multiline) i += 2
      } else if (c === '[' || c === '{') depth++
      else if (c === ']' || c === '}') depth--
    }
    offset += line.length
    if (current && !quote && !depth) { out.push({ ...current, end: offset }); current = null }
  }
  if (current || quote || depth !== 0) throw new Error('Malformed TOML assignment; left unchanged')
  return out
}

/** Refuse declarations that the section editor cannot safely rewrite/remove. */
export function assertMcpTomlEditable(text, serverId) {
  const sections = tomlSections(text)
  const scopes = [{ keys: [], bodyStart: 0, end: sections[0]?.start ?? text.length }, ...sections]
  for (const scope of scopes) {
    const supportedScope = scope.keys[0] === 'mcp_servers' && scope.keys[1] === serverId
    for (const assignment of tomlAssignments(text.slice(scope.bodyStart, scope.end))) {
      const keys = [...scope.keys, ...assignment.keys]
      // An inline mcp_servers container is closed to additional tables, even
      // when it currently contains only other servers. Never append into it.
      if (keys[0] === 'mcp_servers' && (keys.length === 1 || (keys[1] === serverId && !supportedScope))) {
        throw new Error(`Unsupported MCP TOML inline-table/dotted-key declaration for ${serverId}; manually convert MCP declarations to explicit tables (including [mcp_servers.${serverId}]), do not append duplicate tables; left unchanged`)
      }
    }
  }
}

function withoutAssignment(body, key) {
  const hits = tomlAssignments(body).filter(item => item.key === key)
  if (hits.length > 1) throw new Error('Duplicate TOML managed assignment; left unchanged')
  const hit = hits[0]
  return hit ? body.slice(0, hit.start) + body.slice(hit.end) : body
}

/** Replace launch keys; default timeouts do not overwrite existing preferences. */
export function upsertTomlSection(text, serverId, incoming, { removeAutoApproval = false } = {}) {
  assertMcpTomlEditable(text, serverId)
  const sections = mcpTomlSections(text, serverId)
  if (sections.length > 1 || sections.some(s => s.array)) throw new Error('Duplicate/array MCP TOML table; left unchanged')
  const section = sections[0]
  if (!section) {
    // A subtable implicitly declares its parent. Define it before the subtable.
    const child = mcpTomlSections(text, serverId, true)[0]
    const name = /^[A-Za-z0-9_-]+$/.test(serverId) ? serverId : JSON.stringify(serverId)
    const block = `[mcp_servers.${name}]\n${incoming.trim()}\n`
    if (child) return text.slice(0, child.start) + block + '\n' + text.slice(child.start)
    return `${text.trimEnd()}${text.trim() ? '\n\n' : ''}${block}`
  }
  let body = text.slice(section.bodyStart, section.end), assignments = ''
  // Declining the installer's approval choice must revoke its auto grant,
  // without replacing a user's explicit ask/never policy.
  if (removeAutoApproval && tomlAssignments(body).some(item => item.key === 'default_tools_approval_mode'
    && /^(?:"auto"|'auto')[ \t]*(?:#[^\n]*)?\r?\n?$/.test(body.slice(item.valueStart, item.end).trimStart()))) {
    body = withoutAssignment(body, 'default_tools_approval_mode')
  }
  for (const line of incoming.trim().split('\n')) {
    const key = /^([A-Za-z0-9_-]+)\s*=/.exec(line)?.[1]
    if (!key) throw new Error('Unsupported generated TOML assignment')
    if (['startup_timeout_sec', 'tool_timeout_sec'].includes(key) && tomlAssignments(body).some(item => item.key === key)) continue
    body = withoutAssignment(body, key)
    assignments += line + '\n'
  }
  return text.slice(0, section.bodyStart) + assignments + body + text.slice(section.end)
}

/** Delete the complete owned subtree, including interleaved env/other subtables. */
export function removeTomlSection(text, serverId) {
  assertMcpTomlEditable(text, serverId)
  for (const section of mcpTomlSections(text, serverId, true).reverse()) text = text.slice(0, section.start) + text.slice(section.end)
  return text.trimEnd()
}
export function hasTomlSection(text, serverId) { return mcpTomlSections(text, serverId, true).length > 0 }

/** Read-only launch evidence. Unsupported expressions are unknown, never guessed. */
export function mcpTomlStringArray(text, serverId, key) {
  const sections = mcpTomlSections(text, serverId)
  if (sections.length !== 1 || sections[0].array) return null
  const body = text.slice(sections[0].bodyStart, sections[0].end)
  const hits = tomlAssignments(body).filter(item => item.key === key)
  if (hits.length !== 1) return null
  const raw = body.slice(hits[0].valueStart, hits[0].end), values = []
  let i = 0
  const skip = () => {
    while (i < raw.length) {
      if (/\s/.test(raw[i])) i++
      else if (raw[i] === '#') { while (i < raw.length && raw[i] !== '\n') i++ }
      else break
    }
  }
  skip()
  if (raw[i++] !== '[') return null
  for (;;) {
    skip()
    if (raw[i] === ']') { i++; skip(); return i === raw.length ? values : null }
    const quote = raw[i], start = i++
    if (!['"', "'"].includes(quote) || raw.slice(start, start + 3) === quote.repeat(3)) return null
    while (i < raw.length && raw[i] !== quote) {
      if (raw[i] === '\\' && quote === '"') i++
      i++
    }
    if (i >= raw.length) return null
    const decoded = dottedKeys(raw.slice(start, ++i))
    if (decoded?.length !== 1) return null
    values.push(decoded[0]); skip()
    if (raw[i] !== ',' && raw[i] !== ']') return null
    if (raw[i] === ',') i++
  }
}
