// Engine layer: keyless Bing / DuckDuckGo / Exa MCP / anonymous AnySearch;
// keyed APIs join the api/hybrid pools when configured and enabled.
//  - bing / ddg: keyless HTML scraping
//  - exa-free: keyless Exa MCP semantic retrieval
//  - anysearch: anonymous in free, optional key in hybrid, required key in api
//  - tavily / brave / exa / tinyfish: keyed APIs (TinyFish Search is zero-priced)
// Engines throw on failure; runChain tries them in order and reports the trail.

import { ENGINE_POOLS } from './routing.js'
import { collapseSpace } from './results.js'
import { engineSearchUrl } from '../engine-endpoints.mjs'
import { readKeys, readEngineBaseUrls } from '../keys.mjs'
import { searchExaFree, exaFreeAvailable } from './exa-free.js'
import { readLimited } from './ssrf.js'
import { ipv4Fetch } from './ipv4-fetch.js'

export const ENGINE_ORDER = [...ENGINE_POOLS.hybrid]

/** @deprecated Prefer readKeys() from lib/keys.mjs — kept for vendor export parity. */
export function loadKeys() {
  return readKeys()
}

function requestSignal(opts, timeoutMs) {
  const timeout = AbortSignal.timeout(timeoutMs)
  const extra = opts?.signal
  if (extra && typeof extra.addEventListener === 'function') {
    try {
      return AbortSignal.any([extra, timeout])
    } catch {
      return timeout
    }
  }
  return timeout
}

const stripTags = (s) => String(s ?? '').replace(/<[^>]*>/g, ' ')
const decodeHtml = (s) => String(s ?? '')
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
  .replace(/&ndash;/g, '–').replace(/&mdash;/g, '—')

const UA_CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36'

