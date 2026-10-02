// Deterministic fake provider observations for ordinary fused compatibility.
// `fused-baseline-v1.json` digests were captured from the independent checkout
// 77e01146271f4d718cc6d8ce499978f94a517203; they are replayed here to prove the
// merged base produces byte-identical ordinary fused scores/lists/provenance.
// `fused-baseline-community-v1.json` digests were captured on the N_off worktree
// base 0a0ce082c3c287e56a72400a599736b242c829e9 BEFORE the snapshot/community
// changes, so they freeze the ordinary path with community on and off.
// Expected digests are never regenerated from the implementation under test.
import { createHash } from 'node:crypto'

export const FUSED_BASELINE_SHA = '77e01146271f4d718cc6d8ce499978f94a517203'
export const NOFF_BASE_SHA = '0a0ce082c3c287e56a72400a599736b242c829e9'

export const baselineCases = ['balanced', 'research', 'fresh'].flatMap(ranking => ['free', 'hybrid'].map(enginePool => ({ query: 'Node fetch cancellation OR abort site:reference.example', ranking, enginePool, complexity: 'medium', maxResults: 6 })))
baselineCases.push({ query: 'Node fetch abort', ranking: 'research', enginePool: 'hybrid', complexity: 'simple', maxResults: 4, engineWeights: { bing: 0, ddg: 2 } })

// Community replays deliberately carry no site: operator, so the X branch is
// allowed for the community=true cases and excluded for the domain case.
const COMMUNITY_QUERY = 'Node fetch cancellation OR abort'
export const communityCases = [
  { query: COMMUNITY_QUERY, ranking: 'balanced', enginePool: 'free', complexity: 'medium', maxResults: 6, community: false },
  { query: COMMUNITY_QUERY, ranking: 'balanced', enginePool: 'free', complexity: 'medium', maxResults: 6, community: true },
  { query: COMMUNITY_QUERY, ranking: 'research', enginePool: 'hybrid', complexity: 'medium', maxResults: 6, community: false },
  { query: COMMUNITY_QUERY, ranking: 'research', enginePool: 'hybrid', complexity: 'medium', maxResults: 6, community: true },
  { query: COMMUNITY_QUERY, ranking: 'balanced', enginePool: 'hybrid', complexity: 'medium', maxResults: 6, community: true, excludeDomains: ['x.com', 'twitter.com'] },
]

export function baselineSnapshot({ xOfficial = false } = {}) {
  const names = ['bing', 'ddg', 'exa']
  return {
    fingerprint: `frozen-fused-baseline-v1:${xOfficial ? 'x' : 'no-x'}`,
    engines: Object.fromEntries(names.map((name, e) => [name, {
      available: () => true,
      async search(query, count) {
        return Array.from({ length: Math.min(count, 10) }, (_, i) => ({
          url: `https://${i % 3 === 0 ? 'reference.example/common' : `reference.example/${name}`}/${i}`,
          title: `${i % 2 ? 'Node abort source' : 'Node fetch cancellation'} ${i}`,
          snippet: `Node fetch abort implementation reference with evidence ${e}-${i}: ${query}`,
        }))
      },
    }])),
    capability: { x: { official: { available: xOfficial, source: xOfficial ? 'fixture' : 'none' }, fallback: { available: true } } },
  }
}

/** Fixed Snowflake ids so post dates (and therefore digests) never drift. */
const idAt = (date, seq = 0) => (((BigInt(Date.parse(date)) - 1288834974657n) << 22n) + BigInt(seq)).toString()
const post = (name, date, seq) => ({ url: `https://x.com/${name}/status/${idAt(date, seq)}`, text: 'Node fetch cancellation alpha beta community evidence' })

export const baselineOfficialPosts = [
  post('alice', '2026-01-15T12:00:00Z', 1),
  post('bob', '2026-01-14T12:00:00Z', 2),
  post('alice', '2026-01-13T12:00:00Z', 3),
]
export const baselineFallbackPosts = [
  post('carol', '2026-01-12T12:00:00Z', 4),
  post('dave', '2026-01-11T12:00:00Z', 5),
]

export const baselineOfficialSearch = async () => ({ credential: 'fixture', data: baselineOfficialPosts })
export const baselineFallbackSearch = async () => ({ type: 'keyword', data: baselineFallbackPosts, via: 'engines' })

export function fusedBaselineDigest(result) {
  // Every selected field/order/score/selectionScore/provenance is covered; omit only wall time/cache.
  return createHash('sha256').update(JSON.stringify({
    query: result.query, queriesUsed: result.queriesUsed, scoreVersion: result.scoreVersion,
    enginePool: result.enginePool, ranking: result.ranking, effectiveWeights: result.effectiveWeights,
    results: result.results, truncated: result.truncated,
  })).digest('hex')
}
