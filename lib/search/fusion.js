// Fusion scoring, query preprocessing, and TTL cache.
// Ported from the session-level plugin (plugin-host.js) — same proven math:
// rank weight + cross-engine bonus + domain quality + term relevance +
// Grok-style half-life recency decay + min_score pruning + per-domain cap.

export const CACHE_TTL_MS = 6 * 3600 * 1000

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

const JUNK_DOMAINS = new Set([
  'pinterest.com', 'pinterest.ca', 'instagram.com', 'facebook.com', 'facebook.net',
  'tiktok.com', 'linkedin.com', 'x.com', 'twitter.com', 'youtube.com',
])
const AUTHORITATIVE_TLDS = ['.gov', '.edu', '.mil']

export function searchCacheKey({ query, queries = [], engines = [], includeDomains = [], excludeDomains = [], recency = null, maxResults, tier, layer = null, routing = null }) {
  return JSON.stringify({
    v: 4,
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
export async function fusedSearch({ query, queries, engines, maxResults = 6, maxResultsCap = 10, includeDomains = [], excludeDomains = [], recency, tier = 'medium', layer = null, singleKeyedPool = false, depth = null, minScore = 0, engineWeights = RANKING_WEIGHTS.hybrid.balanced, finalize = true, runOne, signal }) {
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
    const score = (engineWeights[task.engine] ?? 1) * Math.max(0, 1 - rank / 10)
    return [{ ...hit, engines: [task.engine], score, contributions: { [task.engine]: score } }]
  }))
  const merged = dedupeBy(candidates, resultKey, (prior, hit) => {
    for (const [engine, score] of Object.entries(hit.contributions)) prior.contributions[engine] = Math.max(prior.contributions[engine] ?? 0, score)
    prior.engines = Object.keys(prior.contributions)
    prior.score = Object.values(prior.contributions).reduce((a, b) => a + b, 0)
    prior.snippet ||= hit.snippet
    prior.published ||= hit.published
    if (hit.content && (!prior.content || hit.content.length > prior.content.length)) prior.content = hit.content
    if (!prior.username && hit.username) { prior.username = hit.username; prior.url = hit.url }
    return prior
  })
  const ranked = rankFusedRows(merged, query, recency)
  const { results: capped, truncated } = finalize
    ? selectDiverse(ranked, { limit: maxResults, minScore: scoreFloor, singleEngineDiscount: singleKeyedPool ? 1 : 0.9 })
    : { results: ranked, truncated: false }

  const clean = capped.map((r) => {
    const item = { title: r.title, url: r.url, domain: r.domain, snippet: r.snippet, score: r.score, engines: r.engines, kind: r.kind }
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

/** Common relevance/recency/domain scoring; ranking presets only affect input engine contributions. */
export function rankFusedRows(rows, query, recency) {
  const halfLifeMs = recency ? RECENCY_HALF_LIFE_DAYS[recency] * 86400000 : undefined
  const relTerms = queryTerms(query)
  return rows
    .map((r) => {
      const cross = Math.min(2.4, (r.engines.length - 1) * 0.8)
      const hay = `${r.title} ${r.snippet}`.toLowerCase()
      let termHits = 0
      for (const t of relTerms) {
        if (t.length >= 2 && hay.includes(t.toLowerCase())) termHits++
      }
      const rel = termHits > 0 ? Math.min(termHits, 3) * 0.25 : -0.6
      let rec = 0
      if (halfLifeMs !== undefined) {
        if (r.published) {
          const t = Date.parse(r.published)
          if (!Number.isNaN(t)) {
            const ageMs = Date.now() - t
            rec = ageMs > 0 ? 0.6 * Math.pow(0.5, ageMs / halfLifeMs) : 0.6
          } else {
            rec = -0.1
          }
        } else {
          rec = -0.1
        }
      }
      const bonus = (() => {
        if (AUTHORITATIVE_TLDS.some((t) => r.domain.endsWith(t))) return 0.6
        if (r.domain === 'wikipedia.org' || r.domain === 'github.com') return 0.4
        if (JUNK_DOMAINS.has(r.domain)) return -0.5
        return 0
      })()
      return { ...r, score: Math.round((r.score + cross + rel + rec + bonus) * 100) / 100 }
    })
    .sort((a, b) => b.score - a.score)

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
