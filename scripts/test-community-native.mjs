#!/usr/bin/env node
import './isolate-tests.mjs'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, symlinkSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { xhsNote, xiaohongshuNativeProvider } from '../lib/community/providers/xiaohongshu-native.mjs'
import { zhihuDetail } from '../lib/community/providers/zhihu-native.mjs'
import { bilibiliOpus } from '../lib/community/providers/bilibili-native.mjs'
import { collectVideoBlock, publicVideoNote, publicNoteText, bilibiliLocalTime, projectVideoBlock } from '../lib/community/bilibili-block.mjs'
import { fulfillNativeRequest } from '../lib/community/native-transport.mjs'
import { allowedNativeRequest, nativeHome, nativeSessionState, nativeAvailability, withNativeSession, initializeNativeSession } from '../lib/community/native-session.mjs'
import { communityRegistry, manageCommunityBackend, communityCacheIdentity } from '../lib/community/config.mjs'
import { communitySearch } from '../lib/community/service.mjs'
import { finishPlatformItems, normalizeCommunityInput } from '../lib/community/pipeline.mjs'
import { mergePlatformResults } from '../lib/community/fusion.mjs'
import { fusedHitToJson } from '../lib/runtime.mjs'
import { COMMUNITY_OUTPUT, validateCommunity } from '../lib/community/schemas.mjs'
import { createCommunityPages } from '../lib/community/pages.mjs'

const root = mkdtempSync(join(tmpdir(), 'native-community-'))
process.env.SEARCH_BOOST_HOME = join(root, 'state')
const executable = join(root, 'fake-chromium')
writeFileSync(executable, 'fixture only', { mode: 0o700 })
process.env.SEARCH_BOOST_BROWSER_EXECUTABLE = executable
const id = '69cf0679000000001d01ad1f', bvid = 'BV1fR4y1T7aV', pub = Date.parse('2026-10-07T07:44:00Z') / 1000
const note = { noteId: id, title: 'Claude 体验', desc: '实际笔记正文', time: pub * 1000, user: { nickname: '测试作者', cookie: 'SECRET' }, xsecToken: 'SIGNED' }
assert.equal(xhsNote(id, note).published, '2026-10-07T07:44:00.000Z')
assert.equal(xhsNote(id, { ...note, noteId: '69cf0679000000001d01ad2f' }), null)
assert.equal(xhsNote(id, { ...note, time: 0 }).published, null)
assert.doesNotMatch(JSON.stringify(xhsNote(id, note)), /SIGNED|SECRET/)
const zhUrl = 'https://www.zhihu.com/question/123/answer/456'
const zhState = { initialState: { entities: { answers: { '789': { id: 789, content: '推荐答案' }, '456': { id: 456, content: '<p>目标回答正文</p>', created_time: pub, author: { name: '作者' }, question: { title: 'Claude 如何？' } } } } } }
assert.equal(zhihuDetail(zhUrl, zhState).text, '目标回答正文')
assert.equal(zhihuDetail(zhUrl, { initialState: { entities: { answers: { '789': zhState.initialState.entities.answers['789'] } } } }), null)
assert.equal(zhihuDetail('https://zhuanlan.zhihu.com/p/42', { initialState: { entities: { articles: { '42': { id: 42, content: '文章正文', created: pub, author: { name: '作者' } } } } } }).published, '2026-10-07T07:44:00.000Z')
assert.equal(bilibiliOpus('https://www.bilibili.com/opus/12345', { id_str: '12345', modules: { module_author: { name: '图文作者', pub_ts: pub }, module_dynamic: { desc: { text: '图文文字' } } } }).text, '图文文字')
assert.equal(bilibiliOpus('https://www.bilibili.com/opus/12345', { id_str: '9' }), null)
assert.equal(publicNoteText('[{"insert":"笔记主体\\n"},{"insert":{"image":"private.png"}}]'), '笔记主体')
assert.equal(bilibiliLocalTime('2026-10-07 15:44'), '2026-10-07T07:44:00.000Z')
assert.equal(bilibiliLocalTime('2026-02-30 12:00'), null)

