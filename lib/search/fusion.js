// Versioned evidence fusion, query preprocessing and TTL cache.
export const CACHE_TTL_MS = 6 * 3600 * 1000

import { SCORE_VERSION, SCORE_CONFIG, scoreEvidence, logicalEngine } from './scoring.js'
export { SCORE_VERSION, SCORE_CONFIG, scoreEvidence } from './scoring.js'

import { ENGINE_POOLS, RANKING_WEIGHTS, legacyPool } from './routing.js'
import { normalizeSearchHit, normalizeDomains, matchesDomains, resultKey, dedupeBy, selectDiverse, resultLimit } from './results.js'
export { collapseSpace, hostOf, normalizeUrl, parseDate, displayUrl } from './results.js'

// Compatibility exports. Budget no longer changes the selected engine pool.
export const TIER_ENGINES = Object.fromEntries(['simple', 'medium', 'complex'].map((tier) => [tier, ENGINE_POOLS.hybrid]))
export const TIER_ENGINES_FREE = Object.fromEntries(['simple', 'medium', 'complex'].map((tier) => [tier, ENGINE_POOLS.free]))
export const FREE_DOMAIN_ENGINES = ENGINE_POOLS.free
export function tierEnginesFor(layer, tier) { return ENGINE_POOLS[legacyPool(layer)] }
export const TIER_VARIANTS = { simple: 1, medium: 2, complex: 3 }

const RESEARCH_SIGNALS =
  /compare|comparison|comparative|versus|vs\.?|difference|architecture|design|implement|how to|why|what is the best|review|benchmark|survey|tutorial|guide|optimization|performance|最新|综述|对比|区别|架构|设计|实现|原理|怎么|如何|选型|方案/i

const RECENCY_HALF_LIFE_DAYS = { day: 0.5, week: 3, month: 15, year: 90 }

export function searchCacheKey({ query, queries = [], engines = [], includeDomains = [], excludeDomains = [], recency = null, maxResults, tier, layer = null, routing = null }) {
  return JSON.stringify({
    v: 5, scoreVersion: SCORE_VERSION, scoring: SCORE_CONFIG,
    q: query,
    qs: queries,
    e: engines,
    id: includeDomains,
    xd: excludeDomains,
    rec: recency ?? null,
    m: maxResults,
    t: tier,
    lay: layer ?? null,
    routing,
  })
}


export function queryTerms(text) {
  const out = []
  const lower = String(text ?? '').toLowerCase()
  for (const m of lower.match(/[a-z0-9][a-z0-9\-_.]{1,}/g) || []) {
    if (m.length >= 2 && !/^\d+$/.test(m)) out.push(m)
  }
  for (const run of lower.match(/[\u4e00-\u9fff]{2,}/g) || []) {
    for (let i = 0; i + 2 <= run.length; i++) out.push(run.slice(i, i + 2))
  }
  return out
}

export function preprocessQuery(raw) {
  let q = String(raw ?? '').trim().replace(/[“”]/g, '"')
  // Preserve phrase text verbatim; site:/OR inside a quote are text, not our
  // routing syntax. Placeholders are local and cannot collide with the input.
  let prefix = '\uE000'
  while (q.includes(prefix)) prefix += '\uE000'
  const phrases = []
  q = q.replace(/"(?:\\.|[^"\\])*"?/g, (phrase) => `${prefix}${phrases.push(phrase) - 1}\uE001`)
  const restore = (text) => text.replace(new RegExp(`${prefix}(\\d+)\uE001`, 'g'), (_, id) => phrases[Number(id)])
  const includeDomains = [], excludeDomains = []
  q = q.replace(/(?:^|\s)(-?)site:([a-z0-9][a-z0-9.-]*\.[a-z]{2,})/gi, (_m, neg, d) => {
    ;(neg ? excludeDomains : includeDomains).push(d.toLowerCase())
    return ' '
  })
  const source = restore(q.replace(/\s+/g, ' ').trim())
  const parts = q.split(/\s+OR\s+/i).map((part) => restore(part.replace(/\s+/g, ' ').trim()))
  const cleaned = parts.shift() ?? ''
  return { cleaned, source, includeDomains: [...new Set(includeDomains)], excludeDomains: [...new Set(excludeDomains)],
    alternatives: [...new Set(parts.filter((part) => part && part !== cleaned))] }
}

export function estimateComplexity(query) {
  if (RESEARCH_SIGNALS.test(query)) return 'complex'
  const n = queryTerms(query).length
  if (n <= 2) return 'simple'
  if (n <= 4) return 'medium'
  return 'complex'
}

/**
 * When domainSearch filters to specific hosts, prepend site: so HTML engines
 * (ddg/yahoo) return in-domain URLs instead of the generic homepages.
 */
export function domainSearchQuery(query, includeDomains) {
  const q = String(query ?? '').trim()
  if (!q || !includeDomains?.length) return q
  if (/\bsite:/i.test(q)) return q
  const site = includeDomains.includes('x.com') ? 'x.com'
    : includeDomains.includes('twitter.com') ? 'twitter.com'
      : includeDomains[0]
  return `site:${site} ${q}`
}

