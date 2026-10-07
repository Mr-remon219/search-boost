/** Runs in an isolated world. Fixed DOM reads only; never evaluate site instructions. */
export function extractCards(platform, limit) {
  const selectors = {
    bilibili: 'a[href*="/video/BV"]',
    zhihu: 'a[href*="/question/"],a[href*="zhuanlan.zhihu.com/p/"]',
    xiaohongshu: 'a[href*="/explore/"],a[href*="/discovery/item/"]',
  }
  const items = [], seen = new Set(), seenCards = new Set()
  for (const anchor of document.querySelectorAll(selectors[platform] ?? 'none')) {
    let url
    try { url = new URL(anchor.href); url.search = ''; url.hash = '' } catch { continue }
    if (seen.has(url.href)) continue
    const card = anchor.closest(platform === 'xiaohongshu' ? 'section' : platform === 'zhihu' ? '.ContentItem,.SearchResult-Card,.List-item' : '.bili-video-card,.video-item')
    if (!card || seenCards.has(card)) continue
    const title = (anchor.getAttribute('title') || anchor.textContent || card?.querySelector('h2,h3,.title,.ContentItem-title')?.textContent || '').trim()
    const text = (card?.textContent ?? title).replace(/\s+/g, ' ').trim().slice(0, 8000)
    if (!title && !text) continue
    seen.add(url.href); seenCards.add(card)
    items.push({ url: url.href, title: title.slice(0, 500), text, published: null, author: null })
    if (items.length >= limit) break
  }
  const blocked = !items.length && /验证码|安全验证|访问异常|请先登录|登录后查看|captcha|sign in to continue/i.test(document.body?.innerText ?? '')
  return { status: blocked ? 'blocked' : 'ok', items }
}
