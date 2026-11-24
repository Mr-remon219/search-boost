#!/usr/bin/env node
import './isolate-tests.mjs'
import assert from 'node:assert/strict'
import { normalizeCommunityInput, finishPlatformItems } from '../lib/community/pipeline.mjs'
import { CommunityRegistry } from '../lib/community/registry.mjs'
import { communitySearch } from '../lib/community/service.mjs'
import { redditArcticProvider } from '../lib/community/providers/reddit.mjs'
import { parseDate } from '../lib/search/results.js'
import { normalizeUsers } from '../lib/search/x/x-pipeline.js'
import { runFused, runAdaptiveSearch, clearAllCaches } from '../lib/runtime.mjs'
import { makeHarness, outputValidator } from './screening-run-fixture.mjs'

const failures = []
async function test(name, fn) {
  try { clearAllCaches(); await fn(); console.log(`ok: ${name}`) }
  catch (error) { failures.push(name); console.error(`FAIL: ${name}: ${error.message}`) }
}
const query = 'Node migration developer experience'
const answer = 'https://www.zhihu.com/question/123/answer/456'
const hit = url => ({ url, title: query, snippet: 'First-hand Node migration developer experience with concrete implementation and reproducible evidence.' })
const provider = (platform, cacheHit = false) => ({
  id: platform === 'reddit' ? 'reddit-arctic' : 'zhihu-web', platform, label: 'Offline self-review fixture', version: 1,
  operations: ['keyword'], retrievalMode: platform === 'reddit' ? 'archive' : 'web-index',
  validateConfig: () => ({}), describeAvailability: () => ({ ready: true }),
  search: async () => ({ via: 'fixture', cacheHit, items: [], engineStats: {} }),
})
const baseState = { fingerprint: 'adaptive-community-self-review', capability: { availableEngines: ['bing'] }, engines: { bing: { available: () => true, search: async () => [hit('https://docs.example/migration')] } } }

await test('AR1: day-only dates cannot masquerade as midnight within a hard timestamp window', () => {
  const request = normalizeCommunityInput({ engines: ['zhihu'], query, platform_options: { zhihu: { to_date: '2026-01-02T10:00:00Z' } } }).requests[0]
  const result = finishPlatformItems(request, [{ ...hit(answer), published: '2026-01-02' }])
  assert.equal(result.items.length, 0)
  assert.equal(result.diagnostics.unknown_dates, 1)
  const day = normalizeCommunityInput({ engines: ['zhihu'], query, to_date: '2026-01-02' }).requests[0]
  assert.equal(finishPlatformItems(day, [{ ...hit(answer), published: '2026-01-02' }]).items.length, 1)
  assert.equal(finishPlatformItems(request, [{ ...hit(answer), published: '2026-01-02T09:00:00Z' }]).items.length, 1)
  assert.equal(finishPlatformItems(request, [{ ...hit(answer), published: '2026-01-02T11:00:00Z' }]).items.length, 0)
})

await test('AR1: a rejected native timestamp cannot return via a day-projected ordinary Web hit', async () => {
  const native = provider('zhihu')
  native.search = async () => ({ via: 'fixture', items: [{ ...hit(answer), published: '2026-01-02T11:00:00Z', engineRanks: { bing: 1 } }] })
  const registry = new CommunityRegistry().register(native)
  const config = { backends: [{ id: 'zhihu-fixture', provider: native.id, enabled: true, config: {} }] }
  const state = { ...baseState, engines: { bing: { available: () => true, search: async () => [{ ...hit(answer), published: '2026-01-02T11:00:00Z' }] } } }
  const result = await runFused({ query, community: ['zhihu'], platform_options: { zhihu: { to_date: '2026-01-02T10:00:00Z' } }, candidateSelection: 'snapshot' }, {
    snapshot: () => state, communityService: (args, context) => communitySearch(args, { ...context, registry, config }),
  })
  assert.equal(result.results.length, 0)
  assert.ok(result.warnings.some(value => /date|hard platform/.test(value)))
})

