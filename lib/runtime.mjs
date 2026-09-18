/**
 * SearchBoost Core runtime — the single host-neutral facade over lib/search.
 *
 * Every host adapter (adapters/mcp, adapters/pi, adapters/dsh) calls into this
 * module for search / fetch / research / x_search orchestration and only adds
 * host-specific registration, rendering and prompt policy on top. Search
 * algorithms live in lib/search/*; nothing here depends on a host SDK.
 */
import {
  engineRegistry,
  ENGINE_ORDER,
} from './search/engines.js'

import {
  fusedSearch,
  makeCache,
  estimateComplexity,
  TIER_ENGINES,
  TIER_ENGINES_FREE,
  FREE_DOMAIN_ENGINES,
  domainSearchQuery,
  searchCacheKey,
  hostOf,
  normalizeUrl,
} from './search/fusion.js'

import { fetchPage, makePageCache } from './search/fetch.js'
import { researchRound, parallelResearch, setTimer as setResearchTimer } from './search/research.js'
import { runResearchLoop as researchLoop } from './search/research-loop.js'
import { LAYER_LABELS } from './search/layer.js'
import { runXTool, xAuthAvailableSync } from './search/xsearch.js'
import { fallbackXSearch, hitToPost, cleanJsonValue } from './search/xfallback.js'
import {
  authStatus,
  importApiKey,
  importFromGrok,
  jwtTier,
  logout as xLogout,
  piAuthPath,
  readGrokAuth,
  tierName,
  xAuthCacheToken,
} from './search/xauth.js'
import { isSsrfError } from './search/ssrf.js'
import { AuditLog, NULL_AUDIT } from './search/audit.js'
import { countWords } from './search/text.js'
import { excerptForTool, pickParagraphs } from './search/evidence.js'
import { readKeysRouting, partialKeyedPoolWarning } from './keys.mjs'
import { getLayer, setLayer, layerSelectOptions } from './layer-config.mjs'

export { ENGINE_ORDER }

export {
  fetchPage,
  researchRound,
  parallelResearch,
  setResearchTimer,
  getLayer,
  setLayer,
  LAYER_LABELS,
  runXTool,
  xAuthAvailableSync,
  fallbackXSearch,
  hitToPost,
  cleanJsonValue,
  authStatus,
  importApiKey,
  importFromGrok,
  jwtTier,
  xLogout,
  piAuthPath,
  readGrokAuth,
  tierName,
  xAuthCacheToken,
  isSsrfError,
  hostOf,
  normalizeUrl,
  AuditLog,
  NULL_AUDIT,
  countWords,
  excerptForTool,
  pickParagraphs,
}

export const SEARCH_CACHE = makeCache()
export const PAGE_CACHE = makePageCache()
export const X_CACHE = {
  keyword: makeCache(5 * 60 * 1000),
  semantic: makeCache(5 * 60 * 1000),
  user: makeCache(10 * 60 * 1000),
  thread: makeCache(15 * 60 * 1000),
}
/** single-flight registry: concurrent identical x_search calls share one run */
const X_INFLIGHT = new Map()

/** Drop fusion + x_search caches after layer or credential changes. */
export function invalidateSearchCaches() {
  SEARCH_CACHE.clear()
  for (const cache of Object.values(X_CACHE)) cache.clear()
  X_INFLIGHT.clear()
}

/** Drop every cache, including fetched pages (host "clear cache" commands). */
export function clearAllCaches() {
  invalidateSearchCaches()
  PAGE_CACHE.clear()
}

export function cacheSizes() {
  return {
    search: SEARCH_CACHE.size(),
    page: PAGE_CACHE.size(),
    x_keyword: X_CACHE.keyword.size(),
    x_semantic: X_CACHE.semantic.size(),
    x_user: X_CACHE.user.size(),
    x_thread: X_CACHE.thread.size(),
  }
}

export const stats = {
  startedAt: new Date().toISOString(),
  cacheHits: 0,
  cacheMisses: 0,
  tierCounts: {},
  recent: [],
}

export function bumpEngines() {
  const { keys, enabledNames, summary } = readKeysRouting()
  const enabledSet = summary.hasExplicitRouting || summary.enabled.length < summary.configured.length
    ? new Set(enabledNames)
    : null
  return engineRegistry(keys, enabledSet)
}

