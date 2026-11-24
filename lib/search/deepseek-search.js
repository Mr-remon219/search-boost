// Official DeepSeek Search API only. One engine id, one wire protocol.
// The retired Anthropic messages + web_search_20250305 path is not called,
// not used as fallback, and not kept behind the same key.
import { normalizeEngineBaseUrl } from '../engine-endpoints.mjs'
import { readLimited } from './ssrf.js'
import { ipv4Fetch } from './ipv4-fetch.js'

export const DEEPSEEK_ENGINE = 'deepseek-search'
export const PASSTHROUGH_QUERY_ENGINES = new Set([DEEPSEEK_ENGINE])
export const DEEPSEEK_SEARCH_ORIGIN = 'https://api.deepseek.com'
export const DEEPSEEK_SEARCH_PATH = '/v1/tools/search'
export const DEEPSEEK_SEARCH_ENDPOINT = `${DEEPSEEK_SEARCH_ORIGIN}${DEEPSEEK_SEARCH_PATH}`
/** 0.3.0 default base. A stored copy of this exact value is the old default, not a second protocol. */
export const LEGACY_DEEPSEEK_MESSAGES_BASE = 'https://api.deepseek.com/anthropic/v1'
/**
 * Official text says 1–128 Unicode characters. It does not define code points,
 * UTF-16 code units, or grapheme clusters. This adapter counts Unicode scalar
 * values (code points) and never truncates. Not verified against a live account.
 */
export const DEEPSEEK_UNICODE_COUNT = 'unicode scalar values (code points)'
/** Extra attempts after the first. Only HTTP 408, 429, and 5xx. */
export const DEEPSEEK_RETRY_LIMIT = 2
const RETRY_WAIT_MS = [20, 40]
/** A Retry-After longer than this is over budget: stop, do not sleep it, and do not substitute the short backoff. */
const MAX_RETRY_AFTER_MS = 1000

/**
 * Milliseconds to wait before another try, or null when this response must not be retried.
 * Integer seconds: 0 and 1 wait; larger integers stop.
 * HTTP-date is compared with `now`. A past or current time waits 0. A future time within
 * the budget waits that long. A future time past the budget stops. An unparseable value stops.
 * A missing header uses the short backoff.
 */
export function retryWaitMs(attempt, retryAfter, now = Date.now()) {
  if (retryAfter == null || String(retryAfter).trim() === '') {
    return RETRY_WAIT_MS[Math.min(Math.max(attempt, 1) - 1, RETRY_WAIT_MS.length - 1)]
  }
  const text = String(retryAfter).trim()
  if (/^\d+$/.test(text)) {
    const seconds = Number(text)
    if (seconds > MAX_RETRY_AFTER_MS / 1000) return null
    return seconds * 1000
  }
  const when = Date.parse(text)
  if (!Number.isFinite(when)) return null
  const delta = when - now
  if (delta > MAX_RETRY_AFTER_MS) return null
  return Math.max(0, delta)
}

export function unicodeLength(value) {
  return Array.from(String(value ?? '')).length
}

function fail(message, kind) {
  return Object.assign(new Error(message), { kind })
}

export function assertDeepseekQuery(query) {
  if (typeof query !== 'string') throw fail('deepseek-search: query must be 1–128 Unicode code points and not whitespace', 'invalid_request')
  const count = unicodeLength(query)
  if (count < 1 || count > 128 || query.trim().length === 0) {
    throw fail(`deepseek-search: query must be 1–128 Unicode code points and not whitespace (counted ${count}; not truncated)`, 'invalid_request')
  }
  return query
}

export function assertDeepseekCount(count) {
  if (count == null) return 10
  if (!Number.isSafeInteger(count) || count < 1 || count > 50) {
    throw fail('deepseek-search: count must be an integer from 1 to 50', 'invalid_request')
  }
  return count
}

export function assertDeepseekOriQuestion(value) {
  if (value == null) return undefined
  if (typeof value !== 'string') throw fail('deepseek-search: ori_question must be 1–128 Unicode code points when provided', 'invalid_request')
  const count = unicodeLength(value)
  if (count < 1 || count > 128 || value.trim().length === 0) {
    throw fail(`deepseek-search: ori_question must be 1–128 Unicode code points when provided (counted ${count}; not truncated)`, 'invalid_request')
  }
  return value
}

/** Request body for the Search API. localization is never sent. need_content defaults false. */
export function deepseekRequestBody({ query, count, oriQuestion, needContent = false } = {}) {
  const body = {
    query: assertDeepseekQuery(query),
    count: assertDeepseekCount(count),
    need_content: needContent === true,
  }
  const original = assertDeepseekOriQuestion(oriQuestion)
  if (original !== undefined) body.ori_question = original
  return body
}

export function isLegacyMessagesBase(value) {
  try { return normalizeEngineBaseUrl(value) === LEGACY_DEEPSEEK_MESSAGES_BASE } catch { return false }
}

