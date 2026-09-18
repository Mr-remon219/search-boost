// Evidence extraction: pick the paragraphs / sentences of a page that matter
// for a focus question (Grok find_in_page / Anthropic dynamic-filtering
// pattern). Scores unique concept coverage rather than any single term,
// preserves markdown data tables, and drops reader-mode navigation noise.
// Ported from pi-search-boost lib/extract.ts; used by the research loop and
// available to any host that wants focus-aware excerpts.

import { countWords, evidenceTerms, searchTermRegExp } from './text.js'

const collapseSpace = (s) => String(s ?? '').replace(/\s+/g, ' ').trim()

/** Markdown data tables often contain many links but are evidence, not nav. */
function isTableSeparator(line) {
  const cells = line.trim().replace(/^\||\|$/g, '').split('|').map((cell) => cell.trim())
  return cells.length >= 2 && cells.every((cell) => /^:?-{3,}:?$/.test(cell))
}

export function isMarkdownTable(text) {
  const lines = String(text).split('\n')
  return lines.some((line) => line.includes('|') && !isTableSeparator(line)) && lines.some(isTableSeparator)
}

/** Reader-mode markdown keeps navigation as dense link lists; those lines
 * match query terms as readily as prose and are worthless as evidence. */
export function isBoilerplate(text) {
  if (isMarkdownTable(text)) return false
  const linkCount = (text.match(/\]\(|https?:\/\/|!\[/g) ?? []).length
  const proseWords = countWords(text.replace(/\[[^\]]*\]\([^)]*\)/g, ' '))
  if (linkCount >= 3 && proseWords < 20) return true
  const urlChars = (text.match(/https?:\/\/\S+/g) ?? []).join('').length
  return urlChars > text.length * 0.35
}

const GENERIC_FOCUS_TERMS = new Set([
  'current', 'latest', 'newest', 'recent', 'status', 'release', 'releases',
  'version', 'versions', 'official', 'overview', 'guide', 'documentation',
  'identify', 'determine', 'find', 'report', 'explain', 'information',
  '当前', '最新', '状态', '版本', '发布', '官方', '说明', '信息',
])

function termMatchers(text) {
  return [...new Set(evidenceTerms(text))]
    .filter((t) => t.length >= 2)
    .map((t) => ({
      term: t,
      re: searchTermRegExp(t),
      weight: Math.min(t.length, 12),
      generic: GENERIC_FOCUS_TERMS.has(t.toLowerCase()),
    }))
}

function scoreAgainstTerms(text, matchers) {
  const lower = text.toLowerCase()
  let score = 0
  let uniqueHits = 0
  let subjectHits = 0
  for (const { re, weight, generic } of matchers) {
    re.lastIndex = 0
    const count = lower.match(re)?.length ?? 0
    if (count === 0) continue
    uniqueHits++
    if (!generic) subjectHits++
    // Cap repetition so one generic word cannot dominate the ranking.
    score += Math.min(count, 2) * (generic ? Math.max(2, weight * 0.35) : weight)
  }
  // Reward breadth: a status table matching four concepts should outrank an
  // installation paragraph that repeats only "Node.js" many times.
  score += uniqueHits * uniqueHits * 2 + subjectHits * 5
  return { score, uniqueHits, subjectHits }
}

function normalizeBlock(text) {
  if (!isMarkdownTable(text)) return collapseSpace(text)
  return text
    .split('\n')
    .map((line) => line.trim().replace(/[ \t]+/g, ' '))
    .filter(Boolean)
    .join('\n')
}

/** Preserve table headers plus the highest-relevance complete rows. */
function trimRelevantTable(text, matchers, maxLen) {
  if (text.length <= maxLen) return text
  const lines = text.split('\n').filter(Boolean)
  const separator = lines.findIndex(isTableSeparator)
  const headerEnd = separator >= 0 ? separator : Math.min(1, lines.length - 1)
  const selected = new Set()
  for (let i = 0; i <= headerEnd; i++) selected.add(i)
  const rankedRows = lines
    .map((line, index) => ({ line, index, score: scoreAgainstTerms(line, matchers).score }))
    .filter((row) => row.index > headerEnd)
    .sort((a, b) => b.score - a.score || a.index - b.index)
  let used = [...selected].reduce((sum, index) => sum + lines[index].length + 1, 0)
  for (const row of rankedRows) {
    if (used + row.line.length + 1 > maxLen - 20) continue
    selected.add(row.index)
    used += row.line.length + 1
  }
  return [...selected].sort((a, b) => a - b).map((index) => lines[index]).join('\n') + '\n[table truncated]'
}

