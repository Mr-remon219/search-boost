#!/usr/bin/env node
import './isolate-tests.mjs'
import assert from 'node:assert/strict'
import { cleanCommunityHit, unavailableCommunityContent } from '../lib/community/content-quality.mjs'
import { webIndexProvider } from '../lib/community/providers/web.mjs'
import { communitySearch } from '../lib/community/service.mjs'
import { mergePlatformResults } from '../lib/community/fusion.mjs'
import { normalizeCommunityInput } from '../lib/community/pipeline.mjs'

const url = 'https://www.xiaohongshu.com/explore/69cf0679000000001d01ad1f'
const error = '安全限制 Account abnormal. Switch account and retry. 300011 我要反馈 返回首页'
const missing = '小红书 - 你访问的页面不见了 © 2014-2026 行吟信息科技'
assert(unavailableCommunityContent('xiaohongshu', error))
assert(unavailableCommunityContent('xiaohongshu', missing))
assert(unavailableCommunityContent('zhihu', '知乎，让每一次点击都充满意义 —— 欢迎来到知乎，发现问题背后的世界。'))
assert(!unavailableCommunityContent('xiaohongshu', 'Claude 的安全限制值得讨论，账号异常怎么处理？'))
assert(!unavailableCommunityContent('bilibili', '我的视频不见了？创作体验分享'))
const blocked = { url, title: 'Claude experience', snippet: error, published: '2026-10-07', engineRanks: { exa: 1 }, engines: ['exa'], provenance: [{ engine: 'exa', rank: 1, url, snippet: error, published: '2026-10-07' }] }
assert.equal(cleanCommunityHit('xiaohongshu', blocked), null)
const mixed = { ...blocked, engineRanks: { exa: 1, bing: 3 }, engines: ['exa', 'bing'], provenance: [...blocked.provenance, { engine: 'bing', rank: 3, url, snippet: 'Claude 付费使用心得', published: null }] }
const clean = cleanCommunityHit('xiaohongshu', mixed)
assert.equal(clean.snippet, 'Claude 付费使用心得')
assert.equal(clean.published, null); assert.deepEqual(clean.engineRanks, { bing: 3 })
assert.doesNotMatch(JSON.stringify(clean), /300011/)
const args = { engines: ['xiaohongshu'], query: 'Claude' }
const snapshot = () => ({ capability: { availableEngines: ['bing'] } })
const context = { snapshot, webSearch: async () => ({ results: [blocked, { ...blocked, url: url.replace('69cf0679000000001d01ad1f', '69cced1b000000002302584c'), snippet: missing, provenance: [] }] }) }
const out = await communitySearch(args, context)
assert.equal(out.status, 'partial'); assert.equal(out.results, 0)
assert.equal(out.channels[0].diagnostics.unavailable_content, 2)
assert.match(out.warnings.join(' '), /not a native search/)
const dated = await communitySearch({ ...args, from_date: '2026-10-07', to_date: '2026-10-08' }, { snapshot, webSearch: async () => [{ ...mixed, snippet: 'Claude 付费使用心得', provenance: [], published: null }] })
assert.equal(dated.status, 'partial', 'unknown dates must not look like healthy native empty coverage')
assert.equal(dated.channels[0].diagnostics.postprocessing.unknown_dates, 1)
const fusion = mergePlatformResults([blocked], [], { query: 'Claude', effectiveWeights: { exa: 1 }, platforms: ['xiaohongshu'], requests: normalizeCommunityInput(args).requests })
assert.deepEqual(fusion.results, [], 'ordinary Web branch must not reintroduce error-page evidence')
const unrelated = mergePlatformResults([{ ...blocked, url: 'https://docs.example/guide' }], [], { query: 'Claude', effectiveWeights: { exa: 1 }, platforms: ['xiaohongshu'], requests: normalizeCommunityInput(args).requests })
assert.equal(unrelated.results.length, 1, 'only selected platform posts are affected')
await assert.rejects(() => webIndexProvider('xiaohongshu').search(args, { webSearch: async () => { throw new Error('cancelled') } }))
console.log('ok: platform error-page filtering, clean engine excerpts, honest empty/date diagnostics and fused Web seam')
