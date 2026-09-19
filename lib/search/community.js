/** Final Web/X aggregation only. Retrieval stays in runtime.runXSearch. */
import { createXPipeline } from './x-pipeline.js'
import { normalizeSearchHit } from './results.js'
import { rankFusedRows } from './fusion.js'

export function mergeCommunityResults(web, posts, { query, recency, effectiveWeights, xArgs }) {
  // X posts found by the ordinary Web leg must not bypass X constraints. Merge
  // their metadata with official/fallback candidates BEFORE filtering/limiting.
  const filtered = createXPipeline(xArgs, 30).finish([
    { source: 'web', data: web.filter((r) => r.kind === 'x').map((r) => ({ ...r, text: r.snippet, created_at: r.published })) },
    { source: 'community', data: posts },
  ], { limitResults: false })
  const xRows = filtered.items.map((post, rank) => {
    const engines = post.engines?.length ? post.engines : ['x-fallback']
    return {
      ...normalizeSearchHit({ url: post.url, title: `${post.author || post.username || 'X post'}: ${post.text.slice(0, 120)}`, snippet: post.text, created_at: post.created_at }),
      engines,
      // Official/fallback-only evidence has neutral weight 1. Each search
      // engine contributes once, even if both retrieval paths found the post.
      score: engines.reduce((sum, name) => sum + (effectiveWeights[name] ?? 1), 0) * Math.max(0.1, 1 - rank / 30),
    }
  })
  return { results: [...web.filter((r) => r.kind !== 'x'), ...rankFusedRows(xRows, query, recency)], note: filtered.note }
}
