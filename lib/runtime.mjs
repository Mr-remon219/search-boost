/**
 * Engine runtime — caches and search orchestration over dsh lib.
 */
import { importDsh } from './dsh-lib.mjs'

const {
  loadKeys,
  engineRegistry,
  ENGINE_ORDER,
} = await importDsh('engines.js')

export { ENGINE_ORDER }

const {
  fusedSearch,
  makeCache,
  estimateComplexity,
  TIER_ENGINES,
  TIER_ENGINES_FREE,
  searchCacheKey,
  hostOf,
  normalizeUrl,
} = await importDsh('fusion.js')

const { fetchPage, makePageCache } = await importDsh('fetch.js')
const { researchRound } = await importDsh('research.js')
const { getLayer, setLayer, LAYER_LABELS } = await importDsh('layer.js')
const { SEARCH_POLICY_SECTION } = await importDsh('policy.js')
const { runXTool, xAuthAvailableSync } = await importDsh('xsearch.js')
const { fallbackXSearch, hitToPost, cleanJsonValue } = await importDsh('xfallback.js')
const { authStatus } = await importDsh('xauth.js')

export {
  fetchPage,
  researchRound,
  getLayer,
  setLayer,
  LAYER_LABELS,
  SEARCH_POLICY_SECTION,
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
  return engineRegistry(loadKeys())
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

export function resolveLayer(requested) {
  if (requested === 'free' || requested === 'api') {
    setLayer(requested)
    return requested
  }
  const env = process.env.SEARCH_BOOST_LAYER
  if (env === 'free' || env === 'api') setLayer(env)
  return getLayer()
}

export async function runFused({ query, queries, engineList, maxResults, includeDomains, excludeDomains, recency, complexity = 'auto', layer = null, signal }) {
  const engines = bumpEngines()
  const active = layer ?? getLayer()
  const resolvedTier = complexity === 'auto' ? estimateComplexity(query) : complexity
  const tierTable = layerTierTable(active)
  const engineNames = availableEngines(engines, engineList ?? tierTable[resolvedTier] ?? tierTable.simple)
  const key = searchCacheKey({
    query,
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
    stats.recent.unshift({ query, layer: active, tookMs: 0, results: cached.results.length, cacheHit: true })
    if (stats.recent.length > 20) stats.recent.pop()
    return { ...cached, cacheHit: true, tookMs: 0 }
  }
  stats.cacheMisses++
  const result = await fusedSearch({
    query,
    queries,
    engines: engineNames,
    maxResults,
    includeDomains,
    excludeDomains,
    recency,
    tier: resolvedTier,
    layer: active,
    signal,
    runOne: (engineName, q, n, o) => runEngine(engines, engineName, q, n, o),
  })
  result.layer = active
  stats.tierCounts[result.tier] = (stats.tierCounts[result.tier] ?? 0) + 1
  stats.recent.unshift({ query, layer: active, tookMs: result.tookMs, results: result.results.length, cacheHit: false })
  if (stats.recent.length > 20) stats.recent.pop()
  SEARCH_CACHE.set(key, result)
  return result
}

export async function domainSearch(engines, { query, maxResults = 5, includeDomains = ['x.com', 'twitter.com'], signal }) {
  const active = getLayer()
  const keyed = active === 'free' ? [] : ['tavily', 'brave', 'exa']
  const names = availableEngines(engines, ['bing', 'ddg', 'exa-free', ...keyed])
  const n = Math.min(Math.max(maxResults ?? 5, 1), 8)
  const per = Math.max(4, Math.ceil(n * 0.8))
  const opts = { includeDomains, signal }
  const all = (await Promise.all(names.map(async (name) => {
    try {
      return await runEngine(engines, name, query, per, opts)
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

export function fusedHitToJson(r) {
  return {
    title: r.title,
    url: r.url,
    domain: r.domain,
    snippet: r.snippet ?? '',
    score: r.score,
    engines: r.engines,
    published: r.published ?? null,
  }
}

export function formatFusedSummary(value) {
  const lines = [
    `fused_search: "${value.query}" — layer ${value.layer ?? 'api'}, tier ${value.tier}, ${value.results.length} hits, ${value.tookMs}ms${value.cacheHit ? ' (cache)' : ''}`,
  ]
  for (const [i, r] of value.results.entries()) {
    lines.push(`${i + 1}. [${r.score}] ${r.title} — ${r.domain} (${r.engines.join('+')})`)
    lines.push(`   ${r.url}`)
    if (r.snippet) lines.push(`   ${r.snippet.slice(0, 240)}`)
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
