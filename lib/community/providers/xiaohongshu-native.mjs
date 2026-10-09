import { integratedProvider, navigate, plainText, unixTime, nativeDateMatches } from '../native-reader.mjs'
import { platformUrl } from '../selection.mjs'
import { nativeAvailability } from '../native-session.mjs'
import { newDiscussion, observeDiscussion, collectXhsDiscussion } from '../discussion-browser.mjs'

export function xhsNote(id, note) {
  if (!/^[a-f0-9]{24}$/i.test(id) || String(note?.noteId ?? note?.note_id ?? '') !== id) return null
  const text = plainText(note.desc)
  if (!text) return null
  return { url: platformUrl('xiaohongshu', 'https://www.xiaohongshu.com/explore/' + id), title: plainText(note.title, 500), text,
    author: plainText(note.user?.nickname, 200) || null, published: unixTime(note.time, true), coverage: 'note text and fully traversed accessible comments/replies when discussion.status is complete; no OCR/video transcript' }
}
async function read(args, context, browser) {
  const page = await browser.newPage(), items = [], warnings = []
  const search = new URL('https://www.xiaohongshu.com/search_result')
  search.search = new URLSearchParams({ keyword: args.query, source: 'web_explore_feed' })
  await navigate(page, search.href, context.signal)
  await page.waitForFunction(() => {
    const feeds = window.__INITIAL_STATE__?.search?.feeds
    return Array.isArray(feeds?.value ?? feeds?._value)
  }, { timeout: 15_000 })
  if (args.from_date || args.to_date) {
    const before = await page.evaluate(() => {
      const feeds = window.__INITIAL_STATE__.search.feeds
      return (feeds.value ?? feeds._value).map(row => row.id).join(',')
    })
    try {
      await page.locator('div.filter').hover({ timeout: 5000 })
      const group = page.locator('div.filter-panel div.filters').filter({ has: page.locator(':scope > span', { hasText: '排序依据' }) })
      await group.locator('div.tags:visible').filter({ hasText: /^最新$/ }).first().click({ timeout: 5000 })
      await page.waitForFunction(previous => {
        const feeds = window.__INITIAL_STATE__?.search?.feeds, rows = feeds?.value ?? feeds?._value
        return Array.isArray(rows) && rows.length > 0 && rows.map(row => row.id).join(',') !== previous
      }, before, { timeout: 15_000 })
    } catch {
      context.signal?.throwIfAborted()
      warnings.push('Latest ordering could not be verified; only exact detail dates determine inclusion, recent coverage may be incomplete')
    }
  }
  // Preserve signature only within this search/detail transaction.
  const candidates = await page.evaluate(() => {
    const feeds = window.__INITIAL_STATE__.search.feeds
    return (feeds.value ?? feeds._value).slice(0, 30).map(note => ({ id: note.id, token: note.xsecToken ?? note.xsec_token }))
  })
  const max = Math.min(10, args.max_results ?? 5)
  let requests = 0, invalid = 0, stopped = false, accepted = 0
  for (const candidate of candidates.slice(0, Math.min(30, max * 3))) {
    context.signal?.throwIfAborted()
    if (!/^[a-f0-9]{24}$/i.test(candidate.id) || typeof candidate.token !== 'string' || !candidate.token || candidate.token.length > 4096) { invalid++; continue }
    if (Date.now() + 30_000 >= (context.deadline ?? Infinity)) { stopped = true; warnings.push('Native query budget reached; collected notes retained'); break }
    const detail = new URL('https://www.xiaohongshu.com/explore/' + candidate.id)
    detail.search = new URLSearchParams({ xsec_token: candidate.token, xsec_source: 'pc_search' })
    const journal = newDiscussion('xiaohongshu', detail.href, args)
    const observer = observeDiscussion(page, 'xiaohongshu', journal)
    try {
      requests++
      await navigate(page, detail.href, context.signal)
      await page.waitForFunction(id => Boolean(window.__INITIAL_STATE__?.note?.noteDetailMap?.[id]?.note), candidate.id, { timeout: 15_000 })
      const row = await page.evaluate(id => {
        const note = window.__INITIAL_STATE__.note.noteDetailMap[id].note
        return { noteId: note.noteId ?? note.note_id, title: note.title, desc: note.desc, time: note.time, user: { nickname: note.user?.nickname }, interactInfo: { commentCount: note.interactInfo?.commentCount }, comments: window.__INITIAL_STATE__.note.noteDetailMap[id].comments }
      }, candidate.id)
      const item = xhsNote(candidate.id, row)
      if (item) {
        journal.seed({ note: { noteDetailMap: { [candidate.id]: { note: row, comments: row.comments } } } })
        const selected = nativeDateMatches(item.published, context.filters)
        if (selected) {
          item.discussion = await collectXhsDiscussion(page, journal, observer, context)
          accepted++
          if (item.discussion.status !== 'complete') warnings.push('Note comments/replies incomplete: ' + item.discussion.stop_reason)
        }
        items.push(item)
      } else invalid++
      if (accepted >= max) break
    } catch {
      context.signal?.throwIfAborted()
      stopped = true; warnings.push('Note detail unavailable; stopped without retry, login bypass or index fallback'); break
    } finally { await observer.flush(); observer.close() }
  }
  return { items, warnings, stop_reason: stopped ? 'detail_unavailable' : undefined, diagnostics: { detail_requests: requests, invalid_notes: invalid }, coverage: 'first station search page; exact note-id detail; publication verified from note time' }
}
export const xiaohongshuNativeProvider = { ...integratedProvider('xiaohongshu', read), version: 2, describeAvailability() { return nativeAvailability('xiaohongshu') } }
