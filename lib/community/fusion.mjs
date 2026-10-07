import { mergeCommunityResults } from '../search/x/community.js'
import { normalizeSearchHit } from '../search/results.js'
import { logicalEngine } from '../search/scoring.js'
import { mergeFusedCandidates, rankFusedRows, publicFusedRow } from '../search/fusion.js'
import { communityRegistry } from './config.mjs'

/** Shared scorer, original engine votes, no extra vote for a web-index wrapper. */
export function mergePlatformResults(web, items, { query, recency, effectiveWeights, xArgs, platforms }) {
  const x = platforms.includes('x') ? mergeCommunityResults(web, items.filter(i => i.platform === 'x'), { query, recency, effectiveWeights, xArgs }) : { results: web }
  const weights = { ...effectiveWeights, 'x-official': 1, 'x-fallback': 1 }
  for (const provider of communityRegistry.list()) weights[`community-${provider.id}`] = 1
  const extra = items.filter(i => i.platform !== 'x').flatMap(item => {
    const row = normalizeSearchHit({ url: item.url, title: item.title ?? `${item.platform} post`, snippet: item.text ?? item.snippet ?? '', published: item.published ?? item.created_at })
    if (!row) return []
    const engineRanks = {}
    for (const [name, rank] of Object.entries(item.engineRanks ?? {})) {
      const engine = logicalEngine(name)
      if (Object.hasOwn(weights, engine) && Number.isSafeInteger(rank) && rank > 0) engineRanks[engine] = rank
    }
    if (!Object.keys(engineRanks).length) return []
    return [{ ...row, engines: Object.keys(engineRanks), engineRanks,
      provenance: [...(item.provenance ?? []), ...Object.entries(engineRanks).map(([engine, rank]) => ({ engine, rank, url: row.url, title: row.title, snippet: row.snippet, published: row.published,
        platform: item.platform, provider: item.provider, backend: item.backend, retrieval_mode: item.retrieval_mode, content_type: item.content_type }))], dateStatus: row.published ? 'known' : 'unknown' }]
  })
  const ranked = rankFusedRows(mergeFusedCandidates([...x.results, ...extra], query), query, recency, weights)
  const used = new Set(ranked.flatMap(row => row.engines ?? []))
  return { results: ranked.map(publicFusedRow), note: x.note,
    contributionWeights: Object.fromEntries(Object.entries(weights).filter(([source, weight]) => weight > 0 && (Object.hasOwn(effectiveWeights, source) || used.has(source)))) }
}