/**
 * Paragraphs most relevant to the focus terms (dynamic filtering, find_in_page).
 * Includes bounded neighboring context around headings/tables.
 */
export function pickParagraphs(content, focus, max = 8, maxLen = 400) {
  const matchers = termMatchers(focus)
  const blocks = String(content ?? '')
    .split(/\n{2,}/)
    .map((raw, index) => ({ raw: raw.trim(), index }))
    .filter((x) => {
      const structural = /^#{1,6}\s+/m.test(x.raw) || isMarkdownTable(x.raw)
      return (structural || countWords(x.raw) >= 6) && !isBoilerplate(x.raw)
    })
    .map((x) => {
      const p = normalizeBlock(x.raw)
      const relevance = scoreAgainstTerms(p, matchers)
      const table = isMarkdownTable(x.raw)
      const heading = /^#{1,6}\s+/m.test(x.raw)
      let score = relevance.score
      if (table && relevance.uniqueHits > 0) score += 12 + relevance.uniqueHits * 4
      if (heading && relevance.uniqueHits > 0) score += 8
      return { ...x, p, table, heading, ...relevance, score }
    })
  const candidates = blocks
    .filter((x) => x.score > 0 && (x.subjectHits > 0 || x.uniqueHits >= 2))
    .sort((a, b) => b.score - a.score || a.index - b.index)
  const byIndex = new Map(blocks.map((x) => [x.index, x]))
  const chosen = []
  const seen = new Set()
  const add = (x) => {
    if (!x || seen.has(x.index) || chosen.length >= max) return
    seen.add(x.index)
    chosen.push(x)
  }
  for (const seed of candidates) {
    if (chosen.length >= max) break
    // A nearby heading/table supplies the schema or subject that a row alone
    // lacks. Only table/heading seeds expand context, preventing broad drift.
    if (seed.table || seed.heading) add(byIndex.get(seed.index - 1))
    add(seed)
    if (seed.table || seed.heading) add(byIndex.get(seed.index + 1))
  }
  return chosen.map((x) => x.table
    ? trimRelevantTable(x.p, matchers, Math.max(maxLen, 800))
    : x.p.slice(0, maxLen))
}

/** Pick the sentences/blocks most relevant to the query for evidence excerpts. */
export function pickExcerpts(content, query, max = 3, maxLen = 500) {
  const matchers = termMatchers(query)
  const scored = String(content ?? '')
    .split(/(?<=[.!?。！？])\s+|\n{2,}/)
    .map((s) => s.trim())
    .filter((s) => countWords(s) >= 10 && !isBoilerplate(s))
    .map((raw) => {
      const s = normalizeBlock(raw)
      const relevance = scoreAgainstTerms(s, matchers)
      const table = isMarkdownTable(raw)
      return { s, ...relevance, score: relevance.score + (table ? 10 : 0) }
    })
    .filter((x) => x.score > 0 && (x.subjectHits > 0 || x.uniqueHits >= 2))
    .sort((a, b) => b.score - a.score)
    .slice(0, max)
  if (scored.length === 0) {
    return [collapseSpace(content).slice(0, maxLen)]
  }
  return scored.map((x) => isMarkdownTable(x.s)
    ? trimRelevantTable(x.s, matchers, maxLen)
    : x.s.slice(0, maxLen))
}

/** Truncate engine-provided page text for a tool payload. */
export function excerptForTool(content, maxChars = 2000) {
  const t = String(content ?? '').trim()
  if (t.length <= maxChars) return t
  const cut = t.slice(0, maxChars)
  const boundary = Math.max(cut.lastIndexOf('\n\n'), cut.lastIndexOf('\n'))
  return (boundary > maxChars * 0.6 ? cut.slice(0, boundary) : cut) + '\n[content truncated]'
}
