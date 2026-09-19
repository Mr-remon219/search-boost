// Conservative fetch_page preprocessor.
//
// Invariant: may reduce noise, must not reduce semantic evidence.
// Drop chrome that can never be evidence (CSS, JS, ad slots, 1×1 pixels)
// while keeping every heading, paragraph, list, table, code block, link,
// and alt text. Nav / sidebar / footer stay — docs often put API facts
// there. Never summarize; never guess "the main article".
//
// Pipeline:
//   protect code first — fenced, inline, <pre> (HTML), ≥4-space indented (Markdown)
//     → format detection and chrome-stripping only ever see unprotected regions
//     → img / a (resolve relative URLs) before any stripTags
//     → headings / tables / nested lists
//     → decode entities once
//     → normalize prose only (HTML and Markdown use different rules)
//     → restore code
//
// If the structured HTML path would throw away most of the *plain* text
// (same information space — not raw markup length), fall back to a
// newline-preserving strip that still rewrites links/images.

const AD_HOST =
  /doubleclick|googlesyndication|adservice\.google|googletagservices|adnxs\.com|adsystem|taboola\.com|outbrain\.com|carbonads|amazon-adsystem|criteo\.com/i

const DROP_TAGS = ['script', 'style', 'noscript', 'template']
const NESTABLE_DROP = new Set(['template'])

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
  nbsp: ' ', ensp: ' ', emsp: ' ', thinsp: ' ',
  ndash: '–', mdash: '—', hellip: '…',
  copy: '©', reg: '®', trade: '™',
  lsquo: '\u2018', rsquo: '\u2019', ldquo: '\u201c', rdquo: '\u201d',
  sbquo: '\u201a', bdquo: '\u201e',
  times: '×', divide: '÷', minus: '−', plusmn: '±',
  deg: '°', micro: 'µ', para: '¶', sect: '§',
  bull: '•', middot: '·',
  laquo: '«', raquo: '»',
  iexcl: '¡', iquest: '¿',
  cent: '¢', pound: '£', yen: '¥', euro: '€',
}

const SLOT = (i) => `\uE000SBCODE_${i}\uE000`
const SLOT_RE = /\uE000SBCODE_(\d+)\uE000/g

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function decodeHtml(s) {
  return String(s ?? '').replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (full, body) => {
    if (body[0] === '#') {
      const hex = body[1] === 'x' || body[1] === 'X'
      const code = hex ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10)
      if (!Number.isFinite(code) || code <= 0) return full
      try { return String.fromCodePoint(code) } catch { return full }
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? full
  })
}

function collapseSpace(s) {
  return String(s ?? '').replace(/\s+/g, ' ').trim()
}

function meaningfulLen(s) {
  return collapseSpace(s).length
}

function stripTags(s) {
  return String(s ?? '').replace(/<\/?[a-zA-Z][^>]*>/g, ' ')
}

/** Attribute value; requires a real attr boundary so data-href ≠ href. */
function attr(tag, name) {
  const re = new RegExp(
    `(?:^|\\s)${escapeRegExp(name)}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`,
    'i',
  )
  const m = re.exec(tag)
  return m ? (m[1] ?? m[2] ?? m[3] ?? '') : ''
}

function isSelfClosing(s, start, gt) {
  return s[gt - 1] === '/' || /\/\s*>$/.test(s.slice(start, gt + 1))
}

/** Resolve href/src against the fetched page. Keep relatives if no base. */
function resolveUrl(href, baseUrl) {
  const raw = String(href ?? '').trim()
  if (!raw) return ''
  const lower = raw.toLowerCase()
  if (lower.startsWith('javascript:') || lower.startsWith('data:') || lower.startsWith('vbscript:')) {
    return ''
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) {
    if (/^https?:/i.test(raw) || /^mailto:/i.test(raw) || /^ftp:/i.test(raw)) return raw
    return ''
  }
  if (!baseUrl) return raw
  try {
    return new URL(raw, baseUrl).href
  } catch {
    return raw
  }
}

function findFirstClose(s, tag, from) {
  const closeRe = new RegExp(`</${tag}\\s*>`, 'i')
  const m = closeRe.exec(s.slice(from))
  return m ? from + m.index + m[0].length : -1
}

