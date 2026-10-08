import { communityJson } from '../http.mjs'
import { platformUrl } from '../selection.mjs'

export const bilibiliPublicProvider = {
  id: 'bilibili-public', platform: 'bilibili', label: 'SearchBoost Bilibili public video API', version: 1,
  operations: ['keyword'], retrievalMode: 'native',
  validateConfig(config) {
    if (!config || typeof config !== 'object' || Array.isArray(config) || Object.keys(config).length) throw new Error('bilibili-public accepts an empty config only')
    return {}
  },
  describeAvailability() { return { ready: true, reason: 'Public endpoint configured; anti-bot/access failures remain possible' } },
  async search(args, context) {
    const url = new URL('https://api.bilibili.com/x/web-interface/search/type')
    url.search = new URLSearchParams({ search_type: 'video', keyword: args.query, page: '1', page_size: '20' }).toString()
    const doc = await communityJson(url, { signal: context.signal, fetchImpl: context.fetchImpl, headers: { Referer: 'https://www.bilibili.com/' } })
    if (doc.code !== 0) throw Object.assign(new Error('Bilibili public API refused the request'), { kind: [-101, -352, -412].includes(doc.code) ? 'access_denied' : 'http_error' })
    if (!Array.isArray(doc.data?.result)) throw new Error('Bilibili result shape changed')
    const items = doc.data.result.flatMap((row, i) => {
      const url = platformUrl('bilibili', row.arcurl ?? `https://www.bilibili.com/video/${row.bvid}`)
      if (!url) return []
      const published = Number.isFinite(row.pubdate) ? new Date(row.pubdate * 1000).toISOString() : null
      return [{ url, title: String(row.title ?? '').replace(/<[^>]*>/g, '').slice(0, 500), text: String(row.description ?? '').slice(0, 8000),
        author: String(row.author ?? '').slice(0, 200), published, content_type: 'video', engineRanks: { 'community-bilibili-public': i + 1 },
        provenance: [{ engine: 'community-bilibili-public', rank: i + 1, url, published }], coverage: 'first public API page; video search only' }]
    })
    return { via: 'native', items, enginesUsed: ['community-bilibili-public'], engineStats: { 'community-bilibili-public': { used: true, attempts: 1, successes: 1, errors: 0 } }, warnings: [] }
  },
}
