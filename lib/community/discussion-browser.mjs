import { createDiscussion, discussionByteLimit } from './discussion.mjs'
import { navigate } from './native-reader.mjs'

function relevant(journal, platform, value) {
  let url
  try { url = new URL(value) } catch { return false }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return false
  const target = journal.target
  if (platform === 'xiaohongshu') return url.hostname === 'edith.xiaohongshu.com' && ['/api/sns/web/v2/comment/page', '/api/sns/web/v2/comment/sub/page'].includes(url.pathname) && url.searchParams.get('note_id') === target.id
  if (url.hostname !== 'www.zhihu.com') return false
  if (target.kind === 'question' && new RegExp('^/api/v4/questions/' + target.id + '(?:/(?:answers|feeds))?$').test(url.pathname)) return true
  const root = /^\/api\/v4\/comment_v5\/(questions|answers|articles)\/(\d+)\/root_comment$/.exec(url.pathname)
  const child = /^\/api\/v4\/comment_v5\/comment\/(\d+)\/child_comment$/.exec(url.pathname)
  const current = journal.snapshot()
  if (root) {
    const kind = { questions: 'question', answers: 'answer', articles: 'article' }[root[1]]
    return kind === target.kind && root[2] === target.id || current.entities.some(row => row.kind === kind && row.id === root[2])
  }
  return Boolean(child && current.comments.some(row => row.id === child[1] && row.parent_id === null))
}
export function observeDiscussion(page, platform, journal) {
  let pending = Promise.resolve()
  const listener = response => {
    if (!relevant(journal, platform, response.url()) || journal.stopped) return
    pending = pending.then(async () => {
      if (journal.stopped) return
      if (response.status() !== 200) { journal.fail('access_denied'); return }
      const body = await response.body()
      if (body.byteLength > 2_000_000) { journal.fail('capacity'); return }
      journal.receive(response.url(), JSON.parse(Buffer.from(body).toString('utf8')))
    }).catch(() => journal.fail('response_invalid'))
  }
  if (typeof page.on !== 'function') { journal.fail('driver_unavailable'); return { flush: async () => {}, close() {} } }
  page.on('response', listener)
  return { flush: () => pending, close: () => page.off('response', listener), matches: response => relevant(journal, platform, response.url()) }
}
const unfinished = (journal, kind, id, answers = false) => journal.needsRead(kind, id, answers)
async function readState(page) {
  return page.evaluate(() => {
    const script = document.getElementById('js-initialData')
    return script ? JSON.parse(script.textContent) : null
  })
}
async function scrollReadOnly(page, platform, answers) {
  return page.evaluate(({ platform, answers }) => {
    const selectors = platform === 'xiaohongshu' ? ['.note-scroller', '.comments-container']
      : answers ? ['.Question-main', '.QuestionAnswers-answers'] : ['.CommentListV2', '.Comments-container', '.CommentsV2', '[role="dialog"]']
    let moved = false
    for (const selector of selectors) {
      for (const node of document.querySelectorAll(selector)) {
        if (node.scrollHeight <= node.clientHeight) continue
        const before = node.scrollTop
        node.scrollTop = node.scrollHeight
        moved ||= before !== node.scrollTop
      }
    }
    const before = window.scrollY
    window.scrollTo(0, document.documentElement.scrollHeight)
    return moved || before !== window.scrollY
  }, { platform, answers })
}
/** Trigger ordinary read controls; observe authentic site-signed requests, never forge signatures. */
export async function driveDiscussion(page, platform, journal, observer, { kind, id, answers = false, signal, deadline = Date.now() + 60_000 } = {}) {
  if (typeof page.waitForResponse !== 'function' || typeof page.locator !== 'function') { journal.fail('driver_unavailable'); return }
  let stalled = 0
  if (!answers && platform === 'zhihu' && unfinished(journal, kind, id)) {
    const controls = kind === 'question' ? '.QuestionHeader-actions button' : '.ContentItem-actions button'
    try {
      const toggle = page.locator(controls).filter({ hasText: /^(?:\d+\s*(?:条)?\s*评论|评论|添加评论|查看.*评论)$/ }).first()
      if (await toggle.count() && await toggle.isVisible()) await toggle.click({ timeout: 3000 })
      else { journal.failEntity(kind, id, 'driver_unavailable'); return }
    } catch { signal?.throwIfAborted(); journal.failEntity(kind, id, 'driver_unavailable'); return }
  }
  for (let attempts = 0; attempts < 200 && !journal.stopped; attempts++) {
    signal?.throwIfAborted()
    await observer.flush()
    if (!unfinished(journal, kind, id, answers)) return
    if (Date.now() >= deadline) { journal.fail('deadline'); return }
    // Subscribe before the action, otherwise a fast first/next page is lost.
    const response = page.waitForResponse(observer.matches, { timeout: Math.min(4000, Math.max(1, deadline - Date.now())) }).catch(() => null)
    let clicked = false
    if (!answers) {
      const more = platform === 'xiaohongshu' ? page.locator('.comments-container .show-more:visible').filter({ hasText: /^展开\s*(?:\d+\s*条|更多)回复$/ })
        : page.locator('.Comments-container button:visible, .CommentsV2 button:visible, .CommentListV2 button:visible, [role="dialog"] button:visible').filter({ hasText: /^(?:查看全部\s*\d*\s*条?回复|展开(?:更多|全部)?回复|加载更多|查看更多回复)$/ })
      try {
        if (await more.count()) { await more.first().click({ timeout: 3000 }); clicked = true }
      } catch { signal?.throwIfAborted(); await response; journal.failEntity(kind, id, 'driver_unavailable'); return }
    }
    if (!clicked) await scrollReadOnly(page, platform, answers)
    const received = await response
    await observer.flush()
    if (answers && !received) {
      const end = page.locator('.QuestionAnswers-answers .List-end:visible, .Question-main .List-end:visible').filter({ hasText: /^(?:没有更多回答|没有更多了|已经没有更多回答|暂时还没有回答)$/ })
      if (await end.count()) journal.confirmAnswersEnd()
    }
    if (!unfinished(journal, kind, id, answers)) return
    stalled = received ? 0 : stalled + 1
    if (stalled >= 3) { journal.failEntity(kind, id, 'stalled', answers); return }
  }
  if (!journal.stopped && unfinished(journal, kind, id, answers)) journal.fail('page_limit')
}
export async function collectXhsDiscussion(page, journal, observer, context) {
  try {
    const drive = context.discussionDriver ?? driveDiscussion
    await drive(page, 'xiaohongshu', journal, observer, { kind: 'note', id: journal.target.id, signal: context.signal, deadline: Math.min(context.deadline ?? Infinity, Date.now() + 60_000) })
  } catch { context.signal?.throwIfAborted(); journal.fail('access_denied') }
  await observer.flush()
  return journal.snapshot()
}
export async function collectZhihuDiscussion(browser, journal, context) {
  const target = journal.target, page = await browser.newPage()
  const observer = observeDiscussion(page, 'zhihu', journal)
  const deadline = Math.min(context.deadline ?? Infinity, Date.now() + 60_000)
  const drive = context.discussionDriver ?? driveDiscussion
  try {
    await navigate(page, target.url, context.signal)
    journal.seed(await readState(page), { detailUrl: target.url }); await observer.flush()
    if (target.kind === 'question') await drive(page, 'zhihu', journal, observer, { kind: 'question', id: target.id, answers: true, signal: context.signal, deadline })
    if (!journal.stopped) await drive(page, 'zhihu', journal, observer, { kind: target.kind, id: target.id, signal: context.signal, deadline })
    if (target.kind === 'question' && !journal.stopped) {
      for (const answer of journal.snapshot().entities.filter(row => row.kind === 'answer')) {
        if (answer.body_complete && !unfinished(journal, 'answer', answer.id)) continue
        if (Date.now() >= deadline) { journal.fail('deadline'); break }
        await navigate(page, answer.url, context.signal)
        journal.seed(await readState(page), { detailUrl: answer.url }); await observer.flush()
        if (!journal.snapshot().entities.find(row => row.kind === 'answer' && row.id === answer.id)?.body_complete) { journal.failEntity('answer', answer.id, 'content_unavailable'); continue }
        await drive(page, 'zhihu', journal, observer, { kind: 'answer', id: answer.id, signal: context.signal, deadline })
        if (journal.stopped) break
      }
    }
  } catch { context.signal?.throwIfAborted(); journal.fail('access_denied') }
  finally { await observer.flush(); observer.close(); await page.close().catch(() => {}) }
  return journal.snapshot()
}
export const newDiscussion = (platform, url, args) => createDiscussion(platform, url, { maxBytes: discussionByteLimit(args.max_results), maxPages: 200 })
