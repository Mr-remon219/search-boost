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

import { SCORE_VERSION } from './search/scoring.js'
import { DEFAULT_SNAPSHOT_CANDIDATE_LIMIT, validateSnapshotCandidateLimit } from './search/snapshot-capacity.js'
import { allAttemptedEnginesFailed } from './search/engine-status.js'
export { allAttemptedEnginesFailed }

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
import { describeJudgmentForCapability, readJudgmentConfig } from './judgment/config.mjs'
import { createDecisionClient } from './judgment/registry.mjs'
import { createHeadVerifier } from './judgment/capacity.mjs'
import { runAdaptiveScreening } from './search/screening/run.js'
import { resultPages } from './search/screening/pages.js'
import { saveResearchResultsV3, loadResearchResults } from './research-results.mjs'
import { toolState } from './tool-config.mjs'
import { getLayer, setLayer, layerSelectOptions } from './layer-config.mjs'

export { ENGINE_ORDER }

export {
  fetchPage,
  parallelResearch,
  getLayer,
  setLayer,
  LAYER_LABELS,  runXTool,
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
/** A run where an engine failed is cached briefly: enough to stop re-paying for a
 *  broken engine on repeat queries, short enough not to freeze a degraded answer. */
const DEGRADED_CACHE_TTL_MS = 5 * 60 * 1000
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
  resultPages.clear()
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
  // preprocessQuery turns `site:` into includeDomains and strips it from the
  // query. An engine that cannot filter hosts server-side would then answer with
  // unrelated hosts, and the client-side domain filter would drop every hit — so
  // put the site: hint back for those engines only.
  const query = o?.includeDomains?.length && !engine.nativeDomains ? domainSearchQuery(q, o.includeDomains) : q
  return engine.search(query, n, o)
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
 * Snapshot candidate cap for the single fused screening path (M2). The screening
 * budget's candidateLimit is the same number: the snapshot keeps one bounded pool
 * for web and X rows so the screening layer can judge the whole declared snapshot
 * instead of a per-engine quota or an already-diversified public selection.
 */
/** Bumped when the snapshot's aggregate source weights / global truncation contract changes. */
const SNAPSHOT_CACHE_VERSION = 3

/** Positive-weight sources actually used by one aggregation: a zero-weight engine
 *  never reached the fused score, and an unobserved X source is not provenance. */
function positiveContributionWeights(effectiveWeights) {
  return Object.fromEntries(Object.entries(effectiveWeights).filter(([, weight]) => Number.isFinite(weight) && weight > 0))
}

/** Global score/resultKey snapshot selection: no per-engine quota, no diversity pass. */
function selectSnapshot(rows, limit) {
  const ranked = [...rows].sort((a, b) => (Number(b.score) || 0) - (Number(a.score) || 0) || resultKey(a).localeCompare(resultKey(b)))
  return { results: ranked.slice(0, limit), truncated: ranked.length > limit }
}

/**
 * Snapshot-only community channel record. `not_run` is reserved for a caller that
 * never reached the search stage; this runtime always reports what it did, and a
 * branch that cannot attest its own result is partial, never a success.
 */
function snapshotCommunityExecution({ community, communityUsed, blocked, unavailable, x }) {
  if (!community) return { requested: false, effective: false, outcome: 'not_requested', cacheHit: false, inFlight: false, reason: null, usage: null }
  if (blocked) return { requested: true, effective: false, outcome: 'blocked', cacheHit: false, inFlight: false, reason: 'capability_blocked', usage: null }
  if (unavailable) return { requested: true, effective: false, outcome: 'unavailable', cacheHit: false, inFlight: false, reason: 'x_branch_unavailable', usage: null }
  if (!communityUsed) return { requested: true, effective: false, outcome: 'domain_excluded', cacheHit: false, inFlight: false, reason: 'x_domain_excluded', usage: null }
  const observed = x?.communityExecution
  if (!observed) {
    // The X call rejected before it could attest its own result (validation or an
    // unexpected branch failure): a failed branch, never a success or a partial one.
    if (x?.error) return { requested: true, effective: true, outcome: 'failed', cacheHit: Boolean(x?.cacheHit), inFlight: false, reason: 'channel_failed', usage: null }
    return { requested: true, effective: true, outcome: 'partial', cacheHit: Boolean(x?.cacheHit), inFlight: Boolean(x?.inFlight), reason: 'unknown_channel_state', usage: null }
  }
  return { requested: true, effective: true, ...observed, cacheHit: Boolean(observed.cacheHit || x?.cacheHit), inFlight: Boolean(observed.inFlight || x?.inFlight) }
}

/** Reused results keep their recorded outcome but never claim a fresh dispatch. */
function reusedCommunityExecution(execution, { cacheHit, inFlight }) {
  if (!execution) return execution
  return { ...execution, cacheHit: Boolean(cacheHit), inFlight: Boolean(inFlight),
    usage: execution.usage ? {
      ...execution.usage, logicCalls: 0, dispatchedNow: false,
      officialAttempted: false, fallbackAttempted: false,
      engineRequests: 0, engineErrors: 0, enhancementAttempts: 0, enhancementErrors: 0,
      httpAttempts: 0, tokens: 0,
    } : null }
}

/**
 * Fused multi-engine search on the active layer with the shared 6h cache.
 * `depth` / `minScore` / `maxResultsCap` are optional host extras (pi exposes
 * them); MCP and DSH use the defaults. `candidateSelection: 'snapshot'` is the
 * internal bounded pool used by the screening path; it never changes ordinary
 * fused selection.
 */
export async function runFused({ query, queries, engineList, maxResults, includeDomains, excludeDomains, recency, complexity = 'medium', layer = null, enginePool, ranking = 'balanced', engineWeights, community = false, depth = null, minScore = 0, maxResultsCap = 10, candidateSelection = 'fused', snapshotCandidateLimit = DEFAULT_SNAPSHOT_CANDIDATE_LIMIT, signal }, { snapshot = runtimeSnapshot, xSearch = runXSearch } = {}) {
  const started = Date.now()
  if (!['fused', 'snapshot'].includes(candidateSelection)) throw new Error('Invalid candidate selection')
  const snapshotLimit = candidateSelection === 'snapshot' ? validateSnapshotCandidateLimit(snapshotCandidateLimit) : null
  const q = String(query ?? '').trim()
  if (!q) throw new Error('fused_search: query is required')
  if (typeof community !== 'boolean') throw new Error('community must be boolean')
  signal?.throwIfAborted()
  if (typeof minScore !== 'number' || !Number.isFinite(minScore) || minScore < 0) throw new Error('min_score must be finite and nonnegative')
  const state = snapshot()
  const { engines, fingerprint } = state
  const active = activeLayer(layer)
  const route = resolveSearchRoute({ enginePool, layer: active, engineList, ranking, engineWeights, engines })
  if (minScore > 0) route.warnings.push(`${SCORE_VERSION}: min_score uses the new evidence scale; legacy thresholds require recalibration`)
  const resolvedTier = complexity === 'auto' ? estimateComplexity(q) : complexity
  if (!['simple', 'medium', 'complex'].includes(resolvedTier)) throw new Error('Invalid complexity')
  if (complexity === 'auto') route.warnings.push('complexity=auto is deprecated; use simple, medium or complex (default medium)')
  maxResults = resultLimit(maxResults, resultLimit(maxResultsCap, candidateSelection === 'fused' ? 20 : 500, 10))
  // Use identical query-derived domain constraints on BOTH paths.
  const parsed = [q, ...(queries ?? [])].map(preprocessQuery)
  includeDomains = normalizeDomains([...(includeDomains ?? []), ...parsed.flatMap((p) => p.includeDomains)])
  excludeDomains = normalizeDomains([...(excludeDomains ?? []), ...parsed.flatMap((p) => p.excludeDomains)])
  // P3: the public x_search tool switch is not an internal engine authorization
  // table. Only an explicit capability declaration can disable the X branch, and
  // a missing capability block never counts as one.
  const xCapability = state.capability?.x
  const communityBlocked = community && xCapability?.blocked === true
  const communityUnavailable = community && !xCapability?.official?.available && xCapability?.fallback?.available === false
  const communityUsed = community && !communityBlocked && !communityUnavailable
    && ['https://x.com/', 'https://twitter.com/'].some((url) => matchesDomains(url, includeDomains, excludeDomains))
  if (communityBlocked) route.warnings.push('Community search skipped: the host authorization boundary blocks the X channel')
  else if (communityUnavailable) route.warnings.push('Community search skipped: no usable X channel in this runtime')
  else if (community && !communityUsed) route.warnings.push('Community search skipped: domain filters exclude X')
  const cache = community ? COMMUNITY_CACHE : SEARCH_CACHE
  const key = searchCacheKey({ query: q, queries: queries ?? [], engines: route.engineNames, includeDomains, excludeDomains, recency,
    maxResults: `${maxResults}|${depth ?? ''}|${minScore}|${maxResultsCap}`, tier: resolvedTier, layer: active,
    routing: { enginePool: route.enginePool, ranking, weights: route.effectiveWeights, community, requested: route.enginesRequested, fingerprint, complexity, candidateSelection,
      // A snapshot entry carries aggregate source weights and a channel record;
      // older snapshot shapes must not be reused as this implementation's result.
      ...(candidateSelection === 'snapshot' ? { snapshotVersion: SNAPSHOT_CACHE_VERSION, snapshotCandidateLimit: snapshotLimit } : {}) },
  })
  const cached = cache.get(key)
  if (cached) {
    stats.cacheHits++
    return {
      ...cached, cacheHit: true, tookMs: 0,
      ...(candidateSelection === 'snapshot' ? { communityExecution: reusedCommunityExecution(cached.communityExecution, { cacheHit: true, inFlight: false }) } : {}),
    }
  }
  stats.cacheMisses++
  const fromDays = { day: 1, week: 7, month: 30, year: 365 }[recency]
  const communityArgs = { type: 'keyword', query: parsed[0].source || q,
    max_results: Math.min(30, Math.max(10, maxResults * 3)), enginePool: route.enginePool, engineList: route.enginesRequested,
    ...(fromDays ? { from_date: new Date(Date.now() - fromDays * 86400000).toISOString().slice(0, 10) } : {}),
  }
  if (communityUsed) createXPipeline(communityArgs) // validate before any provider calls
  const [web, x] = await Promise.all([
    fusedSearch({ query: q, queries, engines: route.engineNames, maxResults, maxResultsCap, includeDomains, excludeDomains, recency,
      tier: resolvedTier, layer: active, depth, minScore, signal, engineWeights: route.effectiveWeights, finalize: false, candidateMode: candidateSelection === 'snapshot',
      runOne: (name, qi, n, opts) => runEngine(engines, name, qi, n, { ...opts, enginePool: route.enginePool }),
    }),
    communityUsed ? Promise.resolve().then(() => xSearch(communityArgs, { signal, candidateMode: true, snapshot: () => state })).catch((err) => ({ via: 'error', error: String(err.message ?? err), items: [], enginesUsed: [] })) : null,
  ])
  signal?.throwIfAborted()
  const aggregation = x ? mergeCommunityResults(web.results, x.items ?? [], { query: q, recency, effectiveWeights: route.effectiveWeights, xArgs: communityArgs }) : { results: web.results }
  const rows = aggregation.results
  const filteredRows = rows.filter((row) => matchesDomains(row.url, includeDomains, excludeDomains))
  const selected = candidateSelection === 'snapshot'
    ? selectSnapshot(filteredRows, snapshotLimit)
    : selectDiverse(filteredRows, { limit: maxResults, minScore, includeDomains })
  const engineStats = { ...web.engineStats }
  for (const [name, stat] of Object.entries(x?.engineStats ?? {})) {
    const prior = engineStats[name]
    engineStats[name] = { used: !!(prior?.used || stat.used), errors: (prior?.errors ?? 0) + stat.errors, attempts: (prior?.attempts ?? 0) + (stat.attempts ?? 0), successes: (prior?.successes ?? 0) + (stat.successes ?? 0), ...(stat.note || prior?.note ? { note: stat.note || prior.note } : {}) }
  }
  const enginesUsed = [...new Set([...Object.entries(web.engineStats).filter(([, v]) => v.used).map(([name]) => name), ...(x?.enginesUsed ?? [])])]
  const warnings = [...new Set([...route.warnings, ...web.warnings, ...(x?.warnings ?? []), ...(x?.note ? [`community: ${x.note}`] : []), ...(aggregation.note ? [`community: ${aggregation.note}`] : []), ...(x?.error ? [`community failed: ${x.error}; web results retained`] : [])])]
  const freeOnlyWarning = apiLayerFreeOnlyWarning(active, enginesUsed, { anysearchKeyed: route.enginePool !== 'free' && !!state.routing?.keys?.anysearch })
  if (freeOnlyWarning) warnings.push(freeOnlyWarning)
  const result = { ...web, ...selected, layer: active, enginePool: route.enginePool, ranking,
    enginesRequested: route.enginesRequested, enginesUsed, effectiveWeights: route.effectiveWeights, communityUsed, warnings, engineStats,
    // Evidence-funnel stage counts (additive; public contract unchanged):
    // engineRowsRaw = rows returned by engines before any merge,
    // uniqueCandidates = rows surviving URL/metadata merge, fusionRows = rows
    // reaching the final candidate selection, selectedRows = rows kept.
    funnel: {
      engineRowsRaw: web.funnel?.engineRowsRaw ?? null,
      uniqueCandidates: web.funnel?.uniqueCandidates ?? null,
      fusionRows: rows.length,
      selectedRows: selected.results?.length ?? 0,
      truncated: Boolean(selected.truncated),
    },
    tookMs: Date.now() - started,
    // Snapshot-only metadata for the screening path: the source weights the
    // aggregation really used and one bounded channel execution record.
    // Ordinary fused public fields keep their existing meaning.
    ...(candidateSelection === 'snapshot' ? {
      contributionWeights: aggregation.contributionWeights ?? positiveContributionWeights(route.effectiveWeights),
      communityExecution: snapshotCommunityExecution({ community, communityUsed, blocked: communityBlocked, unavailable: communityUnavailable, x }),
    } : {}),
  }
  stats.tierCounts[result.tier] = (stats.tierCounts[result.tier] ?? 0) + 1
  stats.recent.unshift({ query: q, layer: active, tookMs: result.tookMs, results: result.results.length, cacheHit: false })
  if (stats.recent.length > 20) stats.recent.pop()
  // Clean runs keep the full TTL. A run where an engine failed is still cached
  // when it produced results, but only briefly: one broken engine must not disable
  // caching entirely, and a degraded answer must not be frozen for six hours. An X
  // failure stays uncached so community evidence never masquerades as a success.
  const degraded = Object.values(engineStats).some((stat) => stat.errors)
  if (!x?.error) {
    if (!degraded) cache.set(key, result)
    else if (result.results.length) cache.set(key, result, DEGRADED_CACHE_TTL_MS)
  }
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
      const hits = await runEngine(engines, name, searchQ, per, { includeDomains, signal, enginePool: route.enginePool })
      stat.successes++
      return hits.map((hit, rank) => ({ ...hit, engines: [name], engineRanks: { [name]: Number.isSafeInteger(hit.providerRank) && hit.providerRank >= 1 ? hit.providerRank : rank + 1 } }))
    }
    catch (err) { stat.errors++; stat.note = String(err.message ?? err).slice(0, 120); return [] }
  }))).flat()
  signal?.throwIfAborted()
  return dedupeBy(all.map(normalizeSearchHit).filter((hit) => hit && matchesDomains(hit.url, includeDomains)), resultKey, (a, b) => ({
    ...a, engineRanks: Object.fromEntries([...new Set([...Object.keys(a.engineRanks), ...Object.keys(b.engineRanks)])].map((name) => [name, Math.min(a.engineRanks[name] ?? Infinity, b.engineRanks[name] ?? Infinity)])), snippet: a.snippet || b.snippet, published: a.published || b.published, engines: [...new Set([...a.engines, ...b.engines])],
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
    scoreVersion: r.scoreVersion ?? SCORE_VERSION,
    rankScore: r.rankScore, evidenceScore: r.evidenceScore, consensusBoost: r.consensusBoost,
    metadataDelta: r.metadataDelta, selectionScore: r.selectionScore,
    engineRanks: r.engineRanks, contributions: r.contributions, provenance: r.provenance, dateStatus: r.dateStatus,
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

export function formatAllEnginesFailedMessage(result) {
  const engines = formatEngineStatsLine(result.engineStats)
  const layer = result.layer ?? 'api'
  const hint = layer === 'free'
    ? 'Inspect search_stats, returned engine errors and network/proxy settings. Configure keys with search-boost config keys only when authorized; search_layer api is a persistent change, not an automatic retry.'
    : 'Inspect search_stats and returned engine errors first; check configured keys with search-boost config keys --show. A network failure does not by itself imply a missing key.'
  return `fused_search: all engines failed for "${result.query}" (${engines}). ${hint}`
}

export function formatFusedSummary(value) {
  const lines = [
    `fused_search: "${value.query}" — layer ${value.layer ?? 'api'}, tier ${value.tier}, ${value.results.length} hits, ${value.tookMs}ms${value.cacheHit ? ' (cache)' : ''}`,
  ]
  lines.push(`scoreVersion: ${value.scoreVersion ?? SCORE_VERSION}; engine_pool: ${value.enginePool ?? legacyPool(value.layer)}; ranking: ${value.ranking ?? 'balanced'}; enginesUsed: ${(value.enginesUsed ?? []).join(', ') || '(none)'}; effectiveWeights: ${JSON.stringify(value.effectiveWeights ?? {})}; communityUsed: ${!!value.communityUsed}`)
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
export function apiLayerFreeOnlyWarning(layer, enginesUsed, { anysearchKeyed = false } = {}) {
  if (layer !== 'api') return null
  if (!enginesUsed?.length) return null
  if (enginesUsed.some((e) => KEYED_OR_API_ENGINES.has(e) || (e === 'anysearch' && anysearchKeyed))) return null
  return 'layer api but using free engines only — inspect capabilities and warnings; keyed engines may be missing, disabled or excluded. Change keys or persistent defaults only when authorized.'
}

/** Attach enginesRequested/enginesUsed and api-layer free-only warning to a fused result. */
export function annotateFusedLayerEngines(result, layer, enginesRequested, enginesUsed, authModes = {}) {
  result.enginesRequested = enginesRequested
  result.enginesUsed = enginesUsed
  const warn = apiLayerFreeOnlyWarning(layer, enginesUsed, authModes)
  if (warn) result.warnings = [...(result.warnings ?? []), warn]
  return result
}

// Re-export for installer TUI (layer labels in selects)
export { layerSelectOptions }

// ---------------------------------------------------------------------------
// Shared tool orchestration — hosts call these and only render the result.
// ---------------------------------------------------------------------------

/** fetch_page on the shared 24h page cache. Content is preprocessed and returned
 * in bounded windows (see windowPageResult); the cached body is never clipped. */
export function runFetchPage(url, focus, signal, opts = {}) {
  const target = String(url ?? '').trim()
  if (!target) throw new Error('fetch_page: url is required')
  return fetchPage(target, focus, PAGE_CACHE, signal, opts)
}

/** Credential-free Jev readiness for capability sections and MCP resources. */
export function jevCapability() {
  return describeJudgmentForCapability()
}

/**
 * adaptive_search — the single N_off screening flow shared by MCP / Pi / DSH.
 *
 * One bounded fused candidate snapshot, one fixed-option Jev strategy request
 * (ranking plus, when community is omitted, enable/disable/unknown for the
 * already-wired community branch), then the prototype safety/value/discount
 * screening and ranking. All heavy lifting lives in lib/search/screening/*; this
 * facade only wires the host-neutral dependencies and adds the audit sink.
 * `deps` stays injectable so hosts/tests can exercise the flow offline.
 *
 * There is no self-imposed cumulative cost, token, request-count or whole-run
 * time quota: `opts.deadlineMs` is ignored on purpose and usage is observation
 * only. Real per-request timeouts, limited retries, authentication/rate-limit
 * failures, safety refusals, SSRF/network policy and explicit cancellation stay.
 *
 * @param {object} input public adaptive_search arguments
 * @param {{ signal?: AbortSignal | null, audit?: { write: Function } | null, host?: 'mcp'|'pi'|'dsh', onProgress?: (message: string) => void, limits?: object }} [opts]
 * @param {object} [deps] host-neutral dependency overrides (tests only)
 */
export function runAdaptiveSearch(input, opts = {}, deps = {}) {
  return runAdaptiveScreening(input, opts, {
    toolState: () => toolState('adaptive_search'),
    readConfig: readJudgmentConfig,
    createClient: ({ provider = 'jev', baseUrl, apiKey, model, transport, authMode, options, capacityManifest, ...controls }) =>
      createDecisionClient({ provider, baseUrl, apiKey, ...(model ? { model } : {}),
        ...(transport ? { transport } : {}), ...(authMode ? { authMode } : {}), ...(options ? { options } : {}) }, { ...controls, verifyHead: createHeadVerifier(capacityManifest) }),
    snapshot: runtimeSnapshot,
    route: (state, ranking) => resolveSearchRoute({ ...state, ranking }),
    search: (args, state) => runFused(args, { snapshot: () => state }),
    loadResults: loadResearchResults,
    saveResults: saveResearchResultsV3,
    ...deps,
  })
}

export function xSearchCacheKey(kind, args, maxResults, fingerprint = runtimeSnapshot().fingerprint, candidateMode = false) {  return JSON.stringify({
    kind, scoreVersion: SCORE_VERSION,
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
    // Candidate-mode entries carry the bounded channel record; an older entry
    // without it must not be reused as if the channel were observed successfully.
    ...(candidateMode ? { snapshotVersion: SNAPSHOT_CACHE_VERSION } : {}),
  })
}

/** Reject with the signal's own reason when it is an Error (matches text.throwIfAborted). */
const abortErrorFor = (signal) => (signal.reason instanceof Error ? signal.reason : new Error('aborted'))

/**
 * Single-flight registry for x_search. The shared run owns its own
 * AbortController: every caller — the first one included — waits with its own
 * signal, so cancelling one waiter neither aborts the run that other waiters
 * still need nor keeps it waiting for a result it no longer wants. The run is
 * aborted once the last waiter leaves. New callers never join an aborted run;
 * cleanup is identity-checked so an old run cannot evict its replacement.
 */
function startSharedX(key, run) {
  const flight = { key, controller: new AbortController(), waiters: 0, settled: false, promise: null }
  const settle = () => {
    flight.settled = true
    if (X_INFLIGHT.get(key) === flight) X_INFLIGHT.delete(key)
  }
  flight.promise = run(flight.controller.signal)
  flight.promise.then(settle, settle)
  X_INFLIGHT.set(key, flight)
  return flight
}

function awaitSharedX(flight, signal) {
  flight.waiters++
  let released = false
  const release = () => {
    if (released) return
    released = true
    flight.waiters--
    if (flight.waiters <= 0 && !flight.settled) {
      if (X_INFLIGHT.get(flight.key) === flight) X_INFLIGHT.delete(flight.key)
      flight.controller.abort()
    }
  }
  let wait
  if (!signal) wait = flight.promise
  else if (signal.aborted) wait = Promise.reject(abortErrorFor(signal))
  else wait = new Promise((resolve, reject) => {
    const onAbort = () => reject(abortErrorFor(signal))
    signal.addEventListener('abort', onAbort, { once: true })
    flight.promise.then(
      (value) => { signal.removeEventListener('abort', onAbort); resolve(value) },
      (error) => { signal.removeEventListener('abort', onAbort); reject(error) },
    )
  })
  return wait.finally(release)
}

/**
 * Snapshot-only channel outcome from settled branch facts and observed engine
 * counters. Notes, warnings and `via` strings are never parsed for status:
 *  - a planned credential-free fallback is normal operation (official not dispatched)
 *  - one dispatched channel failing while another answers is partial, never success
 *  - every attempted engine failing is failed, never an empty success
 *  - a leg that dispatched no engine at all is unavailable, not empty
 */
function xChannelOutcome({ official, web, officialRows = 0, webRows = 0, engines = 'none' }) {
  const rows = officialRows + webRows
  if (official === 'rejected' && web === 'rejected') return { outcome: 'failed', reason: 'channel_failures' }
  if (engines === 'all_failed') return { outcome: rows > 0 ? 'partial' : 'failed', reason: 'engine_failures' }
  if (official === 'rejected') {
    if (web === 'not_dispatched') return { outcome: 'failed', reason: 'official_failed' }
    if (rows === 0 && engines === 'none') return { outcome: 'failed', reason: 'no_engines' }
    return { outcome: 'partial', reason: 'official_failed' }
  }
  if (web === 'rejected') return { outcome: 'partial', reason: 'fallback_failed' }
  if (engines === 'partial') return { outcome: 'partial', reason: 'engine_failures' }
  if (rows > 0) return { outcome: 'succeeded', reason: null }
  if (web === 'fulfilled' && engines === 'none') return { outcome: 'unavailable', reason: 'no_engines' }
  return { outcome: 'empty', reason: 'no_results' }
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
 * to surface that. Candidate (snapshot) mode additionally returns the bounded
 * `communityExecution` record; ordinary x_search output is unchanged.
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
  // A candidate-mode entry without the channel record is an incompatible cache
  // shape: it is not reused as a successfully observed community channel.
  if (cached && (!candidateMode || cached.communityExecution)) {
    return { ...cached, cacheHit: true, tookMs: 0,
      ...(cached.communityExecution ? { communityExecution: reusedCommunityExecution(cached.communityExecution, { cacheHit: true, inFlight: false }) } : {}) }
  }
  const shared = X_INFLIGHT.get(cacheKey)
  if (shared && !shared.controller.signal.aborted) {
    const out = await awaitSharedX(shared, signal)
    return { ...out, cacheHit: false, inFlight: true, tookMs: 0,
      ...(out.communityExecution ? { communityExecution: reusedCommunityExecution(out.communityExecution, { cacheHit: false, inFlight: true }) } : {}) }
  }

  // The task is driven by the shared signal, not by any single caller's.
  const task = (signal) => (async () => {
    const engines = state.engines
    const trace = { engineStats: {}, warnings: [] }
    // Dispatch facts recorded by the branches themselves; the channel record is
    // derived from these settled statuses, not re-read from notes/warnings.
    const facts = { official: 'not_dispatched', officialRows: 0, web: 'not_dispatched', webRows: 0, enhancements: null }
    const diagnostics = () => ({ engineStats: trace.engineStats, enginesUsed: Object.keys(trace.engineStats).filter((n) => trace.engineStats[n].used), warnings: [...trace.warnings, ...Object.entries(trace.engineStats).filter(([, v]) => v.errors).map(([n, v]) => `${n}: ${v.note}`)] })
    const engineChannel = () => {
      const attempted = Object.values(trace.engineStats).filter((stat) => stat?.used)
      if (!attempted.length) return 'none'
      const errored = attempted.filter((stat) => (stat.errors ?? 0) > 0)
      if (!errored.length) return 'ok'
      return errored.length === attempted.length ? 'all_failed' : 'partial'
    }
    const channelRecord = () => {
      if (!candidateMode) return null
      const attempted = Object.entries(trace.engineStats).filter(([, stat]) => stat?.used)
      return {
        requested: true, effective: true,
        ...xChannelOutcome({ official: facts.official, web: facts.web, officialRows: facts.officialRows, webRows: facts.webRows, engines: engineChannel() }),
        cacheHit: false, inFlight: false,
        usage: {
          // Observed facts of this run. Provider-internal HTTP attempts and billing
          // tokens are not exposed here and stay null (unknown), never estimated.
          logicCalls: 1, dispatchedNow: true,
          officialAttempted: facts.official !== 'not_dispatched',
          fallbackAttempted: facts.web !== 'not_dispatched',
          engineRequests: attempted.length ? attempted.reduce((sum, [, stat]) => sum + (stat.attempts ?? 0), 0) : null,
          engineErrors: attempted.length ? attempted.reduce((sum, [, stat]) => sum + (stat.errors ?? 0), 0) : null,
          enginesUsed: attempted.map(([name]) => name),
          enhancementAttempts: facts.enhancements?.attempted ?? null,
          enhancementErrors: facts.enhancements?.failed ?? null,
          httpAttempts: null,
          tokens: null,
        },
      }
    }
    const finish = (batches, meta) => {
      signal?.throwIfAborted()
      const filtered = pipeline.finish(batches, { applyConstraints: !candidateMode, limitResults: !candidateMode })
      const note = [meta.note, filtered.note].filter(Boolean).join('; ')
      const record = channelRecord()
      const out = {
        ...meta, ...filtered, ...diagnostics(), ...(note ? { note } : {}),
        tookMs: Date.now() - started, cacheHit: false,
        items: cleanJsonValue(filtered.items),
        ...(record ? { communityExecution: record } : {}),
      }
      if (out.results > 0) X_CACHE[kind].set(cacheKey, out)
      return out
    }
    const failure = (error) => {
      const record = channelRecord()
      return { via: 'error', credential: 'none', results: 0, tookMs: Date.now() - started, cacheHit: false, error, items: [], ...diagnostics(), ...(record ? { communityExecution: record } : {}) }
    }
    const message = (err) => err instanceof Error ? err.message : String(err)
    const enhancementNote = (fb) => fb?.enhancement?.failed
      ? `oEmbed enhancement: ${fb.enhancement.failed}/${fb.enhancement.attempted} post(s) kept the base engine text`
      : null
    const fallback = async () => {
      facts.web = 'dispatched'
      try {
        const fb = await fallbackSearch({
          ...params,
          query: kind === 'keyword' || kind === 'semantic' ? pipeline.searchQuery : params.query,
          limit: pipeline.candidateLimit,
          signal,
          webSearch: (query, maxResults) => domainSearch(engines, { query, maxResults, layer: args.layer, enginePool: args.enginePool, engineList: args.engineList, trace, signal }),
        })
        facts.web = 'fulfilled'
        facts.webRows = Array.isArray(fb?.data) ? fb.data.length : 0
        facts.enhancements = fb?.enhancement ?? null
        return fb
      } catch (err) {
        facts.web = 'rejected'
        throw err
      }
    }
    const official = async (toolParams) => {
      facts.official = 'dispatched'
      try {
        const res = await officialSearch(toolParams, signal)
        facts.official = 'fulfilled'
        facts.officialRows = Array.isArray(res?.data) ? res.data.length : 0
        return res
      } catch (err) {
        facts.official = 'rejected'
        throw err
      }
    }
    const finishFallback = (fb, note) => finish([{ source: 'engines', data: fb.data }], {
      via: `fallback:${fb.via}`, credential: `fallback:${fb.via}`,
      note: [note, enhancementNote(fb)].filter(Boolean).join('; '),
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
      const [officialResult, web] = await Promise.allSettled([official(toolParams), fallback()])
      if (officialResult.status === 'fulfilled') {
        const batches = [{ source: 'official', data: officialResult.value.data }]
        if (web.status === 'fulfilled') batches.push({ source: 'engines', data: web.value.data })
        const notes = [
          web.status === 'rejected' ? `multi-engine: ${message(web.reason)}` : null,
          web.status === 'fulfilled' ? enhancementNote(web.value) : null,
        ].filter(Boolean)
        return finish(batches, {
          via: 'parallel',
          credential: officialResult.value.credential + (web.status === 'fulfilled' && web.value.data.length ? ' + multi-engine parallel' : ''),
          ...(notes.length ? { note: notes.join('; ') } : {}),
        })
      }
      if (web.status === 'fulfilled') return finishFallback(web.value, `primary: ${message(officialResult.reason).slice(0, 200)}`)
      return failure(`${message(officialResult.reason)} | fallback: ${message(web.reason)}`)
    }
    try {
      const res = await official(toolParams)
      return finish([{ source: 'official', data: res.data }], { via: res.credential, credential: res.credential })
    } catch (err) { return runFallback(message(err)) }
  })()

  const flight = startSharedX(cacheKey, task)
  const out = await awaitSharedX(flight, signal)
  signal?.throwIfAborted()
  return out
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

/** x credential commands shared by /x-login, /x-logout and `config x`. */export const xAuthCommands = {
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