function findNestedClose(s, tag, from) {
  const tokenRe = new RegExp(`<${tag}\\b|</${tag}\\s*>`, 'gi')
  tokenRe.lastIndex = from
  let depth = 1
  let m
  while ((m = tokenRe.exec(s))) {
    if (m[0][1] === '/') {
      depth--
      if (depth === 0) return m.index + m[0].length
      continue
    }
    const gt = s.indexOf('>', m.index)
    if (gt < 0) return -1
    if (isSelfClosing(s, m.index, gt)) continue
    depth++
    tokenRe.lastIndex = gt + 1
  }
  return -1
}

/**
 * Drop a named element and its inner HTML without a greedy regex.
 * script/style/noscript: first close (HTML parsing rules).
 * template: depth-counted, because it may nest.
 */
function removeElementsByName(html, tag, nestable = false) {
  let s = String(html ?? '')
  let from = 0
  const openRe = new RegExp(`<${tag}\\b`, 'i')
  for (let n = 0; n < 10_000; n++) {
    const m = openRe.exec(s.slice(from))
    if (!m) break
    const start = from + m.index
    const gt = s.indexOf('>', start)
    if (gt < 0) {
      s = s.slice(0, start)
      break
    }
    const openEnd = gt + 1
    if (isSelfClosing(s, start, gt)) {
      s = `${s.slice(0, start)}\n${s.slice(openEnd)}`
      from = start
      continue
    }
    const closeAt = nestable ? findNestedClose(s, tag, openEnd) : findFirstClose(s, tag, openEnd)
    if (closeAt < 0) {
      s = s.slice(0, start) + s.slice(openEnd)
      from = start
      continue
    }
    s = `${s.slice(0, start)}\n${s.slice(closeAt)}`
    from = start
  }
  return s
}

function dropComments(html) {
  return String(html ?? '').replace(/<!--[\s\S]*?-->/g, '\n')
}

function dropNonContent(html) {
  let s = dropComments(html)
  for (const tag of DROP_TAGS) s = removeElementsByName(s, tag, NESTABLE_DROP.has(tag))
  s = s.replace(/<link\b[^>]*>/gi, '\n')
  s = s.replace(/<meta\b[^>]*>/gi, '\n')
  return s
}

function replaceIframes(html, baseUrl) {
  return html.replace(/<iframe\b[^>]*\/>|<iframe\b[^>]*>[\s\S]*?<\/iframe>/gi, (block) => {
    if (AD_HOST.test(block)) return '\n'
    const open = /^<iframe\b[^>]*\/?>/i.exec(block)?.[0] ?? block
    const title = (attr(open, 'title') || attr(open, 'aria-label')).trim()
    const src = resolveUrl(attr(open, 'src'), baseUrl)
    if (src) {
      const label = title ? `Embedded: ${title}` : 'Embedded'
      return `\n[${label}](${src})\n`
    }
    return title ? `\n${title}\n` : '\n'
  })
}

