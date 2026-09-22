import assert from 'node:assert/strict'
import * as z from 'zod'
import { fusedSearchOutput } from '../adapters/mcp/schemas.mjs'
import { fusedHitToJson } from '../lib/runtime.mjs'
import { scoreEvidence, SCORE_CONFIG, SCORE_VERSION } from '../lib/search/scoring.js'
import { fusedSearch, rankFusedRows, mergeFusedCandidates, searchCacheKey } from '../lib/search/fusion.js'
import { normalizeSearchHit, selectDiverse } from '../lib/search/results.js'
import { SHARED_RANKING_WEIGHTS, ENGINE_POOLS, resolveSearchRoute } from '../lib/search/routing.js'
import { engineRegistry } from '../lib/search/engines.js'
import { readEngineRoutingFromDoc, resolveKeyedEngines } from '../lib/keys.mjs'
import { createXPipeline } from '../lib/search/x/x-pipeline.js'
import { mergeCommunityResults } from '../lib/search/x/community.js'
import { hitToPost } from '../lib/search/x/xfallback.js'

const names = Object.keys(SHARED_RANKING_WEIGHTS.balanced)
const neutral = Object.fromEntries([...names, 'x-official', 'x-fallback'].map((n) => [n, 1]))
const score = (obs, weights = neutral, config = SCORE_CONFIG) => scoreEvidence(obs, weights, config).evidenceScore
const obs = (...engines) => engines.map((engine) => ({ engine, rank: 1 }))
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-11, `${actual} != ${expected}`)
near(score(obs('bing')), 1)
near(score(obs('bing', 'tavily')), 1 + Math.log(2))
near(score(obs('bing', 'tavily', 'brave')), 1 + Math.log(3))
near(score(obs('bing', 'ddg', 'yahoo')), 1 + Math.log(1.5))
near(score(obs('exa', 'exa-free')), 1 + Math.log(1.2))
near(score([{ engine: 'bing', rank: 20 }]), 10 / 29)
assert.ok(score(['bing', 'tavily'].map((engine) => ({ engine, rank: 10 }))) < 1)
assert.ok(score(['bing', 'tavily', 'brave'].map((engine) => ({ engine, rank: 10 }))) > 1)
assert.equal(score(obs('bing', 'tavily'), { ...neutral, tavily: 0 }), 1)
assert.equal(score(obs('bing'), { ...neutral, bing: 0 }), 0)
assert.equal(score(obs('anysearch', 'anysearch-anonymous', 'anysearch-keyed')), 1)
assert.ok(Number.isFinite(score(obs(...names), Object.fromEntries(names.map((n) => [n, Number.MAX_VALUE])))))
for (const invalid of [0, -1, 1.5, Infinity, NaN]) assert.throws(() => score([{ engine: 'bing', rank: invalid }]))
for (const invalid of [-1, Infinity, NaN, '1']) assert.throws(() => score(obs('bing'), { bing: invalid }))
for (const config of [{ kappa: 0 }, { beta: -1 }, { retention: { bing: 2 } }]) assert.throws(() => score(obs('bing'), neutral, { ...SCORE_CONFIG, ...config }))
for (const weights of Object.values(SHARED_RANKING_WEIGHTS)) near(Math.exp(Object.values(weights).reduce((sum, n) => sum + Math.log(n), 0) / 8), 1)

// Fixed seed: reproducible property checks, not a relevance benchmark.
let seed = 20260922
const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32)
for (let i = 0; i < 10000; i++) {
  const observations = names.filter(() => random() > .3).map((engine) => ({ engine, rank: 1 + Math.floor(random() * 30) }))
  const weights = Object.fromEntries(names.map((engine) => [engine, random() * 2]))
  const base = score(observations, weights)
  const engine = names[Math.floor(random() * names.length)]
  assert.ok(score([...observations, { engine, rank: 1 + Math.floor(random() * 30) }], weights) + 1e-12 >= base)
  assert.ok(score(observations, { ...weights, [engine]: weights[engine] + random() }) + 1e-12 >= base)
  assert.ok(score(observations.map((o) => o.engine === engine ? { ...o, rank: 1 } : o), weights) + 1e-12 >= base)
  assert.equal(score([...observations].reverse(), weights), base)
  assert.equal(score([...observations, ...observations.map((o) => ({ ...o, rank: o.rank + 1 }))], weights), base)
  assert.ok(score(observations, weights, { ...SCORE_CONFIG, retention: { bing: 1, exa: 1 } }) + 1e-12 >= base)
  assert.ok(score(observations, weights, { ...SCORE_CONFIG, retention: { bing: .5, exa: .5 } }) + 1e-12 >= base)
  // Independent reference calculation (straight group sums rather than production residual algorithm).
  const votes = observations.map((o) => ({ e: o.engine, v: weights[o.engine] * 10 / (10 + o.rank - 1) }))
  const groups = new Map()
  for (const { e, v } of votes) { const g = SCORE_CONFIG.families[e] ?? e; groups.set(g, [...(groups.get(g) ?? []), v]) }
  const total = [...groups].reduce((sum, [g, values]) => { const max = Math.max(...values); return sum + max + (SCORE_CONFIG.retention[g] ?? 1) * (values.reduce((a, b) => a + b, 0) - max) }, 0)
  const max = Math.max(0, ...votes.map((v) => v.v))
  near(base, max + Math.log1p(Math.max(0, total - max)))
}
console.log('ok: 10,000 seeded inputs × 8 consensus properties/reference checks')

