import { platformUrl } from './selection.mjs'
import { unavailableCommunityContent } from './content-quality.mjs'
import { withNativeSession } from './native-session.mjs'

export function plainText(value, limit = 8000) {
  return String(value ?? '').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<\/(?:p|div|li|h[1-6])\s*>|<br\s*\/?\s*>/gi, '\n').replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim().slice(0, limit)
}
export function unixTime(value, milliseconds = false) {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return null
  const ms = milliseconds ? n : n * 1000
  if (ms < Date.UTC(2000, 0, 1) || ms > Date.now() + 86400000) return null
  return new Date(ms).toISOString()
}
export function nativeDateMatches(published, filters = {}) {
  if (filters.from == null && filters.to == null) return true
  if (!published) return false
  const date = Date.parse(published)
  return Number.isFinite(date) && (filters.from == null || date >= filters.from) && (filters.to == null || date <= filters.to)
}
export async function navigate(page, url, signal) {
  signal?.throwIfAborted()
  const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 })
  signal?.throwIfAborted()
  if (response && response.status() >= 400) throw Object.assign(new Error('Platform page refused retrieval'), { kind: 'access_denied' })
}
export async function nativeJson(context, url, signal) {
  const page = await context.newPage()
  try {
    await navigate(page, url, signal)
    const body = await page.locator('body').innerText({ timeout: 10_000 })
    if (body.length > 2_000_000) throw Object.assign(new Error('Platform response too large'), { kind: 'response_too_large' })
    const doc = JSON.parse(body)
    if (doc.code !== undefined && doc.code !== 0) throw Object.assign(new Error('Platform API refused retrieval'), { kind: 'access_denied' })
    return doc.data ?? doc
  } finally { await page.close().catch(() => {}) }
}
export async function searchLinks(page, platform, url, signal) {
  await navigate(page, url, signal)
  await page.waitForFunction(() => document.querySelectorAll('a[href]').length > 10, undefined, { timeout: 15_000 })
  const links = await page.evaluate(() => [...document.querySelectorAll('a[href]')].map(a => ({ url: a.href, title: a.innerText })).slice(0, 400))
  const seen = new Set()
  return links.flatMap(row => {
    const safe = platformUrl(platform, row.url)
    if (!safe || seen.has(safe)) return []
    seen.add(safe)
    return [{ url: safe, title: plainText(row.title, 500) }]
  })
}
export function integratedProvider(platform, reader) {
  const id = platform + '-native', engine = 'community-' + id
  return {
    id, platform, label: 'SearchBoost integrated ' + platform + ' reader', version: 1, operations: ['keyword'], retrievalMode: 'native',
    validateConfig(config) {
      if (!config || Array.isArray(config) || typeof config !== 'object' || Object.keys(config).length) throw new Error(id + ' accepts an empty config only')
      return {}
    },
    describeAvailability(context) {
      return context.nativeAvailability?.(platform) ?? { ready: context.nativeReady?.includes(platform) === true, reason: 'Initialize the SearchBoost-owned session using community-login; no external server' }
    },
    async search(args, context) {
      const run = context.nativeSession ?? withNativeSession
      const signal = context.signal ? AbortSignal.any([context.signal, AbortSignal.timeout(120_000)]) : AbortSignal.timeout(120_000)
      return run(platform, async browser => {
        const result = await reader(args, { ...context, signal, deadline: Date.now() + 110_000 }, browser)
        signal.throwIfAborted()
        const items = result.items.filter(item => item.text && !unavailableCommunityContent(platform, item.text)).map((item, i) => ({
          ...item, engineRanks: { [engine]: i + 1 }, provenance: [{ engine, rank: i + 1, url: item.url, published: item.published }],
        }))
        return { ...result, via: 'native', items, enginesUsed: [engine],
          engineStats: { [engine]: { used: true, attempts: 1, successes: 1, errors: result.stop_reason ? 1 : 0 } },
          partial: true, warnings: [...(result.warnings ?? []), 'Bounded native sample; not exhaustive platform coverage'],
          diagnostics: { ...result.diagnostics, coverage: result.coverage ?? 'first native search page and bounded details' } }
      }, { signal })
    },
  }
}
