// Fast path: origin GET (Undici, optional same-route curl compatibility fallback)
// and local cleanup. Jina Reader is a backup for failed/empty origin content,
// not a mandatory extra network hop. Cleaned text is cached for 24 hours; focus
// filtering, PDF text extraction and windowing run at read time.
//
// Bytes are read before they are interpreted: a PDF is parsed into text and any
// other binary body is refused, so a non-text response can never be handed to a
// caller as page content. Long text is returned in bounded windows (see
// windowPageResult) while the full body stays in the cache, so continuing a read
// costs no second request. Jina sends the target URL to a third party only if
// that backup is used.

import { queryTerms, collapseSpace } from './fusion.js'
import { ipv4Fetch } from './ipv4-fetch.js'
import { preprocessPage } from './page-preprocess.js'
import { assertStaticHttpUrl, guardedFetch, mergeSignals, readLimitedBytes, SsrfError, pageResponseUrl } from './ssrf.js'
import { NET_ERROR_KINDS } from './net-policy.mjs'
import { countWords } from './text.js'
import { extractPdfText, isPlausibleText, looksBinary, looksBinaryType, looksLikePdf, normalizePdfText } from './pdf.js'

const PAGE_TTL_MS = 24 * 3600 * 1000
/** Download safety only — not an agent-facing clip. Long docs stay intact. */
const PAGE_MAX_RAW_BYTES = 8_000_000
/** Model-facing window per call; the cached body is never clipped. */
export const PAGE_WINDOW_CHARS = 60_000

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

export function toFetchPageResult(url, via, content, focus, cacheHit, started, sourceUrl = url) {
  const focused = focusFilter(content, focus)
  const trimmed = collapseSpace(focused)
  const focusMiss = Boolean(focus && trimmed.length === 0 && collapseSpace(content).length > 0)
  return {
    url: sourceUrl,
    ...(sourceUrl !== url ? { requestedUrl: url } : {}),
    via,
    fetched_at: new Date().toISOString(),
    word_count: countWords(focused),
    content: focused,
    totalChars: focused.length,
    offset: 0,
    truncated: false,
    focusMiss,
    cacheHit,
    tookMs: Date.now() - started,
  }
}

/**
 * One bounded step of a long body. An exact character range, never a summary:
 * the result reports where it starts and which offset continues it (nextOffset
 * is present only while more content follows), and the 24h cache makes that
 * continuation a cache hit. `windowChars: Infinity` keeps the whole body for
 * internal callers (the adaptive pool ingests pages itself).
 */
export function windowPageResult(result, offset = 0, windowChars = PAGE_WINDOW_CHARS) {
  const full = String(result.content ?? '')
  const total = full.length
  const start = Number.isFinite(offset) ? Math.max(0, Math.trunc(offset)) : 0
  const width = Number.isFinite(windowChars) ? Math.max(1, Math.trunc(windowChars)) : total
  const content = full.slice(start, Math.min(total, start + width))
  const end = start + content.length
  const pastEnd = content.length === 0 && start >= total && total > 0
  const nextOffset = !pastEnd && end < total ? end : null
  const windowNote = pastEnd
    ? `offset ${start} is past the end of the ${total}-character body; call fetch_page again without offset to restart`
    : nextOffset !== null
      ? `characters ${start}–${end} of ${total}; call fetch_page again with offset=${nextOffset} for the rest`
      : null
  const out = {
    ...result,
    content,
    word_count: countWords(content),
    totalChars: total,
    offset: start,
    truncated: Boolean(result.truncated || result.limitation?.kind === 'pdf_truncated') || nextOffset !== null || start > 0,
  }
  // Window-owned fields are set here and never inherited from the full body:
  // an absent nextOffset is the documented "this was the last window" signal.
  if (nextOffset === null) delete out.nextOffset
  else out.nextOffset = nextOffset
  if (windowNote) out.windowNote = windowNote
  return out
}

