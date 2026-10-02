/** Final Web/X aggregation. All votes retain their original provider rank. */
import { createXPipeline } from './x-pipeline.js'
import { normalizeSearchHit } from '../results.js'
import { logicalEngine } from '../scoring.js'
import { rankFusedRows } from '../fusion.js'

export function mergeCommunityResults(web, posts, { query, recency, effectiveWeights, xArgs }) {
  const filtered = createXPipeline(xArgs, 30).finish([
    { source: 'web', data: web.filter((r) => r.kind === 'x').map((r) => ({ ...r, text: r.snippet, created_at: r.published })) },
    { source: 'community', data: posts },
  ], { limitResults: false })
  const weights = { ...effectiveWeights, 'x-official': 1, 'x-fallback': 1 }
  const xRows = filtered.items.map((post) => {
    const engineRanks = {}
    for (const [name, rank] of Object.entries(post.engineRanks ?? {})) {
      const engine = logicalEngine(name)
      if (Object.hasOwn(weights, engine)) engineRanks[engine] = Math.min(engineRanks[engine] ?? Infinity, rank)
    }
    const row = normalizeSearchHit({ url: post.url, title: `${post.author || post.username || 'X post'}: ${post.text.slice(0, 120)}`, snippet: post.text, created_at: post.created_at })
    return { ...row, engines: Object.keys(engineRanks).sort(), engineRanks,
      provenance: [...(post.provenance ?? []), ...Object.entries(engineRanks).map(([engine, rank]) => ({ engine, rank, url: row.url, title: row.title, snippet: row.snippet, published: row.published }))],
      dateStatus: row.published ? 'known' : 'unknown',
    }
  })
  // Source weights this aggregation really used: zero-weight engines never
  // reached the fused score, and an X source is listed only when a kept row
  // carries it as provenance. Snapshot consumers use this instead of the public
  // effectiveWeights (whose meaning is unchanged).
  const ranked = rankFusedRows(xRows, query, recency, weights)
  const contributionWeights = Object.fromEntries(Object.entries(effectiveWeights).filter(([, weight]) => Number.isFinite(weight) && weight > 0))
  for (const source of ['x-official', 'x-fallback']) {
    if (ranked.some((row) => row.engines?.includes(source))) contributionWeights[source] = 1
  }
  return { results: [...web.filter((r) => r.kind !== 'x'), ...ranked], note: filtered.note, contributionWeights }
}