function dropTrackingPixels(html) {
  return html.replace(/<img\b[^>]*>/gi, (tag) => {
    const w = /width\s*=\s*["']?(\d+)/i.exec(tag)
    const h = /height\s*=\s*["']?(\d+)/i.exec(tag)
    if (w && h && Number(w[1]) <= 1 && Number(h[1]) <= 1) return ''
    return tag
  })
}

function rewriteImages(html, baseUrl) {
  return html.replace(/<img\b[^>]*>/gi, (tag) => {
    const alt = attr(tag, 'alt').trim()
    const src = resolveUrl(attr(tag, 'src'), baseUrl)
    if (alt && src) return `![${alt}](${src})`
    if (alt) return `[${alt}]`
    return src || ''
  })
}

function rewriteLinks(html, baseUrl) {
  return html.replace(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi, (_, attrs, inner) => {
    const href = resolveUrl(attr(attrs, 'href'), baseUrl)
    const text = collapseSpace(stripTags(inner))
    if (!href) return text
    if (!text) return href
    return `[${text}](${href})`
  })
}

function tableToText(tableHtml) {
  const rows = []
  for (const row of tableHtml.match(/<tr[\s\S]*?<\/tr>/gi) || []) {
    const cells = [...row.matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi)]
      .map((m) => collapseSpace(stripTags(m[1])))
    if (cells.some(Boolean)) rows.push(cells.join(' | '))
  }
  return rows.length ? `\n\n${rows.join('\n')}\n\n` : '\n'
}

function extractDirectLis(html) {
  const items = []
  let from = 0
  const openRe = /<li\b/i
  for (let n = 0; n < 10_000; n++) {
    const m = openRe.exec(html.slice(from))
    if (!m) break
    const start = from + m.index
    const gt = html.indexOf('>', start)
    if (gt < 0) break
    const after = findNestedClose(html, 'li', gt + 1)
    if (after < 0) {
      items.push(html.slice(gt + 1))
      break
    }
    const close = /<\/li\s*>/i.exec(html.slice(gt + 1, after))
    const contentEnd = close ? gt + 1 + close.index : after
    items.push(html.slice(gt + 1, contentEnd))
    from = after
  }
  return items
}

function formatListItem(inner, marker) {
  let s = String(inner ?? '')
  s = s.replace(/<br\s*\/?>/gi, '\n')
  s = s.replace(/<\/p>/gi, '\n')
  s = stripTags(s)
  const prose = []
  const nested = []
  for (const line of s.split('\n')) {
    const trimmedEnd = line.replace(/[ \t]+$/g, '')
    if (nested.length) {
      if (trimmedEnd.trim()) nested.push(trimmedEnd)
      continue
    }
    if (/^[ \t]*(?:[-*+]|\d+\.)[ \t]/.test(trimmedEnd)) {
      nested.push(trimmedEnd)
      continue
    }
    if (trimmedEnd.trim()) prose.push(trimmedEnd)
  }
  const head = collapseSpace(prose.join(' '))
  const out = [head ? `${marker} ${head}` : marker]
  for (const line of nested) out.push(`  ${line}`)
  return out.join('\n')
}

function renderListBlock(block) {
  const gt = block.indexOf('>')
  if (gt < 0) return block
  const openTag = block.slice(0, gt + 1)
  const ordered = /^<ol\b/i.test(openTag)
  let index = Number.parseInt(attr(openTag, 'start') || '1', 10)
  if (!Number.isFinite(index) || index < 1) index = 1
  const inner = block.slice(gt + 1).replace(/<\/(?:ul|ol)\s*>\s*$/i, '')
  const lines = []
  for (const item of extractDirectLis(inner)) {
    const marker = ordered ? `${index}.` : '-'
    index++
    const rendered = formatListItem(item, marker)
    if (rendered.trim()) lines.push(rendered)
  }
  return lines.length ? `\n\n${lines.join('\n')}\n\n` : '\n'
}

function findInnermostList(html) {
  const openRe = /<(ul|ol)\b[^>]*>/gi
  let m
  while ((m = openRe.exec(html))) {
    const start = m.index
    const afterOpen = start + m[0].length
    const end = findNestedClose(html, m[1], afterOpen)
    if (end < 0) continue
    const interior = html.slice(afterOpen, end).replace(/<\/(?:ul|ol)\s*>\s*$/i, '')
    if (/<(?:ul|ol)\b/i.test(interior)) continue
    return { start, end }
  }
  return null
}

/** Innermost-first so nested <li> is not closed by the first inner </li>. */
function rewriteLists(html) {
  let s = String(html ?? '')
  for (let n = 0; n < 10_000; n++) {
    const found = findInnermostList(s)
    if (!found) break
    s = s.slice(0, found.start) + renderListBlock(s.slice(found.start, found.end)) + s.slice(found.end)
  }
  return s
}

function fenceFor(code, char = '`') {
  const re = char === '`' ? /`+/g : /~+/g
  let max = 2
  for (const m of String(code).matchAll(re)) {
    if (m[0].length > max) max = m[0].length
  }
  return char.repeat(max + 1)
}

/** Turn one <pre> block into fenced markdown so chrome-stripping cannot touch it. */
function preToFence(inner) {
  const code = decodeHtml(inner.replace(/<\/?[a-zA-Z][^>]*>/g, ''))
  const body = code.replace(/^\n+|\n+$/g, '')
  const fence = fenceFor(body)
  return `\n\n${fence}\n${body}\n${fence}\n\n`
}

function matchOpenFence(line) {
  const m = /^([ \t]{0,3})(`{3,}|~{3,})(.*)$/.exec(line)
  if (!m) return null
  const fence = m[2]
  const char = fence[0]
  if (char === '`' && m[3].includes('`')) return null
  return { char, len: fence.length }
}

