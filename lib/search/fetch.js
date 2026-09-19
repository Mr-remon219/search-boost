// Page fetch: Jina Reader first (curl UA), local HTML fallback for blocked
// sites, then conservative preprocess (drop CSS/JS/ad chrome, keep every
// heading / table / code / link, resolve relative URLs). 24h TTL in-memory
// cache stores the preprocessed text; optional focus filtering happens at
// read time. Returned content is not character-clipped.
//
// Privacy: the Jina path sends the target URL to r.jina.ai (third party).
// Local fallback never follows redirects or DNS names into private space.

import { queryTerms, collapseSpace, normalizeUrl } from './fusion.js'
import { ipv4Fetch } from './ipv4-fetch.js'
import { preprocessPage } from './page-preprocess.js'
import { assertPublicHttpUrl, guardedFetch, isSsrfError, mergeSignals, readLimited, SsrfError } from './ssrf.js'
import { countWords } from './text.js'

const PAGE_TTL_MS = 24 * 3600 * 1000
/** Download safety only — not an agent-facing clip. Long docs stay intact. */
const PAGE_MAX_RAW_BYTES = 8_000_000

function focusFilter(text, focus) {
  if (!focus) return text
  const terms = queryTerms(focus)
  if (terms.length === 0) return text
  const paras = String(text ?? '').split(/\n{2,}/)
  const out = []
  for (let i = 0; i < paras.length; i++) {
    const low = paras[i].toLowerCase()
    const hit = terms.some((t) => low.includes(t))
    if (hit) {
      if (i > 0 && out[out.length - 1] !== paras[i - 1]) out.push(paras[i - 1])
      out.push(paras[i])
      if (i + 1 < paras.length) out.push(paras[i + 1])
    }
  }
  return out.join('\n\n')
}

export function makePageCache(maxEntries = 100) {
  const map = new Map()
  return {
    get(key) {
      const entry = map.get(key)
      if (!entry) return undefined
      if (Date.now() - entry.ts > PAGE_TTL_MS) {
        map.delete(key)
        return undefined
      }
      return entry.value
    },
    set(key, value) {
      if (maxEntries > 0 && map.size >= maxEntries && !map.has(key)) {
        const oldest = map.keys().next().value
        if (oldest !== undefined) map.delete(oldest)
      }
      map.set(key, { ts: Date.now(), value })
    },
    size: () => map.size,
    clear: () => map.clear(),
  }
}

export function toFetchPageResult(url, via, content, focus, cacheHit, started) {
  const focused = focusFilter(content, focus)
  const trimmed = collapseSpace(focused)
  const focusMiss = Boolean(focus && trimmed.length === 0 && collapseSpace(content).length > 0)
  return {
    url,
    via,
    fetched_at: new Date().toISOString(),
    word_count: countWords(focused),
    content: focused,
    truncated: false,
    focusMiss,
    cacheHit,
    tookMs: Date.now() - started,
  }
}

/**
 * @param {string} url
 * @param {string|undefined} focus
 * @param {ReturnType<typeof makePageCache>} cache
 * @param {AbortSignal} [signal]
 * @param {object} [_opts] — accepted for host compat; content is never clipped
 */
export async function fetchPage(url, focus, cache, signal, _opts = {}) {
  const started = Date.now()
  const target = String(url ?? '').trim()
  await assertPublicHttpUrl(target)
  const cacheKey = `page:${normalizeUrl(target)}`
  const cached = cache.get(cacheKey)
  if (cached) return toFetchPageResult(target, 'cache', cached, focus, true, started)

  let content = ''
  let via = 'jina'
  try {
    const res = await ipv4Fetch(`https://r.jina.ai/${encodeURIComponent(target)}`, {
      headers: { 'user-agent': 'curl/8.5.0', 'x-return-format': 'markdown' },
      signal: mergeSignals(signal, 25000),
    })
    if (!res.ok) throw new Error(`jina http ${res.status}`)
    content = await readLimited(res, PAGE_MAX_RAW_BYTES)
  } catch (err) {
    if (isSsrfError(err) || err instanceof SsrfError) throw err
    via = 'local'
    content = await localFetch(target, signal)
  }
  if (collapseSpace(content).length < 80) {
    via = 'local'
    try {
      content = await localFetch(target, signal)
    } catch (err) {
      if (isSsrfError(err)) throw err
    }
  }

  // Jina is asked for markdown; the local fallback fetched the page itself (HTML).
  content = preprocessPage(content, target, { format: via === 'jina' ? 'markdown' : 'html' })

  // only remember bodies with real text — a short error page or an empty
  // local fallback must not poison the 24h cache
  if (collapseSpace(content).length >= 80) {
    cache.set(cacheKey, content)
  }
  return toFetchPageResult(target, via, content, focus, false, started)
}

async function localFetch(url, signal) {
  const res = await guardedFetch(url, {
    headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
    timeoutMs: 20000,
    signal,
  })
  if (!res.ok) throw new Error(`local http ${res.status}`)
  return readLimited(res, PAGE_MAX_RAW_BYTES)
}