// ---------- DuckDuckGo HTML (free, keyless) ----------
// Second free HTML scrape, same pattern as Bing. Fails fast and non-fatally
// inside the parallel fan-out.
async function ddgSearch(query, count, opts) {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`
  const res = await ipv4Fetch(url, {
    headers: { 'user-agent': UA_CHROME },
    signal: requestSignal(opts, 15000),
  })
  if (res.status !== 200) {
    try { await res.body?.cancel() } catch { /* release error response */ }
    if (res.status === 202) throw new Error('ddg: HTTP 202 (bot challenge)')
    throw new Error(`ddg: HTTP ${res.status}`)
  }
  const html = await readLimited(res, 8_000_000)
  // Anchor-driven parse: each result block is an <a class="result__a">; the
  // snippet lives inside the same block, between this anchor and the next.
  const anchorRe = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi
  const anchors = [...html.matchAll(anchorRe)]
  if (anchors.length === 0) throw new Error('ddg: no result anchors parsed')
  const hits = []
  for (let i = 0; i < anchors.length && hits.length < count; i++) {
    const m = anchors[i]
    let u = m[1].replace(/&amp;/g, '&')
    // DDG redirect links: //duckduckgo.com/l/?uddg=<urlencoded>
    const uddg = /[?&]uddg=([^&]+)/.exec(u)
    if (uddg) {
      try { u = decodeURIComponent(uddg[1]) } catch { /* keep */ }
    } else if (u.startsWith('//')) {
      u = 'https:' + u
    }
    if (!/^https?:\/\//i.test(u)) continue
    const title = collapseSpace(decodeHtml(stripTags(m[2])))
    if (!title) continue
    const end = i + 1 < anchors.length ? anchors[i + 1].index : html.length
    const sm = /<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/i.exec(html.slice(m.index, end))
    const snippet = sm ? collapseSpace(decodeHtml(stripTags(sm[1]))) : ''
    hits.push({ title, url: u, snippet, published: null, providerRank: i + 1 })
  }
  if (hits.length === 0) throw new Error('ddg: parsed 0 hits (structure changed)')
  return hits
}

// ---------- Bing HTML (free, keyless) ----------
function decodeBingUrl(href) {
  const m = /[?&]u=([^&]+)/.exec(href)
  if (!m) return href
  try {
    let s = m[1]
    try { s = decodeURIComponent(s) } catch { /* raw */ }
    if (s.startsWith('a1')) s = s.slice(2)
    s = s.replace(/-/g, '+').replace(/_/g, '/')
    while (s.length % 4 !== 0) s += '='
    return Buffer.from(s, 'base64').toString('utf8')
  } catch {
    return href
  }
}

async function bingSearch(query, count, opts) {
  const url = `https://www.bing.com/search?q=${encodeURIComponent(query)}&count=${Math.min(count, 20)}`
  const res = await ipv4Fetch(url, {
    headers: { 'user-agent': UA_CHROME },
    signal: requestSignal(opts, 15000),
  })
  if (!res.ok) {
    try { await res.body?.cancel() } catch { /* release error response */ }
    throw new Error(`bing http ${res.status}`)
  }
  const html = await readLimited(res, 8_000_000)
  if (!/<li class="b_algo"/.test(html)) throw new Error('bing: no b_algo blocks (challenge page or structure change)')
  const blocks = html.match(/<li class="b_algo"[\s\S]*?<\/li>/g) || []
  if (blocks.length === 0) throw new Error('bing: no result blocks parsed')
  const hits = []
  for (const [rank, block] of blocks.entries()) {
    if (hits.length >= count) break
    const anchor = /<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(block)
    if (!anchor) continue
    const u = decodeBingUrl(anchor[1].replace(/&amp;/g, '&'))
    if (!/^https?:\/\//i.test(u)) continue
    const title = collapseSpace(decodeHtml(stripTags(anchor[2])))
    if (!title) continue
    const p = /<p[^>]*>([\s\S]*?)<\/p>/i.exec(block)
    const snippet = p ? collapseSpace(decodeHtml(stripTags(p[1]))) : ''
    const dt = /<span class="news_dt">([^<]*)<\/span>/i.exec(block)
    hits.push({ title, url: u, snippet, published: dt ? dt[1].trim() : null, providerRank: rank + 1 })
  }
  if (hits.length === 0) throw new Error('bing: parsed 0 hits (structure changed)')
  return hits
}

// ---------- Tavily ----------
async function tavilySearch(query, count, opts, keys, bases) {
  const body = {
    api_key: keys.tavily,
    query,
    search_depth: opts.depth ?? 'basic',
    max_results: count,
    include_answer: false,
    include_raw_content: false,
  }
  if (opts.includeDomains?.length) body.include_domains = opts.includeDomains.slice(0, 5)
  if (opts.excludeDomains?.length) body.exclude_domains = opts.excludeDomains.slice(0, 5)
  if (opts.recency) body.time_range = opts.recency
  const res = await ipv4Fetch(engineSearchUrl('tavily', bases), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: requestSignal(opts, 20000),
  })
  if (!res.ok) {
    try { await res.body?.cancel() } catch { /* release error response */ }
    throw new Error(`tavily http ${res.status}`)
  }
  const json = JSON.parse(await readLimited(res, 8_000_000))
  return (json.results ?? [])
    .map((r, index) => r && { ...r, providerRank: index + 1 })
    .filter((r) => r && r.url)
    .slice(0, count)
    .map((r) => ({
      providerRank: r.providerRank, title: collapseSpace(r.title ?? ''),
      url: r.url,
      snippet: collapseSpace(r.content ?? '').slice(0, 240),
      content: r.content,
      published: r.published_date || r.publishedDate || null,
    }))
}

// ---------- Brave ----------
async function braveSearch(query, count, opts, keys, bases) {
  let url = `${engineSearchUrl('brave', bases)}?q=${encodeURIComponent(query)}&count=${Math.min(count, 20)}`
  const freshness = { day: 'pd', week: 'pw', month: 'pm', year: 'py' }[opts.recency ?? '']
  if (freshness) url += `&freshness=${freshness}`
  const res = await ipv4Fetch(url, {
    headers: { 'x-subscription-token': keys.brave, accept: 'application/json' },
    signal: requestSignal(opts, 15000),
  })
  if (!res.ok) {
    try { await res.body?.cancel() } catch { /* release error response */ }
    throw new Error(`brave http ${res.status}`)
  }
  const json = JSON.parse(await readLimited(res, 8_000_000))
  return (json.web?.results ?? [])
    .map((r, index) => r && { ...r, providerRank: index + 1 })
    .filter((r) => r && r.url)
    .slice(0, count)
    .map((r) => ({
      providerRank: r.providerRank, title: collapseSpace(r.title ?? ''),
      url: r.url,
      snippet: collapseSpace(r.description ?? ''),
      published: r.age || null,
    }))
}

