#!/usr/bin/env node
import './isolate-tests.mjs'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { readFileSync, writeFileSync } from 'node:fs'
import { searchBoostHome } from '../lib/config-paths.mjs'
import { communitySearch, communityExecution } from '../lib/community/service.mjs'
import { communityPlatforms } from '../lib/community/selection.mjs'
import { communityCacheIdentity, communityCapabilities } from '../lib/community/config.mjs'
import { bilibiliPublicProvider } from '../lib/community/providers/bilibili.mjs'
import { browserProvider, validateBrowserConfig } from '../lib/community/providers/browser.mjs'
import { webIndexProvider } from '../lib/community/providers/web.mjs'
import { redditArcticProvider } from '../lib/community/providers/reddit.mjs'
import { runCommunityBackend, runXSearch, runFused, clearAllCaches, runCommunitySearch } from '../lib/runtime.mjs'
import { normalizeAdaptiveInput } from '../lib/search/screening/input.js'
import { runAdaptiveScreening } from '../lib/search/screening/run.js'
import { makeHarness } from './screening-run-fixture.mjs'
import { COMMUNITY_SELECTION_SCHEMA } from '../lib/community/selection.mjs'
import { ADAPTIVE_V6_OUTPUT_SCHEMA } from '../lib/search/screening/schema.js'
import Ajv from 'ajv'

const state = { fingerprint: 'platform-fixture', capability: { availableEngines: ['bing'], x: { official: { available: false }, fallback: { available: true, webEngines: ['bing'] } } }, engines: {
  bing: { available: () => true, search: async () => [{ url: 'https://docs.example/alpha', title: 'Alpha guide', snippet: 'alpha docs' }] },
} }
const snapshot = () => state
const hit = (url, title = 'alpha community') => ({ url, title, snippet: 'alpha practical experience', engineRanks: { bing: 1 } })
const webSearch = async ({ includeDomains }) => ({ results: [hit({ reddit: 'https://www.reddit.com/r/localtest/comments/abc/', bilibili: 'https://www.bilibili.com/video/BV1abc123/', zhihu: 'https://www.zhihu.com/question/123/answer/456', xiaohongshu: 'https://www.xiaohongshu.com/explore/abc123' }[includeDomains[0].split('.')[0]])] })
assert.deepEqual(communityPlatforms(true), ['x']); assert.deepEqual(communityPlatforms([]), [])
for (const value of [[1,0,0,0,0], ['x','x'], ['unknown'], null, 'auto']) assert.throws(() => communityPlatforms(value))
assert.deepEqual(normalizeAdaptiveInput({ questions: ['Q?'], intent: 'I', community: ['reddit', 'zhihu'] }).community, ['reddit', 'zhihu'])
assert.equal(new Ajv().compile(COMMUNITY_SELECTION_SCHEMA)(['reddit', 'x']), true)
console.log('ok: shared platform arrays, strict invalid/duplicate rejection and legacy X boolean')

let requests = 0
const epoch = Date.parse('2026-01-20') / 1000
const fetchArchive = async url => {
  requests++; const u = new URL(url)
  assert.equal(u.origin, 'https://arctic-shift.photon-reddit.com'); assert.equal(u.searchParams.has('query'), false, 'local retrieval, not unreliable archive keyword search')
  const before = Number(u.searchParams.get('before'))
  const data = before > epoch ? Array.from({ length: 100 }, (_, i) => ({ id: (i + 1).toString(36), subreddit: 'localtest', created_utc: epoch - i, title: i ? 'Unrelated topic' : 'Alpha benchmark', selftext: 'collected evidence', author: 'fixture' })) : []
  return Response.json({ data })
}
const redditArgs = { engines: ['reddit'], query: 'alpha', subreddits: ['localtest'], from_date: '2026-01-01', to_date: '2026-02-01', max_pages: 1 }
let out = await communitySearch(redditArgs, { snapshot, fetchImpl: fetchArchive })
assert.equal(out.items[0].retrieval_mode, 'archive'); assert.equal(out.items[0].title, 'Alpha benchmark')
assert.equal(out.channels[0].diagnostics.stop_reason, 'page_budget'); assert.equal(requests, 1)
out = await communitySearch(redditArgs, { snapshot, fetchImpl: fetchArchive })
assert.equal(requests, 2); assert.equal(out.channels[0].diagnostics.stop_reason, 'archive_window_exhausted')
out = await communitySearch(redditArgs, { snapshot, fetchImpl: fetchArchive })
assert.equal(requests, 2); assert.equal(out.channels[0].cache_hit, true)
assert.equal(out.channels[0].diagnostics.coverage, 'unknown')
console.log('ok: bounded archive acquisition, local relevance, resume checkpoint, reuse and honest timestamp coverage')