/** Fetch and score web candidates. Runtime optionally defers final selection
 * until community results join; direct callers retain final diversity/limits. */
export async function fusedSearch({ query, queries, engines, maxResults = 6, maxResultsCap = 10, includeDomains = [], excludeDomains = [], recency, tier = 'medium', layer = null, depth = null, minScore = 0, engineWeights = RANKING_WEIGHTS.hybrid.balanced, finalize = true, runOne, signal }) {
  const started = Date.now()
  maxResults = resultLimit(maxResults, Math.min(20, maxResultsCap))
  const resolvedTier = tier === 'auto' ? estimateComplexity(query) : tier
  if (!Object.hasOwn(TIER_VARIANTS, resolvedTier)) throw new Error('Invalid complexity')
  const resolvedDepth = depth === 'basic' || depth === 'advanced' ? depth : (resolvedTier === 'complex' ? 'advanced' : 'basic')
  const scoreFloor = Number.isFinite(Number(minScore)) ? Math.max(0, Number(minScore)) : 0
  const warnings = []
  const engineNames = [...new Set(engines ?? ENGINE_POOLS[legacyPool(layer)])]
  if (!engineNames.length) warnings.push('No available engines; no implicit fallback')
  signal?.throwIfAborted()

  const parsed = [query, ...(queries ?? [])].map(preprocessQuery)
  includeDomains = normalizeDomains([
    ...includeDomains,
    ...parsed.flatMap((p) => p.includeDomains),
  ])
  excludeDomains = normalizeDomains([
    ...excludeDomains,
    ...parsed.flatMap((p) => p.excludeDomains),
  ])

  const variantPool = [...new Set(parsed.flatMap((p) => [p.cleaned, ...p.alternatives]).filter(Boolean))]
  if (variantPool.length === 0) variantPool.push(query)
  const variants = variantPool.slice(0, TIER_VARIANTS[resolvedTier])

  const maxPerEngine = Math.min(20, Math.max({ simple: 4, medium: 8, complex: 10 }[resolvedTier], Math.ceil(maxResults * 0.75)))
  const perEngineHits = new Map()
  const engineStats = {}
  for (const e of engineNames) engineStats[e] = { used: false, errors: 0, attempts: 0, successes: 0 }

  const tasks = []
  for (const e of engineNames) tasks.push({ engine: e, query: variants[0] })
  for (let i = 1; i < variants.length; i++) {
    for (const e of engineNames) tasks.push({ engine: e, query: variants[i] })
  }

  await Promise.all(tasks.map(async (task) => {
    const key = `${task.engine}\u0000${task.query}`
    engineStats[task.engine].used = true
    engineStats[task.engine].attempts++
    try {
      const hits = await runOne(task.engine, task.query, maxPerEngine, { includeDomains, excludeDomains, recency, depth: resolvedDepth, signal })
      engineStats[task.engine].successes++
      perEngineHits.set(key, hits)
    } catch (err) {
      engineStats[task.engine].errors++
      engineStats[task.engine].note = (err instanceof Error ? err.message : String(err)).slice(0, 120)
      perEngineHits.set(key, [])
    }
  }))

  signal?.throwIfAborted()
  for (const [name, stat] of Object.entries(engineStats)) if (stat.errors) warnings.push(`${name}: ${stat.errors}/${stat.attempts} attempts failed (${stat.note})`)
  // merge
  const candidates = tasks.flatMap((task) => (perEngineHits.get(`${task.engine}\u0000${task.query}`) ?? []).flatMap((raw, rank) => {
    const hit = normalizeSearchHit(raw)
    if (!hit || !matchesDomains(hit.url, includeDomains, excludeDomains)) return []
    rank = Number.isSafeInteger(raw.providerRank) && raw.providerRank >= 1 ? raw.providerRank - 1 : rank
    const engine = logicalEngine(task.engine)
    return [{ ...hit, engines: [engine], engineRanks: { [engine]: rank + 1 },
      provenance: [{ engine, rank: rank + 1, variant: task.query, url: hit.url, title: hit.title, snippet: hit.snippet, published: hit.published }],
    }]
  }))
  const merged = mergeFusedCandidates(candidates, query)
  const ranked = rankFusedRows(merged, query, recency, engineWeights)
  const { results: capped, truncated } = finalize
    ? selectDiverse(ranked, { limit: maxResults, minScore: scoreFloor, includeDomains })
    : { results: ranked, truncated: false }

  const clean = capped.map((r) => {
    const item = { title: r.title, url: r.url, domain: r.domain, snippet: r.snippet, score: r.score, engines: r.engines, kind: r.kind, engineRanks: r.engineRanks, scoreVersion: SCORE_VERSION, rankScore: r.rankScore, evidenceScore: r.evidenceScore, consensusBoost: r.consensusBoost, metadataDelta: r.metadataDelta, contributions: r.contributions, provenance: r.provenance, dateStatus: r.dateStatus, ...(r.selectionScore !== undefined ? { selectionScore: r.selectionScore } : {}) }
    if (r.id) item.id = r.id
    if (r.username) item.username = r.username
    if (r.published) item.published = r.published
    // full text from tavily(advanced)/exa — consumers (research loop, hosts
    // that surface "usable directly") can skip fetch_page for these
    if (typeof r.content === 'string' && r.content.trim()) item.content = r.content
    return item
  })

  return {
    query,
    queriesUsed: variants,
    scoreVersion: SCORE_VERSION,
    tier: resolvedTier,
    depth: resolvedDepth,
    engineStats,
    results: clean,
    truncated,
    tookMs: Date.now() - started,
    cacheHit: false,
    warnings,
  }
}