// ---------- Exa ----------
async function exaSearch(query, count, opts, keys, bases) {
  const body = { query, numResults: count, contents: { text: true } }
  if (opts.recency) {
    const days = { day: 1, week: 7, month: 30, year: 365 }[opts.recency]
    // Exa's documented filter is startPublishedDate (ISO 8601). publishedAfter is
    // not part of the search request schema, so it never carried the constraint.
    body.startPublishedDate = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10)
  }
  const res = await ipv4Fetch(engineSearchUrl('exa', bases), {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': keys.exa },
    body: JSON.stringify(body),
    signal: requestSignal(opts, 20000),
  })
  if (!res.ok) {
    try { await res.body?.cancel() } catch { /* release error response */ }
    throw new Error(`exa http ${res.status}`)
  }
  const json = JSON.parse(await readLimited(res, 8_000_000))
  return (json.results ?? [])
    .map((r, index) => r && { ...r, providerRank: index + 1 })
    .filter((r) => r && r.url)
    .slice(0, count)
    .map((r) => ({
      providerRank: r.providerRank, title: collapseSpace(r.title ?? ''),
      url: r.url,
      snippet: collapseSpace(r.text ?? '').slice(0, 240),
      content: r.text,
      published: r.publishedDate || null,
    }))
}

// AnySearch's error envelope can contain auto-generated credentials on 402.
// Never read HTTP error bodies, or echo/persist/retry error envelopes.
// A 200 business envelope must be parsed to check code, but its message is ignored.
async function anysearchSearch(query, count, opts = {}, keys, bases) {
  const headers = { 'content-type': 'application/json' }
  if (opts.enginePool !== 'free' && keys.anysearch) headers.authorization = `Bearer ${keys.anysearch}`
  const res = await ipv4Fetch(engineSearchUrl('anysearch', bases), {
    method: 'POST', headers,
    body: JSON.stringify({ query, max_results: Math.min(10, Math.max(1, count)), format: 'json' }),
    signal: requestSignal(opts, 20000),
  })
  if (!res.ok) {
    try { await res.body?.cancel() } catch { /* release without reading secrets */ }
    throw new Error(`anysearch http ${res.status}`)
  }
  let json
  try { json = JSON.parse(await readLimited(res, 8_000_000)) }
  catch { throw new Error('anysearch: invalid JSON response') }
  if (json?.code !== 0 || !Array.isArray(json?.data?.results)) throw new Error('anysearch: invalid or unsuccessful response')
  return json.data.results.map((r, index) => r && { ...r, providerRank: index + 1 }).filter((r) => r && typeof r.url === 'string').slice(0, count).map((r) => ({
    providerRank: r.providerRank, title: collapseSpace(r.title), url: r.url,
    snippet: collapseSpace(r.snippet ?? r.content).slice(0, 240),
    ...(typeof r.content === 'string' ? { content: r.content } : {}), published: null,
  }))
}

