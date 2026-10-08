/** Final Web/X aggregation. All votes retain their original provider rank. */
import { createXPipeline } from './x-pipeline.js'
import { normalizeSearchHit, xIdentity } from '../results.js'
import { logicalEngine } from '../scoring.js'
import { rankFusedRows, publicFusedRow } from '../fusion.js'

export function mergeCommunityResults(web, posts, { query, recency, effectiveWeights, xArgs }) {
  const accountMode = xArgs.type === 'user'
  const threadId = xArgs.type === 'thread' ? xIdentity(xArgs.post_id).id || String(xArgs.post_id) : null
  const webPosts = web.filter(row => row.kind === 'x' && (!threadId || xIdentity(row.url).id === threadId))
    .map(row => ({ ...row, text: row.snippet, created_at: row.published }))
  // Web post snippets cannot fabricate an account observation. Accounts retain
  // their real provider ranks; recent posts are verified by the user pipeline.
  const filtered = createXPipeline(xArgs, 30).finish([
    ...(accountMode ? [] : [{ source: 'web', data: webPosts }]),
    { source: 'community', data: posts },
  ], { limitResults: false })
  const weights = { ...effectiveWeights, 'x-official': 1, 'x-fallback': 1 }
  const xRows = filtered.items.map((post) => {
    const engineRanks = {}
    for (const [name, rank] of Object.entries(post.engineRanks ?? {})) {
      const engine = logicalEngine(name)
      if (Object.hasOwn(weights, engine)) engineRanks[engine] = Math.min(engineRanks[engine] ?? Infinity, rank)
    }
    const text = accountMode ? [post.bio, ...(post.recent_posts ?? []).slice(0, 3).map(item => item.text)].filter(Boolean).join('\n') : post.text
    const row = normalizeSearchHit({ url: post.url, title: accountMode ? `${post.name} (@${post.username})` : `${post.author || post.username || 'X post'}: ${text.slice(0, 120)}`, snippet: text,
      ...(accountMode ? {} : { created_at: post.created_at }) })
    if (accountMode) Object.assign(row, { kind: 'x', username: post.username })
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
  const accountWeb = accountMode ? createXPipeline({ ...xArgs, type: 'keyword', query: '' }, 30).finish([{ source: 'web', data: webPosts }], { limitResults: false }).items.map(post => web.find(row => xIdentity(row.url).id === post.id)).filter(Boolean) : []
  return { results: [...web.filter(row => row.kind !== 'x'), ...accountWeb, ...ranked.map(publicFusedRow)], note: filtered.note, contributionWeights }
}