await test('AR1: timezone-qualified dates use their UTC day, not their literal local-date prefix', async () => {
  const published = '2026-01-02T00:30:00+08:00'
  assert.equal(parseDate(published), '2026-01-01')
  assert.equal(parseDate('2026-01-01T23:30:00-03:00'), '2026-01-02')
  assert.equal(parseDate('2026-01-02T00:30:00'), null, 'unqualified time must not invent a timezone')
  assert.equal(parseDate('2026年1月'), null, 'a month must not invent January 1')
  const native = provider('zhihu')
  native.search = async () => ({ via: 'fixture', items: [{ ...hit(answer), published, engineRanks: { bing: 1 } }] })
  const registry = new CommunityRegistry().register(native), config = { backends: [{ id: 'zhihu-fixture', provider: native.id, enabled: true, config: {} }] }
  const state = { ...baseState, fingerprint: 'utc-publication-bound', engines: { bing: { available: () => true, search: async () => [{ ...hit(answer), published }] } } }
  const result = await runFused({ query, community: ['zhihu'], platform_options: { zhihu: { from_date: '2026-01-02' } }, candidateSelection: 'snapshot' }, { snapshot: () => state, communityService: (args, context) => communitySearch(args, { ...context, registry, config }) })
  assert.equal(result.results.length, 0, 'Jan 1 UTC cannot pass the Jan 2 lower bound via a Jan 2 local-date prefix')
})

await test('AR1: conflicting indexed dates and native authors fail closed independent of source order', async () => {
  for (const reversed of [false, true]) {
    const engines = { bing: { available: () => true, search: async q => /zhihu/.test(q) ? [{ ...hit(answer), published: reversed ? '2026-01-02' : '2020-01-02' }] : [] }, ddg: { available: () => true, search: async q => /zhihu/.test(q) ? [{ ...hit(answer), published: reversed ? '2020-01-02' : '2026-01-02' }] : [] } }
    const state = { engines, fingerprint: `conflicting-date-order-${reversed}`, capability: { availableEngines: ['bing', 'ddg'] } }
    const result = await runFused({ query, community: ['zhihu'], platform_options: { zhihu: { to_date: '2021-01-01' } }, candidateSelection: 'snapshot' }, { snapshot: () => state })
    assert.equal(result.results.length, 0)
    assert.ok(result.warnings.some(value => /conflicting|unverified/.test(value)))
    const request = normalizeCommunityInput({ engines: ['reddit'], query, platform_options: { reddit: { allowed_authors: ['alice'] } } }).requests[0]
    const rows = ['alice', 'bob'].map(author => ({ ...hit('https://www.reddit.com/r/node/comments/abc/'), author }))
    if (reversed) rows.reverse()
    const finished = finishPlatformItems(request, rows)
    assert.equal(finished.items.length, 0)
    assert.equal(finished.diagnostics.unknown_authors, 1)
  }
})

await test('AR1: X Snowflake date authority survives original indexed observations without rewriting them', async () => {
  const id = (((BigInt(Date.parse('2026-01-02T12:00:00Z')) - 1288834974657n) << 22n) + 1n).toString()
  const state = { ...baseState, capability: { ...baseState.capability, x: { official: { available: false }, fallback: { available: true } } }, engines: { bing: { available: () => true, search: async () => [{ ...hit(`https://x.com/alice/status/${id}`), published: '2020-01-02' }] } } }
  const result = await runFused({ query, community: ['x'], candidateSelection: 'snapshot' }, { snapshot: () => state,
    communityService: async () => ({ items: [], channels: [{ platform: 'x', status: 'empty', warnings: [], execution: { outcome: 'empty', usage: {} } }] }),
  })
  assert.equal(result.results[0].published, '2026-01-02')
  assert.equal(result.results[0].dateStatus, 'known')
  assert.ok(result.results[0].provenance.some(source => source.published === '2020-01-02'))
})

await test('AR2: selected-platform hard categories apply to unrecognized Web paths, not just valid native item URLs', async () => {
  const native = provider('zhihu'), registry = new CommunityRegistry().register(native)
  const config = { backends: [{ id: 'zhihu-fixture', provider: native.id, enabled: true, config: {} }] }
  const state = { ...baseState, engines: { bing: { available: () => true, search: async () => [hit('https://www.zhihu.com/'), hit('https://www.zhihu.com/people/alice'), hit(answer), hit('https://docs.example/migration')] } } }
  const result = await runFused({ query, community: ['zhihu'], platform_options: { zhihu: { content_type: 'answer' } }, candidateSelection: 'snapshot' }, {
    snapshot: () => state, communityService: (args, context) => communitySearch(args, { ...context, registry, config }),
  })
  assert.ok(result.results.some(row => row.url === answer))
  assert.ok(result.results.some(row => row.domain === 'docs.example'))
  assert.equal(result.results.filter(row => row.domain === 'zhihu.com').length, 1)
})