/** Deterministic metadata selection, independent of engine completion/input order.
 * Keep all original observations; a conflicting date is unknown, not first-wins.
 */
export function mergeFusedCandidates(rows, query) {
  const terms = [...new Set(queryTerms(query))]
  const affinity = (text) => terms.filter((t) => String(text).toLowerCase().includes(t)).length
  const key = (r) => JSON.stringify([r.url, r.title, r.snippet, r.content ?? ''])
  const ordered = [...rows].sort((a, b) =>
    affinity(`${b.title} ${b.snippet}`) - affinity(`${a.title} ${a.snippet}`)
    || Math.min(...Object.values(a.engineRanks ?? {})) - Math.min(...Object.values(b.engineRanks ?? {}))
    || key(a).localeCompare(key(b)))
  const merged = dedupeBy(ordered.map((r) => ({ ...r, engineRanks: { ...r.engineRanks }, provenance: [...(r.provenance ?? [])] })), resultKey, (prior, hit) => {
    for (const [engine, rank] of Object.entries(hit.engineRanks ?? {})) prior.engineRanks[engine] = Math.min(prior.engineRanks[engine] ?? Infinity, rank)
    prior.provenance.push(...hit.provenance)
    prior.snippet ||= hit.snippet
    prior.content ||= hit.content
    if (!prior.username && hit.username) { prior.username = hit.username; prior.url = hit.url }
    return prior
  })
  return merged.map((r) => {
    const provenance = [...new Map(r.provenance.map((p) => [JSON.stringify(p), p])).values()].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
    const dates = [...new Set(provenance.map((p) => p.published).filter(Boolean))]
    return { ...r, provenance, engines: Object.keys(r.engineRanks).sort(),
      published: dates.length === 1 ? dates[0] : null,
      dateStatus: dates.length > 1 ? 'conflicting' : dates.length ? 'known' : 'unknown' }
  })
}

/** Ranking presets affect only weights; unknown dates/lexical mismatch are neutral. */
export function rankFusedRows(rows, query, recency, weights = RANKING_WEIGHTS.hybrid.balanced) {
  const halfLifeMs = RECENCY_HALF_LIFE_DAYS[recency] * 86400000
  const terms = [...new Set(queryTerms(query))]
  const now = Date.now()
  return rows.map((r) => {
    const observations = Object.entries(r.engineRanks ?? {}).map(([engine, rank]) => ({ engine, rank }))
    const evidence = scoreEvidence(observations, weights)
    const hay = `${r.title} ${r.snippet}`.toLowerCase()
    const lexical = terms.length ? terms.filter((t) => hay.includes(t)).length / terms.length : 0
    const date = Date.parse(r.published)
    // recency remains SOFT. Missing/conflicting/future dates do not earn a bonus.
    const freshness = halfLifeMs && Number.isFinite(date) && date <= now && r.dateStatus !== 'conflicting'
      ? Math.pow(0.5, (now - date) / halfLifeMs) : 0
    const metadataDelta = Math.max(-SCORE_CONFIG.metadataClip, Math.min(SCORE_CONFIG.metadataClip,
      SCORE_CONFIG.lexical * lexical + SCORE_CONFIG.freshness * freshness))
    const score = Math.min(Number.MAX_VALUE, evidence.evidenceScore * (1 + metadataDelta))
    return { ...r, ...evidence, metadataDelta, score }
  }).filter((r) => r.evidenceScore > 0)
    .sort((a, b) => b.score - a.score || resultKey(a).localeCompare(resultKey(b)))
}

/** In-memory TTL cache keyed by JSON of inputs. LRU cap prevents long-session OOM. */
export function makeCache(ttlMs = CACHE_TTL_MS, maxEntries = 200) {
  const map = new Map()
  return {
    get(key) {
      const entry = map.get(key)
      if (!entry) return undefined
      if (Date.now() - entry.ts > entry.ttl) {
        map.delete(key)
        return undefined
      }
      return entry.value
    },
    set(key, value, ttl = ttlMs) {
      if (maxEntries > 0 && map.size >= maxEntries && !map.has(key)) {
        const oldest = map.keys().next().value
        if (oldest !== undefined) map.delete(oldest)
      }
      map.set(key, { ts: Date.now(), ttl, value })
    },
    size: () => map.size,
    clear() {
      map.clear()
    },
  }
}
