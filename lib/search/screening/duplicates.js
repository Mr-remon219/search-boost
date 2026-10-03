// Near-duplicate document identity for screening selection. Deliberately a
// word-level heuristic, NOT reliable semantic dedup (design doc §4.6). It
// combines a normalized URL document stem, version compatibility and
// title/text overlap. Exercised against the frozen ablation fixture in
// scripts/test-screening-ablation.mjs, which includes deliberate near-miss
// guards: two different `duckdb-vs-sqlite` articles sharing a URL basename,
// MDN vs Node.js AbortSignal docs with similar titles, and versioned snapshots
// of the same manual page that must NOT be treated as one document.
//
// KNOWN LIMIT: cross-domain pages that share a slug AND a title fold even when
// their bodies differ (the fixture also requires cross-domain title folds like
// C1/C10 and B6/B8, so precision cannot be fixed by title alone). This is why
// the controller keeps folding OFF by default; it is explicit opt-in until an
// out-of-sample set with negative pairs validates a stricter rule.

const STOP_STEMS = new Set(['index', 'overview', 'readme', 'docs', 'documentation', 'home', 'main', 'default', 'login', 'about', 'contact', 'search', 'download', 'article', 'post', 'blog'])
const TITLE_SIMILARITY = 0.5
const TEXT_SIMILARITY = 0.6
const versionToken = /^\d+$|^v?\d+(\.\d+)+$/

const words = (text) => String(text ?? '').toLowerCase().match(/[a-z0-9]+/g) ?? []

/** Normalized document stem from the URL basename; '' when too generic to use.
 * Trailing version segments (…/git-sparse-checkout/2.55.0) are skipped so a
 * versioned docs path shares its canonical document stem — found by the
 * frozen ablation fixture (C9 must fold into C1). */
export function docStem(url) {
  try {
    const segments = new URL(url).pathname.split('/').filter(Boolean)
    let i = segments.length - 1
    while (i > 0 && /^v?\d+(\.\d+)*$/.test(segments[i])) i--
    const base = (segments[i] ?? '').toLowerCase().replace(/\.(html?|adoc|md|markdown|txt|1\.en|en)$/i, '')
    return base.length >= 4 && !STOP_STEMS.has(base) ? base : ''
  } catch {
    return ''
  }
}

/** Major version visible in url+title, or null when unversioned. */
export function versionMajor(url, title) {
  const match = /\bv?(\d+)\.\d+/.exec(`${url} ${title}`)
  return match ? match[1] : null
}

/** Title words with version tokens stripped, so version drift does not hide identity. */
export function titleTokens(title) {
  return new Set(words(title).filter((token) => !versionToken.test(token)))
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0
  let overlap = 0
  for (const token of a) if (b.has(token)) overlap++
  return overlap / (a.size + b.size - overlap)
}

/** Trigram shingle set over title+text, or null when the item is too short to
 * compare. Exported so callers can precompute it once per candidate instead of
 * rebuilding it for every pair in a list-selection loop. */
export function textShingles(item) {
  const tokens = words(`${item.title} ${item.text}`)
  if (tokens.length < 8) return null
  return new Set(tokens.slice(0, -2).map((_, i) => tokens.slice(i, i + 3).join(' ')))
}

/** Jaccard overlap of two precomputed shingle sets; 0 when either is absent.
 * `textShingles` returns null for short items, so the guard belongs here — the
 * shared `jaccard` dereferences `.size` and would raise on a null set. */
export function shingleOverlap(left, right) {
  return left && right ? jaccard(left, right) : 0
}

/** Trigram similarity over title+text; 0 when either side is too short to compare. */
export function textSimilarity(a, b) {
  const left = textShingles(a), right = textShingles(b)
  return left && right ? jaccard(left, right) : 0
}

/**
 * True when `candidate` is a duplicate entry of the same underlying document as
 * `representative`. Same stem required; explicit different versions are kept as
 * distinct evidence; then title or text overlap must confirm the identity.
 */
export function foldsInto(candidate, representative) {
  const stem = docStem(candidate.url)
  if (!stem || stem !== docStem(representative.url)) return false
  const left = versionMajor(candidate.url, candidate.title)
  const right = versionMajor(representative.url, representative.title)
  if (left !== null && right !== null && left !== right) return false
  return jaccard(titleTokens(candidate.title), titleTokens(representative.title)) >= TITLE_SIMILARITY
    || textSimilarity(candidate, representative) >= TEXT_SIMILARITY
}
