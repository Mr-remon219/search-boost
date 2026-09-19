/**
 * SearchBoost Core runtime — the single host-neutral facade over lib/search.
 *
 * Every host adapter (adapters/mcp, adapters/pi, adapters/dsh) calls into this
 * module for search / fetch / research / x_search orchestration and only adds
 * host-specific registration, rendering and prompt policy on top. Search
 * algorithms live in lib/search/*; nothing here depends on a host SDK.
 */
import {
  ENGINE_ORDER,
} from './search/engines.js'

import {
  fusedSearch,
  makeCache,
  estimateComplexity,
  preprocessQuery,
  TIER_ENGINES,
  TIER_ENGINES_FREE,
  domainSearchQuery,
  searchCacheKey,
  hostOf,
  normalizeUrl,
} from './search/fusion.js'

import { runtimeSnapshot, collectRuntimeCapabilities, formatRuntimeCapabilities } from './search/capability.js'
import { resolveSearchRoute, ENGINE_POOLS, legacyPool } from './search/routing.js'
import { normalizeSearchHit, normalizeDomains, matchesDomains, dedupeBy, resultKey, selectDiverse, resultLimit } from './search/results.js'
import { mergeCommunityResults } from './search/x/community.js'
export { collectRuntimeCapabilities, formatRuntimeCapabilities }

import { fetchPage, makePageCache } from './search/fetch.js'
import { parallelResearch } from './search/research.js'
import { LAYER_LABELS } from './search/layer.js'
import { runXTool, xAuthAvailableSync } from './search/x/xsearch.js'
import { fallbackXSearch, hitToPost, cleanJsonValue } from './search/x/xfallback.js'
import { createXPipeline } from './search/x/x-pipeline.js'
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
} from './search/x/xauth.js'
import { isSsrfError } from './search/ssrf.js'
import { AuditLog, NULL_AUDIT } from './search/audit.js'
import { countWords } from './search/text.js'
import { excerptForTool, pickParagraphs } from './search/evidence.js'
import { getLayer, setLayer, layerSelectOptions } from './layer-config.mjs'

export { ENGINE_ORDER }