const apiCalls = []
const video = { bvid, aid: 338677252, title: 'Claude 使用视频', pubdate: pub, owner: { name: 'UP主' }, desc: '不得把简介作为主体' }
const publicDetail = { cvid: 15160286, pub_status: 2, arc: { oid: video.aid }, title: '公开笔记', content: '[{"insert":"Claude 的详细使用笔记\\n"}]', author: { name: '笔记作者' }, cookie: 'SECRET' }
const noteRow = { cvid: 15160286, pubtime: '2026-10-07 15:44', title: '公开笔记' }
const api = async url => {
  apiCalls.push(url)
  const path = new URL(url).pathname
  if (path === '/x/web-interface/view') return video
  if (path === '/x/note/publish/list/archive') return { list: [noteRow] }
  if (path === '/x/note/publish/info') return publicDetail
  if (path === '/x/v2/reply') return { replies: [{ rpid_str: '123456789', ctime: pub, like: 3, content: { message: '补充评论' }, member: { uname: '评论者', SESSDATA: 'SECRET' } }] }
  throw new Error('unexpected endpoint')
}
const row = await collectVideoBlock(bvid, api)
assert(row.text.startsWith('# Claude 使用视频'))
assert(row.text.indexOf('公开笔记（主体）') < row.text.indexOf('评论（补充）'))
assert(row.text.endsWith('BV 号：' + bvid))
const verbose = { ...row.video_block, title: '标题'.repeat(250), notes: Array.from({ length: 5 }, () => ({ ...row.video_block.notes[0], title: '笔记'.repeat(250), text: '正文'.repeat(2000), author: '作者'.repeat(100) })), comments: Array.from({ length: 20 }, () => ({ ...row.video_block.comments[0], text: '评论'.repeat(500), author: '评论者'.repeat(100) })) }
const { renderVideoBlock } = await import('../lib/community/bilibili-block.mjs')
assert(renderVideoBlock(verbose).length < 8000); assert(renderVideoBlock(verbose).endsWith(bvid))
assert.equal(row.video_block.notes.length, 1); assert.equal(row.video_block.comments.length, 1)
assert.doesNotMatch(JSON.stringify(row), /SECRET|不得把简介|private\.png/i)
assert(!apiCalls.some(url => /\/x\/note\/(?:list|info)(?:\?|$)/.test(url)), 'only public-note endpoints')
assert.equal(publicVideoNote(noteRow, { ...publicDetail, arc: { oid: 1 } }, video.aid), null)
const disabled = await collectVideoBlock(bvid, api, { commentLimit: 0 })
assert.equal(disabled.video_block.comments_status, 'disabled')
let attempts = 0
const partial = await collectVideoBlock(bvid, async url => {
  attempts++
  if (new URL(url).pathname === '/x/web-interface/view') return video
  throw new Error('access gated SECRET')
})
assert.equal(attempts, 2)
assert.equal(partial.video_block.notes_status, 'unavailable')
assert.equal(partial.video_block.comments_status, 'not_requested')
assert(partial.text.endsWith(bvid))
const filtered = await collectVideoBlock(bvid, api, { filters: { from: Date.parse('2026-10-08T00:00:00Z'), to: null } })
assert.equal(filtered.video_block.notes.length, 0); assert.equal(filtered.video_block.comments.length, 0)
assert.equal(row.video_block.notes[0].published_precision, 'minute')
const narrow = await collectVideoBlock(bvid, api, { filters: { from: null, to: Date.parse('2026-10-07T07:44:30Z') }, commentLimit: 0 })
assert.equal(narrow.video_block.notes.length, 0, 'minute precision cannot fabricate a second-exact timestamp inside a narrower window')
const block = projectVideoBlock({ ...row.video_block, raw: 'SECRET' }, row.url)
assert.doesNotMatch(JSON.stringify(block), /SECRET/)