/** @returns {{ routing: ReturnType<typeof readKeysRouting>, engines: ReturnType<typeof engineRegistry> }} */
export function resolveRuntimeEngines() {
  const routing = readKeysRouting()
  const enabledSet = routing.summary.hasExplicitRouting || routing.summary.enabled.length < routing.summary.configured.length
    ? routing.enabledSet
    : null
  return { routing, engines: engineRegistry(routing.keys, enabledSet) }
}

export function collectSearchStats() {
  const { summary } = readKeysRouting()
  const engines = bumpEngines()
  const xSource = authStatus()
  return {
    startedAt: stats.startedAt,
    layer: getLayer(),
    cacheHits: stats.cacheHits,
    cacheMisses: stats.cacheMisses,
    tierCounts: stats.tierCounts,
    keyedEngines: {
      configured: summary.configured,
      enabled: summary.enabled,
      total: summary.total,
      enabledNames: summary.enabledNames,
    },
    engines: Object.fromEntries(
      ENGINE_ORDER.map((name) => [name, engines[name]?.available() ?? false]),
    ),
    xOfficial: xAuthAvailableSync(),
    xSource: xSource.source,
    recent: stats.recent.slice(0, 10),
  }
}

export function availableEngines(engines, names) {
  return names.filter((e) => engines[e]?.available())
}

export function runEngine(engines, engineName, q, n, o) {
  const engine = engines[engineName]
  if (!engine?.available()) throw new Error(`${engineName} unavailable`)
  return engine.search(q, n, o)
}

export function layerTierTable(layer) {
  return layer === 'free' ? TIER_ENGINES_FREE : TIER_ENGINES
}

/**
 * Layer for one tool call. Override does not persist unless persistLayer is used (search_layer tool).
 * @param {'free'|'api'|null|undefined} override
 */
export function activeLayer(override) {
  if (override === 'free' || override === 'api') return override
  return getLayer()
}

/** @param {'free'|'api'} layer */
export function persistLayer(layer) {
  return setLayer(layer)
}

/** Keyed engines excluded from tier pools when disabled or missing keys. */
const KEYED_ENGINE_NAMES = new Set(['tavily', 'brave', 'exa'])

function keyedEnginesInList(engineNames) {
  return engineNames.filter((name) => KEYED_ENGINE_NAMES.has(name))
}

function appendRuntimeWarning(result, message) {
  if (!message) return result
  result.warnings = [...(result.warnings ?? []), message]
  return result
}

/**
 * Fused multi-engine search on the active layer with the shared 6h cache.
 * `depth` / `minScore` / `maxResultsCap` are optional host extras (pi exposes
 * them); MCP and DSH use the defaults.
 */
export async function runFused({ query, queries, engineList, maxResults, includeDomains, excludeDomains, recency, complexity = 'auto', layer = null, depth = null, minScore = 0, maxResultsCap = 10, signal }) {
  const q = String(query ?? '').trim()
  if (!q) throw new Error('fused_search: query is required')

  const { routing, engines } = resolveRuntimeEngines()
  const active = activeLayer(layer)
  const resolvedTier = complexity === 'auto' || !complexity ? estimateComplexity(q) : complexity
  const tierTable = layerTierTable(active)
  // caller engine lists may name engines unknown to Core — drop them so the
  // registry lookup never throws; fusedSearch falls back to the tier default
  const tierDefault = tierTable[resolvedTier] ?? tierTable.simple
  const enginesRequested = Array.isArray(engineList) ? engineList.filter((e) => ENGINE_ORDER.includes(e)) : tierDefault
  const requestedPool = enginesRequested.length > 0 ? enginesRequested : tierDefault
  const engineNames = availableEngines(engines, requestedPool)
  const keyedInPool = keyedEnginesInList(engineNames)
  const singleKeyedPool = active === 'api' && keyedInPool.length <= 1
  const key = searchCacheKey({
    query: q,
    queries: queries ?? [],
    engines: engineNames,
    includeDomains: includeDomains ?? [],
    excludeDomains: excludeDomains ?? [],
    recency: recency ?? null,
    maxResults: `${maxResults}|${depth ?? ''}|${minScore || 0}`,
    tier: resolvedTier,
    layer: active,
  })
  const cached = SEARCH_CACHE.get(key)
  if (cached) {
    stats.cacheHits++
    stats.recent.unshift({ query: q, layer: active, tookMs: 0, results: cached.results.length, cacheHit: true })
    if (stats.recent.length > 20) stats.recent.pop()
    return { ...cached, cacheHit: true, tookMs: 0 }
  }
  stats.cacheMisses++
  const result = await fusedSearch({
    query: q,
    queries,
    engines: engineNames,
    maxResults,
    maxResultsCap,
    includeDomains,
    excludeDomains,
    recency,
    tier: resolvedTier,
    layer: active,
    depth,
    minScore,
    signal,
    singleKeyedPool,
    runOne: (engineName, qi, n, o) => runEngine(engines, engineName, qi, n, o),
  })
  result.layer = active
  annotateFusedLayerEngines(result, active, requestedPool, engineNames)
  if (active === 'api') {
    appendRuntimeWarning(result, partialKeyedPoolWarning(routing.summary))
  }
  stats.tierCounts[result.tier] = (stats.tierCounts[result.tier] ?? 0) + 1
  stats.recent.unshift({ query: q, layer: active, tookMs: result.tookMs, results: result.results.length, cacheHit: false })
  if (stats.recent.length > 20) stats.recent.pop()
  SEARCH_CACHE.set(key, result)
  return result
}