const row = (engine, rank, extra = {}) => {
  const hit = normalizeSearchHit({ url: 'https://example.org/doc', title: 'alpha', snippet: 'useful alpha evidence', ...extra })
  return { ...hit, engines: [engine], engineRanks: { [engine]: rank }, provenance: [{ engine, rank, variant: 'alpha', url: hit.url, title: hit.title, snippet: hit.snippet, published: hit.published }] }
}
const metadataRows = [row('bing', 3, { published: '2026-01-01' }), row('tavily', 1, { title: '中文语义材料', snippet: 'translation without literal match', published: '2026-02-01' })]
const merged = mergeFusedCandidates(metadataRows, 'alpha')
assert.deepEqual(merged, mergeFusedCandidates([...metadataRows].reverse(), 'alpha'))
assert.equal(merged[0].published, null)
assert.equal(merged[0].dateStatus, 'conflicting')
assert.equal(merged[0].provenance.length, 2)
const quality = rankFusedRows(merged, 'alpha', 'week', neutral)[0]
assert.ok(quality.score <= quality.evidenceScore * 1.2)
const neutralMetadata = rankFusedRows([row('bing', 1, { title: '中文', snippet: '语义检索', published: null })], 'alpha', 'day', neutral)[0]
assert.equal(neutralMetadata.score, 1)
assert.equal(rankFusedRows([row('bing', 1, { title: 'alpha', published: '2026-01-01' })], 'alpha', 'year', { ...neutral, bing: 0 }).length, 0)
assert.equal(rankFusedRows([row('bing', 1, { url: 'https://test.edu/doc', title: '无关', snippet: '' })], 'alpha', undefined, neutral)[0].score, 1)
console.log('ok: deterministic provenance, conflicting/unknown dates, neutral mismatch/TLD, bounded metadata')

const sparse = Array.from({ length: 5 }, (_, i) => ({ ...row('bing', i + 1), url: `https://example.org/${i}`, score: 1, evidenceScore: 1 }))
const selected = selectDiverse(sparse, { limit: 5, includeDomains: ['example.org'] })
assert.equal(selected.results.length, 5)
assert.equal(selectDiverse(sparse, { limit: 5 }).results.length, 2)
assert.ok(selected.results.every((r) => r.score === 1 && r.evidenceScore === 1 && r.selectionScore === 1))
const rich = (url, score, text) => ({ url, title: '', snippet: text, domain: new URL(url).hostname, score })
const richRows = [
  rich('https://a.org/1', 1, 'the official update enables concurrent tasks with bounded memory usage'),
  rich('https://b.org/1', .98, 'the official update enables concurrent tasks with bounded memory usage'),
  rich('https://c.org/1', .95, 'another documented aspect includes release dates migration rules and supported versions'),
]
const chosen = selectDiverse(richRows, { limit: 2 }).results
assert.deepEqual(chosen.map((r) => r.url), ['https://a.org/1', 'https://c.org/1'])
assert.equal(chosen[1].score, .95)
assert.deepEqual(selectDiverse([...richRows].reverse(), { limit: 2 }).results, chosen)
assert.equal(selectDiverse(richRows, { limit: 3, minScore: .97 }).results.length, 2, 'floor applies to quality before diversity')
console.log('ok: selected-only MMR, stable quality/floor, explicit-site cap exemption')