const discovered = await communitySearch({ engines: ['reddit'], query: 'alpha', from_date: '2026-01-01', to_date: '2026-02-01' }, { snapshot, fetchImpl: fetchArchive, webSearch })
assert.equal(discovered.channels[0].diagnostics.discovery, 'web-index')
assert.deepEqual(discovered.channels[0].diagnostics.scopes, ['localtest'])
let badCalls = 0
for (const args of [{ ...redditArgs, from_date: '2026-02-30' }, { ...redditArgs, to_date: '2025-01-01' }, { ...redditArgs, subreddits: ['bad/name'] }, { ...redditArgs, max_pages: 0 }]) await assert.rejects(() => communitySearch(args, { snapshot, fetchImpl: () => { badCalls++; throw new Error('bad') } }))
assert.equal(badCalls, 0)
const rate = await communitySearch({ ...redditArgs, subreddits: ['different'] }, { snapshot, fetchImpl: async () => Response.json({}, { status: 429 }) })
assert.equal(rate.status, 'failed'); assert.match(JSON.stringify(rate), /rate_limited/)
const cancelled = new AbortController(); cancelled.abort()
await assert.rejects(() => redditArcticProvider.search({ ...redditArgs, max_results: 5 }, { signal: cancelled.signal, fetchImpl: fetchArchive }))
const checkpoint = join(searchBoostHome(), 'cache', 'community', 'reddit', `${discovered.channels[0].diagnostics.checkpoint}.json`)
const pristine = readFileSync(checkpoint, 'utf8'), damaged = JSON.parse(pristine)
damaged.rows = [null, { ...damaged.rows[0], subreddit: 'outsidescope' }]
writeFileSync(checkpoint, JSON.stringify(damaged))
const scrubbed = await communitySearch(redditArgs, { snapshot, fetchImpl: fetchArchive })
assert.equal(scrubbed.results, 0, 'foreign-scope or malformed private-cache rows cannot become evidence')
damaged.windows = [{ scope: 'outsidescope', before: epoch, done: true }]
writeFileSync(checkpoint, JSON.stringify(damaged))
const repaired = await communitySearch(redditArgs, { snapshot, fetchImpl: fetchArchive })
assert.equal(repaired.items[0].title, 'Alpha benchmark', 'invalid private cache windows reset rather than blocking retrieval')
damaged.rows = Array.from({ length: 4000 }, (_, i) => ({ ...JSON.parse(pristine).rows[0], id: (i + 1).toString(36) }))
damaged.windows = [{ scope: 'localtest', before: epoch, done: false }]
writeFileSync(checkpoint, JSON.stringify(damaged))
const saturated = await communitySearch(redditArgs, { snapshot, fetchImpl: () => { throw new Error('capacity must not dispatch') } })
assert.equal(saturated.channels[0].diagnostics.stop_reason, 'corpus_capacity')
assert.equal(saturated.channels[0].diagnostics.pages_requested, 0)
writeFileSync(checkpoint, pristine)
console.log('ok: scope discovery, zero-dispatch validation, rate-limit stop, cancellation and poisoned-cache scope repair')

for (const platform of ['bilibili', 'zhihu', 'xiaohongshu']) {
  const out = await communitySearch({ engines: [platform], query: 'alpha' }, { snapshot, webSearch })
  assert.equal(out.items[0].retrieval_mode, 'web-index'); assert.equal(out.status, 'ok')
}
const poisoned = await webIndexProvider('zhihu').search({ query: 'alpha', max_results: 5 }, { webSearch: async () => [hit('https://evil.example/question/123'), hit('javascript:alert(1)'), hit('https://www.zhihu.com/search?q=alpha')] })
assert.deepEqual(poisoned.items, [])
const mixed = await communitySearch({ engines: ['bilibili', 'zhihu', 'xiaohongshu'], query: 'alpha', max_results: 2 }, { snapshot, webSearch })
assert.deepEqual(mixed.items.map(i => i.platform), ['bilibili', 'zhihu'])
const dated = await communitySearch({ engines: ['zhihu'], query: 'alpha', from_date: '2026-01-01' }, { snapshot, webSearch })
assert.equal(dated.results, 0); assert.match(dated.warnings.join(' '), /date unverified/)
console.log('ok: all three public index adapters, URL allowlists, fair caps and fail-closed publication filters')

const bili = await bilibiliPublicProvider.search({ query: 'alpha', max_results: 5 }, { fetchImpl: async url => {
  assert.equal(new URL(url).pathname, '/x/web-interface/search/type')
  return Response.json({ code: 0, data: { result: [{ bvid: 'BV1abc123', title: '<em>Alpha</em> guide', description: 'video metadata', author: 'fixture', pubdate: epoch }] } })
} })
assert.equal(bili.items[0].title, 'Alpha guide'); assert.equal(bili.items[0].content_type, 'video')
await assert.rejects(() => bilibiliPublicProvider.search({ query: 'alpha' }, { fetchImpl: async () => Response.json({ code: -412 }) }), /refused/)
for (const config of [{ endpoint: 'https://remote.example', token_env: 'TOKEN' }, { endpoint: 'http://localhost:1/path', token_env: 'TOKEN' }, { endpoint: 'http://u:p@localhost:1', token_env: 'TOKEN' }, { endpoint: 'http://localhost:1', token_env: 'SECRET raw value' }]) assert.throws(() => validateBrowserConfig(config))
process.env.FIXTURE_BRIDGE_TOKEN = 'secret-not-visible'
const browser = browserProvider('xiaohongshu')
const browserResult = await browser.search({ query: 'alpha', max_results: 5 }, { backendConfig: { endpoint: 'http://127.0.0.1:19826', token_env: 'FIXTURE_BRIDGE_TOKEN' }, fetchImpl: async (_url, init) => {
  assert.equal(init.headers.Authorization, 'Bearer secret-not-visible')
  assert.deepEqual(JSON.parse(init.body), { platform: 'xiaohongshu', query: 'alpha', max_results: 5 })
  return Response.json({ status: 'ok', items: [{ url: 'https://www.xiaohongshu.com/explore/abc123?xsec_token=SECRET', title: 'alpha', text: 'card', published: null }] })
} })
assert.doesNotMatch(JSON.stringify(browserResult), /SECRET|secret-not-visible|xsec_token/)
console.log('ok: Bilibili API boundary, read-only browser contract, credential reference and signed-URL stripping')

