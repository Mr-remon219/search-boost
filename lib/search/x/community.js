/** Final Web/X aggregation. All votes retain their original provider rank. */
import { createXPipeline } from './x-pipeline.js'
import { normalizeSearchHit } from '../results.js'
import { rankFusedRows } from '../fusion.js'

export function mergeCommunityResults(web, posts, { query, recency, effectiveWeights, xArgs }) {
  const filtered = createXPipeline(xArgs, 30).finish([
    { source: 'web', data: web.filter((r) => r.kind === 'x').map((r) => ({ ...r, text: r.snippet, created_at: r.published })) },
    { source: 'community', data: posts },
  ], { limitResults: false })
  const weights = { ...effectiveWeights, 'x-official': 1, 'x-fallback': 1 }
  const xRows = filtered.items.map((post) => {
    const engineRanks = Object.fromEntries(Object.entries(post.engineRanks ?? {}).filter(([name]) => Object.hasOwn(weights, name)))
    const row = normalizeSearchHit({ url: post.url, title: `${post.author || post.username || 'X post'}: ${post.text.slice(0, 120)}`, snippet: post.text, created_at: post.created_at })
    return { ...row, engines: Object.keys(engineRanks).sort(), engineRanks,
      provenance: [...(post.provenance ?? []), ...Object.entries(engineRanks).map(([engine, rank]) => ({ engine, rank, url: row.url, title: row.title, snippet: row.snippet, published: row.published }))],
      dateStatus: row.published ? 'known' : 'unknown',
    }
  })
  return { results: [...web.filter((r) => r.kind !== 'x'), ...rankFusedRows(xRows, query, recency, weights)], note: filtered.note }
}
