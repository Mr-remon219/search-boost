/** Console-only quota adapters. Never imported by search routing or the quick TUI. */
import { createHash } from 'node:crypto'
import { ENGINE_BASE_URLS, normalizeEngineBaseUrl } from './engine-endpoints.mjs'
import { ipv4Fetch } from './search/ipv4-fetch.js'

export const QUOTA_REFRESH_MS = 60_000
export const QUOTA_PROVIDERS = Object.freeze({
  tavily: { endpoint: 'https://api.tavily.com/usage', dashboard: 'https://app.tavily.com', mode: 'credits',
    docs: 'https://docs.tavily.com/documentation/api-reference/endpoint/usage' },
  brave: { endpoint: 'https://api.search.brave.com/res/v1/web/search?q=Brave%20Search%20API&count=1', dashboard: 'https://api-dashboard.search.brave.com', mode: 'search_probe',
    docs: 'https://api-dashboard.search.brave.com/documentation/guides/rate-limiting' },
  exa: { dashboard: 'https://dashboard.exa.ai', mode: 'service_key_required',
    docs: 'https://exa.ai/docs/reference/team-management/get-api-key-usage' },
  anysearch: { dashboard: 'https://www.anysearch.com/console/api-keys', mode: 'manual', docs: 'https://anysearch.com/docs/auth' },
  tinyfish: { endpoint: 'https://agent.tinyfish.ai/v1/wallet', dashboard: 'https://agent.tinyfish.ai', mode: 'wallet',
    docs: 'https://docs.tinyfish.ai/api-reference/wallet/get-wallet' },
})

// Cache partitioning never stores the key or exposes its hash in rendering/logs.
export function quotaIdentity(name, routing) {
  return createHash('sha256').update(JSON.stringify([name, routing.keys[name] ?? null, routing.baseUrls[name]])).digest('hex')
}
export function quotaAvailability(name, routing) {
  const provider = QUOTA_PROVIDERS[name]
  if (!provider) return 'unsupported'
  if (!routing.keys[name]) return 'no_key'
  if (normalizeEngineBaseUrl(routing.baseUrls[name]) !== ENGINE_BASE_URLS[name]) return 'custom_gateway'
  return provider.endpoint ? 'idle' : provider.mode
}
const nonnegative = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER
function creditMetric(id, used, limit) {
  if (!Number.isSafeInteger(used) || used < 0 || (limit !== null && (!Number.isSafeInteger(limit) || limit < 0))) throw new Error('Invalid credit counters')
  return { id, unit: 'credits', used, limit, remaining: limit === null ? null : Math.max(0, limit - used) }
}
export function parseTavilyQuota(doc) {
  if (!doc?.key || !Object.hasOwn(doc.key, 'limit')) throw new Error('Missing key quota')
  const key = creditMetric('key', doc.key.usage, doc.key.limit)
  if (doc.key.limit === null) key.unlimited = true // Tavily explicitly documents null as unlimited for this key.
  const metrics = [key]
  if (doc.account) {
    metrics.push(creditMetric('plan', doc.account.plan_usage, doc.account.plan_limit))
    if (Object.hasOwn(doc.account, 'paygo_usage') || Object.hasOwn(doc.account, 'paygo_limit')) metrics.push(creditMetric('paygo', doc.account.paygo_usage, doc.account.paygo_limit))
  }
  // Account and key counters are independent ceilings, never added together.
  return { metrics, note: 'independent_limits' }
}
export function parseTinyfishQuota(doc) {
  if (doc?.currency !== 'USD' || typeof doc.available_balance !== 'string' || !/^-?(?:0|[1-9]\d{0,11})(?:\.\d{1,6})?$/.test(doc.available_balance) || !Number.isFinite(Date.parse(doc.as_of))) throw new Error('Invalid wallet')
  return { metrics: [{ id: 'wallet', unit: 'USD', remaining: Number(doc.available_balance), used: null, limit: null }],
    providerAsOf: new Date(doc.as_of).toISOString(), note: 'account_wallet_not_search_quota' }
}
export function parseBraveQuota(headers) {
  const vector = name => {
    const raw = headers.get(name)
    if (!raw) throw new Error('Missing quota headers')
    return raw.split(',').map(value => {
      if (!/^\s*\d+\s*$/.test(value)) throw new Error('Invalid quota headers')
      const number = Number(value)
      if (!nonnegative(number)) throw new Error('Invalid quota headers')
      return number
    })
  }
  const limits = vector('x-ratelimit-limit'), remaining = vector('x-ratelimit-remaining')
  const policies = (headers.get('x-ratelimit-policy') ?? '').split(',').map(value => {
    const match = /^\s*(\d+)\s*;\s*w=(\d+)\s*$/.exec(value)
    if (!match) throw new Error('Invalid quota policy')
    return { limit: Number(match[1]), window: Number(match[2]) }
  })
  if (limits.length !== policies.length || limits.length !== remaining.length || policies.some((p, i) => !nonnegative(p.window) || p.limit !== limits[i])) throw new Error('Inconsistent quota headers')
  const index = policies.reduce((best, p, i) => p.window >= 86400 && (best < 0 || p.window > policies[best].window) ? i : best, -1)
  if (index < 0) return { metrics: [], note: 'no_long_window' }
  const limit = limits[index], left = remaining[index]
  if (limit > 0 && left > limit) throw new Error('Invalid quota counters')
  return { metrics: [{ id: 'window', unit: 'requests', windowSeconds: policies[index].window,
    used: limit ? limit - left : null, limit: limit || null, remaining: limit ? left : null, unlimited: limit === 0 }], note: 'brave_probe' }
}

