// Fast path: origin GET (Undici, optional same-route curl compatibility fallback)
// and local cleanup. Jina Reader is a backup for failed/empty origin content,
// not a mandatory extra network hop. Cleaned text is cached for 24 hours; focus
// filtering runs at read time. Jina sends the target URL to a third party only
// if that backup is used.

import { queryTerms, collapseSpace } from './fusion.js'
import { ipv4Fetch } from './ipv4-fetch.js'
import { preprocessPage } from './page-preprocess.js'
import { assertStaticHttpUrl, guardedFetch, mergeSignals, readLimited, SsrfError, pageResponseUrl } from './ssrf.js'
import { NET_ERROR_KINDS } from './net-policy.mjs'
import { countWords } from './text.js'

const PAGE_TTL_MS = 24 * 3600 * 1000
/** Download safety only — not an agent-facing clip. Long docs stay intact. */
const PAGE_MAX_RAW_BYTES = 8_000_000

function focusFilter(text, focus) {
  if (!focus) return text
  const terms = queryTerms(focus)
  if (terms.length === 0) return text
  const paras = String(text ?? '').split(/\n{2,}/)
  const selected = new Set()
  for (let i = 0; i < paras.length; i++) {
    if (terms.some((term) => paras[i].toLowerCase().includes(term))) {
      // Merge overlapping context windows by index, not paragraph contents:
      // identical paragraphs at distinct positions are still real evidence.
      for (let j = Math.max(0, i - 1); j <= Math.min(paras.length - 1, i + 1); j++) selected.add(j)
    }
  }
  return [...selected].sort((a, b) => a - b).map((index) => paras[index]).join('\n\n')
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
  if (signal?.aborted) throw new SsrfError('fetch_page: cancelled before start', NET_ERROR_KINDS.cancelled)
  assertStaticHttpUrl(target)
  const requestUrl = new URL(target)
  requestUrl.hash = '' // fragments are not sent in HTTP requests; preserve every query parameter
  const cacheKey = `page:${requestUrl.href}`
  const cached = cache.get(cacheKey)
  if (cached) return toFetchPageResult(target, 'cache', cached, focus, true, started)

  const combined = mergeSignals(signal, 40_000)
  let content = ''
  let via = 'local'
  let localError = null
  let limitation = null
  try {
    const origin = await localFetch(target, combined)
    content = preprocessPage(origin.content, origin.baseUrl, { format: 'html' })
  } catch (err) {
    if (terminalFetchFailure(err, combined)) throw err
    localError = err
  }
  // A useful origin response wins immediately: no Jina request, no second GET.
  if (collapseSpace(content).length < 80) {
    try {
      const res = await ipv4Fetch(`https://r.jina.ai/${encodeURIComponent(target)}`, {
        headers: { 'user-agent': 'curl/8.5.0', 'x-return-format': 'markdown' },
        signal: combined,
      })
      if (!res.ok) {
        try { await res.body?.cancel() } catch { /* release unused response */ }
        throw new Error(`jina http ${res.status}`)
      }
      const reader = preprocessPage(await readLimited(res, PAGE_MAX_RAW_BYTES), target, { format: 'markdown' })
      if (collapseSpace(reader).length > collapseSpace(content).length) {
        content = reader
        via = 'jina'
      }
      if (!collapseSpace(content)) throw new Error('fetch_page: origin and reader returned no readable content')
    } catch (err) {
      if (signal?.aborted) throw err
      if (localError || !collapseSpace(content)) {
        if (terminalFetchFailure(err, combined)) throw err
        const failure = localError ?? err
        if (failure !== err) {
          failure.readerCause = err
          failure.message = `${failure.message}; reader failed: ${err.message}`
        }
        throw failure
      }
      // Do not discard useful short origin content just because Jina is down.
      limitation = { kind: err.kind ?? NET_ERROR_KINDS.http, message: `reader unavailable: ${err.message}` }
    }
  }

  // only remember bodies with real text — a short error page or an empty
  // local fallback must not poison the 24h cache
  if (collapseSpace(content).length >= 80) {
    cache.set(cacheKey, content)
  }
  const result = toFetchPageResult(target, via, content, focus, false, started)
  if (limitation) result.limitation = limitation
  return result
}

function terminalFetchFailure(err, signal) {
  return signal?.aborted || [NET_ERROR_KINDS.cancelled,
    NET_ERROR_KINDS.blockedHost, NET_ERROR_KINDS.blockedAddress, NET_ERROR_KINDS.tls,
    NET_ERROR_KINDS.responseTooLarge, NET_ERROR_KINDS.proxyConfig, NET_ERROR_KINDS.proxyUnsupported].includes(err?.kind)
}

async function localFetch(url, signal) {
  // Both origin transports share this stage budget; a body retry cannot mint
  // another 20 seconds and consume the reader backup's remaining time.
  const stageSignal = mergeSignals(signal, 20_000)
  const options = {
    headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
    timeoutMs: 20000,
    signal: stageSignal,
  }
  const read = async (res) => {
    if (!res.ok) {
      try { await res.body?.cancel() } catch { /* release unused response */ }
      throw new Error(`local http ${res.status}`)
    }
    return { content: await readLimited(res, PAGE_MAX_RAW_BYTES), baseUrl: pageResponseUrl(res) || url }
  }
  const res = await guardedFetch(url, options)
  try { return await read(res) } catch (err) {
    const code = err?.cause?.code ?? err?.code ?? ''
    if (terminalFetchFailure(err, signal) || !['UND_ERR_SOCKET', 'ECONNRESET', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_RES_CONTENT_LENGTH_MISMATCH'].includes(code)) throw err
    // This is a repeatable GET; do not replay API POSTs or bypass URL/TLS checks.
    try { return await read(await guardedFetch(url, { ...options, transport: 'curl' })) } catch (curlError) {
      curlError.primaryCause = err
      throw curlError
    }
  }
}
