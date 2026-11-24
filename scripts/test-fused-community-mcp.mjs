import './isolate-tests.mjs'
import assert from 'node:assert/strict'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { registerAll } from '../adapters/mcp/register.mjs'
import { runtimeSnapshot } from '../lib/search/capability.js'
import { runFused, clearAllCaches, collectSearchStats } from '../lib/runtime.mjs'

// Prime the real runtime cache with offline community evidence, then exercise
// discovery, argument mapping, result projection and SDK output validation.
const server = new McpServer({ name: 'community-contract-test', version: '1' })
const unwatch = registerAll(server)
const client = new Client({ name: 'contract-client', version: '1' })
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
try {
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  await client.listTools()
  for (const [platform, kind, url] of [
    ['bilibili', 'video', 'https://www.bilibili.com/video/BV1fR4y1T7aV'],
    ['zhihu', 'answer', 'https://www.zhihu.com/question/123/answer/456'],
    ['xiaohongshu', 'note', 'https://www.xiaohongshu.com/explore/69cf0679000000001d01ad1f'],
  ]) {
    clearAllCaches()
    const query = `offline native ${platform}`
    const text = `Detailed first-hand ${platform} implementation evidence for ${query}.`
    const data = { schema_version: 1, platform, kind, title: query, text, ...(platform === 'bilibili' ? {
      video_block: { schema_version: 1, title: query, url, bvid: 'BV1fR4y1T7aV', published: null,
        notes: [], comments: [], notes_status: 'empty', comments_status: 'disabled', coverage: 'offline fixture' },
    } : {}) }
    const start = Date.now()
    const primed = await runFused({ query, enginePool: 'api', community: [platform], maxResults: 6 }, {
      communityService: async () => {
        await new Promise(resolve => setTimeout(resolve, 30))
        return { status: 'ok', channels: [{ platform, status: 'ok', provider: `${platform}-native`, warnings: [] }],
          items: [{ platform, provider: `${platform}-native`, backend: 'fixture', retrieval_mode: 'native', content_type: kind,
            title: query, url, text, published: null, author: null, engineRanks: { [`community-${platform}-native`]: 1 }, data }], warnings: [] }
      },
    })
    assert(primed.tookMs >= 25 && primed.tookMs <= Date.now() - start, 'timing includes community wait')
    assert.equal(collectSearchStats().recent[0].tookMs, primed.tookMs)
    assert.equal(primed.results.length, 1)
    const result = await client.callTool({ name: 'fused_search', arguments: { query, engine_pool: 'api', community: [platform] } })
    assert(!result.isError, JSON.stringify(result))
    assert.equal(result.structuredContent.cacheHit, true, 'must reuse offline evidence, not call real engines')
    const stats = await client.callTool({ name: 'search_stats', arguments: {} })
    assert.equal(stats.structuredContent.recent[0].tookMs, primed.tookMs)
    assert.equal(result.structuredContent.tookMs, 0)
    assert.equal(result.structuredContent.results[0].content, primed.results[0].content)
    assert.deepEqual(result.structuredContent.results[0].community_data, primed.results[0].community_data)
  }
  clearAllCaches()
  const query = 'offline mixed implementation evidence'
  const state = runtimeSnapshot()
  const data = { schema_version: 1, platform: 'zhihu', kind: 'answer', text: query }
  const primed = await runFused({ query, engineList: ['bing'], enginePool: 'free', community: ['zhihu', 'x'], maxResults: 6 }, {
    snapshot: () => ({ ...state, engines: { bing: { available: () => true, search: async () => [
      { title: query, url: 'https://docs.example/reference', snippet: query },
    ] } } }),
    communityService: async () => ({ status: 'ok', channels: ['zhihu', 'x'].map(platform => ({ platform, status: 'ok', warnings: [] })), warnings: [], items: [
      { platform: 'zhihu', provider: 'zhihu-native', backend: 'fixture', retrieval_mode: 'native', content_type: 'answer',
        title: query, url: 'https://www.zhihu.com/question/123/answer/456', text: query, data, engineRanks: { 'community-zhihu-native': 1 } },
      { platform: 'x', provider: 'x-existing', backend: 'fixture', retrieval_mode: 'native', content_type: 'post',
        id: '1900000000000000000', username: 'fixture', text: query, url: 'https://x.com/fixture/status/1900000000000000000', engines: ['x-official'], engineRanks: { 'x-official': 1 } },
    ] }),
  })
  assert.equal(primed.results.length, 3)
  const mixed = await client.callTool({ name: 'fused_search', arguments: { query, engines: ['bing'], engine_pool: 'free', community: ['zhihu', 'x'] } })
  assert(!mixed.isError, JSON.stringify(mixed))
  assert.equal(mixed.structuredContent.cacheHit, true)
  assert.equal(mixed.structuredContent.results.length, 3)
  assert(mixed.structuredContent.results.some(row => row.kind === 'x'))
  assert(mixed.structuredContent.results.some(row => row.domain === 'docs.example' && row.community_data === undefined))
  assert(mixed.structuredContent.results.some(row => row.community_data?.platform === 'zhihu'))
  console.log('ok: SDK listTools/callTool accepts native community evidence and video blocks; full-branch timing retained')
} finally {
  unwatch()
  await client.close()
  await server.close()
}
