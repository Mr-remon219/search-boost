import { mergeCommunityResults } from '../search/x/community.js'
import { normalizeSearchHit, parseDate, matchesDomains, xIdentity, hostOf } from '../search/results.js'
import { snowflakeDate } from '../search/x/x-pipeline.js'
import { logicalEngine } from '../search/scoring.js'
import { mergeFusedCandidates, rankFusedRows, publicFusedRow } from '../search/fusion.js'
import { communityRegistry } from './config.mjs'
import { finishPlatformItems, platformContentType, platformIdentityKey } from './pipeline.mjs'
import { PLATFORM_DOMAINS, platformUrl } from './selection.mjs'

function communityProvenance(item, row) {
  const route = { platform: item.platform, provider: item.provider, backend: item.backend, retrieval_mode: item.retrieval_mode, content_type: item.content_type }
  return [...(item.provenance ?? []).map(entry => ({ ...entry, ...(entry.published !== undefined ? { published: item.content_type === 'account' ? null : parseDate(entry.published) } : {}), ...route })), ...Object.entries(item.engineRanks ?? {}).map(([engine, rank]) => ({
    engine, rank, url: row.url, title: row.title, snippet: row.snippet, published: item.content_type === 'account' ? null : parseDate(row.published), ...route,
  }))]
}

function canonicalPlatformWeb(web, items, platforms) {
  const selected = platforms.filter(platform => platform !== 'x'), identities = new Map()
  if (!selected.length) return web
  const key = (platform, url) => platformIdentityKey(platform, url, platformContentType(platform, url))
  for (const item of items.filter(item => selected.includes(item.platform))) {
    const url = platformUrl(item.platform, item.url)
    if (url) identities.set(key(item.platform, url), url)
  }
  return web.map(row => {
    for (const platform of selected) {
      const url = platformUrl(platform, row.url)
      if (!url) continue
      const identity = key(platform, url), canonical = identities.get(identity) ?? url
      identities.set(identity, canonical)
      return { ...row, url: canonical, domain: hostOf(canonical), provenance: (row.provenance ?? []).map(entry => {
        const safe = platformUrl(platform, entry.url)
        return safe ? { ...entry, url: safe } : entry
      }) }
    }
    return row
  })
}

/** Shared scorer, original engine votes, no extra vote for a web-index wrapper.
 * Hard platform conditions also constrain matching ordinary Web candidates.
 * Providers have already filtered their own observations; the final pass merges
 * verified metadata first and cannot invent author identity from index labels.
 */
export function mergePlatformResults(web, items, { query, recency, effectiveWeights, xArgs, platforms, requests = [], softDates = {}, routeProvenance = false }) {
  // Additive route observations belong to snapshots/new parameter contracts.
  // Legacy ordinary boolean-X calls retain their frozen public provenance.
  const xItems = items.filter(item => item.platform === 'x').map(item => routeProvenance ? ({ ...item, provenance: communityProvenance(item, { url: item.url, title: item.title, snippet: item.text, published: item.published }) }) : item)
  const canonicalWeb = canonicalPlatformWeb(web, items, platforms)
  const x = platforms.includes('x') ? mergeCommunityResults(canonicalWeb, xItems, { query, recency, effectiveWeights, xArgs }) : { results: canonicalWeb }
  const weights = { ...effectiveWeights, 'x-official': 1, 'x-fallback': 1 }
  for (const provider of communityRegistry.list()) weights[`community-${provider.id}`] = 1
  const extra = items.filter(item => item.platform !== 'x').flatMap(item => {
    const row = normalizeSearchHit({ url: item.url, title: item.title ?? `${item.platform} post`, snippet: item.text ?? item.snippet ?? '', published: item.published ?? item.created_at })
    if (!row) return []
    const engineRanks = {}
    for (const [name, rank] of Object.entries(item.engineRanks ?? {})) {
      const engine = logicalEngine(name)
      if (Object.hasOwn(weights, engine) && Number.isSafeInteger(rank) && rank > 0) engineRanks[engine] = rank
    }
    if (!Object.keys(engineRanks).length) return []
    return [{ ...row, engines: Object.keys(engineRanks), engineRanks, provenance: communityProvenance({ ...item, engineRanks }, row), dateStatus: row.published ? 'known' : 'unknown' }]
  })
  const merged = mergeFusedCandidates([...x.results, ...extra], query).map(row => {
    const id = platforms.includes('x') ? xIdentity(row.url).id : null
    const published = id && parseDate(snowflakeDate(id))
    // Preserve conflicting engine observations, but use the stronger post-id
    // timestamp for metadata/scoring. Account IDs are never post dates.
    return published ? { ...row, published, dateStatus: 'known' } : row
  })
  let ranked = rankFusedRows(merged, query, recency, weights)
  let removed = 0
  for (const request of requests.filter(request => request.platform !== 'x')) {
    const { platform, args, filters } = request, soft = softDates[platform] ?? false
    const fromHard = filters.from !== null && soft !== true && soft?.from !== true
    const toHard = filters.to !== null && soft !== true && soft?.to !== true
    if (!fromHard && !toHard && !filters.contentType && !filters.allowedAuthors?.length && !filters.excludedAuthors?.length && !args.subreddits?.length) continue
    const key = url => platformIdentityKey(platform, url, platformContentType(platform, url, args.type))
    const metadata = new Map(items.filter(item => item.platform === platform).map(item => [key(item.url), item]))
    const belongs = row => matchesDomains(row.url, PLATFORM_DOMAINS[platform])
    const observed = ranked.filter(belongs).map(row => {
      const verified = metadata.get(key(row.url))
      return { ...row, author: verified?.author ?? null,
        published: row.dateStatus !== 'conflicting' && verified?.published && parseDate(verified.published) === row.published ? verified.published : row.published }
    })
    const finished = finishPlatformItems(request, observed, { softDates: soft })
    const allowed = new Set(finished.items.map(item => key(item.url)))
    const prior = ranked.length
    ranked = ranked.filter(row => !belongs(row) || allowed.has(key(row.url)))
    removed += prior - ranked.length
  }
  const used = new Set(ranked.flatMap(row => row.engines ?? []))
  return { results: ranked.map(publicFusedRow), note: [x.note, removed ? `${removed} Web/community candidates removed by hard platform conditions` : null].filter(Boolean).join('; ') || undefined,
    contributionWeights: Object.fromEntries(Object.entries(weights).filter(([source, weight]) => weight > 0 && (Object.hasOwn(effectiveWeights, source) || used.has(source)))) }
}