// ---------- TinyFish Search (keyed, zero-priced; api/hybrid only by default) ----------
async function tinyfishSearch(query, count, opts = {}, keys, bases) {
  if (!keys.tinyfish) throw new Error('tinyfish: missing API key')
  const url = new URL(engineSearchUrl('tinyfish', bases))
  url.searchParams.set('query', query)
  if (opts.includeDomains?.length) url.searchParams.set('include_domains', opts.includeDomains.join(','))
  if (opts.excludeDomains?.length) url.searchParams.set('exclude_domains', opts.excludeDomains.join(','))
  const minutes = { day: 1440, week: 10080, month: 43200, year: 525600 }[opts.recency]
  if (minutes) url.searchParams.set('recency_minutes', String(minutes))
  // First page only. There is no documented count parameter; never auto-fetch
  // pages or page content to fill the caller's result count.
  const res = await ipv4Fetch(url.href, {
    method: 'GET',
    headers: { 'X-API-Key': keys.tinyfish, accept: 'application/json' },
    signal: requestSignal(opts, 20000),
  })
  if (!res.ok) {
    try { await res.body?.cancel() } catch { /* release without echoing bodies */ }
    // No HTTP retry: quota/access failures are disclosed, not bypassed. Keep a
    // safe Retry-After hint for callers without persisting a service error body.
    const retryAfter = res.status === 429 ? res.headers.get('retry-after') : null
    const seconds = retryAfter && /^\d+$/.test(retryAfter) ? Number(retryAfter) : NaN
    const hint = Number.isSafeInteger(seconds) ? `; retry after ${seconds}s` : ''
    throw new Error(`tinyfish http ${res.status}${hint}`)
  }
  const text = await readLimited(res, 8_000_000)
  let json
  try { json = JSON.parse(text) }
  catch { throw new Error('tinyfish: invalid JSON response') }
  if (json?.error || !Array.isArray(json?.results)) throw new Error('tinyfish: invalid or unsuccessful response')
  return json.results
    .filter((r) => r && typeof r.url === 'string' && /^https?:\/\//i.test(r.url)
      && Number.isSafeInteger(r.position) && r.position >= 1)
    .slice(0, count)
    .map((r) => ({
      providerRank: r.position, title: collapseSpace(r.title), url: r.url,
      snippet: collapseSpace(r.snippet), published: typeof r.date === 'string' ? r.date : null,
    }))
}

export function engineRegistry(keys, enabledKeyed = null, baseUrls = readEngineBaseUrls()) {
  const keyedAvailable = (name) => {
    if (!keys[name]) return false
    if (enabledKeyed === null) return true
    return enabledKeyed.has(name)
  }
  const anysearchEnabled = enabledKeyed === null || enabledKeyed.has('anysearch')
  return {
    anysearch: {
      available: () => anysearchEnabled,
      availableForPool: (pool) => anysearchEnabled && (pool !== 'api' || !!keys.anysearch),
      search: (q, n, o) => anysearchSearch(q, n, o, keys, baseUrls),
    },
    bing: {
      available: () => true,
      search: bingSearch,
    },
    ddg: {
      available: () => true,
      search: ddgSearch,
    },
    'exa-free': {
      available: exaFreeAvailable,
      search: (q, n, o) => searchExaFree(q, n, o?.signal),
    },
    tavily: {
      available: () => keyedAvailable('tavily'),
      // Native domain params (also supported by TinyFish); other engines get
      // the site: hint from runEngine plus the shared client-side domain filter.
      nativeDomains: true,
      search: (q, n, o) => tavilySearch(q, n, o, keys, baseUrls),
    },
    brave: {
      available: () => keyedAvailable('brave'),
      search: (q, n, o) => braveSearch(q, n, o, keys, baseUrls),
    },
    exa: {
      available: () => keyedAvailable('exa'),
      search: (q, n, o) => exaSearch(q, n, o, keys, baseUrls),
    },
    tinyfish: {
      available: () => keyedAvailable('tinyfish'),
      nativeDomains: true,
      search: (q, n, o) => tinyfishSearch(q, n, o, keys, baseUrls),
    },
  }
}

/** Try engines in order; first success wins; throw with the attempt trail. */
export async function runChain(engines, query, count, opts) {
  const attempts = []
  for (const name of ENGINE_ORDER) {
    const engine = engines[name]
    if (!engine?.available()) continue
    try {
      return { engine: name, hits: await engine.search(query, count, opts) }
    } catch (err) {
      attempts.push(`${name}: ${(err instanceof Error ? err.message : String(err)).slice(0, 90)}`)
    }
  }
  throw new Error(`no engine could answer (${attempts.join('; ')})`)
}
