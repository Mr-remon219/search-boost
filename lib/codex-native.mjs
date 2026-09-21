/** Surgical root-TOML edits. Lex statements rather than matching lines inside
 * multiline strings/arrays. Unknown fields and user values are retained verbatim.
 */
const START = '# SEARCH_BOOST_WEB_SEARCH_START'
const END = '# SEARCH_BOOST_WEB_SEARCH_END'
const PREVIOUS = '# search-boost-previous: '
const assignment = /^\s*(?:web_search|"web_search"|'web_search')\s*=/

function statements(text) {
  const out = []
  let start = 0, quote = '', triple = false, escape = false, comment = false, depth = 0
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (comment) { if (c !== '\n') continue; comment = false }
    else if (quote) {
      if (escape) { escape = false; continue }
      if (c === '\\' && quote === '"') { escape = true; continue }
      if (triple ? text.slice(i, i + 3) === quote.repeat(3) : c === quote) {
        if (triple) i += 2
        quote = ''; triple = false
      }
      continue
    } else if (c === '"' || c === "'") {
      quote = c; triple = text.slice(i, i + 3) === c.repeat(3)
      if (triple) i += 2
      continue
    } else if (c === '#') comment = true
    else if (c === '[' || c === '{') depth++
    else if (c === ']' || c === '}') depth--
    if (depth < 0) throw new Error('Malformed TOML; configuration left unchanged')
    if (c === '\n' && depth === 0) {
      out.push({ start, end: i + 1, text: text.slice(start, i + 1) }); start = i + 1
    }
  }
  if (quote || depth) throw new Error('Unterminated TOML string/array; configuration left unchanged')
  if (start < text.length) out.push({ start, end: text.length, text: text.slice(start) })
  return out
}

function rootAssignment(text) {
  const list = []
  for (const item of statements(text)) {
    if (item.text.trimStart().startsWith('[')) break
    if (assignment.test(item.text)) list.push(item)
  }
  if (list.length > 1) throw new Error('Duplicate root web_search fields; configuration left unchanged')
  return list[0] ?? null
}
function disabled(item) {
  return Boolean(item && /^\s*(?:web_search|"web_search"|'web_search')\s*=\s*(?:"disabled"|'disabled')\s*(?:#[^\n]*)?\s*$/.test(item.text))
}
function managed(text) {
  const list = statements(text)
  const starts = list.filter((x) => x.text.trim() === START)
  const ends = list.filter((x) => x.text.trim() === END)
  if (!starts.length && !ends.length) return null
  if (starts.length !== 1 || ends.length !== 1 || ends[0].start < starts[0].end) {
    throw new Error('Incomplete/duplicate SearchBoost web_search marker; configuration left unchanged')
  }
  const from = starts[0].start, to = ends[0].end
  const inner = list.filter((x) => x.start >= starts[0].end && x.end <= ends[0].start)
  if (inner.some((x) => x.text.trim() && !x.text.trimStart().startsWith('#') && !assignment.test(x.text))) {
    throw new Error('Unexpected content inside managed web_search block; configuration left unchanged')
  }
  const prior = inner.find((x) => x.text.trimStart().startsWith(PREVIOUS))
  let previous = null
  if (prior) {
    try {
      previous = JSON.parse(Buffer.from(prior.text.trim().slice(PREVIOUS.length), 'base64').toString('utf8')).assignment
      if (previous !== null && (typeof previous !== 'string' || !assignment.test(previous) || statements(previous).filter((x) => x.text.trim()).length !== 1)) throw new Error('invalid')
    } catch { throw new Error('Invalid web_search restoration record; configuration left unchanged') }
  }
  const current = inner.find((x) => assignment.test(x.text))
  return { from, to, previous, current, inner }
}

/** Upgrade is not an opt-in to replace native search. Only migrate an old,
 * misplaced disabled block; an explicit root preference always wins. */
export function migrateCodexNativeSearch(text) {
  const block = managed(text)
  if (!block) return text
  const before = text.slice(0, block.from)
  if (!statements(before).some((x) => x.text.trimStart().startsWith('['))) return text
  if (!disabled(block.current)
    || block.inner.filter((x) => assignment.test(x.text)).length !== 1
    || block.inner.some((x) => x.text.trimStart().startsWith(PREVIOUS))) return text
  const cleaned = before + text.slice(block.to)
  return rootAssignment(cleaned) ? cleaned : setCodexNativeSearch(cleaned, true)
}

export function codexRootSearchDisabled(text) {
  try { return disabled(rootAssignment(text)) } catch { return false }
}

export function setCodexNativeSearch(text, replace) {
  const block = managed(text)
  if (block) {
    const before = text.slice(0, block.from), after = text.slice(block.to)
    const inRoot = !statements(before).some((x) => x.text.trimStart().startsWith('['))
    // Legacy v0.2.0 blocks were appended inside the MCP table and had no effect.
    const cleaned = before + after
    if (inRoot && replace && disabled(block.current) && !rootAssignment(cleaned)) return text
    if (inRoot && !disabled(block.current)) {
      // The user changed our managed setting; remove ownership, not their edit.
      const content = block.inner.filter((x) => !x.text.trimStart().startsWith(PREVIOUS)).map((x) => x.text).join('')
      text = before + content + after
    } else {
      text = inRoot && block.previous !== null && !rootAssignment(cleaned)
        ? before + block.previous + after : cleaned
    }
  }
  if (!replace) return text
  const existing = rootAssignment(text)
  if (disabled(existing)) return text // a pre-existing user preference is not ours
  const previous = existing?.text ?? null
  const before = existing ? text.slice(0, existing.start) : ''
  const after = existing ? text.slice(existing.end) : text
  const receipt = Buffer.from(JSON.stringify({ assignment: previous })).toString('base64')
  return `${before}${START}\n${PREVIOUS}${receipt}\nweb_search = "disabled"\n${END}\n${after}`
}