/**
 * Layer-aware multi-engine search restricted to specific hosts — the "instant"
 * parallel channel of x_search and the fallback chain's injected webSearch.
 * Calls the engine registry directly (bypassing the fusion scorer, whose
 * per-domain cap of 2 would truncate an X-only result set).
 */
export async function domainSearch(engines, { query, maxResults = 5, includeDomains = ['x.com', 'twitter.com'], layer = null, signal }) {
  const active = activeLayer(layer)
  const keyed = active === 'free' ? [] : ['tavily', 'brave', 'exa']
  const pool = active === 'free' ? FREE_DOMAIN_ENGINES : [...FREE_DOMAIN_ENGINES, ...keyed]
  const names = availableEngines(engines, pool)
  const searchQ = domainSearchQuery(query, includeDomains)
  const n = Math.min(Math.max(maxResults ?? 5, 1), 8)
  const per = Math.max(4, Math.ceil(n * 0.8))
  const opts = { includeDomains, signal }
  const all = (await Promise.all(names.map(async (name) => {
    try {
      return await runEngine(engines, name, searchQ, per, opts)
    } catch {
      return []
    }
  }))).flat()
  const seen = new Set()
  const out = []
  for (const h of all) {
    if (!h?.url) continue
    const host = hostOf(h.url)
    if (!includeDomains.some((d) => host === d || host.endsWith('.' + d))) continue
    const key = normalizeUrl(h.url)
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ title: h.title ?? '', url: h.url, snippet: h.snippet ?? '', domain: host })
    if (out.length >= n) break
  }
  return out
}