for (const platform of ['bilibili', 'zhihu', 'xiaohongshu']) {
  assert(communityRegistry.list().some(p => p.id === platform + '-native'))
  assert.deepEqual(communityRegistry.get(platform + '-native').validateConfig({}), {})
  assert.throws(() => communityRegistry.get(platform + '-native').validateConfig({ endpoint: 'http://127.0.0.1:18060' }))
}
assert(!communityRegistry.list().some(p => p.id === 'xiaohongshu-mcp'))
const request = normalizeCommunityInput({ engines: ['bilibili'], query: 'Claude', platform_options: { bilibili: { content_type: 'video', note_limit: 2, comment_limit: 0 } } }).requests[0]
assert.equal(request.args.note_limit, 2); assert.equal(request.args.comment_limit, 0)
const finished = finishPlatformItems(request, [{ ...row, raw: 'SECRET', cookie: 'SECRET' }]).items[0]
assert.deepEqual(finished.data.video_block, block)
assert(!Object.hasOwn(finished, 'video_block'), 'only typed public data carries the block')
validateCommunity(COMMUNITY_OUTPUT, { schema_version: 1, status: 'partial', results: 1, items: [{ ...finished, platform: 'bilibili', provider: 'bilibili-native', backend: 'fixture', retrieval_mode: 'native' }], channels: [], warnings: [], took_ms: 0 })
const fused = mergePlatformResults([], [{ ...finished, platform: 'bilibili', provider: 'bilibili-native', backend: 'fixture', retrieval_mode: 'native', engineRanks: { 'community-bilibili-native': 1 } }], { query: 'Claude', effectiveWeights: {}, platforms: ['bilibili'], requests: [request] })
assert(fused.results[0].content.endsWith(bvid))
assert.deepEqual(fusedHitToJson(fused.results[0]).community_data.video_block, block)

assert(allowedNativeRequest('xiaohongshu', 'https://edith.xiaohongshu.com/api/sns/web/v1/feed', 'POST'))
assert(!allowedNativeRequest('xiaohongshu', 'https://edith.xiaohongshu.com/api/sns/web/v1/note/like', 'POST'))
assert(allowedNativeRequest('bilibili', 'https://api.bilibili.com/x/note/publish/info?cvid=1'))
assert(!allowedNativeRequest('bilibili', 'https://bilibili.com.evil.example/x/note/publish/info'))
assert(!allowedNativeRequest('zhihu', 'http://www.zhihu.com/'))
assert(!allowedNativeRequest('zhihu', 'https://www.zhihu.com:444/'))
const makeRoute = (url, method = 'GET') => {
  const observation = { aborts: 0, fulfills: [] }
  return { observation, request: () => ({ url: () => url, method: () => method, resourceType: () => 'document', allHeaders: async () => ({ 'proxy-authorization': 'SECRET', cookie: 'wrong-origin', host: 'ignored' }), postDataBuffer: () => method === 'POST' ? Buffer.from('{}') : null }),
    abort: async () => observation.aborts++, fulfill: async body => observation.fulfills.push(body) }
}
let hop
const route = makeRoute('https://www.zhihu.com/search?q=Claude')
await fulfillNativeRequest(route, { env: {}, allow: () => true, validateUrl: async () => ({ validatedAddresses: [{ address: '93.184.216.34', family: 4 }] }),
  cookiesFor: async () => [{ name: 'auth', value: 'HTTPONLY' }],
  fetchHop: async (url, options) => { hop = options; return new Response('body', { headers: { 'set-cookie': 'auth=refreshed; HttpOnly; Secure' } }) } })
assert.equal(hop.headers.cookie, 'auth=HTTPONLY'); assert(!hop.headers['proxy-authorization'])
assert.equal(hop.allowDirectFallback, false); assert.deepEqual(hop.addresses, [{ address: '93.184.216.34', family: 4 }])
assert.equal(route.observation.fulfills[0].status, 200)
const redirected = makeRoute('https://www.zhihu.com/')
await assert.rejects(() => fulfillNativeRequest(redirected, { env: { HTTPS_PROXY: 'http://127.0.0.1:9999' }, allow: () => true, cookiesFor: async () => [],
  validateUrl: async () => { throw new Error('proxy target must not resolve locally') },
  fetchHop: async () => new Response('', { status: 302, headers: { location: 'http://127.0.0.1/private' } }) }), { kind: 'redirect_blocked' })
assert.equal(redirected.observation.fulfills.length, 0, 'never send a browser-controlled redirect')
const forbidden = makeRoute('https://example.invalid/')
await fulfillNativeRequest(forbidden, { allow: () => false, fetchHop: () => { throw new Error('must not fetch') } })
assert.equal(forbidden.observation.aborts, 1)
const dns = makeRoute('https://www.zhihu.com/')
await assert.rejects(() => fulfillNativeRequest(dns, { env: {}, allow: () => true, validateUrl: async () => { throw new Error('blocked address') }, fetchHop: () => { throw new Error('must not fetch') } }), /blocked address/)
const controller = new AbortController()
controller.abort()
await assert.rejects(() => fulfillNativeRequest(makeRoute('https://www.zhihu.com/'), { allow: () => true, signal: controller.signal }), { name: 'AbortError' })

