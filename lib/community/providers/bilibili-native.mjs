import { integratedProvider, searchLinks, nativeJson, navigate, plainText, unixTime, nativeDateMatches } from '../native-reader.mjs'
import { nativeAvailability } from '../native-session.mjs'
import { collectVideoBlock, publicNoteText } from '../bilibili-block.mjs'
import { platformUrl } from '../selection.mjs'

export function bilibiliOpus(url, item) {
  const id = /\/opus\/(\d+)/.exec(url)?.[1]
  if (!id || item?.id_str !== id) return null
  const author = item.modules?.module_author, dynamic = item.modules?.module_dynamic
  const opus = dynamic?.major?.opus
  const text = plainText(opus?.summary?.text ?? dynamic?.desc?.text)
  if (!text) return null
  return { url: platformUrl('bilibili', url), title: plainText(opus?.title ?? text.slice(0, 80), 500), text, author: plainText(author?.name, 200) || null,
    published: unixTime(author?.pub_ts), coverage: 'Opus dynamic text/summary; images and expanded opus body not transcribed' }
}
async function read(args, context, browser) {
  const searchPage = await browser.newPage(), items = [], warnings = []
  const max = Math.min(10, args.max_results ?? 5), kind = context.filters?.contentType
  const get = url => nativeJson(browser, url, context.signal)
  const query = new URLSearchParams({ keyword: args.query })
  let candidates = []
  if (!kind || kind === 'article') candidates.push(...await searchLinks(searchPage, 'bilibili', 'https://search.bilibili.com/article?' + query, context.signal))
  if (!kind || kind === 'video') candidates.push(...await searchLinks(searchPage, 'bilibili', 'https://search.bilibili.com/video?' + query, context.signal))
  // Global Opus discovery is indexed; detail retrieval is native and labelled as such.
  if ((!kind || kind === 'post') && context.webSearch) {
    const indexed = await context.webSearch({ query: args.query + ' site:www.bilibili.com/opus/', include_domains: ['bilibili.com'], max_results: max })
    for (const row of indexed.results ?? indexed ?? []) if (platformUrl('bilibili', row.url)?.includes('/opus/')) candidates.push(row)
    warnings.push('Opus discovery uses Web index; the verified detail text is native, coverage is mixed')
  }
  const seen = new Set()
  let requests = 0, stopped = false, accepted = 0
  for (const candidate of candidates) {
    const url = platformUrl('bilibili', candidate.url)
    if (!url || seen.has(url)) continue
    seen.add(url); context.signal?.throwIfAborted()
    if (accepted >= max || requests >= Math.min(30, max * 3)) break
    requests++
    try {
      let item
      const bvid = /\/video\/(BV[0-9A-Za-z]{10})/.exec(url)?.[1], cvid = /\/read\/cv(\d+)/.exec(url)?.[1]
      if (bvid) item = await collectVideoBlock(bvid, get, { signal: context.signal, filters: context.filters, noteLimit: args.note_limit ?? 3, commentLimit: args.comment_limit ?? 5 })
      else if (cvid) {
        const info = await get('https://api.bilibili.com/x/article/viewinfo?id=' + cvid)
        if ([41, 42].includes(info.category?.id)) {
          const detail = await get('https://api.bilibili.com/x/note/publish/info?cvid=' + cvid)
          if (String(detail.cvid) !== cvid || detail.pub_status !== 2) throw new Error('Public note identity changed')
          item = { url, title: plainText(detail.title, 500), text: publicNoteText(detail.content), author: plainText(detail.author?.name, 200) || null,
            published: unixTime(info.publish_time), coverage: 'public video-note text; no private notes or image OCR' }
        } else {
          const page = await browser.newPage()
          try {
            await navigate(page, url + '?jump_opus=1', context.signal)
            const text = await page.locator('.article-holder').innerText({ timeout: 15_000 })
            item = { url, title: plainText(info.title, 500), text: plainText(text), author: plainText(info.author_name, 200) || null, published: unixTime(info.publish_time),
              coverage: 'public column body; no private notes or image OCR' }
          } finally { await page.close().catch(() => {}) }
        }
      } else if (/\/opus\/\d+/.test(url)) {
        const id = /\/opus\/(\d+)/.exec(url)[1]
        const data = await get('https://api.bilibili.com/x/polymer/web-dynamic/v1/detail?' + new URLSearchParams({ id, features: 'itemOpusStyle', platform: 'web' }))
        item = bilibiliOpus(url, data.item)
      }
      if (item?.text) { items.push(item); if (nativeDateMatches(item.published, context.filters)) accepted++ }
      if (item?.stopped) { stopped = true; warnings.push('Video attachments unavailable; existing video block preserved, acquisition stopped without retry'); break }
    } catch { context.signal?.throwIfAborted(); stopped = true; warnings.push('Bilibili text/detail unavailable; stopped without retry or transcript substitution'); break }
  }
  return { items, warnings, stop_reason: stopped ? 'detail_unavailable' : undefined, diagnostics: { detail_requests: requests }, coverage: 'public column/note bodies; video blocks with bounded public notes and comments; Opus discovery may be indexed' }
}
export const bilibiliNativeProvider = { ...integratedProvider('bilibili', read), describeAvailability() { return nativeAvailability('bilibili') } }