/**
 * @param {string} url
 * @param {string|undefined} focus
 * @param {ReturnType<typeof makePageCache>} cache
 * @param {AbortSignal} [signal]
 * @param {{ offset?: number, windowChars?: number }} [opts] — model-facing window of the cached body
 */
export async function fetchPage(url, focus, cache, signal, opts = {}) {
  const started = Date.now()
  const target = String(url ?? '').trim()
  if (signal?.aborted) throw new SsrfError('fetch_page: cancelled before start', NET_ERROR_KINDS.cancelled)
  assertStaticHttpUrl(target)
  const requestUrl = new URL(target)
  requestUrl.hash = '' // fragments are not sent in HTTP requests; preserve every query parameter
  const cacheKey = `page:${requestUrl.href}`
  const cached = cache.get(cacheKey)
  if (cached) {
    // Accept historical string entries; new entries retain extraction limits so
    // cached continuation never turns a partial PDF into an apparently full one.
    const body = typeof cached === 'string' ? cached : cached.content
    const result = toFetchPageResult(target, 'cache', body, focus, true, started, cached.url ?? target)
    if (cached.limitation) result.limitation = { ...cached.limitation }
    return windowPageResult(result, opts.offset, opts.windowChars)
  }

  const combined = mergeSignals(signal, 40_000)
  let content = ''
  let via = 'local'
  let localError = null
  let limitation = null
  let sourceUrl = target
  try {
    const origin = await localFetch(target, combined)
    sourceUrl = origin.baseUrl
    if (looksLikePdf(origin.bytes, origin.contentType)) {
      // A PDF becomes its text, or it becomes an error — never raw bytes.
      const extracted = await extractPdfText(origin.bytes, { signal: combined, parser: opts.pdfParser })
      if (combined.aborted || extracted.reason === 'cancelled') throw abortFailure(signal)
      if (extracted.ok && isPlausibleText(extracted.text)) {
        content = normalizePdfText(extracted.text)
        via = 'pdf'
        if (extracted.truncated) {
          limitation = { kind: 'pdf_truncated', message: `extracted ${extracted.pages} of ${extracted.totalPages} page(s), ${extracted.chars} characters` }
        }
      } else {
        localError = pdfTextFailure(extracted)
      }
    } else if (looksBinaryType(origin.contentType) || looksBinary(origin.bytes)) {
      localError = new SsrfError(`fetch_page: response is not text (${origin.contentType || 'binary body'}); refusing to deliver it as page content`, NET_ERROR_KINDS.unsupported)
    } else {
      const decoded = origin.bytes.toString('utf8')
      // Text in another charset decodes into replacement characters. That is the
      // same failure as binary delivery — unreadable content that looks like a
      // successful read — so the reader backup gets the chance to decode it.
      if (undecodableShare(decoded) > 0.2) {
        localError = new SsrfError('fetch_page: page bytes are not decodable text (charset mismatch or binary body); refusing to deliver them as page content', NET_ERROR_KINDS.unsupported)
      } else {
        content = preprocessPage(decoded, origin.baseUrl, { format: 'html' })
      }
    }
  } catch (err) {
    if (terminalFetchFailure(err, combined)) throw err
    localError = localError ?? err
    if (err.sourceUrl) sourceUrl = err.sourceUrl
  }
  // A useful origin response wins immediately: no Jina request, no second GET.
  if (collapseSpace(content).length < 80) {
    try {
      const res = await ipv4Fetch(`https://r.jina.ai/${encodeURIComponent(sourceUrl)}`, {
        headers: { 'user-agent': 'curl/8.5.0', 'x-return-format': 'markdown' },
        signal: combined,
      })
      if (!res.ok) {
        try { await res.body?.cancel() } catch { /* release unused response */ }
        throw new Error(`jina http ${res.status}`)
      }
      const readerBytes = await readLimitedBytes(res, PAGE_MAX_RAW_BYTES)
      // The reader may proxy the payload unchanged, or decode it in the wrong
      // charset; neither may become text.
      if (looksBinaryType(res.headers.get('content-type')) || looksLikePdf(readerBytes) || looksBinary(readerBytes)) throw new Error('reader returned binary content')
      const readerText = readerBytes.toString('utf8')
      if (undecodableShare(readerText) > 0.2) throw new Error('reader returned undecodable text')
      // Reader URL Source metadata belongs to the wrapper, not page prose.
      // Do not use the reader service's own response URL as the source URL.
      const readerUrl = readerSourceUrl(readerText) ?? sourceUrl
      const reader = preprocessPage(readerText, readerUrl, { format: 'markdown' })
      if (collapseSpace(reader).length > collapseSpace(content).length) {
        content = reader
        sourceUrl = readerUrl
        via = 'jina'
        limitation = null // a local truncation note no longer describes what is returned
        localError = null
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
    const entry = { content, url: sourceUrl, ...(limitation ? { limitation: { ...limitation } } : {}) }
    cache.set(cacheKey, entry)
    // Both the requested alias and actual source support cached continuation.
    const finalUrl = new URL(sourceUrl)
    finalUrl.hash = ''
    const finalKey = `page:${finalUrl.href}`
    if (finalKey !== cacheKey) cache.set(finalKey, entry)
  }
  const result = toFetchPageResult(target, via, content, focus, false, started, sourceUrl)
  if (limitation) result.limitation = limitation
  return windowPageResult(result, opts.offset, opts.windowChars)
}

// Only accept the reader's pre-body metadata header, never a URL Source line
// embedded in the article. URL policy still rejects credentials/non-http URLs.
function readerSourceUrl(text) {
  const header = String(text).split(/^Markdown Content:\s*$/m, 1)[0]
  if (header === text || header.length > 4096) return null
  const value = /^URL Source:\s*(https?:\/\/[^\s]+)\s*$/m.exec(header)?.[1]
  if (!value) return null
  try { assertStaticHttpUrl(value); return new URL(value).href } catch { return null }
}

/** Share over the bounded decoded body, including non-UTF-8 tails. */
function undecodableShare(text) {
  const sample = String(text ?? '')
  if (!sample.length) return 0
  return (sample.match(/\uFFFD/g) ?? []).length / sample.length
}
/** Why a PDF could not be read, in the caller's terms. */
function pdfTextFailure(extracted) {
  const reason = {
    parser_unavailable: 'no local PDF text extractor is installed',
    password_protected: 'the PDF is password protected',
    no_text: 'the PDF has no extractable text (scanned images need OCR)',
    empty_body: 'the PDF body was empty',
    extract_failed: 'the PDF text could not be extracted',
  }[extracted.reason] ?? 'the PDF text could not be extracted'
  return new SsrfError(`fetch_page: ${reason}${extracted.detail ? ` (${extracted.detail})` : ''}`, NET_ERROR_KINDS.unsupported)
}

/** Cancellation during local extraction keeps the caller's own reason. */
function abortFailure(signal) {
  return signal?.aborted
    ? new SsrfError('fetch_page: cancelled during PDF text extraction', NET_ERROR_KINDS.cancelled)
    : new SsrfError('fetch_page: deadline reached during PDF text extraction', NET_ERROR_KINDS.deadline)
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
    const baseUrl = pageResponseUrl(res) || url
    try {
      if (!res.ok) {
        try { await res.body?.cancel() } catch { /* release unused response */ }
        throw new Error(`local http ${res.status}`)
      }
      return { bytes: await readLimitedBytes(res, PAGE_MAX_RAW_BYTES), contentType: res.headers.get('content-type') ?? '', baseUrl }
    } catch (err) {
      // A known redirect destination remains the source even if its HTTP/body
      // fails and the reader supplies the text instead.
      err.sourceUrl = baseUrl
      throw err
    }
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
