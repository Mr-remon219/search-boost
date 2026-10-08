import { communityJson } from '../http.mjs'
import { platformUrl } from '../selection.mjs'

export function validateBrowserConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config) || Object.keys(config).some(k => !['endpoint', 'token_env'].includes(k))) throw new Error('Browser config accepts endpoint and token_env only')
  let url
  try { url = new URL(config.endpoint) } catch { throw new Error('A loopback browser bridge endpoint is required') }
  if (url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash || !['/', ''].includes(url.pathname)) throw new Error('Browser bridge must be a credential-free loopback HTTP origin')
  if (typeof config.token_env !== 'string' || !/^[A-Z][A-Z0-9_]{0,127}$/.test(config.token_env)) throw new Error('Browser token_env must name an environment variable, never contain the token itself')
  return { endpoint: url.origin, token_env: config.token_env }
}
export function browserProvider(platform) {
  return {
    id: `${platform}-browser`, platform, label: `SearchBoost ${platform} read-only browser bridge`, version: 1,
    operations: ['keyword'], retrievalMode: 'native', configFields: ['endpoint', 'token_env'], validateConfig: validateBrowserConfig,
    describeAvailability(_state, config = {}) {
      const ready = Boolean(config.token_env && process.env[config.token_env])
      return { ready, reason: ready ? 'Bridge and token configured, not a connectivity/session test' : 'Browser bridge token environment variable missing' }
    },
    async search(args, context) {
      const config = context.backendConfig, token = process.env[config.token_env]
      if (!token) throw new Error('Browser token unavailable')
      const response = await communityJson(`${config.endpoint}/search`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: { platform, query: args.query, max_results: Math.min(args.max_results, 50) }, signal: context.signal, fetchImpl: context.fetchImpl, timeout: 60_000 })
      if (response.status !== 'ok' || !Array.isArray(response.items) || response.items.length > 100) throw Object.assign(new Error('Browser bridge unavailable, blocked or session required'), { kind: 'access_denied' })
      const items = response.items.flatMap((row, i) => {
        const url = platformUrl(platform, row.url)
        if (!url || typeof row.title !== 'string' || typeof row.text !== 'string') return []
        const published = typeof row.published === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(row.published) && Number.isFinite(Date.parse(row.published)) ? new Date(row.published).toISOString() : null
        return [{ url, title: row.title.slice(0, 500), text: row.text.slice(0, 8000), author: typeof row.author === 'string' ? row.author.slice(0, 200) : null, published,
          content_type: platform === 'bilibili' ? 'video' : 'post', engineRanks: { [`community-${platform}-browser`]: i + 1 },
          provenance: [{ engine: `community-${platform}-browser`, rank: i + 1, url, published }], coverage: 'visible browser search cards; not full post/video/comment content' }]
      })
      return { via: 'browser', items, warnings: [], note: 'Visible search-card DOM; dates/author fields may be unavailable. Login or security challenges must be handled by the user.',
        enginesUsed: [`community-${platform}-browser`], engineStats: { [`community-${platform}-browser`]: { used: true, attempts: 1, successes: 1, errors: 0 } } }
    },
  }
}
