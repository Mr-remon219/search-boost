#!/usr/bin/env node
import './isolate-tests.mjs'
import assert from 'node:assert/strict'
import { normalizeCommunityInput, finishPlatformItems, communityDate } from '../lib/community/pipeline.mjs'
import { communitySearch } from '../lib/community/service.mjs'
import { runCommunitySearch, runFused, clearAllCaches } from '../lib/runtime.mjs'
import { communityCapabilities } from '../lib/community/config.mjs'
import { COMMUNITY_SEARCH_INPUT, COMMUNITY_OUTPUT, communityZod } from '../lib/community/schemas.mjs'
import { toDshSchema } from '../adapters/dsh/schema.js'
import { assertSupportedJsonSchema, validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'

const snapshot = () => ({ fingerprint: 'platform-pipeline', capability: { availableEngines: ['bing'], x: { official: { available: false }, fallback: { available: true } } }, engines: { bing: { available: () => true, search: async () => [] } } })
const input = { engines: ['x', 'reddit', 'zhihu'], query: ' common ', platform_options: { x: null, reddit: { query: ' reddit ', max_pages: null, allowed_authors: ['Alice'] }, zhihu: { query: null, content_type: 'answer' } } }
const normalized = normalizeCommunityInput(input)
assert.deepEqual(normalized.requests.map(r => r.args.query), ['common', 'reddit', 'common'])
assert.equal(normalized.requests[1].args.max_pages, undefined)
assert.deepEqual(normalized.requests[1].filters.allowedAuthors, ['alice'])
assert.deepEqual(normalizeCommunityInput({ engines: ['x'], username: '@alice' }).requests[0].args.query, 'from:alice')
assert.deepEqual(normalizeCommunityInput({ engines: ['zhihu'], platform_options: { zhihu: { query: 'own query' } } }).requests[0].args.query, 'own query')
assert.equal(normalizeCommunityInput({ engines: ['zhihu'], query: 'q', from_date: '2026-01-01', platform_options: { zhihu: { from_date: null } } }).requests[0].filters.from, Date.parse('2026-01-01'))
assert.equal(communityDate('2026-01-01', true), Date.parse('2026-01-02') - 1)
assert.equal(communityDate('2026-01-01T08:00:00+08:00', true), Date.parse('2026-01-01T00:00:00Z'))
const precise = normalizeCommunityInput({ engines: ['reddit'], query: 'q', platform_options: { reddit: { from_date: '2026-01-01T08:30:00+08:00', to_date: '2026-01-01T01:30:00Z' } } }).requests[0]
assert.equal(precise.args.from_date, '2026-01-01'); assert.equal(precise.args.to_date, '2026-01-01')
assert.equal(precise.filters.from, Date.parse('2026-01-01T00:30:00Z'))
let dispatched = 0
for (const bad of [
  { engines: ['zhihu'], query: 'q', platform_options: { x: null } },
  { engines: ['reddit'], query: 'q', platform_options: { reddit: { max_pages: 0 } } },
  { engines: ['reddit'], query: 'q', platform_options: { reddit: { allowed_authors: ['Alice'], excluded_authors: ['Bob'] } } },
  { engines: ['zhihu'], query: 'q', platform_options: { zhihu: { content_type: 'video' } } },
  { engines: ['x'], query: 'q', platform_options: { x: { query: '' } } },
  { engines: ['reddit'], query: 'q', from_date: '2026-02-30' },
  { engines: ['reddit'], query: 'q', from_date: '2026-01-01T00:00:00' },
  { engines: ['reddit'], query: 'q', platform_options: { reddit: { unknown: null } } },
]) await assert.rejects(() => communitySearch(bad, { snapshot, webSearch: () => { dispatched++ }, fetchImpl: () => { dispatched++ } }))
assert.equal(dispatched, 0)
console.log('ok: platform preprocessing: independent overrides/null defaults, X author keyword compatibility, ISO precision and invalid conditions fail before dispatch')

const request = normalizeCommunityInput({ engines: ['reddit'], query: 'q', from_date: '2026-01-01T00:30:00Z', to_date: '2026-01-01T01:30:00Z', platform_options: { reddit: { allowed_authors: ['alice'] } } }).requests[0]
const row = { url: 'https://www.reddit.com/r/test/comments/abc/', title: 'q', text: 'evidence', id: 'abc', subreddit: 'test', engineRanks: { bing: 1 } }
const finished = finishPlatformItems(request, [
  { ...row, author: null, published: null },
  { ...row, author: 'Alice', published: '2026-01-01T01:00:00Z', engineRanks: { bing: 2 } },
  { ...row, url: 'https://www.reddit.com/r/test/comments/def/', author: 'Bob', published: '2026-01-01T01:00:00Z' },
  { ...row, url: 'https://www.reddit.com/r/test/comments/ghi/', author: '[deleted]', published: '2026-01-01T01:00:00Z' },
  { ...row, url: 'https://www.reddit.com/r/test/comments/jkl/', author: 'Alice', published: '2026-01-01T02:00:00Z' },
  { ...row, url: 'https://www.reddit.com/r/test/comments/mno/', author: 'Alice', published: null },
])
assert.equal(finished.items.length, 1, 'merge metadata before applying precise conditions')
assert.equal(finished.items[0].engineRanks.bing, 1)
assert.equal(finished.items[0].data.subreddit, 'test')
assert.equal(finished.diagnostics.unknown_authors, 1)
assert.equal(finished.diagnostics.unknown_dates, 1)
assert.equal(finished.diagnostics.removed, 2)
const urls = {
  bilibili: ['https://www.bilibili.com/video/BV1alpha', 'https://www.bilibili.com/read/cv123', 'https://www.bilibili.com/opus/123'],
  zhihu: ['https://www.zhihu.com/question/123', 'https://www.zhihu.com/question/123/answer/456', 'https://zhuanlan.zhihu.com/p/789'],
  xiaohongshu: ['https://www.xiaohongshu.com/explore/abcdef'],
}
for (const [platform, addresses] of Object.entries(urls)) {
  const req = normalizeCommunityInput({ engines: [platform], query: 'q' }).requests[0]
  const result = finishPlatformItems(req, addresses.map(url => ({ url: `${url}?token=SECRET`, title: 'q', text: 'card', backendConfig: { cookie: 'SECRET' }, raw: 'SECRET' })))
  assert.deepEqual(result.items.map(i => i.content_type), platform === 'bilibili' ? ['video', 'article', 'post'] : platform === 'zhihu' ? ['question', 'answer', 'article'] : ['note'])
  for (const item of result.items) { assert.equal(item.data.platform, platform); assert.equal(item.data.schema_version, 1) }
  assert.doesNotMatch(JSON.stringify(result), /SECRET|backendConfig|cookie|raw/)
}
console.log('ok: platform postprocessing: identity-derived categories, typed platform data, merge-before-filter, strict unknown author/date and no raw/config/URL secrets')

const queries = []
const mixed = await communitySearch({ engines: ['x', 'zhihu', 'bilibili'], query: 'common', platform_options: { x: { type: 'thread', post_id: '1' }, zhihu: { content_type: 'answer', query: 'own' } } }, {
  snapshot, xSearch: async args => { assert.equal(args.type, 'thread'); return { via: 'fixture', items: [{ url: 'https://x.com/alice/status/1', text: 'post' }] } },
  webSearch: async args => { queries.push(args.query); const platform = args.includeDomains[0]; return { results: (platform === 'zhihu.com' ? urls.zhihu : urls.bilibili).map(url => ({ url, title: 'q', snippet: 'evidence', engineRanks: { bing: 1 } })) } },
})
assert.deepEqual(queries, ['own', 'common'])
assert.equal(mixed.items.filter(i => i.platform === 'zhihu').length, 1)
assert.equal(mixed.items.find(i => i.platform === 'zhihu').data.answer_id, '456')
const unsupported = await communitySearch({ engines: ['zhihu', 'bilibili'], query: 'q', platform_options: { zhihu: { type: 'semantic' } } }, { snapshot, webSearch: async () => ({ results: [{ url: urls.bilibili[0], title: 'q' }] }) })
assert.equal(unsupported.status, 'partial'); assert.equal(unsupported.channels[0].status, 'unsupported'); assert.equal(unsupported.items[0].platform, 'bilibili')
assert.equal(communityCapabilities(snapshot().capability).result_delivery.cursor_namespace, 'c1')
assert.equal(communityCapabilities(snapshot().capability).integrations.adaptive_search.base, 'fused_search')
assert.equal(communityCapabilities(snapshot().capability).integrations.fused_search.parameter_options, 'platform_options')
assert.equal(communityCapabilities(snapshot().capability).integrations.adaptive_search.direct_community_cursor, false)
for (const platform of communityCapabilities(snapshot().capability).platforms) assert.ok(platform.request_parameters)
console.log('ok: mixed platform operations and content filters stay independent; an unsupported backend does not block valid channels')

for (const schema of [COMMUNITY_SEARCH_INPUT, COMMUNITY_OUTPUT]) assertSupportedJsonSchema(toDshSchema(schema))
assert.deepEqual(communityZod(COMMUNITY_SEARCH_INPUT).parse(input), input)
assert.deepEqual(validateJsonSchemaValue(toDshSchema(COMMUNITY_OUTPUT), mixed), [])
assert.equal(communityZod(COMMUNITY_OUTPUT).parse(mixed).items.find(i => i.platform === 'zhihu').data.answer_id, '456')
clearAllCaches()
let reads = 0
const webSearch = async () => { reads++; return { results: urls.zhihu.map((url, i) => ({ url, title: 'q', snippet: 'evidence', engineRanks: { bing: i + 1 } })) } }
const page = await runCommunitySearch({ engines: ['zhihu'], query: 'q', max_results: 3, page_size: 1 }, { snapshot, webSearch })
assert.equal(page.schema_version, 2); assert.equal(page.total_results, 3); assert.equal(page.results, 1)
const next = await runCommunitySearch({ cursor: page.next_cursor, page_size: 2 }, { snapshot: () => { throw new Error('No acquisition/config read') }, webSearch: () => { throw new Error('No network') } })
assert.equal(next.results, 2); assert.equal(reads, 1)
const fused = await runFused({ query: 'q', community: ['zhihu'], candidateSelection: 'snapshot' }, { snapshot, communityService: (args, ctx) => communitySearch(args, { ...ctx, webSearch }) })
assert.equal(fused.results.length, 3, 'fusion consumes all candidates, not the public first page')
assert.equal(reads, 2)
console.log('ok: shared schema survives DSH/Zod; public facade pages once while fused consumes full unpaged projection with no duplicate votes/retrieval')
