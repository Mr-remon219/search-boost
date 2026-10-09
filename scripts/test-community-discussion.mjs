#!/usr/bin/env node
import './isolate-tests.mjs'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { xiaohongshuNativeProvider } from '../lib/community/providers/xiaohongshu-native.mjs'
import { zhihuDetail, zhihuNativeProvider } from '../lib/community/providers/zhihu-native.mjs'
import { createDiscussion, projectDiscussion } from '../lib/community/discussion.mjs'
import { observeDiscussion, collectXhsDiscussion, driveDiscussion } from '../lib/community/discussion-browser.mjs'
import { finishPlatformItems, normalizeCommunityInput } from '../lib/community/pipeline.mjs'
import { COMMUNITY_OUTPUT, validateCommunity } from '../lib/community/schemas.mjs'
import { createCommunityPages } from '../lib/community/pages.mjs'
import { mergePlatformResults } from '../lib/community/fusion.mjs'
import { fusedHitToJson } from '../lib/runtime.mjs'
import { DISCUSSION_SCHEMA } from '../lib/community/discussion-schema.mjs'
import { toDshSchema } from '../adapters/dsh/schema.js'
import { assertSupportedJsonSchema, validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'

const noteId = '69cf0679000000001d01ad1f', noteUrl = 'https://www.xiaohongshu.com/explore/' + noteId
const xurl = (cursor = '', root = null) => 'https://edith.xiaohongshu.com/api/sns/web/v2/comment/' + (root ? 'sub/page' : 'page') + '?' + new URLSearchParams({ note_id: noteId, cursor, xsec_token: 'SIGNED', ...(root ? { root_comment_id: root } : {}) })
const xcomment = (id, extra = {}) => ({ id, note_id: noteId, content: '评论 ' + id, user_info: { nickname: '作者', cookie: 'SECRET' }, create_time: Date.parse('2026-10-07T07:44:00Z'), sub_comment_count: 0, sub_comments: [], sub_comment_has_more: false, ...extra })
const first = xcomment('c1', { sub_comment_count: 2, sub_comment_has_more: true, sub_comment_cursor: 'reply-next', sub_comments: [xcomment('r1', { target_comment: { id: 'c1' } })] })
const x = createDiscussion('xiaohongshu', noteUrl)
x.seed({ note: { noteDetailMap: { [noteId]: { note: { interactInfo: { commentCount: '4' } } } } } })
x.receive(xurl(), { code: 0, data: { comments: [first], has_more: true, cursor: 'root-next' } })
assert.equal(x.snapshot().status, 'partial', 'first root page is not full comments')
x.receive(xurl('reply-next', 'c1'), { data: { comments: [xcomment('r2', { target_comment: { id: 'r1' } })], has_more: false, cursor: '' } })
assert.equal(x.snapshot().status, 'partial', 'complete replies do not complete root pagination')
x.receive(xurl('root-next'), { data: { comments: [xcomment('c2')], has_more: false, cursor: '' } })
const complete = x.snapshot()
assert.equal(complete.status, 'complete'); assert.equal(complete.comments.length, 4)
assert.equal(complete.comments.find(c => c.id === 'r2').parent_id, 'r1')
assert.doesNotMatch(JSON.stringify(complete), /SIGNED|SECRET|xsec_token|cursor/)
assert.deepEqual(projectDiscussion('xiaohongshu', complete, noteUrl), complete)
const noReply = createDiscussion('xiaohongshu', noteUrl)
noReply.receive(xurl(), { comments: [first], has_more: false, cursor: '' })
assert.equal(noReply.snapshot().status, 'partial', 'root end does not prove replies end')
const rounded = createDiscussion('xiaohongshu', noteUrl)
rounded.seed({ note: { noteDetailMap: { [noteId]: { note: { interactInfo: { commentCount: '1.2万' } } } } } })
rounded.receive(xurl(), { comments: [xcomment('c1')], has_more: false, cursor: '' })
assert.equal(rounded.snapshot().status, 'partial'); assert.equal(rounded.snapshot().stop_reason, 'count_unknown')
assert.equal(projectDiscussion('xiaohongshu', { ...rounded.snapshot(), status: 'complete', stop_reason: null }, noteUrl).status, 'partial')
const exactFormatted = createDiscussion('xiaohongshu', noteUrl)
exactFormatted.seed({ note: { noteDetailMap: { [noteId]: { note: { interactInfo: { commentCount: '1,024' } } } } } })
assert.equal(exactFormatted.snapshot().sections[0].expected_count, 1024, 'exact separators are not rounded counts')
const empty = createDiscussion('xiaohongshu', noteUrl)
empty.seed({ note: { noteDetailMap: { [noteId]: { note: { interactInfo: { commentCount: 0 } } } } } })
empty.receive(xurl(), { comments: [], has_more: false, cursor: '' })
assert.equal(empty.snapshot().status, 'complete')
const unknown = createDiscussion('xiaohongshu', noteUrl)
unknown.receive(xurl(), { comments: [] })
assert.equal(unknown.snapshot().status, 'partial'); assert.equal(unknown.snapshot().stop_reason, 'response_invalid')
const cycle = createDiscussion('xiaohongshu', noteUrl)
cycle.receive(xurl('same'), { comments: [xcomment('c1')], has_more: true, cursor: 'same' })
assert.equal(cycle.snapshot().status, 'partial'); assert(cycle.snapshot().comments.length > 0, 'valid partial content survives a bad cursor')
const skipped = createDiscussion('xiaohongshu', noteUrl)
skipped.receive(xurl('unobserved-prefix'), { comments: [xcomment('c1')], has_more: false, cursor: '' })
assert.equal(skipped.snapshot().status, 'partial', 'a last page without the first page is incomplete')
const denied = createDiscussion('xiaohongshu', noteUrl)
denied.receive(xurl(), { code: 300011, success: false, message: 'SECRET' })
assert.equal(denied.snapshot().stop_reason, 'access_denied'); assert.doesNotMatch(JSON.stringify(denied.snapshot()), /SECRET/)
const capacity = createDiscussion('xiaohongshu', noteUrl, { maxBytes: 800 })
capacity.receive(xurl(), { comments: [xcomment('c1'), xcomment('c2')], has_more: false, cursor: '' })
assert.equal(capacity.snapshot().status, 'partial'); assert.equal(capacity.snapshot().stop_reason, 'capacity')
assert.equal(capacity.snapshot().comments.length, 1, 'capacity stops explicitly, never silently clips complete rows')
const pageLimit = createDiscussion('xiaohongshu', noteUrl, { maxPages: 1 })
pageLimit.receive(xurl(), { comments: [xcomment('c1')], has_more: true, cursor: 'next' })
pageLimit.receive(xurl('next'), { comments: [xcomment('c2')], has_more: false, cursor: '' })
assert.equal(pageLimit.snapshot().stop_reason, 'page_limit')

const qid = '123', questionUrl = 'https://www.zhihu.com/question/' + qid
const answer = (id, comments = 0) => ({ id, question: { id: 123, title: '问题' }, content: '<p>' + '完整回答'.repeat(3000) + '</p>', created_time: 1791359040, author: { name: '回答作者' }, comment_count: comments })
const q = createDiscussion('zhihu', questionUrl + '/answer/456')
q.seed({ initialState: { entities: { questions: { '123': { id: 123, title: '问题', detail: '<p>问题详情</p>', created: 1791359040, answerCount: 2, commentCount: 1 } }, answers: { '456': answer(456, 3) } } } }, { detailUrl: questionUrl + '/answer/456' })
q.seed({ entities: { answers: { '456': { ...answer(456, 0), content: '稀疏摘要' } } } })
assert.equal(q.snapshot().entities.find(row => row.id === '456').expected_comments, 3, 'sparse zero cannot erase known comments')
assert.equal(q.snapshot().entities.find(row => row.id === '456').text.length, '完整回答'.repeat(3000).length)
assert.equal(q.needsRead('answer', '456'), true, 'a zero update cannot mark the unread comment section complete')
const answerPage = offset => 'https://www.zhihu.com/api/v4/questions/123/answers?' + new URLSearchParams({ offset: String(offset), limit: offset ? '10' : '20' })
q.receive(answerPage(0), { data: [answer(456, 3)], paging: { is_end: false, next: answerPage(1) } })
q.receive(answerPage(1), { data: [answer(789)], paging: { is_end: true } })
q.seed({ entities: { answers: { '789': answer(789) } } }, { detailUrl: questionUrl + '/answer/789' })
assert(q.snapshot().entities.find(row => row.id === '456').text.length > 8000, 'thread bodies are not 8k display excerpts')
assert.equal(q.snapshot().entities.find(row => row.id === '789').body_complete, true)
const fromListOnly = createDiscussion('zhihu', questionUrl)
fromListOnly.seed({ entities: { questions: { '123': { id: 123, detail: '', answerCount: 1, commentCount: 0 } }, answers: { '456': answer(456) } } })
fromListOnly.receive(answerPage(0), { data: [answer(456)], paging: { is_end: true } })
assert.equal(fromListOnly.snapshot().status, 'partial', 'list content cannot verify an answer body')
fromListOnly.seed({ entities: { answers: { '456': { ...answer(456), content: '' } } } }, { detailUrl: questionUrl + '/answer/456' })
assert.equal(fromListOnly.snapshot().status, 'partial', 'an empty answer body is not verified')
fromListOnly.seed({ entities: { answers: { '456': answer(456) } } }, { detailUrl: questionUrl + '/answer/456' })
assert.equal(fromListOnly.snapshot().status, 'complete', 'own answer page can resolve a pending body')
const zcomment = (id, extra = {}) => ({ id, content: '<p>评论正文</p>', created_time: 1791359040, author: { name: '评论作者', cookie: 'SECRET' }, child_comment_count: 0, reply_comment_id: 0, ...extra })
const zroot = (kind, id, offset = '') => 'https://www.zhihu.com/api/v4/comment_v5/' + kind + 's/' + id + '/root_comment?' + new URLSearchParams({ offset, limit: '20' })
q.receive(zroot('question', '123'), { data: [zcomment('10')], paging: { is_end: true } })
q.receive(zroot('answer', '456'), { data: [zcomment('20', { child_comment_count: 2, child_comments: [zcomment('21', { reply_comment_id: 20 })] })], paging: { is_end: true } })
assert.equal(q.snapshot().status, 'partial', 'all answers and root comments still miss a reply')
const zchild = offset => 'https://www.zhihu.com/api/v4/comment_v5/comment/20/child_comment?' + new URLSearchParams({ offset, limit: '10' })
q.receive(zchild(''), { data: [zcomment('21', { reply_comment_id: 20 }), zcomment('22', { reply_comment_id: 21 })], paging: { is_end: false, next: zchild('2') } })
q.receive(zchild('2'), { data: [], paging: { is_end: true } })
const fullQuestion = q.snapshot()
assert.equal(fullQuestion.status, 'complete'); assert.equal(fullQuestion.entities.filter(row => row.kind === 'answer').length, 2)
assert.equal(fullQuestion.comments.length, 4)
assert.equal(fullQuestion.comments.find(row => row.id === '22').parent_id, '21')
assert.doesNotMatch(JSON.stringify(fullQuestion), /SECRET|paging|cursor/)
assert.deepEqual(projectDiscussion('zhihu', fullQuestion, questionUrl + '/answer/456'), fullQuestion)
const changed = structuredClone(fullQuestion)
changed.comments.pop()
assert.equal(projectDiscussion('zhihu', changed, questionUrl).status, 'partial', 'projection recomputes retained section counts')
const missingPart = structuredClone(fullQuestion)
missingPart.sections = missingPart.sections.filter(part => part.kind !== 'replies')
assert.equal(projectDiscussion('zhihu', missingPart, questionUrl).status, 'partial')
const foreign = createDiscussion('zhihu', questionUrl)
foreign.seed({ initialState: { entities: { answers: { bad: { ...answer(999), question: { id: 777 } } } } } })
assert.equal(foreign.snapshot().entities.length, 0)
assert.equal(foreign.snapshot().status, 'partial')
const urlEscape = createDiscussion('zhihu', questionUrl)
urlEscape.receive(answerPage(0), { data: [answer(456)], paging: { is_end: false, next: 'https://evil.example/api/v4/questions/123/answers?offset=1' } })
assert.equal(urlEscape.snapshot().stop_reason, 'identity_mismatch')
const qempty = createDiscussion('zhihu', questionUrl)
qempty.seed({ initialState: { entities: { questions: { '123': { id: 123, title: '空问题', detail: '', answerCount: 0, commentCount: 0 } } } } })
assert.equal(qempty.snapshot().status, 'complete', 'explicit zero counts are verified empty collections')
assert.equal(zhihuDetail(questionUrl, { entities: { questions: { '123': { id: 123, detail: '', title: '只有标题的问题' } } } }).text, '只有标题的问题')
const gatedBody = createDiscussion('zhihu', questionUrl)
gatedBody.seed({ initialState: { entities: { questions: { '123': { id: 123, title: '问题', detail: '', answerCount: 1, commentCount: 0 } }, answers: { '456': { ...answer(456), content: undefined } } } } })
assert.equal(gatedBody.snapshot().stop_reason, 'content_unavailable')

const emitter = new EventEmitter()
const observed = createDiscussion('xiaohongshu', noteUrl)
observed.seed({ note: { noteDetailMap: { [noteId]: { note: { interactInfo: { commentCount: 1 } } } } } })
const observer = observeDiscussion(emitter, 'xiaohongshu', observed)
emitter.emit('response', { url: () => xurl(), status: () => 200, body: async () => Buffer.from(JSON.stringify({ comments: [xcomment('c1')], has_more: false, cursor: '' })) })
await observer.flush()
assert.equal(observed.snapshot().status, 'complete')
observer.close(); assert.equal(emitter.listenerCount('response'), 0)
const localFailure = createDiscussion('zhihu', questionUrl)
localFailure.seed({ entities: { questions: { '123': { id: 123, detail: '', answerCount: 2, commentCount: 0 } }, answers: { '456': answer(456, 1), '789': answer(789, 1) } } }, { detailUrl: questionUrl + '/answer/456' })
localFailure.seed({ entities: { answers: { '789': answer(789, 1) } } }, { detailUrl: questionUrl + '/answer/789' })
localFailure.receive(answerPage(0), { data: [answer(456, 1), answer(789, 1)], paging: { is_end: true } })
const unavailableToggle = { count: async () => 0, first() { return this }, filter() { return this } }
await driveDiscussion({ waitForResponse: async () => null, locator: () => unavailableToggle }, 'zhihu', localFailure, { flush: async () => {} }, { kind: 'answer', id: '456' })
assert.equal(localFailure.stopped, false, 'a missing control must not globally stop the question')
assert.equal(localFailure.needsRead('answer', '789'), true)
localFailure.receive(zroot('answer', '789'), { data: [zcomment('31')], paging: { is_end: true } })
assert(localFailure.snapshot().comments.some(row => row.entity_id === '789'))
assert.equal(localFailure.snapshot().sections.find(row => row.entity_id === '456').stop_reason, 'driver_unavailable')
const throwingJournal = createDiscussion('zhihu', questionUrl)
throwingJournal.seed({ entities: { questions: { '123': { id: 123, detail: '', answerCount: 1, commentCount: 0 } }, answers: { '456': answer(456, 1) } } }, { detailUrl: questionUrl + '/answer/456' })
let clickAttempts = 0
const throwingToggle = { ...unavailableToggle, count: async () => 1, isVisible: async () => true, click: async () => { clickAttempts++; throw new Error('selector changed SECRET') } }
await driveDiscussion({ waitForResponse: async () => null, locator: () => throwingToggle }, 'zhihu', throwingJournal, { flush: async () => {} }, { kind: 'answer', id: '456' })
assert.equal(clickAttempts, 1)
assert.equal(throwingJournal.stopped, false)
assert.equal(throwingJournal.snapshot().stop_reason, 'driver_unavailable')
assert.doesNotMatch(JSON.stringify(throwingJournal.snapshot()), /SECRET/)

const scrollJournal = createDiscussion('xiaohongshu', noteUrl)
scrollJournal.seed({ note: { noteDetailMap: { [noteId]: { note: { interactInfo: { commentCount: 2 } } } } } })
scrollJournal.receive(xurl(), { comments: [xcomment('c1')], has_more: true, cursor: 'next' })
const scrollPage = new EventEmitter(), scrollObserver = observeDiscussion(scrollPage, 'xiaohongshu', scrollJournal)
scrollPage.waitForResponse = async () => null
scrollPage.locator = () => unavailableToggle
scrollPage.evaluate = (fn, arg) => fn(arg)
let secondScrolled = false, windowScrolled = false, position = 0
const firstContainer = { scrollHeight: 100, clientHeight: 10, get scrollTop() { return 0 }, set scrollTop(_value) {} }
const secondContainer = { scrollHeight: 100, clientHeight: 10, get scrollTop() { return position }, set scrollTop(value) {
  position = value; secondScrolled = true
  scrollPage.emit('response', { url: () => xurl('next'), status: () => 200, body: async () => Buffer.from(JSON.stringify({ comments: [xcomment('c2')], has_more: false, cursor: '' })) })
} }
const oldDocument = globalThis.document, oldWindow = globalThis.window
try {
  globalThis.document = { querySelectorAll: selector => selector === '.note-scroller' ? [firstContainer] : [secondContainer], documentElement: { scrollHeight: 100 } }
  globalThis.window = { scrollY: 0, scrollTo: () => { windowScrolled = true } }
  await driveDiscussion(scrollPage, 'xiaohongshu', scrollJournal, scrollObserver, { kind: 'note', id: noteId })
} finally { globalThis.document = oldDocument; globalThis.window = oldWindow; scrollObserver.close() }
assert(secondScrolled && windowScrolled, 'a non-paginating first wrapper cannot prevent the real scrollers/fallback')
assert.equal(scrollJournal.snapshot().status, 'complete')

const incomplete = createDiscussion('xiaohongshu', noteUrl)
const fakeObserver = { flush: async () => {} }
const timed = await collectXhsDiscussion({}, incomplete, fakeObserver, { discussionDriver: async (_p, _platform, journal) => journal.fail('deadline') })
assert.equal(timed.status, 'partial'); assert.equal(timed.stop_reason, 'deadline')
const abort = new AbortController(); abort.abort()
await assert.rejects(() => collectXhsDiscussion({}, createDiscussion('xiaohongshu', noteUrl), fakeObserver, { signal: abort.signal, discussionDriver: async () => { throw new Error('closed') } }), { name: 'AbortError' })

const request = normalizeCommunityInput({ engines: ['zhihu'], query: '问题', platform_options: { zhihu: { content_type: 'question' } } }).requests[0]
const raw = { url: questionUrl, title: '问题', text: '问题详情', published: '2026-10-07T07:44:00Z', discussion: fullQuestion, engineRanks: { 'community-zhihu-native': 1 } }
const item = { ...finishPlatformItems(request, [raw]).items[0], platform: 'zhihu', provider: 'zhihu-native', backend: 'fixture', retrieval_mode: 'native' }
assert.equal(item.data.discussion.status, 'complete')
assert(item.data.discussion.entities.find(row => row.id === '456').text.length > 8000)
const output = { schema_version: 1, status: 'partial', results: 1, items: [item], channels: [], warnings: [], took_ms: 0 }
validateCommunity(COMMUNITY_OUTPUT, output)
const translated = toDshSchema(DISCUSSION_SCHEMA)
assertSupportedJsonSchema(translated)
validateJsonSchemaValue(translated, item.data.discussion)
const fused = mergePlatformResults([], [item], { query: '问题', effectiveWeights: {}, platforms: ['zhihu'], requests: [request] }).results[0]
assert.deepEqual(fusedHitToJson(fused).community_data.discussion, item.data.discussion)
// Exercise provider orchestration, not just the evidence accumulator.
class FixturePage extends EventEmitter {
  async goto(url) { this.url = url }
  async waitForFunction() {}
  async close() {}
  async evaluate() {
    if (this.url?.includes('/search_result')) return [{ id: noteId, token: 'SIGNED' }]
    if (this.url?.includes('/explore/')) return { noteId, title: '笔记', desc: '实际主体', time: 1791359040000, user: { nickname: '作者' }, interactInfo: { commentCount: 4 }, comments: { list: [first], hasMore: true, cursor: 'root-next' } }
    if (this.url?.includes('/search?')) return [{ url: questionUrl + '/answer/456' }, { url: questionUrl + '/answer/789' }]
    return { initialState: { entities: { questions: { '123': { id: 123, title: '问题', detail: '问题详情', created: 1791359040, answerCount: 2, commentCount: 1 } }, answers: { '456': answer(456, 3), '789': answer(789) } } } }
  }
}
const emit = (page, url, body) => page.emit('response', { url: () => url, status: () => 200, body: async () => Buffer.from(JSON.stringify(body)) })
const fixturePages = [], browser = { newPage: async () => { const page = new FixturePage(); fixturePages.push(page); return page } }
const nativeSession = async (_platform, callback) => callback(browser)
const noteResults = await xiaohongshuNativeProvider.search({ query: '笔记', max_results: 1 }, {
  nativeSession, filters: { from: null, to: null }, discussionDriver: async (page, _platform, _journal, watch) => {
    emit(page, xurl('reply-next', 'c1'), { comments: [xcomment('r2', { target_comment: { id: 'r1' } })], has_more: false, cursor: '' })
    await watch.flush()
    emit(page, xurl('root-next'), { comments: [xcomment('c2')], has_more: false, cursor: '' })
    await watch.flush()
  },
})
assert.equal(noteResults.items[0].discussion.status, 'complete')
assert.equal(noteResults.items[0].discussion.comments.length, 4)
let threadTraversals = 0
const questionResults = await zhihuNativeProvider.search({ query: '问题', max_results: 2 }, {
  nativeSession, filters: request.filters, discussionDriver: async (page, _platform, _journal, watch, scope) => {
    if (scope.answers) {
      threadTraversals++
      emit(page, answerPage(0), { data: [answer(456, 3)], paging: { is_end: false, next: answerPage(1) } }); await watch.flush()
      emit(page, answerPage(1), { data: [answer(789)], paging: { is_end: true } })
    } else if (scope.kind === 'question') emit(page, zroot('question', '123'), { data: [zcomment('10')], paging: { is_end: true } })
    else if (scope.id === '456') {
      emit(page, zroot('answer', '456'), { data: [zcomment('20', { child_comment_count: 2 })], paging: { is_end: true } }); await watch.flush()
      emit(page, zchild(''), { data: [zcomment('21', { reply_comment_id: 20 }), zcomment('22', { reply_comment_id: 21 })], paging: { is_end: true } })
    }
    await watch.flush()
  },
})
assert.equal(questionResults.items.length, 1, 'answer search hits resolve to one unique question when requested')
assert.equal(questionResults.items[0].url, questionUrl)
assert.equal(questionResults.items[0].discussion.status, 'complete')
assert.equal(threadTraversals, 1)
assert.equal(questionResults.items[0].discussion.entities.filter(row => row.kind === 'answer').length, 2)
assert(fixturePages.every(page => page.listenerCount('response') === 0), 'all discussion observers detach')
assert.doesNotMatch(JSON.stringify([noteResults, questionResults]), /SIGNED|SECRET|xsec_token/)

const pages = createCommunityPages()
const saved = pages.save(output, { pageSize: 1, persist: true })
const restored = pages.restore(saved.saved_result_id, 1)
assert.deepEqual(restored.items[0].data.discussion, item.data.discussion)
assert.equal(restored.historical, true)
console.log('ok: full accessible comment/reply and question/answer graphs, terminal/count/identity guards, no silent clipping, private observation, typed fusion and zero-network snapshots')
