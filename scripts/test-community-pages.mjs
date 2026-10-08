#!/usr/bin/env node
import './isolate-tests.mjs'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, existsSync, linkSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { createCommunityPages, communityPages, communityResultsDir } from '../lib/community/pages.mjs'
import { communitySearch } from '../lib/community/service.mjs'
import { searchBoostHome } from '../lib/config-paths.mjs'
import { runCommunitySearch } from '../lib/runtime.mjs'
import { COMMUNITY_OUTPUT, communityZod } from '../lib/community/schemas.mjs'
import { validateJsonSchemaValue, assertSupportedJsonSchema } from '@deepseek-ai/dsh-tools'
import { toDshSchema } from '../adapters/dsh/schema.js'
import { registerAll } from '../adapters/mcp/register.mjs'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import piExtension from '../adapters/pi/index.js'

const snapshot = () => ({ capability: { availableEngines: ['bing'] } })
const webSearch = async () => ({ results: Array.from({ length: 8 }, (_, i) => ({ url: `https://www.zhihu.com/question/${100 + i}/answer/${200 + i}`, title: `q ${i}`, snippet: 'public evidence', engineRanks: { bing: i + 1 } })) })
const result = await communitySearch({ engines: ['zhihu'], query: 'q', max_results: 8 }, { snapshot, webSearch })
assert.equal(existsSync(communityResultsDir()), false, 'default acquisition never creates durable result storage')
const pages = createCommunityPages()
const first = pages.save(result, { pageSize: 3 })
assert.equal(first.schema_version, 2); assert.equal(first.total_results, 8); assert.equal(first.page_results, 3); assert.equal(first.reused, false)
assert.equal(first.saved_result_id, undefined)
result.items[0].title = 'mutated caller'; first.items[1].data.kind = 'mutated response'
const second = pages.read(first.next_cursor, 3)
const third = pages.read(second.next_cursor, 3)
assert.deepEqual([...first.items, ...second.items, ...third.items].map(i => i.url), Array.from({ length: 8 }, (_, i) => `https://www.zhihu.com/question/${100 + i}/answer/${200 + i}`))
assert.equal(third.next_cursor, null); assert.equal(third.page_results, 2); assert.equal(second.reused, true)
const again = pages.read(first.next_cursor.replace(/\.\d+$/, '.0'), 3)
assert.equal(again.items[0].title, 'q 0'); assert.equal(again.items[1].data.kind, 'answer')
assert.equal(again.took_ms, 0); assert.equal(again.channels[0].cache_hit, true)
assert.equal(existsSync(communityResultsDir()), false)
for (const cursor of ['s6:fake.0', 'h1:fake.0', '../other', first.next_cursor.replace(/\.\d+$/, '.999'), first.next_cursor.replace(/\.\d+$/, '.9007199254740992')]) assert.throws(() => pages.read(cursor), /no search was performed/)
let now = Date.parse('2026-01-01')
const expiring = createCommunityPages({ now: () => now, ttlMs: 100 })
const expiringPage = expiring.save(result, { pageSize: 1 }); now += 101
assert.throws(() => expiring.read(expiringPage.next_cursor), /expired/)
const evicting = createCommunityPages({ maxRuns: 1 })
const evicted = evicting.save(result, { pageSize: 1 }); evicting.save(result)
assert.throws(() => evicting.read(evicted.next_cursor), /evicted/)
const previousHome = searchBoostHome(), previousOverride = process.env.SEARCH_BOOST_HOME
process.env.SEARCH_BOOST_HOME = join(previousHome, 'different-home')
assert.throws(() => pages.read(first.next_cursor), /another home/)
if (previousOverride === undefined) delete process.env.SEARCH_BOOST_HOME
else process.env.SEARCH_BOOST_HOME = previousOverride
console.log('ok: community c1 pagination is immutable, ordered, process/home-bound, capacity-limited and zero-network; default storage remains memory-only')

const large = structuredClone(result)
for (const item of large.items) { item.text = '中'.repeat(7000); item.data.text = item.text }
const bytePages = createCommunityPages({ pageBytes: 70_000 })
const bytePage = bytePages.save(large, { pageSize: 8 })
assert.equal(bytePage.page_results, 1)
assert.equal(bytePage.items[0].text.length, 7000, 'reduce page count instead of clipping evidence')
const oversized = createCommunityPages({ pageBytes: 30_000 }).save(large, { pageSize: 8 })
assert.equal(oversized.page_results, 1); assert.match(oversized.warnings.join(' '), /returned intact/)
assert.throws(() => createCommunityPages({ maxBytes: 100 }).save(result), /storage byte limit/)
const cancelled = new AbortController(); cancelled.abort()
assert.throws(() => pages.save(result, { signal: cancelled.signal }), /abort/i)
assert.throws(() => pages.read(first.next_cursor, 5, { signal: cancelled.signal }), /abort/i)
const usageResult = structuredClone(result)
usageResult.channels[0].execution = { outcome: 'succeeded', usage: { logicCalls: 1, dispatchedNow: true, officialAttempted: true, fallbackAttempted: true, engineRequests: 2, httpAttempts: null, tokens: null } }
const usagePage = pages.save(usageResult, { pageSize: 1 })
const reusedUsage = pages.read(usagePage.next_cursor).channels[0].execution.usage
assert.equal(reusedUsage.logicCalls, 0); assert.equal(reusedUsage.engineRequests, 0); assert.equal(reusedUsage.httpAttempts, 0); assert.equal(reusedUsage.dispatchedNow, false)
console.log('ok: UTF-8 page byte budget preserves whole rows; cancellation/size limits are explicit and replay usage never claims new dispatch')

