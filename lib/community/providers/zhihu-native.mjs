import { integratedProvider, navigate, searchLinks, plainText, unixTime, nativeDateMatches } from '../native-reader.mjs'
import { nativeAvailability } from '../native-session.mjs'
import { platformUrl } from '../selection.mjs'
import { newDiscussion, collectZhihuDiscussion } from '../discussion-browser.mjs'

export function zhihuDetail(url, state) {
  const safe = platformUrl('zhihu', url)
  if (!safe) return null
  const answer = /\/answer\/(\d+)/.exec(safe), article = /\/p\/(\d+)/.exec(safe), question = /\/question\/(\d+)/.exec(safe)
  const kind = answer ? 'answers' : article ? 'articles' : question ? 'questions' : null, id = answer?.[1] ?? article?.[1] ?? question?.[1]
  if (!kind) return null
  const entities = state?.initialState?.entities ?? state?.entities
  const row = entities?.[kind]?.[id]
  if (!row || String(row.id) !== id) return null
  const text = plainText(kind === 'questions' ? row.detail || row.title : row.content)
  if (!text) return null
  const user = typeof row.author === 'string' ? entities.users?.[row.author] : row.author
  return { url: safe, title: plainText(row.title ?? row.question?.title, 500), text, author: plainText(user?.name, 200) || null,
    published: unixTime(row.created_time ?? row.created), coverage: 'target body with accessible full question/answer/comment graph when discussion.status is complete' }
}
async function read(args, context, browser) {
  const page = await browser.newPage(), items = [], warnings = [], threads = new Map(), seen = new Set()
  const search = new URL('https://www.zhihu.com/search')
  search.search = new URLSearchParams({ type: 'content', q: args.query })
  const candidates = (await searchLinks(page, 'zhihu', search.href, context.signal)).filter(row => /\/question\/\d+|\/p\/\d+/.test(row.url))
  let requests = 0, stopped = false, accepted = 0
  for (const candidate of candidates.slice(0, Math.min(30, (args.max_results ?? 5) * 3))) {
    if (context.filters?.contentType === 'article' && !/\/p\//.test(candidate.url) || context.filters?.contentType === 'answer' && !/\/answer\//.test(candidate.url)) continue
    if (context.filters?.contentType === 'question' && /\/answer\//.test(candidate.url)) candidate.url = candidate.url.replace(/\/answer\/\d+$/, '')
    if (seen.has(candidate.url)) continue
    seen.add(candidate.url)
    if (Date.now() + 30_000 >= (context.deadline ?? Infinity)) { stopped = true; warnings.push('Native query budget reached; collected threads retained'); break }
    try {
      requests++
      await navigate(page, candidate.url, context.signal)
      const state = await page.evaluate(() => {
        const script = document.getElementById('js-initialData')
        return script ? JSON.parse(script.textContent) : null
      })
      const item = zhihuDetail(candidate.url, state)
      if (item) {
        if (nativeDateMatches(item.published, context.filters)) {
          const key = /\/question\/\d+/.exec(item.url)?.[0] ?? item.url
          if (!threads.has(key)) {
            const journal = newDiscussion('zhihu', item.url, args)
            journal.seed(state, { detailUrl: item.url })
            threads.set(key, await collectZhihuDiscussion(browser, journal, context))
          }
          item.discussion = threads.get(key)
          accepted++
          if (item.discussion.status !== 'complete') warnings.push('Zhihu question/article discussion incomplete: ' + item.discussion.stop_reason)
        }
        items.push(item)
      }
      else { stopped = true; warnings.push('Target content missing or access gated; no recommendation/welcome text substituted'); break }
      if (accepted >= Math.min(10, args.max_results ?? 5)) break
    } catch { context.signal?.throwIfAborted(); stopped = true; warnings.push('Question/answer/article detail unavailable; stopped without retry or index fallback'); break }
  }
  return { items, warnings, stop_reason: stopped ? 'detail_unavailable' : undefined, diagnostics: { detail_requests: requests }, coverage: 'visible first search page; exact question/answer/article details with explicit discussion completeness' }
}
export const zhihuNativeProvider = { ...integratedProvider('zhihu', read), version: 2, describeAvailability() { return nativeAvailability('zhihu') } }
