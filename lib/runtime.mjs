/**
 * Engine runtime — caches and search orchestration over vendored lib/search.
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
import { researchRound } from './search/research.js'
import { LAYER_LABELS } from './search/layer.js'
import { runXTool, xAuthAvailableSync } from './search/xsearch.js'
import { fallbackXSearch, hitToPost, cleanJsonValue } from './search/xfallback.js'
import { authStatus } from './search/xauth.js'
import { readKeys } from './keys.mjs'
import { getLayer, setLayer, layerSelectOptions } from './layer-config.mjs'

export { ENGINE_ORDER }
export { MCP_POLICY_TEXT } from './mcp-policy.mjs'

export {
  fetchPage,
  researchRound,
  getLayer,
  setLayer,
  LAYER_LABELS,
  runXTool,
  xAuthAvailableSync,
  fallbackXSearch,
  hitToPost,
  cleanJsonValue,
  authStatus,
  hostOf,
}

export const SEARCH_CACHE = makeCache()
export const PAGE_CACHE = makePageCache()
export const X_CACHE = {
  keyword: makeCache(5 * 60 * 1000),
  semantic: makeCache(5 * 60 * 1000),
  user: makeCache(10 * 60 * 1000),
  thread: makeCache(15 * 60 * 1000),
}

export const stats = {
  startedAt: new Date().toISOString(),
  cacheHits: 0,
  cacheMisses: 0,
  tierCounts: {},
  recent: [],
}

export function bumpEngines() {
  return engineRegistry(readKeys())
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

export async function runFused({ query, queries, engineList, maxResults, includeDomains, excludeDomains, recency, complexity = 'auto', layer = null, signal }) {
  const q = String(query ?? '').trim()
  if (!q) throw new Error('fused_search: query is required')

  const engines = bumpEngines()
  const active = activeLayer(layer)
  const resolvedTier = complexity === 'auto' ? estimateComplexity(q) : complexity
  const tierTable = layerTierTable(active)
  const enginesRequested = engineList ?? tierTable[resolvedTier] ?? tierTable.simple
  const engineNames = availableEngines(engines, enginesRequested)
  const key = searchCacheKey({
    query: q,
    queries: queries ?? [],
    engines: engineNames,
    includeDomains: includeDomains ?? [],
    excludeDomains: excludeDomains ?? [],
    recency: recency ?? null,
    maxResults,
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
    includeDomains,
    excludeDomains,
    recency,
    tier: resolvedTier,
    layer: active,
    signal,
    runOne: (engineName, qi, n, o) => runEngine(engines, engineName, qi, n, o),
  })
  result.layer = active
  annotateFusedLayerEngines(result, active, enginesRequested, engineNames)
  stats.tierCounts[result.tier] = (stats.tierCounts[result.tier] ?? 0) + 1
  stats.recent.unshift({ query: q, layer: active, tookMs: result.tookMs, results: result.results.length, cacheHit: false })
  if (stats.recent.length > 20) stats.recent.pop()
  SEARCH_CACHE.set(key, result)
  return result
}

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
const KEYED_OR_API_ENGINES = new Set(['tavily', 'brave', 'exa', 'antigravity'])

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