await test('AR3: post/foreign URLs cannot lend a fabricated X account identity', () => {
  for (const url of ['https://x.com/alice/status/123', 'https://example.com/alice', 'https://x.com/search']) assert.equal(normalizeUsers([{ url, username: 'alice', bio: 'Account evidence' }]).length, 0, url)
  assert.equal(normalizeUsers([{ username: 'alice' }])[0].url, 'https://x.com/alice')
  assert.equal(normalizeUsers([{ url: 'https://twitter.com/alice', username: 'bob' }])[0].username, 'alice')
})

await test('AR4: nested reused channel observations do not count as new Adaptive engine requests', async () => {
  const reddit = provider('reddit', true), zhihu = provider('zhihu')
  reddit.search = async () => ({ via: 'fixture', cacheHit: true, items: [{ ...hit('https://www.reddit.com/r/node/comments/abc/'), text: hit(answer).snippet, engineRanks: { 'community-reddit-arctic': 1 } }], engineStats: { 'community-reddit-arctic': { used: true, attempts: 7, successes: 7, errors: 0 } } })
  zhihu.search = async () => ({ via: 'fixture', items: [{ ...hit(answer), engineRanks: { bing: 1 } }], engineStats: { bing: { used: true, attempts: 2, successes: 2, errors: 0 } } })
  const registry = new CommunityRegistry().register(reddit).register(zhihu)
  const config = { backends: [reddit, zhihu].map(native => ({ id: `${native.platform}-fixture`, provider: native.id, enabled: true, config: {} })) }
  const harness = makeHarness({ state: baseState })
  harness.deps.search = (args, state) => runFused(args, { snapshot: () => state, communityService: (params, context) => communitySearch(params, { ...context, registry, config }) })
  const result = await runAdaptiveSearch({ questions: [query], intent: 'Find concrete evidence', community: ['reddit', 'zhihu'], max_results: 5 }, {}, harness.deps)
  assert.equal(outputValidator()(result), null)
  assert.equal(result.usage.engineRequests, 3, 'one Web + two fresh indexed calls, not seven old archive observations')
  assert.equal(result.run.community.usage.engineRequests, 2)
  assert.equal(result.run.community.channels.find(channel => channel.platform === 'reddit').engine_stats['community-reddit-arctic'].attempts, 7, 'historical observations remain available')
})

await test('AR4: Reddit discovery requests remain observable even with a warm archive or no scope', async () => {
  const context = { backendConfig: {}, webSearch: async () => ({ results: [hit('https://www.reddit.com/r/node/comments/abc/')], engineStats: { bing: { used: true, attempts: 2, successes: 2, errors: 0 } } }),
    fetchImpl: async () => Response.json({ data: [{ id: 'abc', subreddit: 'node', title: query, selftext: hit(answer).snippet, author: 'alice', created_utc: Date.parse('2026-01-02') / 1000 }] }) }
  const args = { query, max_results: 5, from_date: '2026-01-01', to_date: '2026-01-31' }
  const first = await redditArcticProvider.search(args, context)
  assert.equal(first.engineStats.bing.attempts, 2)
  const warm = await redditArcticProvider.search(args, context)
  assert.equal(warm.engineStats['community-reddit-arctic'].attempts, 0)
  assert.equal(warm.engineStats.bing.attempts, 2)
  assert.equal(warm.cacheHit, false, 'the discovery leg did dispatch new requests')
  const empty = await redditArcticProvider.search(args, { ...context, webSearch: async () => ({ results: [], engineStats: first.engineStats }) })
  assert.equal(empty.engineStats.bing.attempts, 2)
  assert.equal(empty.items.length, 0)
})