const chromium = { launchPersistentContext: async (profile, options) => {
  assert(profile.startsWith(nativeHome('xiaohongshu'))); assert.equal(options.serviceWorkers, 'block')
  return { setDefaultTimeout() {}, routeWebSocket: async () => {}, route: async () => {}, cookies: async () => [],
    newPage: async () => ({ goto: async () => {}, close: async () => {} }), close: async () => {} }
} }
assert.equal(nativeSessionState('xiaohongshu'), null)
assert.equal(await initializeNativeSession('xiaohongshu', async () => true, { chromium }), true)
assert(nativeAvailability('xiaohongshu').ready)
const firstIdentity = communityCacheIdentity()
await initializeNativeSession('xiaohongshu', async () => true, { chromium })
assert.notEqual(communityCacheIdentity(), firstIdentity)
assert.equal(await withNativeSession('xiaohongshu', async () => 42, { chromium }), 42)
await assert.rejects(() => withNativeSession('xiaohongshu', async () => {
  await withNativeSession('xiaohongshu', async () => {}, { chromium })
}, { chromium }), { kind: 'session_busy' })
assert(!existsSync(join(nativeHome('xiaohongshu'), 'browser.lock')))
await assert.rejects(() => withNativeSession('xiaohongshu', async () => { throw new Error('SIGNED SECRET') }, { chromium }), error => !/SIGNED|SECRET/.test(error.message))
const aborted = new AbortController()
await assert.rejects(() => withNativeSession('xiaohongshu', async () => { aborted.abort(); return 42 }, { chromium, signal: aborted.signal }), { name: 'AbortError' })
assert(!existsSync(join(nativeHome('xiaohongshu'), 'browser.lock')))
const profile = join(nativeHome('xiaohongshu'), 'profile')
symlinkSync(join(root, 'outside'), join(profile, 'foreign'))
await assert.rejects(() => withNativeSession('xiaohongshu', async () => {}, { chromium }))
rmSync(join(profile, 'foreign'))
rmSync(profile, { recursive: true })
assert.equal(nativeSessionState('xiaohongshu'), null, 'deleted profile invalidates marker')
delete process.env.SEARCH_BOOST_BROWSER_EXECUTABLE
assert.equal(nativeAvailability('xiaohongshu').ready, false, 'installed library is not an installed browser')
process.env.SEARCH_BOOST_BROWSER_EXECUTABLE = executable

// Run the real provider/service/page projection with a deterministic browser facade.
mkdirSync(profile)
const fakePage = { goto: async () => ({ status: () => 200 }), waitForFunction: async () => {}, evaluate: async (_fn, arg) => arg ? note : [{ id, token: 'SIGNED' }] }
manageCommunityBackend({ action: 'register', id: 'xhs-fixture', provider: 'xiaohongshu-native', config: {} })
manageCommunityBackend({ action: 'update', id: 'xiaohongshu-default', enabled: false })
const output = await communitySearch({ engines: ['xiaohongshu'], query: 'Claude', max_results: 1 }, { nativeSession: async (_platform, work) => work({ newPage: async () => fakePage }), snapshot: () => ({ capability: {} }) })
assert.equal(output.results, 1); assert.equal(output.items[0].retrieval_mode, 'native')
assert.doesNotMatch(JSON.stringify(output), /SIGNED|SECRET|endpoint|cookie/)
const fusedNote = mergePlatformResults([], output.items, { query: 'Claude', effectiveWeights: {}, platforms: ['xiaohongshu'] }).results[0]
assert.equal(fusedHitToJson(fusedNote).content, note.desc)
assert.equal(fusedHitToJson(fusedNote).community_data.note_id, id)
const pages = createCommunityPages({ ttlMs: 5000 })
const first = pages.save(output, { pageSize: 1, persist: true })
const restored = await pages.restore(first.saved_result_id, 1)
assert.equal(restored.historical, true)
assert.deepEqual(restored.items[0].data, first.items[0].data)
rmSync(root, { recursive: true })
console.log('ok: integrated platform parsers, Bilibili note-first video blocks, typed fusion, private sessions, cookie forwarding, pinned/proxy transport and blocked redirects')