export {
  fetchPage,
  parallelResearch,
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
const COMMUNITY_CACHE = makeCache(5 * 60 * 1000)
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
  COMMUNITY_CACHE.clear()
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
    search: SEARCH_CACHE.size() + COMMUNITY_CACHE.size(),
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

export function bumpEngines() { return runtimeSnapshot().engines }

/** Private execution snapshot plus public credential-free capability. */
export function resolveRuntimeEngines() { return runtimeSnapshot() }

export function collectSearchStats() {
  const { routing: { summary }, engines, capability } = runtimeSnapshot()
  const xSource = capability.x.official
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

/**
 * Fused multi-engine search on the active layer with the shared 6h cache.
 * `depth` / `minScore` / `maxResultsCap` are optional host extras (pi exposes
 * them); MCP and DSH use the defaults.
 */
export async function runFused({ query, queries, engineList, maxResults, includeDomains, excludeDomains, recency, complexity = 'medium', layer = null, enginePool, ranking = 'balanced', engineWeights, community = false, depth = null, minScore = 0, maxResultsCap = 10, signal }, { snapshot = runtimeSnapshot, xSearch = runXSearch } = {}) {
  const started = Date.now()
  const q = String(query ?? '').trim()
  if (!q) throw new Error('fused_search: query is required')
  if (typeof community !== 'boolean') throw new Error('community must be boolean')
  signal?.throwIfAborted()
  const state = snapshot()
  const { engines, fingerprint } = state
  const active = activeLayer(layer)
  const route = resolveSearchRoute({ enginePool, layer: active, engineList, ranking, engineWeights, engines })
  const resolvedTier = complexity === 'auto' ? estimateComplexity(q) : complexity
  if (!['simple', 'medium', 'complex'].includes(resolvedTier)) throw new Error('Invalid complexity')
  if (complexity === 'auto') route.warnings.push('complexity=auto is deprecated; use simple, medium or complex (default medium)')
  maxResults = resultLimit(maxResults, resultLimit(maxResultsCap, 20, 10))
  // Use identical query-derived domain constraints on BOTH paths.
  const parsed = [q, ...(queries ?? [])].map(preprocessQuery)
  includeDomains = normalizeDomains([...(includeDomains ?? []), ...parsed.flatMap((p) => p.includeDomains)])
  excludeDomains = normalizeDomains([...(excludeDomains ?? []), ...parsed.flatMap((p) => p.excludeDomains)])
  const communityUsed = community && ['https://x.com/', 'https://twitter.com/'].some((url) => matchesDomains(url, includeDomains, excludeDomains))
  if (community && !communityUsed) route.warnings.push('Community search skipped: domain filters exclude X')
  const cache = community ? COMMUNITY_CACHE : SEARCH_CACHE
  const key = searchCacheKey({ query: q, queries: queries ?? [], engines: route.engineNames, includeDomains, excludeDomains, recency,
    maxResults: `${maxResults}|${depth ?? ''}|${minScore}|${maxResultsCap}`, tier: resolvedTier, layer: active,
    routing: { enginePool: route.enginePool, ranking, weights: route.effectiveWeights, community, requested: route.enginesRequested, fingerprint, complexity },
  })
  const cached = cache.get(key)
  if (cached) { stats.cacheHits++; return { ...cached, cacheHit: true, tookMs: 0 } }
  stats.cacheMisses++
  const fromDays = { day: 1, week: 7, month: 30, year: 365 }[recency]
  const communityArgs = { type: 'keyword', query: parsed[0].source || q,
    max_results: Math.min(30, Math.max(10, maxResults * 3)), enginePool: route.enginePool, engineList: route.enginesRequested,
    ...(fromDays ? { from_date: new Date(Date.now() - fromDays * 86400000).toISOString().slice(0, 10) } : {}),
  }
  if (communityUsed) createXPipeline(communityArgs) // validate before any provider calls
  const [web, x] = await Promise.all([
    fusedSearch({ query: q, queries, engines: route.engineNames, maxResults, maxResultsCap, includeDomains, excludeDomains, recency,
      tier: resolvedTier, layer: active, depth, minScore, signal, engineWeights: route.effectiveWeights, finalize: false,
      runOne: (name, qi, n, opts) => runEngine(engines, name, qi, n, opts),
    }),
    communityUsed ? Promise.resolve().then(() => xSearch(communityArgs, { signal, candidateMode: true, snapshot: () => state })).catch((err) => ({ via: 'error', error: String(err.message ?? err), items: [], enginesUsed: [] })) : null,
  ])
  signal?.throwIfAborted()
  const aggregation = x ? mergeCommunityResults(web.results, x.items ?? [], { query: q, recency, effectiveWeights: route.effectiveWeights, xArgs: communityArgs }) : { results: web.results }
  const rows = aggregation.results
  const selected = selectDiverse(rows.filter((row) => matchesDomains(row.url, includeDomains, excludeDomains)), {
    limit: maxResults, minScore, singleEngineDiscount: route.engineNames.filter((n) => ENGINE_POOLS.api.includes(n)).length === 1 ? 1 : 0.9,
  })
  const engineStats = { ...web.engineStats }
  for (const [name, stat] of Object.entries(x?.engineStats ?? {})) {
    const prior = engineStats[name]
    engineStats[name] = { used: !!(prior?.used || stat.used), errors: (prior?.errors ?? 0) + stat.errors, attempts: (prior?.attempts ?? 0) + (stat.attempts ?? 0), successes: (prior?.successes ?? 0) + (stat.successes ?? 0), ...(stat.note || prior?.note ? { note: stat.note || prior.note } : {}) }
  }
  const enginesUsed = [...new Set([...Object.entries(web.engineStats).filter(([, v]) => v.used).map(([name]) => name), ...(x?.enginesUsed ?? [])])]
  const warnings = [...new Set([...route.warnings, ...web.warnings, ...(x?.warnings ?? []), ...(x?.note ? [`community: ${x.note}`] : []), ...(aggregation.note ? [`community: ${aggregation.note}`] : []), ...(x?.error ? [`community failed: ${x.error}; web results retained`] : [])])]
  const result = { ...web, ...selected, layer: active, enginePool: route.enginePool, ranking,
    enginesRequested: route.enginesRequested, enginesUsed, effectiveWeights: route.effectiveWeights, communityUsed, warnings, engineStats,
    tookMs: Date.now() - started,
  }
  stats.tierCounts[result.tier] = (stats.tierCounts[result.tier] ?? 0) + 1
  stats.recent.unshift({ query: q, layer: active, tookMs: result.tookMs, results: result.results.length, cacheHit: false })
  if (stats.recent.length > 20) stats.recent.pop()
  // Do not cache degraded execution as a full success for six hours.
  if (!x?.error && !Object.values(engineStats).some((stat) => stat.errors)) cache.set(key, result)
  return result
}

/**
 * Layer-aware multi-engine search restricted to specific hosts — the "instant"
 * parallel channel of x_search and the fallback chain's injected webSearch.
 * Calls the engine registry directly (bypassing the fusion scorer, whose
 * per-domain cap of 2 would truncate an X-only result set).
 */
export async function domainSearch(engines, { query, maxResults = 5, includeDomains = ['x.com', 'twitter.com'], layer = null, enginePool, engineList, trace, signal }) {
  const route = resolveSearchRoute({ engines, enginePool, engineList, layer: activeLayer(layer) })
  if (trace) trace.warnings.push(...route.warnings)
  const searchQ = domainSearchQuery(query, includeDomains)
  const per = Math.max(4, Math.ceil(resultLimit(maxResults, 30, 5) * 0.8))
  const all = (await Promise.all(route.engineNames.map(async (name) => {
    const stat = trace ? (trace.engineStats[name] ??= { used: false, errors: 0, attempts: 0, successes: 0 }) : { used: false, errors: 0, attempts: 0, successes: 0 }
    stat.used = true; stat.attempts++
    try {
      const hits = await runEngine(engines, name, searchQ, per, { includeDomains, signal })
      stat.successes++
      return hits.map((hit) => ({ ...hit, engines: [name] }))
    }
    catch (err) { stat.errors++; stat.note = String(err.message ?? err).slice(0, 120); return [] }
  }))).flat()
  signal?.throwIfAborted()
  return dedupeBy(all.map(normalizeSearchHit).filter((hit) => hit && matchesDomains(hit.url, includeDomains)), resultKey, (a, b) => ({
    ...a, snippet: a.snippet || b.snippet, published: a.published || b.published, engines: [...new Set([...a.engines, ...b.engines])],
    ...(!a.username && b.username ? { username: b.username, url: b.url } : {}),
  })) // No pre-filter limit: final X constraints run after enrichment and merge.
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
    ...(r.kind ? { kind: r.kind } : {}),
    ...(r.username ? { username: r.username } : {}),
    ...(r.id ? { id: r.id } : {}),
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

/** True when no engine attempt succeeded (legacy stats fall back to errors). */
export function allAttemptedEnginesFailed(engineStats) {
  if (!engineStats || typeof engineStats !== 'object') return false
  const attempted = Object.values(engineStats).filter((s) => s?.used)
  if (attempted.length === 0) return false
  return attempted.every((s) => s.successes !== undefined ? s.successes === 0 : s.errors > 0)
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
  lines.push(`engine_pool: ${value.enginePool ?? legacyPool(value.layer)}; ranking: ${value.ranking ?? 'balanced'}; enginesUsed: ${(value.enginesUsed ?? []).join(', ') || '(none)'}; effectiveWeights: ${JSON.stringify(value.effectiveWeights ?? {})}; communityUsed: ${!!value.communityUsed}`)
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

// Re-export for installer TUI (layer labels in selects)
export { layerSelectOptions }

// ---------------------------------------------------------------------------
// Shared tool orchestration — hosts call these and only render the result.
// ---------------------------------------------------------------------------

/** fetch_page on the shared 24h page cache. Content is preprocessed, never clipped. */
export function runFetchPage(url, focus, signal, opts = {}) {
  const target = String(url ?? '').trim()
  if (!target) throw new Error('fetch_page: url is required')
  return fetchPage(target, focus, PAGE_CACHE, signal, opts)
}

export function xSearchCacheKey(kind, args, maxResults, fingerprint = runtimeSnapshot().fingerprint, candidateMode = false) {
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
    layer: activeLayer(args.layer),
    model: args.model ?? null,
    effort: args.reasoning_effort ?? null,
    auth: xAuthCacheToken(),
    enginePool: args.enginePool ?? legacyPool(activeLayer(args.layer)),
    engineList: args.engineList ?? null,
    fingerprint, candidateMode,
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
export async function runXSearch(args, { signal, candidateMode = false, snapshot = runtimeSnapshot, officialSearch = runXTool, fallbackSearch = fallbackXSearch } = {}) {
  signal?.throwIfAborted()
  const state = snapshot()
  const started = Date.now()
  const kind = X_MODES.includes(args?.type) ? args.type : 'keyword'
  const subj = args?.query || args?.username || args?.post_id
  if (!subj) throw new Error('x_search: provide query (keyword/semantic/user) or post_id (thread).')
  const maxResults = resultLimit(args.max_results, candidateMode ? 30 : 10, 5)
  const pipeline = createXPipeline({ ...args, type: kind }, maxResults)
  const params = pipeline.params
  const cacheKey = xSearchCacheKey(kind, params, maxResults, state.fingerprint, candidateMode)
  const cached = X_CACHE[kind].get(cacheKey)
  if (cached) return { ...cached, cacheHit: true, tookMs: 0 }
  const inFlight = X_INFLIGHT.get(cacheKey)
  if (inFlight) return inFlight.then((out) => ({ ...out, cacheHit: false, inFlight: true, tookMs: 0 }))

  const task = (async () => {
    const engines = state.engines
    const trace = { engineStats: {}, warnings: [] }
    const diagnostics = () => ({ engineStats: trace.engineStats, enginesUsed: Object.keys(trace.engineStats).filter((n) => trace.engineStats[n].used), warnings: [...trace.warnings, ...Object.entries(trace.engineStats).filter(([, v]) => v.errors).map(([n, v]) => `${n}: ${v.note}`)] })
    const finish = (batches, meta) => {
      signal?.throwIfAborted()
      const filtered = pipeline.finish(batches, { applyConstraints: !candidateMode, limitResults: !candidateMode })
      const note = [meta.note, filtered.note].filter(Boolean).join('; ')
      const out = {
        ...meta, ...filtered, ...diagnostics(), ...(note ? { note } : {}),
        tookMs: Date.now() - started, cacheHit: false,
        items: cleanJsonValue(filtered.items),
      }
      if (out.results > 0) X_CACHE[kind].set(cacheKey, out)
      return out
    }
    const failure = (error) => ({ via: 'error', credential: 'none', results: 0, tookMs: Date.now() - started, cacheHit: false, error, items: [], ...diagnostics() })
    const message = (err) => err instanceof Error ? err.message : String(err)
    const fallback = () => fallbackSearch({
      ...params,
      query: kind === 'keyword' || kind === 'semantic' ? pipeline.searchQuery : params.query,
      limit: pipeline.candidateLimit,
      signal,
      webSearch: (query, maxResults) => domainSearch(engines, { query, maxResults, layer: args.layer, enginePool: args.enginePool, engineList: args.engineList, trace, signal }),
    })
    const finishFallback = (fb, note) => finish([{ source: 'engines', data: fb.data }], {
      via: `fallback:${fb.via}`, credential: `fallback:${fb.via}`, note,
    })
    const runFallback = async (reason) => {
      try { return finishFallback(await fallback(), `primary: ${reason.slice(0, 200)}`) }
      catch (err) { return failure(`${reason} | fallback: ${message(err)}`) }
    }

    if (!state.capability.x.official.available) {
      return runFallback('no xAI credentials (official path disabled — enable with /x-login or XAI_API_KEY)')
    }
    const toolParams = { ...params, max_results: pipeline.candidateLimit }
    if (kind === 'keyword' || kind === 'semantic') {
      // The SAME credential-free retrieval/enrichment path runs alongside the
      // hosted tool. Never re-run it after hosted failure or filter separately.
      const [official, web] = await Promise.allSettled([officialSearch(toolParams, signal), fallback()])
      if (official.status === 'fulfilled') {
        const batches = [{ source: 'official', data: official.value.data }]
        if (web.status === 'fulfilled') batches.push({ source: 'engines', data: web.value.data })
        return finish(batches, {
          via: 'parallel',
          credential: official.value.credential + (web.status === 'fulfilled' && web.value.data.length ? ' + multi-engine parallel' : ''),
          ...(web.status === 'rejected' ? { note: `multi-engine: ${message(web.reason)}` } : {}),
        })
      }
      if (web.status === 'fulfilled') return finishFallback(web.value, `primary: ${message(official.reason).slice(0, 200)}`)
      return failure(`${message(official.reason)} | fallback: ${message(web.reason)}`)
    }
    try {
      const res = await officialSearch(toolParams, signal)
      return finish([{ source: 'official', data: res.data }], { via: res.credential, credential: res.credential })
    } catch (err) { return runFallback(message(err)) }
  })()

  X_INFLIGHT.set(cacheKey, task)
  try { const out = await task; signal?.throwIfAborted(); return out }
  finally { X_INFLIGHT.delete(cacheKey) }
}

/** Layer / engine / x_search status for `search_layer show`, `/web_change show`, prompt sections. */
export function describeLayer() {
  const { routing: { summary }, capability } = runtimeSnapshot()
  return {
    layer: capability.layer,
    label: LAYER_LABELS[capability.layer],
    engines: capability.pools[capability.defaultEnginePool],
    allEngines: capability.availableEngines,
    defaultEnginePool: capability.defaultEnginePool,
    keyedEngines: { configured: summary.configured, enabled: summary.enabled, total: summary.total, enabledNames: summary.enabledNames },
    xOfficial: capability.x.official.available,
    xSource: capability.x.official.source,
    xDetail: authStatus().detail,
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