function isCloseFence(line, char, len) {
  const re = new RegExp(`^[ \\t]{0,3}${escapeRegExp(char)}{${len},}[ \\t]*$`)
  return re.test(line)
}

function protectFences(text, stash) {
  const lines = String(text ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')
  const out = []
  for (let i = 0; i < lines.length; i++) {
    const open = matchOpenFence(lines[i])
    if (!open) {
      out.push(lines[i])
      continue
    }
    let closeAt = -1
    for (let j = i + 1; j < lines.length; j++) {
      if (isCloseFence(lines[j], open.char, open.len)) {
        closeAt = j
        break
      }
    }
    if (closeAt < 0) {
      out.push(stash(lines.slice(i).join('\n')))
      break
    }
    out.push(stash(lines.slice(i, closeAt + 1).join('\n')))
    i = closeAt
  }
  return out.join('\n')
}

/** CommonMark indented code block (≥4 spaces or a tab), outside stashed fences. */
function protectIndentedBlocks(text, stash) {
  const out = []
  let block = []
  const flush = () => {
    if (!block.length) return
    out.push(stash(block.join('\n')))
    block = []
  }
  for (const line of String(text ?? '').split('\n')) {
    if (line.trim() && /^(?: {4,}|\t)/.test(line)) block.push(line)
    else { flush(); out.push(line) }
  }
  flush()
  return out.join('\n')
}

/**
 * Isolate literal code BEFORE chrome-stripping or format detection, so an
 * example can never be rewritten or deleted. Fences and inline spans exist in
 * both formats; the other two are format-specific on purpose:
 *   pre      — HTML code blocks (<pre>) become fenced markdown
 *   indented — Markdown code blocks (≥4 spaces). Never used for HTML, where
 *              that indent is layout: treating it as code would keep the real
 *              <script>/<style> chrome the stripper exists to remove.
 */
function protectCode(s, { indented = false, pre = false } = {}) {
  const slots = []
  // A chunk captured by a later pass can contain a placeholder from an earlier
  // one; resolve those here so the single restore pass at the end always yields
  // real text instead of leaving a placeholder in the output.
  const stash = (chunk) => {
    const i = slots.length
    slots.push(restoreCode(chunk, slots))
    return SLOT(i)
  }
  // Blocks first, inline spans last. Protecting inline code first let an indented
  // block (or <pre>) swallow its placeholder, which corrupted
  // `const message = `keep me`;` and left HTML entities inside a backtick span
  // undecoded, because the later decode never saw the stashed text.
  let text = protectFences(s, stash)
  if (indented) text = protectIndentedBlocks(text, stash)
  if (pre) text = text.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_, inner) => stash(preToFence(inner)))
  text = text.replace(/(`+)((?:(?!\1).)+)\1/g, (full) => stash(full))
  return { text, slots }
}

function restoreCode(s, slots) {
  return String(s ?? '').replace(SLOT_RE, (full, n) => slots[Number(n)] ?? full)
}

/** HTML-derived prose: collapse mid-line junk spaces, keep leading indent (lists). */
function normalizeHtmlText(s) {
  return String(s ?? '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/(\S)[ \t]{2,}/g, '$1 ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** Jina markdown is already clean — never strip leading whitespace. */
function normalizeMarkdown(s) {
  return String(s ?? '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function rewriteBlockquotes(html) {
  return html.replace(/<blockquote\b[^>]*>([\s\S]*?)<\/blockquote>/gi, (_, inner) => {
    const body = stripTags(inner).replace(/\n{3,}/g, '\n\n').trim()
    if (!body) return '\n'
    const quoted = body.split('\n').map((line) => `> ${line}`.replace(/> $/, '>')).join('\n')
    return `\n\n${quoted}\n\n`
  })
}

function htmlToReadable(html, baseUrl) {
  // Code first: dropComments must never see inside a fenced example.
  const guarded = protectCode(html, { pre: true })
  let s = dropComments(guarded.text)
  s = dropNonContent(s)
  s = replaceIframes(s, baseUrl)
  s = dropTrackingPixels(s)
  s = rewriteImages(s, baseUrl)
  s = rewriteLinks(s, baseUrl)
  s = s.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_, n, inner) => (
    `\n\n${'#'.repeat(Number(n))} ${collapseSpace(stripTags(inner))}\n\n`
  ))
  s = s.replace(/<table\b[^>]*>[\s\S]*?<\/table>/gi, (table) => tableToText(table))
  s = rewriteLists(s)
  s = rewriteBlockquotes(s)
  s = s.replace(/<br\s*\/?>/gi, '\n')
  s = s.replace(/<\/(p|div|section|article|header|footer|main|ul|ol|tr)>/gi, '\n\n')
  s = s.replace(/<[^>]+>/g, ' ')
  s = decodeHtml(s)
  return restoreCode(normalizeHtmlText(s), guarded.slots)
}

function htmlToPlainKeepBreaks(html, baseUrl) {
  // Same protections as the readable path: the fallback must not lose evidence either.
  const guarded = protectCode(html, { pre: true })
  let s = dropComments(guarded.text)
  s = dropNonContent(s)
  s = replaceIframes(s, baseUrl)
  s = dropTrackingPixels(s)
  s = rewriteImages(s, baseUrl)
  s = rewriteLinks(s, baseUrl)
  s = rewriteLists(s)
  s = s.replace(/<br\s*\/?>/gi, '\n')
  s = s.replace(/<\/(p|div|h[1-6]|li|tr|section|article|blockquote|header|footer|main)>/gi, '\n\n')
  s = s.replace(/<[^>]+>/g, ' ')
  s = decodeHtml(s)
  return restoreCode(normalizeHtmlText(s), guarded.slots)
}

function preprocessMarkdown(s, baseUrl) {
  const guarded = protectCode(s, { indented: true })
  let out = dropNonContent(guarded.text)
  out = replaceIframes(out, baseUrl)
  out = dropTrackingPixels(out)
  out = rewriteImages(out, baseUrl)
  out = rewriteLinks(out, baseUrl)
  return restoreCode(normalizeMarkdown(out), guarded.slots)
}

export function looksLikeHtml(raw) {
  const s = String(raw ?? '')
  // Isolation first: a fenced HTML example must not decide the whole document's
  // format. Markers inside code are not markup.
  const { text } = protectCode(s)
  const head = text.slice(0, 4000).toLowerCase()
  if (/<!doctype html|<html[\s>]|<body[\s>]/.test(head)) return true
  const tags = (text.match(/<\/?(div|span|section|article|p|table|tr|td|ul|ol|li|h[1-6])[\s>]/gi) || []).length
  const mdMarks = (text.match(/^#{1,6}\s/gm) || []).length + (text.match(/^\s*[-*]\s/gm) || []).length
  return tags >= 8 && tags > mdMarks * 2
}

/**
 * Strip style/script/ad chrome. Never used as a summarizer — if the
 * structured HTML path would drop most of the plain-stripped text, keep
 * that plain strip so agents still see the page.
 *
 * @param {string} raw
 * @param {string} [baseUrl] fetched page URL, used to resolve relative href/src
 */
export function preprocessPage(raw, baseUrl) {
  const input = String(raw ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  if (!input.trim()) return ''
  if (looksLikeHtml(input)) {
    const plain = htmlToPlainKeepBreaks(input, baseUrl)
    const readable = htmlToReadable(input, baseUrl)
    if (meaningfulLen(plain) >= 80 && meaningfulLen(readable) < meaningfulLen(plain) * 0.5) {
      return plain
    }
    return readable
  }
  return preprocessMarkdown(input, baseUrl)
}