const saved = pages.save(result, { pageSize: 2, persist: true })
assert.ok(saved.saved_result_id)
const file = join(communityResultsDir(), `${saved.saved_result_id}.json`)
const pristine = readFileSync(file, 'utf8')
assert.doesNotMatch(pristine, /backendConfig|token_env|Authorization|cookie|platform_options/)
const restarted = createCommunityPages().restore(saved.saved_result_id, 2)
assert.equal(restarted.historical, true); assert.equal(restarted.captured_at, saved.captured_at); assert.equal(restarted.items[0].data.platform, 'zhihu')
const moduleUrl = new URL('../lib/community/pages.mjs', import.meta.url).href
const child = execFileSync(process.execPath, ['--input-type=module', '-e', `import { communityPages } from ${JSON.stringify(moduleUrl)}; console.log(JSON.stringify(communityPages.restore(${JSON.stringify(saved.saved_result_id)}, 1)))`], { encoding: 'utf8', env: process.env })
const restoredChild = JSON.parse(child.trim())
assert.equal(restoredChild.historical, true); assert.equal(restoredChild.page_results, 1); assert.equal(restoredChild.total_results, 8)
for (const change of [
  doc => { doc.format = 'search-boost-research-v3' },
  doc => { doc.id = '00000000-0000-4000-8000-000000000000' },
  doc => { doc.result.items[0].data.cookie = 'SECRET' },
  doc => { doc.result.items[0].data.platform = 'bilibili'; delete doc.result.items[0].data.question_id; delete doc.result.items[0].data.answer_id; delete doc.result.items[0].data.article_id; doc.result.items[0].data.kind = 'post'; doc.result.items[0].content_type = 'post' },
]) {
  const doc = JSON.parse(pristine); change(doc); writeFileSync(file, JSON.stringify(doc))
  assert.throws(() => pages.restore(saved.saved_result_id), error => /invalid; no search was performed/.test(error.message) && !error.message.includes('SECRET'))
}
writeFileSync(file, '{broken'); assert.throws(() => pages.restore(saved.saved_result_id), /invalid/)
writeFileSync(file, pristine)
const hardlink = join(communityResultsDir(), 'fixture-hardlink')
linkSync(file, hardlink)
assert.throws(() => pages.restore(saved.saved_result_id), /invalid/)
unlinkSync(hardlink)
assert.equal(pages.restore(saved.saved_result_id).historical, true)
assert.throws(() => pages.restore('../../outside'), /Invalid saved/)
console.log('ok: explicit private persistence restores across processes; format/identity/payload tampering, corrupt JSON and hardlinks are rejected without leaking values or executing searches')

let dispatches = 0, audits = 0
const fresh = await runCommunitySearch({ engines: ['zhihu'], query: 'q', max_results: 8, page_size: 2 }, { pages, snapshot, webSearch: async () => { dispatches++; return webSearch() }, audit: { write: () => audits++ } })
const failAcquisition = { pages, snapshot: () => { throw new Error('Should not inspect providers') }, webSearch: () => { throw new Error('Should not search') }, audit: { write: () => audits++ } }
await runCommunitySearch({ cursor: fresh.next_cursor }, failAcquisition)
await runCommunitySearch({ saved_result_id: saved.saved_result_id }, failAcquisition)
for (const args of [{ cursor: fresh.next_cursor, query: 'new search' }, { cursor: fresh.next_cursor, saved_result_id: saved.saved_result_id }, { saved_result_id: saved.saved_result_id, engines: ['x'] }]) await assert.rejects(() => runCommunitySearch(args, failAcquisition), /reads accept/)
assert.equal(dispatches, 1); assert.equal(audits, 1)
for (const page of [fresh, restarted, third]) { assert.deepEqual(validateJsonSchemaValue(toDshSchema(COMMUNITY_OUTPUT), page), []); communityZod(COMMUNITY_OUTPUT).parse(page) }
assertSupportedJsonSchema(toDshSchema(COMMUNITY_OUTPUT))
console.log('ok: facade dispatches/audits once, rejects mixed read/search modes, and all heterogeneous pages survive shared DSH/Zod contracts')

// Actual MCP and native Pi handles read seeded snapshots, not mocked runtime.
const hostPage = communityPages.save(await communitySearch({ engines: ['zhihu'], query: 'q', max_results: 8 }, { snapshot, webSearch }), { pageSize: 1 })
const server = new McpServer({ name: 'page-fixture', version: '1' }), stop = registerAll(server)
const client = new Client({ name: 'page-fixture', version: '1' }), [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
try {
  await server.connect(serverTransport); await client.connect(clientTransport)
  const response = await client.callTool({ name: 'community_search', arguments: { cursor: hostPage.next_cursor, page_size: 2 } })
  assert.equal(response.isError, undefined); assert.equal(response.structuredContent.page_results, 2)
  assert.equal(response.structuredContent.items[0].data.answer_id, '201')
  assert.equal(response.structuredContent.reused, true)
} finally { stop(); await client.close(); await server.close() }
const registered = new Map()
piExtension({ on() {}, registerCommand() {}, registerTool: tool => registered.set(tool.name, tool) })
const piResult = await registered.get('community_search').execute('read-page', { cursor: hostPage.next_cursor, page_size: 2 })
assert.equal(piResult.structuredContent.page_results, 2); assert.equal(piResult.details.items[0].data.answer_id, '201')
console.log('ok: real MCP roundtrip and native Pi read-only pages preserve platform data and public counters')
