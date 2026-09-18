// Text helpers shared by the evidence extractor and the research loop:
// CJK-aware tokenization / word counting, boundary-aware term matching, and a
// tiny concurrency pool. Ported from pi-search-boost lib/util.ts so the
// evidence math is identical across hosts. Node built-ins only.

export const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'of', 'to', 'in', 'on', 'for', 'with',
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'this', 'that', 'these',
  'those', 'it', 'its', 'as', 'at', 'by', 'from', 'up', 'down', 'out', 'off',
  'over', 'under', 'again', 'then', 'than', 'so', 'too', 'very', 'can', 'will',
  'just', 'do', 'does', 'did', 'have', 'has', 'had', 'what', 'which', 'who',
  'whom', 'when', 'where', 'why', 'how', 'all', 'any', 'both', 'each', 'few',
  'more', 'most', 'other', 'some', 'such', 'no', 'nor', 'not', 'only', 'own',
  'same', 'should', 'about', 'into', 'through', 'during', 'before', 'after',
  'above', 'below', 'between', 'if', 'because', 'until', 'while',
])

/** Characters that whitespace tokenization cannot split: CJK + kana + hangul. */
const CJK_CHAR = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/
const CJK_CHAR_G = new RegExp(CJK_CHAR.source, 'g')
const CJK_RUN_G = new RegExp(`${CJK_CHAR.source}{2,}`, 'g')

/** Chinese particles that dominate segmenter output and wreck coverage scoring. */
const CJK_STOPWORDS = new Set([
  '的', '了', '和', '是', '在', '有', '与', '及', '或', '对', '把', '被', '从', '到',
  '为', '以', '而', '并', '也', '还', '就', '都', '很', '更', '最', '个', '中', '上',
  '下', '这', '那', '什么', '怎么', '如何', '为什么', '哪些', '可以', '使用', '一个',
  '我们', '他们', '它', '吗', '呢', '吧', '着', '过', '地', '得', '所以', '因为',
])

/** ICU word segmentation for CJK; falls back to whole runs where unavailable. */
const cjkSegmenter = (() => {
  try {
    return new Intl.Segmenter('zh-Hans', { granularity: 'word' })
  } catch {
    return null
  }
})()

/**
 * Segment a CJK run into words. Chinese has no spaces, so a run like
 * 多头注意力机制 must be split before it can be matched against page text —
 * matching the whole run only succeeds on a verbatim repetition of the query.
 */
export function segmentCjk(run) {
  if (!cjkSegmenter) return [run]
  const raw = [...cjkSegmenter.segment(run)].filter((s) => s.isWordLike).map((s) => s.segment)
  const out = []
  let carry = ''
  for (const s of raw) {
    if (s.length === 1 && !CJK_STOPWORDS.has(s)) {
      carry += s
      continue
    }
    if (carry) {
      out.push(carry + s)
      carry = ''
      continue
    }
    out.push(s)
  }
  if (carry) out.push(carry)
  return out.filter((t) => t.length >= 2 && !CJK_STOPWORDS.has(t))
}

/** Latin tokens (len >= 2, non-stopword) plus dictionary-segmented CJK words. */
export function tokenize(text) {
  const out = []
  const s = String(text ?? '')
  for (const run of s.match(CJK_RUN_G) ?? []) out.push(...segmentCjk(run))
  const words = s
    .toLowerCase()
    .replace(CJK_CHAR_G, ' ')
    .match(/[a-z0-9][a-z0-9'._-]*/g) ?? []
  for (const w of words) {
    if (w.length >= 2 && !STOPWORDS.has(w)) out.push(w)
  }
  return out
}

/** Terms used for evidence coverage scoring: latin tokens + segmented CJK words. */
export function evidenceTerms(query) {
  return tokenize(query)
}

/**
 * Length of a text in comparable "words". CJK text has no spaces, so
 * `split(/\s+/).length` reports a Chinese page as a handful of words and every
 * word-count threshold then misfires. Chinese averages ~1.6 characters per word.
 */
export function countWords(text) {
  if (!text || !String(text).trim()) return 0
  const s = String(text)
  const cjk = (s.match(CJK_CHAR_G) ?? []).length
  const latin = s.replace(CJK_CHAR_G, ' ').trim().split(/\s+/).filter(Boolean).length
  return latin + Math.ceil(cjk / 1.6)
}

/** Frequency-ranked distinctive terms of a text. */
export function distinctiveTerms(text, n) {
  const counts = new Map()
  for (const t of tokenize(text)) counts.set(t, (counts.get(t) ?? 0) + 1)
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([t]) => t)
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Boundary-aware term match: Latin `lts` must not match `results`; CJK stays substring-based. */
export function containsSearchTerm(text, term) {
  if (!term) return false
  const hay = String(text ?? '')
  if (CJK_CHAR.test(term)) return hay.includes(term)
  const escaped = escapeRe(term.toLowerCase())
  const start = /^[a-z0-9]/i.test(term) ? '(?:^|[^a-z0-9])' : ''
  const end = /[a-z0-9]$/i.test(term) ? '(?=$|[^a-z0-9])' : ''
  return new RegExp(`${start}${escaped}${end}`, 'i').test(hay.toLowerCase())
}

/** Boundary-aware global matcher for relevance scoring. */
export function searchTermRegExp(term) {
  const escaped = escapeRe(term.toLowerCase())
  if (CJK_CHAR.test(term)) return new RegExp(escaped, 'g')
  const start = /^[a-z0-9]/i.test(term) ? '(?:^|[^a-z0-9])' : ''
  const end = /[a-z0-9]$/i.test(term) ? '(?=$|[^a-z0-9])' : ''
  return new RegExp(`${start}${escaped}${end}`, 'g')
}

/** Run async tasks with bounded concurrency, preserving input order. */
export async function pool(items, limit, fn) {
  const results = new Array(items.length)
  let next = 0
  async function worker() {
    while (next < items.length) {
      const i = next++
      results[i] = await fn(items[i], i)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

/** Throw consistently when the caller cancelled an operation. */
export function throwIfAborted(signal) {
  if (!signal?.aborted) return
  if (signal.reason instanceof Error) throw signal.reason
  throw new Error('aborted')
}

export function nowIso() {
  return new Date().toISOString()
}
