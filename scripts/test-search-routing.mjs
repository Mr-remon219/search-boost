#!/usr/bin/env node
/** Hermetic Core tests: real fusion/X orchestration, fake engine and hosted transports. */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
const temp = mkdtempSync(join(tmpdir(), 'sb-routing-'))
process.env.HOME = process.env.USERPROFILE = join(temp, 'home')
process.env.SEARCH_BOOST_HOME = join(temp, 'state')
process.env.PI_CODING_AGENT_DIR = join(temp, 'pi')
for (const key of ['KEYS', 'LAYER', 'XAUTH', 'XGUEST']) process.env[`SEARCH_BOOST_${key}_FILE`] = join(temp, `${key}.json`)
process.env.SEARCH_BOOST_LAYER = 'free'
for (const key of ['TAVILY_API_KEY', 'BRAVE_API_KEY', 'EXA_API_KEY', 'PI_SEARCH_TAVILY_KEY', 'PI_SEARCH_BRAVE_KEY', 'PI_SEARCH_EXA_KEY', 'XAI_API_KEY']) delete process.env[key]
mkdirSync(process.env.HOME)
const runtime = await import('../lib/runtime.mjs')
const { ENGINE_POOLS, RANKING_WEIGHTS } = await import('../lib/search/routing.js')
const { resultKey, matchesDomains, normalizeSearchHit, selectDiverse, normalizeUrl, parseDate } = await import('../lib/search/results.js')
const { createXPipeline } = await import('../lib/search/x/x-pipeline.js')
const { fallbackXSearch } = await import('../lib/search/x/xfallback.js')
const { runtimeSnapshot } = await import('../lib/search/capability.js')
const idAt = (date, seq = 0) => (((BigInt(Date.parse(date)) - 1288834974657n) << 22n) + BigInt(seq)).toString()
const post = (name, date, seq = 0) => ({ url: `https://x.com/${name}/status/${idAt(date, seq)}`, text: 'alpha beta developer update' })
const now = new Date(Date.now() - 3600000).toISOString()
let enabled = new Set(ENGINE_POOLS.hybrid), auth = false, credentialVersion = 1, calls = [], officialCalls = 0, fallbackCalls = 0, mode = 'web', hostedFailure = false, fallbackFailure = false
let xPosts = [post('alice', now, 1), post('alice', now, 2), post('alice', now, 3), post('bob', now, 4), post('carol', now, 5), post('dan', now, 6)]
const engines = Object.fromEntries(ENGINE_POOLS.hybrid.map((name) => [name, {
  available: () => enabled.has(name),
  async search(query, count, opts) {
    calls.push({ name, query, count, depth: opts.depth, recency: opts.recency })
    if (mode === 'partial-variants' && query.includes('guide')) throw new Error('fixture variant timeout')
    if (query.startsWith('site:x.com')) {
      let posts = xPosts
      if (mode === 'many-authors') posts = name === 'yahoo' ? [post('bob', now, 999)] : Array.from({ length: count }, (_, i) => post('alice', now, (name === 'bing' ? 500 : 600) + i))
      if (mode === 'late-author') posts = name === 'yahoo' ? [post('alice', now, 99)] : Array.from({ length: count }, (_, i) => post('bob', now, (name === 'bing' ? 200 : 300) + i))
      return posts.slice(0, count).map((p) => ({ url: p.url, title: p.text, snippet: p.text }))
    }
    const docs = Array.from({ length: count }, (_, i) => ({ url: `https://${name.replace('-', '')}${i}.example/doc`, title: 'alpha beta', snippet: 'alpha beta evidence' }))
    if (mode === 'community') docs[0] = { url: xPosts[0].url.replace('x.com', 'mobile.twitter.com') + '?utm_source=fixture', title: 'alpha beta', snippet: 'alpha beta web indexed post' }
    return docs
  },
}]))
const snapshot = () => ({ engines, fingerprint: JSON.stringify([[...enabled], auth, credentialVersion]), capability: { x: { official: { available: auth } } } })
const xSearch = (args, opts) => runtime.runXSearch(args, { ...opts, snapshot,
  officialSearch: async () => { officialCalls++; if (hostedFailure) throw new Error('hosted fixture unavailable'); return { credential: 'fixture', data: xPosts.map((p) => ({ ...p, engines: ['invented-engine'] })) } },
  fallbackSearch: async (args) => { fallbackCalls++; if (fallbackFailure) throw new Error('fallback fixture unavailable'); return fallbackXSearch(args) },
})
const fused = (args) => runtime.runFused({ query: 'alpha beta', complexity: 'simple', ...args }, { snapshot, xSearch })
const reset = () => { runtime.invalidateSearchCaches(); calls = []; officialCalls = 0; fallbackCalls = 0 }
let tests = 0
async function test(name, fn) { reset(); await fn(); tests++; console.log(`ok: ${name}`) }
const originalFetch = globalThis.fetch
globalThis.fetch = async (raw) => {
  const url = new URL(String(raw))
  assert.equal(url.hostname, 'publish.x.com', 'tests must never access live services')
  const id = new URL(url.searchParams.get('url')).pathname.split('/').pop()
  const p = xPosts.find((p) => p.url.endsWith(`/${id}`))
  return p ? Response.json({ author_name: 'Fixture author', author_url: p.url.split('/status/')[0], html: '<blockquote>alpha beta full developer community evidence</blockquote>' }) : new Response('', { status: 404 })
}
try {
  await test('all nine exact ranking presets; no ranking-dependent engine selection', async () => {
    const expected = {
      free: [[1,1.05,1,1.1], [.95,.90,.85,1.30], [1.15,.95,.90,1]],
      api: [[1.2,1.1,1.2], [1.35,1,1.45], [1.3,1.4,1.25]],
      hybrid: [[1,1.05,1,1.1,1.2,1.1,1.2], [.9,.85,.8,1.2,1.35,1,1.45], [1.05,.9,.85,1,1.3,1.4,1.25]],
    }
    for (const [pool, presets] of Object.entries(expected)) for (const [i, ranking] of ['balanced','research','fresh'].entries()) {
      calls = []
      const out = await fused({ enginePool: pool, ranking })
      const wanted = Object.fromEntries(ENGINE_POOLS[pool].map((name, j) => [name, presets[i][j]]))
      assert.deepEqual(RANKING_WEIGHTS[pool][ranking], wanted)
      assert.deepEqual(out.effectiveWeights, wanted)
      assert.deepEqual(out.enginesUsed, ENGINE_POOLS[pool])
      assert.deepEqual(calls.map((c) => c.name), ENGINE_POOLS[pool])
      assert.ok(calls.every((c) => c.depth === 'basic' && c.recency === undefined))
    }
  })
  await test('complexity only changes budget, variant count and depth; never engine membership', async () => {
    for (const [i, complexity] of ['simple','medium','complex'].entries()) {
      calls = []
      const out = await fused({ enginePool: 'api', queries: ['alpha beta guide','alpha beta benchmark'], complexity })
      assert.deepEqual(out.enginesUsed, ENGINE_POOLS.api)
      assert.equal(out.queriesUsed.length, i + 1)
      assert.equal(calls.length, 3 * (i + 1))
      assert.ok(calls.every((c) => c.depth === (i === 2 ? 'advanced' : 'basic')))
    }
    const out = await runtime.runFused({ query: 'alpha beta', enginePool: 'api' }, { snapshot })
    assert.equal(out.tier, 'medium')
    assert.ok((await fused({ complexity: 'auto' })).warnings.some((w) => /deprecated/.test(w)))
  })
  await test('ranking and zero/partial weight overrides affect scores only, including cache isolation', async () => {
    const base = await fused({ enginePool: 'api', ranking: 'research' })
    const cached = await fused({ enginePool: 'api', ranking: 'research' })
    assert.equal(cached.cacheHit, true)
    assert.equal(base.results[0].engines[0], 'exa')
    calls = []
    const fresh = await fused({ enginePool: 'api', ranking: 'fresh' })
    assert.equal(fresh.results[0].engines[0], 'brave')
    assert.equal(calls.length, 3)
    calls = []
    const custom = await fused({ enginePool: 'api', engineWeights: { tavily: 0, brave: 8, bing: 99 } })
    assert.equal(custom.results[0].engines[0], 'brave')
    assert.equal(custom.effectiveWeights.tavily, 0)
    assert.ok(!('bing' in custom.effectiveWeights))
    assert.deepEqual(calls.map((c) => c.name), ENGINE_POOLS.api)
  })
  await test('explicit engine override crosses pools but cannot enable missing/disabled engines', async () => {
    const out = await fused({ enginePool: 'free', engineList: ['exa','exa'], ranking: 'research' })
    assert.deepEqual(out.enginesUsed, ['exa'])
    assert.deepEqual(out.effectiveWeights, { exa: 1.45 })
    enabled = new Set(ENGINE_POOLS.free); calls = []
    const missing = await fused({ enginePool: 'api' })
    assert.deepEqual(missing.enginesUsed, [])
    assert.equal(calls.length, 0)
    assert.match(missing.warnings.join(' '), /No available engines/)
    for (const bad of [{engineList:[]}, {engineList:['unknown']}, {ranking:'newest'}, {enginePool:'unknown'}, {engineWeights:{exa:-1}}, {engineWeights:{exa:Infinity}}, {engineWeights:{unknown:1}}, {community:'true'}]) await assert.rejects(() => fused(bad))
    enabled = new Set(ENGINE_POOLS.hybrid)
  })
  await test('legacy layer api maps hybrid; explicit pool wins; capability fingerprint partitions caches', async () => {
    assert.equal((await fused({ layer: 'api' })).enginePool, 'hybrid')
    assert.equal((await fused({ layer: 'free', enginePool: 'api' })).enginePool, 'api')
    calls = []; credentialVersion++
    assert.equal((await fused({ layer: 'free', enginePool: 'api' })).cacheHit, false)
    assert.equal(calls.length, 3)
  })
  await test('community uses actual X Core once without recursion; cross-path dedupe and author diversity precede final cap', async () => {
    mode = 'community'; auth = true
    await fused({ engineList: ['bing','brave'] })
    assert.equal(officialCalls + fallbackCalls, 0)
    reset()
    const out = await fused({ engineList: ['bing','brave'], community: true, maxResults: 12, maxResultsCap: 20 })
    assert.equal(officialCalls, 1); assert.equal(fallbackCalls, 1)
    assert.equal(calls.length, 4, 'one web leg and one X-domain leg per selected engine; no recursive fused call')
    assert.equal(out.communityUsed, true)
    assert.equal(out.results.length, 12)
    assert.equal(new Set(out.results.map(resultKey)).size, out.results.length)
    const posts = out.results.filter((r) => r.kind === 'x')
    assert.ok(posts.length > 2, 'x.com must not be treated as a single domain bucket')
    assert.ok(posts.filter((r) => r.username === 'alice').length <= 2)
    assert.ok(new Set(posts.map((p) => p.username)).size >= 3)
    assert.ok(!out.results.some((r) => r.engines.includes('invented-engine')))
    assert.deepEqual(out.enginesUsed, ['bing','brave'])
    const one = await fused({ engineList: ['bing','brave'], community: true, maxResults: 1 })
    assert.equal(one.results.length, 1)
    mode = 'web'
  })
  await test('domain restrictions cover community, including Twitter aliases and query site operators', async () => {
    let out = await fused({ community: true, includeDomains: ['docs.example'] })
    assert.equal(out.communityUsed, false); assert.equal(officialCalls, 0)
    assert.match(out.warnings.join(' '), /domain filters exclude X/)
    out = await fused({ query: 'alpha site:docs.example', community: true })
    assert.equal(out.communityUsed, false)
    out = await fused({ community: true, excludeDomains: ['twitter.com'] })
    assert.equal(out.communityUsed, false)
    out = await fused({ community: true, includeDomains: ['twitter.com'] })
    assert.equal(out.communityUsed, true)
    assert.ok(out.results.length > 0 && out.results.every((r) => r.kind === 'x'))
    assert.ok(matchesDomains('https://mobile.twitter.com/bob/status/123', ['x.com']))
  })
  await test('X failure retains Web results with warnings, never masquerades as successful community evidence', async () => {
    hostedFailure = fallbackFailure = true
    const out = await fused({ community: true, engineList: ['bing'] })
    assert.equal(out.communityUsed, true)
    assert.ok(out.results.length > 0)
    assert.ok(out.results.every((r) => r.kind === 'web'))
    assert.match(out.warnings.join(' '), /community failed/)
    assert.equal((await fused({ community: true, engineList: ['bing'] })).cacheHit, false)
    hostedFailure = fallbackFailure = false
  })
  await test('X final filtering sees later-engine candidates; no early domain-search truncation', async () => {
    auth = false; mode = 'late-author'
    const out = await xSearch({ query: 'alpha', type: 'keyword', allowed_x_handles: ['alice'], max_results: 1, engineList: ['bing','ddg','yahoo'] }, {})
    assert.equal(out.results, 1)
    assert.equal(out.items[0].username, 'alice')
    assert.deepEqual(out.enginesUsed, ['bing','ddg','yahoo'])
    mode = 'web'
  })
  await test('community defers final cap until author diversity, even beyond 30 candidates', async () => {
    auth = false; mode = 'many-authors'
    const out = await fused({ engineList: ['bing','ddg','yahoo'], community: true, maxResults: 8, includeDomains: ['x.com'] })
    assert.ok(out.results.some((r) => r.username === 'bob'), 'later authors must survive the candidate stage')
    assert.ok(out.results.filter((r) => r.username === 'alice').length <= 2)
    mode = 'web'
  })
  await test('ordinary Web-leg X posts cannot bypass final community author/date filters; OR remains intact', async () => {
    mode = 'community'; auth = true
    const saved = xPosts
    xPosts = [post('bob', now, 1), post('alice', '2020-01-01T00:00:00Z', 2), post('alice', now, 3), post('carol', now, 4)]
    const out = await fused({ query: '(from:alice OR from:carol) alpha beta', community: true, recency: 'day', maxResults: 10 })
    const posts = out.results.filter((r) => r.kind === 'x')
    assert.ok(posts.length >= 2)
    assert.ok(posts.every((r) => ['alice','carol'].includes(r.username)))
    assert.ok(posts.every((r) => r.published > '2020-01-01'))
    xPosts = saved; mode = 'web'
  })
  await test('domain-restricted search puts the site: hint back for engines that cannot filter hosts', async () => {
    const seen = []
    const fake = {
      bing: { available: () => true, search: (q) => { seen.push(['bing', q]); return [] } },
      tavily: { available: () => true, nativeDomains: true, search: (q) => { seen.push(['tavily', q]); return [] } },
    }
    await runtime.runEngine(fake, 'bing', 'installation guide', 5, { includeDomains: ['nodejs.org'] })
    await runtime.runEngine(fake, 'tavily', 'installation guide', 5, { includeDomains: ['nodejs.org'] })
    await runtime.runEngine(fake, 'bing', 'installation guide', 5, {})
    assert.deepEqual(seen, [
      ['bing', 'site:nodejs.org installation guide'],
      ['tavily', 'installation guide'],
      ['bing', 'installation guide'],
    ])
  })

  await test('candidate-mode cache cannot leak unfiltered/unlimited results into public x_search', async () => {
    const args = { type: 'keyword', query: 'alpha beta', allowed_x_handles: ['alice'], max_results: 1, engineList: ['bing'] }
    const candidates = await xSearch(args, { candidateMode: true })
    assert.ok(candidates.results > 1)
    const final = await xSearch(args, {})
    assert.equal(final.results, 1)
    assert.equal(final.items[0].username, 'alice')
    assert.equal(final.cacheHit, false)
  })
  await test('partial variant failures report warnings and successes, not total engine failure', async () => {
    mode = 'partial-variants'
    const out = await fused({ engineList: ['bing'], complexity: 'medium', queries: ['alpha beta guide'] })
    assert.equal(out.engineStats.bing.attempts, 2)
    assert.equal(out.engineStats.bing.successes, 1)
    assert.equal(runtime.allAttemptedEnginesFailed(out.engineStats), false)
    assert.match(out.warnings.join(' '), /1\/2 attempts failed/)
    mode = 'web'
  })

  await test('a run with a failed engine is cached briefly instead of never', async () => {
    mode = 'partial-variants'
    const probe = ['alpha beta engine-cache probe']
    const first = await fused({ engineList: ['bing'], complexity: 'medium', queries: probe })
    assert.ok(first.results.length > 0, `fixture must return results: ${JSON.stringify(first.engineStats)}`)
    const second = await fused({ engineList: ['bing'], complexity: 'medium', queries: probe })
    assert.equal(second.cacheHit, true)
    mode = 'web'
  })

  await test('shared identity/filter helpers reject malformed evidence; stable X timestamps override model dates', () => {
    assert.equal(normalizeSearchHit({ url: 'javascript:alert(1)' }), null)
    assert.notEqual(normalizeUrl('https://example.com:8443/A?reference=X'), normalizeUrl('https://example.com/A?reference=X'))
    assert.ok(normalizeUrl('https://Example.com/A?reference=X&utm_source=y').endsWith('/A?reference=X'))
    assert.equal(parseDate('2025年2月31日'), null)
    const p = post('alice', '2025-01-15T12:00:00Z')
    const out = createXPipeline({ type: 'keyword', query: 'from:alice', from_date: '2025-01-01', to_date: '2025-01-31' }, 1).finish([
      { source: 'official', data: [{ ...p, created_at: '2026-02-01', engines: ['spoof'] }] },
      { source: 'engines', data: [{ id: '123', url: 'https://evil.example/not-a-post', username: 'alice' }] },
    ])
    assert.equal(out.results, 1)
    assert.equal(out.items[0].created_at, '2025-01-15T12:00:00.000Z')
    const rows = Array.from({length:5}, (_, i) => ({domain:'docs.example',kind:'web',score:5-i*.1,engines:['bing'],url:`https://docs.example/${i}`}))
    assert.equal(selectDiverse(rows, {limit:10}).results.length, 2)
  })
  await test('live capabilities honor keys/disabled state/layer/X auth without exposing credentials', () => {
    let cap = runtime.collectRuntimeCapabilities()
    assert.equal(cap.defaultEnginePool, 'free'); assert.ok(!cap.availableEngines.includes('tavily'))
    process.env.TAVILY_API_KEY = 'fixture-secret-tavily'; process.env.XAI_API_KEY = 'xai-fixture-secret-xai'
    cap = runtime.collectRuntimeCapabilities()
    assert.ok(cap.availableEngines.includes('tavily')); assert.equal(cap.x.official.available, true)
    assert.ok(!JSON.stringify(cap).includes('fixture-secret'))
    const before = runtimeSnapshot().fingerprint
    process.env.TAVILY_API_KEY = 'different-fixture-secret'
    assert.notEqual(runtimeSnapshot().fingerprint, before)
    writeFileSync(process.env.SEARCH_BOOST_KEYS_FILE, JSON.stringify({enabledEngines:[]}))
    assert.ok(!runtime.collectRuntimeCapabilities().availableEngines.includes('tavily'))
    runtime.switchLayer('api')
    assert.equal(runtime.collectRuntimeCapabilities().defaultEnginePool, 'hybrid')
  })
  await test('pre-aborted requests never execute or return a cached success', async () => {
    const controller = new AbortController(); controller.abort()
    await assert.rejects(() => fused({ signal: controller.signal }))
    assert.equal(calls.length, 0)
  })
  console.log(`\n${tests} routing/community/capability groups passed.`)
} finally { globalThis.fetch = originalFetch; rmSync(temp, { recursive: true, force: true }) }
