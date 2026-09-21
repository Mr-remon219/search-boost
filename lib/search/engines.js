// Engine layer: free-by-default engines run in parallel (Bing / DuckDuckGo /
// Yahoo HTML / Exa MCP keyless), keyed engines join when keys are present.
//  - bing: free, keyless HTML scraping
//  - ddg (DuckDuckGo HTML): free, keyless HTML scraping
//  - yahoo: free, keyless HTML scraping (Yahoo web search)
//  - exa-free (Exa MCP): free, keyless, neural/semantic — the quality free leg
//  - tavily / brave / exa: keyed APIs (key from ~/.search-boost-keys.json or env)
// Engines throw on failure; runChain tries them in order and reports the trail.

import { collapseSpace } from './results.js'
import { readKeys } from '../keys.mjs'
import { searchExaFree, exaFreeAvailable } from './exa-free.js'
import { readLimited } from './ssrf.js'
import { ipv4Fetch } from './ipv4-fetch.js'

export const ENGINE_ORDER = ['bing', 'ddg', 'yahoo', 'exa-free', 'tavily', 'brave', 'exa']

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
    hits.push({ title, url: u, snippet, published: null })
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
  for (const block of blocks) {
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
    hits.push({ title, url: u, snippet, published: dt ? dt[1].trim() : null })
  }
  if (hits.length === 0) throw new Error('bing: parsed 0 hits (structure changed)')
  return hits
}

// ---------- Yahoo HTML (free, keyless) ----------
function decodeYahooUrl(href) {
  const m = /[?&/]RU=([^/&]+)/i.exec(String(href ?? ''))
  if (!m) return href
  try {
    return decodeURIComponent(m[1])
  } catch {
    return href
  }
}

async function yahooSearch(query, count, opts) {
  const url = `https://search.yahoo.com/search?p=${encodeURIComponent(query)}`
  const res = await ipv4Fetch(url, {
    headers: { 'user-agent': UA_CHROME },
    signal: requestSignal(opts, 15000),
  })
  if (!res.ok) {
    try { await res.body?.cancel() } catch { /* release error response */ }
    throw new Error(`yahoo http ${res.status}`)
  }
  const html = await readLimited(res, 8_000_000)
  const hits = []
  const seen = new Set()
  const push = (href, titleHtml, snippetHtml = '') => {
    if (hits.length >= count) return
    const u = decodeYahooUrl(String(href).replace(/&amp;/g, '&'))
    if (!/^https?:\/\//i.test(u) || seen.has(u)) return
    const title = collapseSpace(decodeHtml(stripTags(titleHtml)))
    if (!title) return
    seen.add(u)
    hits.push({
      title,
      url: u,
      snippet: snippetHtml ? collapseSpace(decodeHtml(stripTags(snippetHtml))).slice(0, 240) : '',
      published: null,
    })
  }
  // primary: organic algo blocks (modern Yahoo layout)
  for (const block of html.split(/<div class="dd fst algo /).slice(1)) {
    const anchor = /compTitle[\s\S]*?<a[^>]+href="([^"]+)"/i.exec(block)
    const titleM = /<h3[^>]*class="[^"]*title[^"]*"[^>]*>([\s\S]*?)<\/h3>/i.exec(block)
    if (!anchor || !titleM) continue
    const snippetM = /class="[^"]*compText[^"]*"[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/i.exec(block)
    push(anchor[1], titleM[1], snippetM?.[1] ?? '')
  }
  // fallback: any compTitle + title h3 pair the block split missed
  if (hits.length < count) {
    for (const m of html.matchAll(/<div class="compTitle[^"]*"[\s\S]*?<a[^>]+href="([^"]+)"[\s\S]*?<h3[^>]*class="[^"]*title[^"]*"[^>]*>([\s\S]*?)<\/h3>/gi)) {
      push(m[1], m[2])
      if (hits.length >= count) break
    }
  }
  if (hits.length === 0) throw new Error('yahoo: parsed 0 hits (structure changed)')
  return hits
}

// ---------- Tavily ----------
async function tavilySearch(query, count, opts, keys) {
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
  const res = await ipv4Fetch('https://api.tavily.com/search', {
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
    .filter((r) => r && r.url)
    .slice(0, count)
    .map((r) => ({
      title: collapseSpace(r.title ?? ''),
      url: r.url,
      snippet: collapseSpace(r.content ?? '').slice(0, 240),
      content: r.content,
      published: r.published_date || r.publishedDate || null,
    }))
}

// ---------- Brave ----------
async function braveSearch(query, count, opts, keys) {
  let url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${Math.min(count, 20)}`
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
    .filter((r) => r && r.url)
    .slice(0, count)
    .map((r) => ({
      title: collapseSpace(r.title ?? ''),
      url: r.url,
      snippet: collapseSpace(r.description ?? ''),
      published: r.age || null,
    }))
}

// ---------- Exa ----------
async function exaSearch(query, count, opts, keys) {
  const body = { query, numResults: count, contents: { text: true } }
  if (opts.recency) {
    const days = { day: 1, week: 7, month: 30, year: 365 }[opts.recency]
    // Exa's documented filter is startPublishedDate (ISO 8601). publishedAfter is
    // not part of the search request schema, so it never carried the constraint.
    body.startPublishedDate = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10)
  }
  const res = await ipv4Fetch('https://api.exa.ai/search', {
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
    .filter((r) => r && r.url)
    .slice(0, count)
    .map((r) => ({
      title: collapseSpace(r.title ?? ''),
      url: r.url,
      snippet: collapseSpace(r.text ?? '').slice(0, 240),
      content: r.text,
      published: r.publishedDate || null,
    }))
}

export function engineRegistry(keys, enabledKeyed = null) {
  const keyedAvailable = (name) => {
    if (!keys[name]) return false
    if (enabledKeyed === null) return true
    return enabledKeyed.has(name)
  }
  return {
    bing: {
      available: () => true,
      search: bingSearch,
    },
    ddg: {
      available: () => true,
      search: ddgSearch,
    },
    yahoo: {
      available: () => true,
      search: yahooSearch,
    },
    'exa-free': {
      available: exaFreeAvailable,
      search: (q, n, o) => searchExaFree(q, n, o?.signal),
    },
    tavily: {
      available: () => keyedAvailable('tavily'),
      // Tavily filters hosts server-side (`include_domains`). Every other engine
      // only understands the site: form, which runEngine puts back into the query.
      nativeDomains: true,
      search: (q, n, o) => tavilySearch(q, n, o, keys),
    },
    brave: {
      available: () => keyedAvailable('brave'),
      search: (q, n, o) => braveSearch(q, n, o, keys),
    },
    exa: {
      available: () => keyedAvailable('exa'),
      search: (q, n, o) => exaSearch(q, n, o, keys),
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
