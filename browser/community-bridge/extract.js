/** Runs in an isolated world. Fixed DOM reads only; never evaluate site instructions. */
export function extractCards(platform, limit) {
  const selectors = {
    bilibili: 'a[href*="/video/BV"]',
    zhihu: 'a[href*="/question/"],a[href*="zhuanlan.zhihu.com/p/"]',
    xiaohongshu: 'a[href*="/explore/"],a[href*="/discovery/item/"]',
  }
  const visible = node => {
    if (!node || !node.getClientRects().length) return false
    for (let element = node; element; element = element.parentElement) {
      const style = getComputedStyle(element)
      if (element.hidden || element.inert || element.getAttribute('aria-hidden') === 'true' || style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || style.contentVisibility === 'hidden' || Number(style.opacity) === 0) return false
    }
    return [...node.getClientRects()].some(rect => rect.width > 0 && rect.height > 0)
  }
  const gateText = /验证码|安全验证|访问异常|请先登录|登录后查看|captcha|sign in to continue/i
  // Inspect actual visible gate containers BEFORE background cards. An ordinary
  // article discussing captchas is not a gate, even if its title matches.
  const gates = '.SignFlow,.login-panel,.login-modal,.login-dialog,.geetest_panel,.geetest_window,.captcha-container,.verify-dialog,.security-verification'
  if ([...document.querySelectorAll(gates)].some(visible) || [...document.querySelectorAll('[role="dialog"],[aria-modal="true"]')].some(node => visible(node) && gateText.test(node.innerText ?? ''))) return { status: 'blocked', items: [] }
  const items = [], seen = new Set(), seenCards = new Set()
  for (const anchor of document.querySelectorAll(selectors[platform] ?? 'none')) {
    let url
    try { url = new URL(anchor.href); url.search = ''; url.hash = '' } catch { continue }
    if (seen.has(url.href)) continue
    const card = anchor.closest(platform === 'xiaohongshu' ? 'section' : platform === 'zhihu' ? '.ContentItem,.SearchResult-Card,.List-item' : '.bili-video-card,.video-item')
    if (!card || seenCards.has(card) || !visible(card) || !visible(anchor)) continue
    const title = (anchor.getAttribute('title') || anchor.innerText || card.querySelector('h2,h3,.title,.ContentItem-title')?.innerText || '').trim()
    const text = (card.innerText ?? title).replace(/\s+/g, ' ').trim().slice(0, 8000)
    if (!title && !text) continue
    seen.add(url.href); seenCards.add(card)
    items.push({ url: url.href, title: title.slice(0, 500), text, published: null, author: null })
    if (items.length >= limit) break
  }
  const blocked = !items.length && gateText.test(document.body?.innerText ?? '')
  return { status: blocked ? 'blocked' : 'ok', items }
}
