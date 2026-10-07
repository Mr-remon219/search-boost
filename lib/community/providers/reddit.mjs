import { setTimeout as pause } from 'node:timers/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { readdirSync, statSync, unlinkSync } from 'node:fs'
import { searchBoostHome } from '../../config-paths.mjs'
import { readJsonStore, withFileLock, writeFileAtomicPrivate } from '../../private-file.mjs'
import { communityJson, safeCommunityReason } from '../http.mjs'

const BASE = 'https://arctic-shift.photon-reddit.com'
export const validSubreddit = value => typeof value === 'string' && /^[A-Za-z0-9_]{2,21}$/.test(value)
export function redditConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config) || Object.keys(config).some(k => k !== 'subreddits')
    || (config.subreddits !== undefined && (!Array.isArray(config.subreddits) || config.subreddits.length > 5 || config.subreddits.some(s => !validSubreddit(s))))) throw new Error('reddit-arctic accepts up to five subreddit names only')
  return config.subreddits ? { subreddits: [...new Set(config.subreddits.map(s => s.toLowerCase()))] } : {}
}
function post(row, scope) {
  if (!row || !validSubreddit(scope) || typeof row.id !== 'string' || typeof row.title !== 'string' || !/^[a-z0-9]+$/i.test(row.id) || String(row.subreddit).toLowerCase() !== scope || !Number.isFinite(row.created_utc) || row.created_utc < 0 || row.created_utc > 32_503_680_000) return null
  const text = String(row.selftext ?? '')
  if (['[removed]', '[deleted]'].includes(text) && !row.title) return null
  const url = `https://www.reddit.com/r/${scope}/comments/${row.id}/`
  return { id: row.id, url, title: String(row.title ?? '').slice(0, 500), text: text.slice(0, 8000), author: String(row.author ?? '').slice(0, 200),
    published: new Date(row.created_utc * 1000).toISOString(), created_utc: row.created_utc, subreddit: scope,
    retrieved_on: Number.isFinite(row.retrieved_on) ? row.retrieved_on : null, content_type: 'post' }
}
function trimCorpora(directory) {
  try {
    const files = readdirSync(directory).filter(n => /^[a-f0-9]{64}\.json$/.test(n)).map(n => ({ path: join(directory, n), time: statSync(join(directory, n)).mtimeMs })).sort((a, b) => b.time - a.time)
    for (const file of files.slice(64)) unlinkSync(file.path)
  } catch { /* A concurrent collector or read-only home must not corrupt results. */ }
}
export const redditArcticProvider = {
  id: 'reddit-arctic', platform: 'reddit', label: 'SearchBoost bounded Arctic Shift collector/local retrieval', version: 1,
  operations: ['keyword'], retrievalMode: 'archive', configFields: ['subreddits'], validateConfig: redditConfig,
  describeAvailability() { return { ready: true, reason: 'Archive endpoint configured; scopes, availability and ingestion coverage are not guaranteed' } },
  async search(args, context) {
    let scopes = args.subreddits ?? context.backendConfig?.subreddits ?? [], discovery = 'explicit'
    if (!scopes.length) {
      discovery = 'web-index'
      const found = await context.webSearch?.({ query: args.query, includeDomains: ['reddit.com'], maxResults: 20, signal: context.signal })
      scopes = [...new Set((Array.isArray(found) ? found : found?.results ?? []).flatMap(hit => {
        try { const u = new URL(hit.url); const match = /\/r\/([A-Za-z0-9_]{2,21})\//.exec(u.pathname); return (u.hostname === 'reddit.com' || u.hostname.endsWith('.reddit.com')) && match ? [match[1].toLowerCase()] : [] } catch { return [] }
      }))].slice(0, 5)
    }
    if (!scopes.length) return { via: 'archive', items: [], warnings: ['No subreddit scope discovered. Supply subreddits; this is not an all-Reddit negative result.'], diagnostics: { discovery, scopes: [], coverage: 'unknown', stop_reason: 'no_scope' } }
    scopes = [...new Set(scopes.map(s => s.toLowerCase()))].sort()
    const end = args.to_date ? Date.parse(args.to_date) / 1000 + 86400 : Math.floor(Date.now() / 86400000) * 86400 + 86400
    const start = args.from_date ? Date.parse(args.from_date) / 1000 : end - 30 * 86400
    const identity = JSON.stringify({ scopes, start, end, version: 1 })
    const key = createHash('sha256').update(identity).digest('hex'), directory = join(searchBoostHome(), 'cache', 'community', 'reddit')
    const path = join(directory, `${key}.json`), stored = readJsonStore(path).doc
    let corpus = stored?.schema_version === 1 && stored.identity === identity && stored.expires_at > Date.now() && Array.isArray(stored.rows) && stored.rows.length <= 4000 && stored.windows?.length === scopes.length
      ? stored : { schema_version: 1, identity, expires_at: Date.now() + 3600_000, rows: [], windows: scopes.map(scope => ({ scope, before: end, done: false })) }
    // Treat private cache contents as data, not trusted code or unchecked URLs.
    corpus.rows = corpus.rows.map(r => post({ ...r, selftext: r?.text }, r?.subreddit)).filter(r => r && scopes.includes(r.subreddit))
    if (!Array.isArray(corpus.windows) || new Set(corpus.windows.map(w => w?.scope)).size !== scopes.length || corpus.windows.some(w => !w || !scopes.includes(w.scope) || !Number.isFinite(w.before) || typeof w.done !== 'boolean' || w.before > end || w.before < start)) {
      corpus = { schema_version: 1, identity, expires_at: Date.now() + 3600_000, rows: [], windows: scopes.map(scope => ({ scope, before: end, done: false })) }
    }
    const rows = new Map(corpus.rows.map(row => [row.id, row])), warnings = []
    let requests = 0, failures = 0, successes = 0, stop = rows.size >= 4000 ? 'corpus_capacity' : 'archive_window_exhausted'
    const maxPages = args.max_pages ?? 6
    for (let round = 0; requests < maxPages && rows.size < 4000 && corpus.windows.some(w => !w.done); round++) {
      let progress = false
      for (const window of corpus.windows) {
        if (window.done || requests >= maxPages) continue
        context.signal?.throwIfAborted()
        const url = new URL('/api/posts/search', BASE)
        url.search = new URLSearchParams({ subreddit: window.scope, after: String(start), before: String(window.before), sort: 'desc', limit: '100', fields: 'id,subreddit,created_utc,title,selftext,author,retrieved_on' }).toString()
        if (requests) await pause(500, undefined, { signal: context.signal ?? undefined })
        requests++
        try {
          const response = await communityJson(url, { signal: context.signal, fetchImpl: context.fetchImpl })
          if (!Array.isArray(response.data) || response.data.length > 100) throw new Error('Archive response shape changed')
          successes++
          const page = response.data.map(r => post(r, window.scope)).filter(r => r && r.created_utc >= start && r.created_utc < window.before)
          for (const row of page) rows.set(row.id, row)
          const before = page.length ? Math.min(...page.map(r => r.created_utc)) : window.before
          if (response.data.length < 100) { window.done = true; progress = true }
          else if (before < window.before) { window.before = before; progress = true }
          else { stop = 'cursor_stalled'; warnings.push(`Archive pagination stalled in r/${window.scope}; coverage remains unknown`) }
          if (rows.size >= 4000) { stop = 'corpus_capacity'; break }
        } catch (error) {
          context.signal?.throwIfAborted(); failures++; stop = safeCommunityReason(error)
          warnings.push(`Archive request failed (${stop}); existing collected evidence retained`)
          // Do not keep retrying a rate/security/policy failure through other scopes.
          break
        }
      }
      if (failures || stop === 'cursor_stalled' || rows.size >= 4000 || !progress) break
    }
    if (!failures && corpus.windows.some(w => !w.done) && stop === 'archive_window_exhausted') stop = 'page_budget'
    corpus.rows = [...rows.values()].slice(0, 4000)
    context.signal?.throwIfAborted()
    if (successes) {
      try {
        withFileLock(path, () => {
          const latest = readJsonStore(path).doc
          if (latest?.identity === identity && latest.expires_at > Date.now() && Array.isArray(latest.rows) && latest.rows.length <= 4000 && Array.isArray(latest.windows)) {
            const merged = new Map(latest.rows.map(r => post({ ...r, selftext: r?.text }, r?.subreddit)).filter(r => r && scopes.includes(r.subreddit)).map(r => [r.id, r]))
            for (const row of corpus.rows) merged.set(row.id, row)
            corpus.rows = [...merged.values()].sort((a, b) => b.created_utc - a.created_utc).slice(0, 4000)
            for (const window of corpus.windows) {
              const other = latest.windows.find(w => w?.scope === window.scope)
              if (other && Number.isFinite(other.before) && other.before >= start && other.before <= end) { window.before = Math.min(window.before, other.before); window.done ||= other.done === true }
            }
          }
          writeFileAtomicPrivate(path, `${JSON.stringify(corpus)}\n`)
        })
        trimCorpora(directory)
      } catch { warnings.push('Archive checkpoint could not be saved; evidence is still returned') }
    }
    const terms = args.query.toLowerCase().match(/[\p{L}\p{N}_]+/gu)?.filter(t => !['or', 'and', 'site', 'com', 'reddit'].includes(t)) ?? []
    const ranked = corpus.rows.map(row => ({ row, relevance: terms.reduce((n, term) => n + (row.title.toLowerCase().includes(term) ? 2 : row.text.toLowerCase().includes(term) ? 1 : 0), 0) })).filter(r => r.relevance > 0).sort((a, b) => b.relevance - a.relevance || b.row.created_utc - a.row.created_utc)
    const items = ranked.slice(0, args.max_results).map(({ row }, i) => ({ ...row, engineRanks: { 'community-reddit-arctic': i + 1 }, provenance: [{ engine: 'community-reddit-arctic', rank: i + 1, url: row.url, published: row.published }], coverage: 'bounded archived subreddit sample, locally ranked; not live Reddit-wide search' }))
    if (stop !== 'archive_window_exhausted') warnings.push(`Archive collection stopped: ${stop}; ${stop === 'corpus_capacity' ? 'narrow the scope/window or wait for cache expiry' : 'a later call may resume the private checkpoint'}`)
    return { via: failures && !corpus.rows.length ? 'error' : 'archive', items, cacheHit: requests === 0, warnings,
      enginesUsed: ['community-reddit-arctic'], engineStats: { 'community-reddit-arctic': { used: successes > 0 || corpus.rows.length > 0, attempts: requests, successes, errors: failures } },
      diagnostics: { discovery, scopes, from_utc: start, before_utc: end, pages_requested: requests, collected: corpus.rows.length, checkpoint: key, stop_reason: stop, coverage: 'unknown', timestamp_boundary_loss_possible: true },
      note: 'Archive availability/ingestion may lag; timestamp pagination may omit equal-timestamp boundary records. Local token relevance is not a fact or complete coverage check.' }
  },
}
