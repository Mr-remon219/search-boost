import { PLATFORM_DOMAINS, platformUrl } from '../selection.mjs'

export function webIndexProvider(platform) {
  return {
    id: `${platform}-web`, platform, label: `SearchBoost ${platform} web-index adapter`, version: 1,
    operations: ['keyword'], retrievalMode: 'web-index',
    validateConfig(config) {
      if (!config || typeof config !== 'object' || Array.isArray(config) || Object.keys(config).length) throw new Error('Web-index adapter accepts an empty config only')
      return {}
    },
    describeAvailability({ availableEngines, x } = {}) {
      const ready = (availableEngines ?? x?.fallback?.webEngines ?? []).length > 0
      return { ready, reason: ready ? 'Public web-index candidates only; not a logged-in platform search' : 'No configured web engines' }
    },
    async search(args, context) {
      if (!context.webSearch) throw new Error('Web retrieval dependency missing')
      const hits = await context.webSearch({ query: args.query, maxResults: Math.min(50, Math.max(10, args.max_results * 3)), includeDomains: PLATFORM_DOMAINS[platform], signal: context.signal })
      const rows = Array.isArray(hits) ? hits : hits?.results ?? []
      const items = rows.flatMap((row, index) => {
        const url = platformUrl(platform, row.url)
        return url ? [{ ...row, url, text: String(row.snippet ?? row.description ?? row.text ?? '').slice(0, 8000),
          title: String(row.title ?? '').slice(0, 500), published: row.published ?? null,
          // Index author/display labels do not establish a native account identity.
          author: null,
          content_type: platform === 'bilibili' ? 'video' : 'post', engineRanks: row.engineRanks ?? { [`community-${platform}-web`]: index + 1 },
          provenance: row.provenance ?? [], coverage: 'web-index sample; no native or complete-platform coverage' }] : []
      })
      return { via: hits?.failed ? 'error' : 'web-index', items, engineStats: hits?.engineStats ?? {}, enginesUsed: [...new Set(items.flatMap(r => Object.keys(r.engineRanks)))],
        warnings: hits?.warnings ?? [], note: 'Indexed excerpts, not verified full content or platform-wide sentiment' }
    },
  }
}