await test('AR5: valid verbose channel summaries fit pages after review without losing statuses/counts or mutating saved metadata', async () => {
  const harness = makeHarness()
  const search = harness.deps.search
  harness.deps.search = async (...args) => {
    const fused = await search(...args)
    fused.communityChannels = ['reddit', 'x', 'bilibili', 'zhihu', 'xiaohongshu'].map(platform => ({ platform, status: 'partial', provider: `${platform}-fixture`, backend: `${platform}-fixture`, retrieval_mode: 'web-index', reason: 'partial_retrieval', warnings: Array(12).fill('警'.repeat(300)), engine_stats: Object.fromEntries(Array.from({ length: 32 }, (_, i) => [`engine_${i}`, { used: true, attempts: Number.MAX_SAFE_INTEGER, successes: Number.MAX_SAFE_INTEGER, errors: 0, note: '警'.repeat(300) }])), diagnostics: { coverage: 'unknown', collected: 1 } }))
    return fused
  }
  const result = await runAdaptiveSearch({ questions: [query], intent: 'Find evidence', community: ['reddit', 'x', 'bilibili', 'zhihu', 'xiaohongshu'], max_results: 5, save_results: true }, {}, harness.deps)
  assert.equal(outputValidator()(result), null)
  assert.equal(result.run.community.channels.length, 5)
  assert.ok(result.run.community.channels.every(channel => channel.status === 'partial' && channel.details_truncated && channel.diagnostics.collected === 1))
  assert.ok(result.warnings.some(warning => /channel.*trim|channel.*omit/i.test(warning)))
  assert.ok(result.run.community.channels.every(channel => !channel.engine_stats))
  assert.ok(harness.calls.save[0].metadata.run.community.channels.every(channel => channel.warnings.length === 12 && !channel.details_truncated))
})

await test('AR6: Web/native aliases merge by platform identity and signed platform URL parameters do not leak', async () => {
  const url = 'https://www.xiaohongshu.com/explore/abcdef'
  const native = { ...provider('zhihu'), id: 'xiaohongshu-web', platform: 'xiaohongshu' }
  native.search = async () => ({ via: 'fixture', items: [{ ...hit(url), engineRanks: { bing: 3 } }] })
  const registry = new CommunityRegistry().register(native), config = { backends: [{ id: 'xhs-fixture', provider: native.id, enabled: true, config: {} }] }
  const state = { ...baseState, engines: { bing: { available: () => true, search: async () => [hit('https://m.xiaohongshu.com/discovery/item/abcdef?xsec_token=PRIVATE_SIGNATURE'), hit(`${url}?xsec_token=PRIVATE_SIGNATURE`), hit('https://docs.example/migration?ref=branch')] } } }
  const result = await runFused({ query, community: ['xiaohongshu'], candidateSelection: 'snapshot' }, { snapshot: () => state, communityService: (params, context) => communitySearch(params, { ...context, registry, config }) })
  const rows = result.results.filter(row => row.domain === 'xiaohongshu.com')
  assert.equal(rows.length, 1)
  assert.equal(rows[0].url, url)
  assert.equal(rows[0].engineRanks.bing, 1)
  assert.equal(JSON.stringify(result.results).includes('PRIVATE_SIGNATURE'), false)
  assert.ok(result.results.some(row => row.url === 'https://docs.example/migration?ref=branch'))
})

await test('DOC1: multi-platform acquisition is not falsely described as a shared 30-row cap', async () => {
  const reddit = provider('reddit'), zhihu = provider('zhihu')
  reddit.search = async () => ({ via: 'fixture', items: Array.from({ length: 25 }, (_, i) => ({ ...hit(`https://www.reddit.com/r/node/comments/id${i}/`), engineRanks: { 'community-reddit-arctic': i + 1 } })) })
  zhihu.search = async () => ({ via: 'fixture', items: Array.from({ length: 25 }, (_, i) => ({ ...hit(`https://www.zhihu.com/question/123/answer/${i + 1}`), engineRanks: { bing: i + 1 } })) })
  const registry = new CommunityRegistry().register(reddit).register(zhihu), config = { backends: [reddit, zhihu].map(native => ({ id: `${native.platform}-fixture`, provider: native.id, enabled: true, config: {} })) }
  const args = { engines: ['reddit', 'zhihu'], query, max_results: 30 }
  assert.equal((await communitySearch(args, { registry, config, candidateMode: true })).items.length, 50)
  assert.equal((await communitySearch(args, { registry, config })).items.length, 30)
  const result = await runFused({ query, community: args.engines, candidateSelection: 'snapshot', snapshotCandidateLimit: 40 }, { snapshot: () => baseState, communityService: (params, context) => communitySearch(params, { ...context, registry, config }) })
  assert.equal(result.results.length, 40)
  assert.ok(result.funnel.fusionRows > 40)
})

if (failures.length) { console.error(`${failures.length} self-review regression(s) failed`); process.exitCode = 1 }