export function deepseekSearchUrl(base) {
  const normalized = normalizeEngineBaseUrl(base ?? DEEPSEEK_SEARCH_ORIGIN)
  if (normalized === LEGACY_DEEPSEEK_MESSAGES_BASE || normalized === DEEPSEEK_SEARCH_ORIGIN) return DEEPSEEK_SEARCH_ENDPOINT
  let url
  try { url = new URL(normalized) } catch { throw fail('deepseek-search: invalid base URL', 'invalid_request') }
  if (/\/anthropic(?:\/|$)/i.test(url.pathname) || /\/messages$/i.test(url.pathname)) {
    throw fail('deepseek-search: stored base URL is the retired messages endpoint. Restore the default Search API base. No request was sent.', 'legacy_endpoint')
  }
  return `${normalized}${DEEPSEEK_SEARCH_PATH}`
}

function httpUrl(value) {
  if (typeof value !== 'string') return ''
  try {
    const url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !url.hostname) return ''
    return value
  } catch { return '' }
}

function boundedNumber(value, min, max) {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max ? value : null
}

/** Map provider rows. Missing fields stay empty or null. summary is not copied into snippet. */
export function mapDeepseekResults(results, { count, needContent = false } = {}) {
  if (!Array.isArray(results)) throw fail('deepseek-search: invalid or unsuccessful response', 'invalid_response')
  const seen = new Set()
  const hits = []
  for (const [index, item] of results.entries()) {
    const url = httpUrl(item?.url)
    if (!url || seen.has(url)) continue
    seen.add(url)
    const hit = {
      url,
      title: typeof item?.title === 'string' ? item.title : '',
      snippet: typeof item?.snippet === 'string' ? item.snippet : '',
      published: typeof item?.date === 'string' ? item.date : null,
      siteName: typeof item?.site_name === 'string' ? item.site_name : null,
      authority: Number.isSafeInteger(item?.authority) && item.authority >= -1 && item.authority <= 4 ? item.authority : null,
      rerankScore: boundedNumber(item?.rerank_score, 0, 3),
      providerRank: index + 1,
    }
    if (item && Object.hasOwn(item, 'summary')) hit.summary = typeof item.summary === 'string' ? item.summary : null
    if (needContent === true && typeof item?.content === 'string' && item.content.trim()) hit.content = item.content
    hits.push(hit)
  }
  return hits.slice(0, assertDeepseekCount(count))
}

function retryableStatus(status) {
  return status === 408 || status === 429 || (status >= 500 && status <= 599)
}

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(fail('deepseek-search: cancelled', 'cancelled'))
    if (signal?.aborted) { abort(); return }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', () => { clearTimeout(timer); abort() }, { once: true })
  })
}

function requestSignal(opts, timeoutMs) {
  const timeout = AbortSignal.timeout(timeoutMs)
  const extra = opts?.signal
  if (extra && typeof extra.addEventListener === 'function') {
    try { return AbortSignal.any([extra, timeout]) } catch { return timeout }
  }
  return timeout
}

async function drain(res) {
  try { await res.body?.cancel() } catch { /* never echo provider bodies */ }
}

/**
 * POST /v1/tools/search. Missing key, invalid query/count, and a retired messages
 * base fail before any request. 200 with an empty results array is success.
 * Retries only 408/429/5xx, at most DEEPSEEK_RETRY_LIMIT extra times, and never after cancel.
 */
export async function deepseekSearch(query, count, opts = {}, keys = {}, bases = {}, deps = {}) {
  const key = keys[DEEPSEEK_ENGINE]
  if (!key) throw fail('deepseek-search: missing API key', 'missing_key')
  const url = deepseekSearchUrl(bases[DEEPSEEK_ENGINE])
  const needContent = opts.needContent === true
  const body = JSON.stringify(deepseekRequestBody({
    query, count, oriQuestion: opts.oriQuestion, needContent,
  }))
  const fetchImpl = deps.fetchImpl ?? ipv4Fetch
  const sleep = deps.sleep ?? delay
  const clock = typeof opts.now === 'function' ? opts.now : Date.now
  let attempt = 0
  let sent = 0
  const noteTransport = () => {
    if (opts.transport && typeof opts.transport === 'object') opts.transport.requests = sent
  }
  while (true) {
    if (opts.signal?.aborted) throw fail('deepseek-search: cancelled', 'cancelled')
    sent += 1
    noteTransport()
    const res = await fetchImpl(url, {
      method: 'POST', redirect: 'error',
      headers: { 'content-type': 'application/json', accept: 'application/json', authorization: `Bearer ${key}` },
      body,
      signal: requestSignal(opts, 60_000),
    })
    if (res.ok) {
      const text = await readLimited(res, 8_000_000)
      let json
      try { json = JSON.parse(text) } catch { throw fail('deepseek-search: invalid JSON response', 'invalid_response') }
      if (json?.error || !Array.isArray(json?.results)) throw fail('deepseek-search: invalid or unsuccessful response', 'invalid_response')
      return mapDeepseekResults(json.results, { count, needContent })
    }
    await drain(res)
    const status = res.status
    const wait = retryWaitMs(attempt + 1, res.headers?.get?.('retry-after'), clock())
    if (!retryableStatus(status) || attempt >= DEEPSEEK_RETRY_LIMIT || wait == null) {
      throw fail(`deepseek-search http ${status}`, `http_${status}`)
    }
    attempt += 1
    await sleep(wait, opts.signal)
  }
}