function decodeHtmlText(s) {
  return String(s ?? '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
}

export function fusedHitToJson(r) {
  return {
    title: decodeHtmlText(r.title),
    url: r.url,
    domain: r.domain,
    snippet: decodeHtmlText(r.snippet ?? ''),
    score: r.score,
    engines: r.engines,
    published: r.published ?? null,
  }
}

export function formatEngineStatsLine(engineStats) {
  if (!engineStats || typeof engineStats !== 'object') return ''
  const parts = []
  for (const [name, stat] of Object.entries(engineStats)) {
    if (!stat?.used) continue
    if (stat.errors > 0) {
      parts.push(`${name}: FAIL${stat.note ? ` (${stat.note})` : ''}`)
    } else {
      parts.push(`${name}: OK`)
    }
  }
  return parts.join(', ')
}

/** True when every attempted engine recorded at least one error. */
export function allAttemptedEnginesFailed(engineStats) {
  if (!engineStats || typeof engineStats !== 'object') return false
  const attempted = Object.values(engineStats).filter((s) => s?.used)
  if (attempted.length === 0) return false
  return attempted.every((s) => s.errors > 0)
}

export function formatAllEnginesFailedMessage(result) {
  const engines = formatEngineStatsLine(result.engineStats)
  const layer = result.layer ?? 'api'
  const hint = layer === 'free'
    ? 'Try search_layer api with keys (~/.search-boost-keys.json or TAVILY/BRAVE/EXA_API_KEY env), or retry later.'
    : 'Check keys in ~/.search-boost-keys.json (or TAVILY/BRAVE/EXA_API_KEY env) and retry.'
  return `fused_search: all engines failed for "${result.query}" (${engines}). ${hint}`
}

export function formatFusedSummary(value) {
  const lines = [
    `fused_search: "${value.query}" — layer ${value.layer ?? 'api'}, tier ${value.tier}, ${value.results.length} hits, ${value.tookMs}ms${value.cacheHit ? ' (cache)' : ''}`,
  ]
  const engineLine = formatEngineStatsLine(value.engineStats)
  if (engineLine) lines.push(`engines: ${engineLine}`)
  if (value.warnings?.length) lines.push(`warnings: ${value.warnings.join('; ')}`)
  for (const [i, r] of value.results.entries()) {
    const hit = fusedHitToJson(r)
    lines.push(`${i + 1}. [${hit.score}] ${hit.title} — ${hit.domain} (${hit.engines.join('+')})`)
    lines.push(`   ${hit.url}`)
    if (hit.snippet) lines.push(`   ${hit.snippet.slice(0, 240)}`)
  }
  return lines.join('\n')
}

export function renderXItem(item) {
  if (Array.isArray(item.recent_posts)) {
    const posts = item.recent_posts.slice(0, 3)
    return `${item.name} (@${item.username}) — followers ${item.followers ?? '?'} — ${posts.map((p) => String(p.text).slice(0, 80)).join(' | ') || '(none)'}`
  }
  const author = item.author ? item.author + (item.username ? ` (@${item.username})` : '') + ': ' : ''
  return `${author}${item.text || item.url}`
}

/** Drop low-signal gap tokens from research coverage (e.g. "what" from "What is …"). */
export function filterResearchGaps(gaps) {
  const stop = new Set(['what', 'how', 'why', 'when', 'where', 'who', 'which'])
  return (gaps ?? []).filter((g) => {
    const t = String(g).trim().toLowerCase()
    return t.length > 3 && !stop.has(t)
  })
}

export const X_MODES = ['keyword', 'semantic', 'user', 'thread']

/** Keyed / api-tier engines — when layer=api but none of these run, warn. */
const KEYED_OR_API_ENGINES = new Set(['tavily', 'brave', 'exa'])

/** @returns {string | null} */
export function apiLayerFreeOnlyWarning(layer, enginesUsed) {
  if (layer !== 'api') return null
  if (!enginesUsed?.length) return null
  if (enginesUsed.some((e) => KEYED_OR_API_ENGINES.has(e))) return null
  return 'layer api but using free engines only — configure keys (~/.search-boost-keys.json or TAVILY/BRAVE/EXA_API_KEY env) or use search_layer free'
}

/** Attach enginesRequested/enginesUsed and api-layer free-only warning to a fused result. */
export function annotateFusedLayerEngines(result, layer, enginesRequested, enginesUsed) {
  result.enginesRequested = enginesRequested
  result.enginesUsed = enginesUsed
  const warn = apiLayerFreeOnlyWarning(layer, enginesUsed)
  if (warn) result.warnings = [...(result.warnings ?? []), warn]
  return result
}

let researchRoundSeq = 0

/** Use explicit round when provided; otherwise auto-increment per deep_research call. */
export function allocateResearchRound(round) {
  if (typeof round === 'number' && round >= 1) return Math.floor(round)
  return ++researchRoundSeq
}

// Re-export for installer TUI (layer labels in selects)
export { layerSelectOptions }

// ---------------------------------------------------------------------------
// Shared tool orchestration — hosts call these and only render the result.
// ---------------------------------------------------------------------------

/** fetch_page on the shared 24h page cache. `opts.maxChars` caps the returned content. */
export function runFetchPage(url, focus, signal, opts = {}) {
  const target = String(url ?? '').trim()
  if (!target) throw new Error('fetch_page: url is required')
  return fetchPage(target, focus, PAGE_CACHE, signal, opts)
}

/**
 * One deep_research round (coverage / corroboration / gaps / suggested queries)
 * on the active layer's complex tier.
 */
export async function runResearchRound({ query, queries, maxSources, recency, layer = null, round, engineList, signal }) {
  const q = String(query ?? '').trim()
  if (!q) throw new Error('deep_research: query is required')
  const engines = bumpEngines()
  const active = activeLayer(layer)
  const pool = Array.isArray(engineList) && engineList.length
    ? engineList.filter((e) => ENGINE_ORDER.includes(e))
    : layerTierTable(active).complex
  const result = await researchRound({
    query: q,
    queries,
    maxSources: Math.min(Math.max(maxSources ?? 8, 2), 12),
    recency,
    layer: active,
    round: allocateResearchRound(round),
    engines: availableEngines(engines, pool.length ? pool : layerTierTable(active).complex),
    runOne: (engineName, qi, n, o) => runEngine(engines, engineName, qi, n, o),
    signal,
  })
  result.layer = active
  result.gaps = filterResearchGaps(result.gaps)
  return result
}

/**
 * Multi-round evidence loop (auto: up to maxRounds; step: one round + gaps).
 * Runs fused search + page fetch on the shared caches.
 */
export function runResearchLoop(opts) {
  return researchLoop({
    ...opts,
    search: (o) => runFused(o),
    fetch: (url, focus, signal) => runFetchPage(url, focus, signal),
  })
}

export function xSearchCacheKey(kind, args, maxResults) {
  return JSON.stringify({
    kind,
    q: args.query ?? null,
    u: args.username ?? null,
    pid: args.post_id ?? null,
    fd: args.from_date ?? null,
    td: args.to_date ?? null,
    m: maxResults,
    ah: args.allowed_x_handles ?? null,
    eh: args.excluded_x_handles ?? null,
    layer: getLayer(),
    auth: xAuthCacheToken(),
  })
}

/**
 * x_search orchestration shared by every host:
 *   1. sync credential preflight → no credentials: straight to the fallback chain
 *   2. keyword/semantic: hosted xAI tool ∥ layer-aware multi-engine (x.com), merged + deduped
 *   3. user/thread: serial hosted path, fallback chain on failure
 *   4. per-kind TTL cache keyed by args + layer + credential fingerprint; single-flight
 *
 * Returns a neutral result: { via, credential, items, results, tookMs, cacheHit,
 * inFlight?, note?, error?, xResults?, engineResults? }. `via === 'error'` means
 * both primary and fallback failed (items empty, error set) — hosts decide how
 * to surface that.
 */
export async function runXSearch(args, { signal } = {}) {
  const started = Date.now()
  const kind = X_MODES.includes(args?.type) ? args.type : 'keyword'
  const subj = args.query ?? args.username ?? args.post_id ?? ''
  if (!subj) throw new Error('x_search: provide query (keyword/semantic/user) or post_id (thread).')
  if (args.allowed_x_handles?.length && args.excluded_x_handles?.length) {
    throw new Error('x_search: allowed_x_handles and excluded_x_handles are mutually exclusive — pass only one')
  }
  const maxResults = Math.min(Math.max(args.max_results ?? 5, 1), 10)
  const engines = bumpEngines()
  const cacheKey = xSearchCacheKey(kind, args, maxResults)

  const inFlight = X_INFLIGHT.get(cacheKey)
  if (inFlight) {
    return inFlight.then((out) => ({ ...out, cacheHit: false, inFlight: true, tookMs: 0 }))
  }

  const task = (async () => {
    const remember = (out) => {
      if (Array.isArray(out.items)) out.items = cleanJsonValue(out.items)
      if (out.via !== 'error' && out.results > 0) X_CACHE[kind].set(cacheKey, out)
      return out
    }

    const engineSearch = (q, n) => domainSearch(engines, { query: q, maxResults: n, layer: args.layer ?? null, signal })
    const webSearch = (q, n) => engineSearch(q, n)
      .then((hits) => hits.map((h) => ({ title: h.title, url: h.url, snippet: h.snippet, domain: h.domain })))

    const runFallback = async (primaryErr) => {
      try {
        const fb = await fallbackXSearch({
          type: kind,
          query: args.query,
          username: args.username,
          post_id: args.post_id,
          limit: maxResults,
          signal,
          webSearch,
        })
        const items = Array.isArray(fb.data) ? fb.data : [fb.data]
        return remember({
          via: `fallback:${fb.via}`,
          credential: `fallback:${fb.via}`,
          results: items.length,
          tookMs: Date.now() - started,
          cacheHit: false,
          note: `primary: ${String(primaryErr).slice(0, 200)}`,
          items,
        })
      } catch (fbErr) {
        const msg = `${String(primaryErr)} | fallback: ${fbErr instanceof Error ? fbErr.message : String(fbErr)}`
        return { via: 'error', credential: 'none', results: 0, tookMs: Date.now() - started, cacheHit: false, error: msg, items: [] }
      }
    }

    const cached = X_CACHE[kind].get(cacheKey)
    if (cached) return { ...cached, cacheHit: true, tookMs: 0 }

    // preflight (sync, zero network): no official credentials → straight to
    // the multi-engine chain instead of waiting on a primary-path timeout
    if (!xAuthAvailableSync()) {
      return runFallback('no xAI credentials (official path disabled — enable with /x-login or XAI_API_KEY)')
    }

    const toolParams = {
      type: kind,
      query: args.query,
      username: args.username,
      post_id: args.post_id,
      from_date: args.from_date,
      to_date: args.to_date,
      allowed_x_handles: args.allowed_x_handles,
      excluded_x_handles: args.excluded_x_handles,
      model: args.model,
      reasoning_effort: args.reasoning_effort,
      max_results: maxResults,
    }

    // keyword/semantic: PARALLEL instant search — hosted x_search ∥ multi-engine
    if (kind === 'keyword' || kind === 'semantic') {
      const engQuery = args.query ?? (args.username ? `from:${args.username}` : subj)
      const [xOutcome, engOutcome] = await Promise.allSettled([
        runXTool(toolParams, signal),
        engineSearch(engQuery, maxResults),
      ])
      if (xOutcome.status === 'fulfilled') {
        const xPosts = Array.isArray(xOutcome.value.data) ? xOutcome.value.data : []
        const extra = engOutcome.status === 'fulfilled'
          ? engOutcome.value
            .filter((h) => h.title || h.snippet)
            .map(hitToPost)
            .filter((p) => !xPosts.some((x) => {
              if (x.id && p.id && x.id === p.id) return true
              if (x.url && p.url && normalizeUrl(x.url) === normalizeUrl(p.url)) return true
              return false
            }))
          : []
        const merged = [...xPosts, ...extra]
        return remember({
          via: 'parallel',
          credential: xOutcome.value.credential + (extra.length ? ' + multi-engine parallel' : ''),
          results: merged.length,
          tookMs: Date.now() - started,
          cacheHit: false,
          xResults: xPosts.length,
          engineResults: extra.length,
          items: merged,
        })
      }
      return runFallback(xOutcome.reason instanceof Error ? xOutcome.reason.message : String(xOutcome.reason))
    }

    // user/thread: serial primary path, fallback chain on failure
    try {
      const res = await runXTool(toolParams, signal)
      const items = Array.isArray(res.data) ? res.data : [res.data]
      return remember({ via: res.credential, credential: res.credential, results: items.length, tookMs: res.tookMs, cacheHit: false, items })
    } catch (err) {
      return runFallback(err instanceof Error ? err.message : String(err))
    }
  })()

  X_INFLIGHT.set(cacheKey, task)
  try {
    return await task
  } finally {
    X_INFLIGHT.delete(cacheKey)
  }
}

/** Layer / engine / x_search status for `search_layer show`, `/web_change show`, prompt sections. */
export function describeLayer() {
  const engines = bumpEngines()
  const layer = getLayer()
  const { summary } = readKeysRouting()
  const tierTable = layerTierTable(layer)
  const names = [...new Set(Object.values(tierTable).flat())]
  const x = authStatus()
  return {
    layer,
    label: LAYER_LABELS[layer],
    engines: availableEngines(engines, names),
    allEngines: ENGINE_ORDER.filter((name) => engines[name]?.available()),
    keyedEngines: {
      configured: summary.configured,
      enabled: summary.enabled,
      total: summary.total,
      enabledNames: summary.enabledNames,
    },
    xOfficial: xAuthAvailableSync(),
    xSource: x.source,
    xDetail: x.detail,
  }
}

/** Persist a layer and drop caches whose keys embed the layer. */
export function switchLayer(layer) {
  persistLayer(layer)
  invalidateSearchCaches()
  return layer
}

/** x credential commands shared by /x-login, /x-logout and `config x`. */
export const xAuthCommands = {
  status: () => authStatus(),
  importGrok() {
    const entry = importFromGrok()
    invalidateSearchCaches()
    return entry
  },
  setApiKey(key) {
    const entry = importApiKey(key)
    invalidateSearchCaches()
    return entry
  },
  logout() {
    const removed = xLogout()
    invalidateSearchCaches()
    return removed
  },
  path: () => piAuthPath(),
}