const previous = communityCacheIdentity()
runCommunityBackend({ action: 'register', id: 'reddit-scoped', provider: 'reddit-arctic', config: { subreddits: ['localtest'] } }, { snapshot })
assert.notEqual(communityCacheIdentity(), previous)
assert.equal(communityCapabilities(state.capability).platforms.every(p => p.supported), true)
assert.doesNotMatch(JSON.stringify(communityCapabilities(state.capability)), /secret-not-visible/)
const audited = []
await runCommunitySearch({ engines: ['zhihu'], query: 'alpha' }, { snapshot, webSearch, audit: { write: e => audited.push(e) } })
assert.equal(audited.length, 1); assert.equal(audited[0].type, 'communitysearch')
runCommunityBackend({ action: 'update', id: 'x-default', enabled: false }, { snapshot })
let xCalls = 0
const closedState = { ...state, capability: { ...state.capability, community: communityCapabilities(state.capability) } }
const x = await runXSearch({ query: 'alpha' }, { snapshot: () => closedState, officialSearch: () => { xCalls++ }, fallbackSearch: () => { xCalls++ } })
assert.equal(x.via, 'error'); assert.equal(xCalls, 0)
runCommunityBackend({ action: 'update', id: 'x-default', enabled: true }, { snapshot })
console.log('ok: cache partition changes with scopes, credential-free capabilities, one audit event and shared legacy X disable')

clearAllCaches()
const fusion = await runFused({ query: 'alpha', community: ['zhihu', 'bilibili'], maxResults: 10, candidateSelection: 'snapshot' }, { snapshot,
  communityService: (args, ctx) => communitySearch(args, { ...ctx, webSearch }),
})
assert.deepEqual(fusion.communityPlatforms, ['zhihu', 'bilibili']); assert.equal(fusion.communityExecution.outcome, 'succeeded')
assert.ok(fusion.results.some(r => r.url.includes('zhihu.com')))
assert.ok(fusion.results.flatMap(r => r.provenance).some(p => p.platform === 'zhihu'))
assert.equal(fusion.results.find(r => r.url.includes('zhihu')).contributions.bing > 0, true)
assert.ok(!fusion.results.some(r => r.engines.includes('community-zhihu-web')), 'a web wrapper adds no duplicate independent vote')
const excluded = await runFused({ query: 'alpha', community: ['zhihu'], includeDomains: ['docs.example'] }, { snapshot, communityService: (args, ctx) => communitySearch(args, { ...ctx, webSearch: () => { throw new Error('should not dispatch') } }) })
assert.equal(excluded.communityUsed, false)
const reused = await runFused({ query: 'alpha', community: ['zhihu', 'bilibili'], maxResults: 10, candidateSelection: 'snapshot' }, { snapshot,
  communityService: () => { throw new Error('must reuse without dispatch') },
})
assert.equal(reused.cacheHit, true); assert.equal(reused.communityChannels.every(c => c.cache_hit), true)
assert.equal(reused.communityExecution.usage.dispatchedNow, false)
console.log('ok: shared multi-platform fusion, original web votes, provenance, honest cache reuse and hard domain preflight')

const { deps } = makeHarness({ rows: [], searchResult: { communityExecution: { requested: true, effective: true, outcome: 'empty', cacheHit: false, reason: null, usage: null } } })
let selected
const originalSearch = deps.search
// Test the real screening strategy and serializer while keeping external services fixture-only.
deps.search = async args => { selected = args.community; return originalSearch(args) }
const adaptive = await runAdaptiveScreening({ questions: ['alpha?'], intent: 'community experience', community: ['reddit', 'zhihu'] }, {}, deps)
assert.deepEqual(selected, ['reddit', 'zhihu']); assert.deepEqual(adaptive.run.community.platforms, ['reddit', 'zhihu'])
assert.equal(new Ajv({ strict: false }).compile(ADAPTIVE_V6_OUTPUT_SCHEMA)(adaptive), true)
assert.equal(communityExecution([{ platform: 'zhihu', status: 'ok' }, { platform: 'reddit', status: 'failed' }]).outcome, 'partial')
console.log('ok: Adaptive explicit arrays preserve the decision contract, v6 schema and partial-channel status')
