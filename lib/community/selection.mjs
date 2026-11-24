import { COMMUNITY_PLATFORMS } from './registry.mjs'

export const COMMUNITY_SELECTION_SCHEMA = Object.freeze({
  oneOf: [{ type: 'boolean' }, { type: 'array', maxItems: 5, uniqueItems: true, items: { type: 'string', enum: COMMUNITY_PLATFORMS } }],
  description: 'Selected community platforms: reddit, x, bilibili, zhihu, xiaohongshu. []/false disables; legacy true selects X only. Defaults false in fused_search. Selection never enables backends or relaxes domains.',
})
export function communityPlatforms(value = false) {
  if (typeof value === 'boolean') return value ? ['x'] : []
  if (!Array.isArray(value) || value.length > 5 || new Set(value).size !== value.length || value.some(p => !COMMUNITY_PLATFORMS.includes(p))) {
    throw new Error('community must be a boolean or a unique array of supported platform names')
  }
  return [...value]
}
export const PLATFORM_DOMAINS = Object.freeze({ x: ['x.com', 'twitter.com'], reddit: ['reddit.com'], bilibili: ['bilibili.com'], zhihu: ['zhihu.com'], xiaohongshu: ['xiaohongshu.com'] })

export function platformUrl(platform, value) {
  try {
    const url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null
    if (!PLATFORM_DOMAINS[platform]?.some(d => url.hostname === d || url.hostname.endsWith(`.${d}`))) return null
    if (platform === 'reddit' && !/\/comments\/[a-z0-9]+/i.test(url.pathname)) return null
    if (platform === 'bilibili' && !/\/(video\/BV[a-z0-9]+|opus\/\d+|read\/cv\d+)/i.test(url.pathname)) return null
    if (platform === 'zhihu' && !/\/(question\/\d+|p\/\d+)/.test(url.pathname)) return null
    if (platform === 'xiaohongshu' && !/\/(explore|discovery\/item)\/[a-z0-9]+/i.test(url.pathname)) return null
    url.hash = ''; url.search = ''; url.protocol = 'https:'
    return url.href
  } catch { return null }
}