async function boundedJson(response, signal) {
  const reader = response.body?.getReader()
  if (!reader) throw new Error('Missing response stream')
  let bytes = 0
  const chunks = []
  try {
    for (;;) {
      signal.throwIfAborted()
      const { value, done } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > 65_536) throw new Error('Response too large')
      chunks.push(Buffer.from(value))
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
}

/** Fixed official endpoints only; no gateway probing, redirects, search fallback or raw error output. */
export async function fetchEngineQuota(name, routing, { signal, fetchImpl = ipv4Fetch, now = Date.now, allowPaidProbe = false } = {}) {
  const availability = quotaAvailability(name, routing)
  if (availability !== 'idle') return { status: availability, metrics: [] }
  const provider = QUOTA_PROVIDERS[name]
  if (name === 'brave' && !allowPaidProbe) return { status: 'probe_consent_required', metrics: [] }
  const combined = signal ? AbortSignal.any([signal, AbortSignal.timeout(12_000)]) : AbortSignal.timeout(12_000)
  let response
  try {
    combined.throwIfAborted()
    const key = routing.keys[name]
    const headers = { Accept: 'application/json', ...(name === 'tavily' ? { Authorization: `Bearer ${key}` } : name === 'brave' ? { 'X-Subscription-Token': key } : { 'X-API-Key': key }) }
    response = await fetchImpl(provider.endpoint, { method: 'GET', headers, signal: combined, redirect: 'error' })
    combined.throwIfAborted()
    if (!response.ok) {
      const status = [401, 403].includes(response.status) ? 'auth_error' : response.status === 429 ? 'rate_limited' : name === 'tinyfish' && response.status === 404 ? 'wallet_unavailable' : 'http_error'
      const retry = response.headers.get('retry-after')
      const seconds = retry && /^\d+$/.test(retry) ? Number(retry) : retry ? Math.ceil((Date.parse(retry) - now()) / 1000) : 0
      return { status, metrics: [], ...(status === 'rate_limited' && Number.isSafeInteger(seconds) && seconds > 0 ? { retryAfterMs: seconds * 1000 } : {}) }
    }
    let parsed
    try {
      parsed = name === 'brave' ? parseBraveQuota(response.headers) : name === 'tavily' ? parseTavilyQuota(await boundedJson(response, combined)) : parseTinyfishQuota(await boundedJson(response, combined))
    } catch {
      combined.throwIfAborted()
      return { status: 'invalid_response', metrics: [] }
    }
    combined.throwIfAborted()
    return { status: 'ok', ...parsed, checkedAt: now() }
  } catch {
    return { status: signal?.aborted ? 'cancelled' : combined.aborted ? 'timeout' : 'network_error', metrics: [] }
  } finally { await response?.body?.cancel().catch(() => {}) }
}