let calls = 0
const retrieval = async (engine, query) => {
  calls++
  if (engine === 'brave') throw new Error('fixture timeout')
  if (query === 'variant') return [{ title: 'alpha', url: 'https://example.org/shared' }]
  return [{ url: 'file:///invalid' }, ...Array.from({ length: 11 }, (_, i) => ({ title: 'alpha', url: `https://example.org/${i === 10 ? 'shared' : i}` }))]
}
const args = { query: 'alpha', queries: ['variant'], engines: ['bing'], tier: 'medium', finalize: false, engineWeights: neutral, runOne: retrieval }
const found = await fusedSearch(args)
const shared = found.results.find((r) => r.url.endsWith('/shared'))
assert.equal(shared.engineRanks.bing, 1)
assert.deepEqual(shared.provenance.map((p) => p.rank).sort((a, b) => a - b), [1, 12])
assert.equal(found.results.find((r) => r.url.endsWith('/0')).engineRanks.bing, 2, 'invalid URL must not promote remaining ranks')
const dropped = await fusedSearch({ ...args, engines: ['bing', 'brave'] })
assert.deepEqual(dropped.results, found.results, 'failed/unobserved engine does not change page scores')
const zero = await fusedSearch({ ...args, engineWeights: { ...neutral, bing: 0 } })
assert.equal(zero.results.length, 0)
assert.ok(calls > 0)
const cache = JSON.parse(searchCacheKey({ query: 'alpha' }))
assert.equal(cache.scoreVersion, SCORE_VERSION)
assert.deepEqual(cache.scoring, SCORE_CONFIG)
z.object(fusedSearchOutput).parse({
  ...found, layer: 'free', resultCount: found.results.length, enginePool: 'free', ranking: 'balanced',
  effectiveWeights: { bing: 1 }, communityUsed: false, results: found.results.map(fusedHitToJson),
})
console.log('ok: raw provider ranks survive invalid results/variants, zero weight still calls, dropout neutral, versioned cache')

const postUrl = 'https://x.com/alice/status/123'
const webPost = { ...row('bing', 12, { url: postUrl, published: null }), score: 1 }
const fallbackPost = hitToPost({ url: postUrl, title: 'alpha', engines: ['bing', 'tavily'], engineRanks: { bing: 8, tavily: 20 } })
const pipeline = createXPipeline({ type: 'keyword', query: 'alpha' }, 10)
const posts = pipeline.finish([
  { source: 'official', data: [{ url: 'not a post' }, { url: postUrl, text: 'alpha', engines: ['fake'], engineRanks: { fake: 1 } }] },
  { source: 'engines', data: [fallbackPost] },
]).items
assert.deepEqual(posts[0].engineRanks, { 'x-official': 2, bing: 8, tavily: 20 })
const community = mergeCommunityResults([webPost], posts, { query: 'alpha', effectiveWeights: { bing: 1, tavily: 1 }, xArgs: { type: 'keyword', query: 'alpha' } }).results[0]
assert.deepEqual(community.engineRanks, { bing: 8, tavily: 20, 'x-official': 2 })
near(community.evidenceScore, score([{ engine: 'bing', rank: 8 }, { engine: 'tavily', rank: 20 }, { engine: 'x-official', rank: 2 }]))
assert.ok(!community.engines.includes('fake'))
const zeroCommunity = mergeCommunityResults([webPost], [fallbackPost], { query: 'alpha', effectiveWeights: { bing: 0, tavily: 0 }, xArgs: { type: 'keyword', query: 'alpha' } })
assert.equal(zeroCommunity.results.length, 0)
const aliasedPost = { url: postUrl, text: 'alpha', engines: ['anysearch-anonymous', 'anysearch-keyed'], engineRanks: { 'anysearch-anonymous': 4, 'anysearch-keyed': 2 } }
const aliased = mergeCommunityResults([], [aliasedPost], { query: 'alpha', effectiveWeights: { anysearch: 1 }, xArgs: { type: 'keyword', query: 'alpha' } }).results[0]
assert.deepEqual(aliased.engineRanks, { anysearch: 2 })
near(aliased.evidenceScore, 10 / 11)
console.log('ok: Web/X share original ranks and one vote/provider; hosted provenance cannot invent votes')

for (const pool of ['free', 'api', 'hybrid']) {
  const route = resolveSearchRoute({ enginePool: pool, engines: engineRegistry({}) })
  assert.equal(route.engineNames.includes('anysearch'), pool !== 'api')
  assert.equal(route.engineNames.filter((n) => n === 'anysearch').length, pool === 'api' ? 0 : 1)
}
const disabled = resolveSearchRoute({ enginePool: 'hybrid', engineList: ['anysearch'], engines: engineRegistry({ anysearch: 'fixture' }, new Set()) })
assert.deepEqual(disabled.engineNames, [])
assert.ok(disabled.warnings.length > 0)
assert.deepEqual(resolveKeyedEngines({ anysearch: 'fixture' }, readEngineRoutingFromDoc({ engines: { anysearch: { enabled: false } } })), [])
assert.equal(new Set(ENGINE_POOLS.hybrid).size, 8)
console.log('ok: AnySearch readiness and disabled routing, eight unique logical engines')
console.log('All consensus-v2 scoring/integration tests passed (no live API calls).')
