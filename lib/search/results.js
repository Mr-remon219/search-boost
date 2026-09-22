import { SCORE_CONFIG } from './scoring.js'
/** Shared result primitives. No provider, host, credentials, or network dependencies. */
export const collapseSpace = (s) => String(s ?? '').replace(/\s+/g, ' ').trim()

export function hostOf(url) {
  try {
    return new URL(String(url)).hostname.toLowerCase().replace(/^www\./, '')
  } catch {
    const m = /^https?:\/\/([^/?#]+)/i.exec(String(url))
    return m ? m[1].toLowerCase().replace(/^www\./, '') : ''
  }
}

// `ref` may select a branch/version; it is not universally a tracking field.
const TRACKING_PARAM = /^(?:utm_|pk_|mtm_)|^(?:via|fpr|gclid|fbclid|mc_cid|mc_eid)$/i

function stripTrackingQuery(search) {
  if (!search) return ''
  const kept = String(search).replace(/^\?/, '').split('&').filter((kv) => {
    if (!kv) return false
    const k = kv.split('=')[0]
    return !TRACKING_PARAM.test(k)
  })
  return kept.length > 0 ? `?${kept.join('&')}` : ''
}

/** First-seen display URL: drop fragment only, keep path/query case. */
export function displayUrl(url) {
  const s = String(url).trim()
  const hash = s.indexOf('#')
  return hash >= 0 ? s.slice(0, hash) : s
}

/**
 * Dedup key only: lowercase host, strip www / fragment / tracking params /
 * trailing slash. Path and query case are preserved so GitHub raw / S3 keys
 * stay valid when the first-seen URL is returned to the model.
 */
export function normalizeUrl(url) {
  const raw = String(url).trim()
  try {
    const parsed = new URL(raw)
    const host = parsed.hostname.toLowerCase().replace(/^www\./, '')
    const proto = parsed.protocol.toLowerCase()
    const path = parsed.pathname.replace(/\/+$/, '') || ''
    const query = stripTrackingQuery(parsed.search)
    return `${proto}//${host}${parsed.port ? `:${parsed.port}` : ''}${path}${query}`
  } catch {
    const hash = raw.indexOf('#')
    const noFrag = hash >= 0 ? raw.slice(0, hash) : raw
    const q = noFrag.indexOf('?')
    const base = q >= 0 ? noFrag.slice(0, q) : noFrag
    const query = q >= 0 ? stripTrackingQuery(noFrag.slice(q)) : ''
    const m = /^(https?:\/\/)([^/?#]+)(.*)$/i.exec(base)
    if (!m) return `${base.replace(/\/+$/, '')}${query}`
    const host = m[2].toLowerCase().replace(/^www\./, '')
    const path = m[3].replace(/\/+$/, '')
    return `${m[1].toLowerCase()}${host}${path}${query}`
  }
}

const validDay = (day) => Number.isFinite(Date.parse(day)) && new Date(day).toISOString().slice(0, 10) === day

export function parseDate(raw) {
  if (!raw) return null
  const t = String(raw).trim()
  let m = /(\d{4})年(\d{1,2})月(\d{1,2})?日?/.exec(t)
  if (m) {
    const d = `${m[1]}-${m[2].padStart(2, '0')}-${m[3] ? m[3].padStart(2, '0') : '01'}`
    return validDay(d) ? d : null
  }
  m = /([A-Za-z]{3,9})\s+(\d{1,2}),\s*(\d{4})/.exec(t)
  if (m) {
    const MON = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
    const d = `${m[3]}-${String(MON.indexOf(m[1].slice(0, 3).toLowerCase()) + 1).padStart(2, '0')}-${m[2].padStart(2, '0')}`
    return validDay(d) ? d : null
  }
  m = /(\d{4}-\d{2}-\d{2})/.exec(t)
  if (m) return validDay(m[1]) ? m[1] : null
  return null
}

export function normalizeHandle(value) {
  const handle = String(value ?? '').trim().replace(/^@/, '').toLowerCase()
  return /^[a-z0-9_]{1,15}$/.test(handle) ? handle : ''
}

/** Only real X/Twitter post/profile URLs supply identity (never display names). */
export function xIdentity(value) {
  try {
    const url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol) || !/^(?:(?:www|mobile|m)\.)?(?:x|twitter)\.com$/i.test(url.hostname)) return {}
    const post = /^\/(?:([\w]+)|i\/web)\/status\/(\d+)(?:\/|$)/i.exec(url.pathname)
    if (post) return { id: post[2], username: post[1]?.toLowerCase() === 'i' ? '' : normalizeHandle(post[1]) }
    const profile = /^\/([\w]+)\/?$/.exec(url.pathname)
    const username = normalizeHandle(profile?.[1])
    if (username && !['home', 'search', 'explore', 'i', 'intent', 'settings', 'notifications', 'messages', 'compose'].includes(username)) return { username }
  } catch { /* malformed or missing URL */ }
  return {}
}

export function isoDate(value) {
  if (value === undefined || value === null || value === '') return undefined
  const text = String(value)
  const day = /^(\d{4}-\d{2}-\d{2})/.exec(text)?.[1]
  if (day && !validDay(day)) return undefined
  const ms = Date.parse(text)
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined
}


export function normalizeDomains(domains = []) {
  return [...new Set(domains.map((value) => {
    if (typeof value !== 'string' || !value.trim()) throw new Error('Invalid domain filter')
    const domain = hostOf(/^https?:\/\//i.test(value.trim()) ? value.trim() : `https://${value.trim()}`)
    if (!domain) throw new Error('Invalid domain filter')
    return domain
  }))]
}
export const domainMatches = (domain, target) => domain === target || domain.endsWith(`.${target}`)
export function matchesDomains(url, include = [], exclude = []) {
  const alias = (domain) => /^(?:(?:mobile|m)\.)?(?:x|twitter)\.com$/.test(domain) ? 'x.com' : domain
  const domain = alias(hostOf(url))
  include = include.map(alias); exclude = exclude.map(alias)
  return !!domain && !exclude.some((d) => domainMatches(domain, d))
    && (!include.length || include.some((d) => domainMatches(domain, d)))
}
export function normalizeSearchHit(hit) {
  if (!hit || typeof hit.url !== 'string') return null
  let parsed
  try { parsed = new URL(hit.url) } catch { return null }
  if (!['http:', 'https:'].includes(parsed.protocol)) return null
  const identity = xIdentity(hit.url)
  return {
    ...hit, title: String(hit.title || hit.url), url: displayUrl(hit.url),
    domain: hostOf(hit.url), snippet: String(hit.snippet ?? hit.text ?? ''),
    ...(identity.id ? { kind: 'x', id: identity.id, ...(identity.username ? { username: identity.username } : {}) } : { kind: 'web' }),
    published: parseDate(hit.published ?? hit.created_at),
  }
}
/** Twitter aliases and author-less status URLs share a stable post identity. */
export function resultKey(hit) {
  const { id } = xIdentity(hit.url)
  return id ? `x:post:${id}` : normalizeUrl(hit.url)
}
export function dedupeBy(rows, keyOf, merge = (a) => a) {
  const byKey = new Map()
  for (const row of rows) {
    const key = keyOf(row)
    if (!key) continue
    byKey.set(key, byKey.has(key) ? merge(byKey.get(key), row) : row)
  }
  return [...byKey.values()]
}
/** Tri-state checks: unknown metadata must not bypass an explicit constraint. */
export function filterVerified(rows, check) {
  let unknown = 0, rejected = 0
  const items = rows.filter((row) => {
    const result = check(row)
    if (result == null) unknown++
    if (result !== true) rejected++
    return result === true
  })
  return { items, unknown, rejected }
}
export const diversityKey = (row) => row.kind === 'x'
  ? `author:${normalizeHandle(row.username) || 'unknown'}` : `domain:${row.domain || hostOf(row.url)}`

/** Lexical shingles approximate redundant content, not semantic coverage. */
function shingles(row) {
  const tokens = `${row.title ?? ''} ${row.snippet ?? ''}`.toLowerCase().match(/[a-z0-9]+|[\u4e00-\u9fff]/g) ?? []
  if (tokens.length < 8) return null
  return new Set(tokens.slice(0, -2).map((_, i) => tokens.slice(i, i + 3).join(' ')))
}
function similarity(a, b) {
  if (!a || !b) return 0
  const overlap = [...a].filter((s) => b.has(s)).length
  return overlap / (a.size + b.size - overlap)
}

/** Quality score stays immutable; only already-selected rows affect selection.
 * Sparse Web evidence falls back to a domain cap, waived for a single-site query.
 * X author caps remain independent of the x.com hostname.
 */
export function selectDiverse(rows, { limit = 6, minScore = 0, includeDomains = [] } = {}) {
  const pending = rows.filter((row) => Number.isFinite(row.score) && row.score > 0 && row.score >= Math.max(0, minScore))
    .map((row) => ({ row, shingles: shingles(row) }))
  const results = [], selected = [], counts = new Map()
  const singleSite = includeDomains.length === 1
  while (pending.length && results.length < limit) {
    let best = -1, bestScore = -Infinity
    for (const [i, candidate] of pending.entries()) {
      const { row } = candidate
      const n = counts.get(diversityKey(row)) ?? 0
      const cap = row.kind === 'x' ? SCORE_CONFIG.authorCap : !candidate.shingles && !singleSite ? SCORE_CONFIG.sparseDomainCap : Infinity
      if (n >= cap) continue
      const redundancy = Math.max(0, ...selected.map((s) => similarity(candidate.shingles, s.shingles)))
      const selectionScore = row.score - SCORE_CONFIG.diversityPenalty * redundancy
      if (selectionScore > bestScore || (selectionScore === bestScore && resultKey(row).localeCompare(resultKey(pending[best]?.row ?? { url: '' })) < 0)) {
        best = i; bestScore = selectionScore
      }
    }
    if (best < 0) break
    const [candidate] = pending.splice(best, 1)
    selected.push(candidate)
    results.push({ ...candidate.row, selectionScore: bestScore })
    const key = diversityKey(candidate.row)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return { results, truncated: pending.length > 0 }
}
export function resultLimit(value, cap = 10, fallback = 6) {
  const n = Number(value ?? fallback)
  return Math.min(Math.max(1, Number.isFinite(n) ? Math.floor(n) : fallback), cap)
}
