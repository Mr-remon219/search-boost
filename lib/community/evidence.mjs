import { COMMUNITY_PLATFORMS } from './registry.mjs'

const object = (properties, required = [], additionalProperties = false) => ({ type: 'object', properties, required, additionalProperties })
const text = { type: 'string' }, count = { type: 'integer', minimum: 0 }, flag = { type: 'boolean' }
export const COMMUNITY_ENGINE_STATS_SCHEMA = object({}, [], object({ used: flag, attempts: count, successes: count, errors: count, note: text }))
const usageFlags = ['officialAttempted', 'fallbackAttempted', 'dispatchedNow', 'inFlight']
const usageSchema = object(Object.fromEntries(usageFlags.map(key => [key, flag])), [], { type: ['integer', 'null'], minimum: 0 })
export const COMMUNITY_CHANNEL_SUMMARY_SCHEMA = object({
  platform: { type: 'string', enum: COMMUNITY_PLATFORMS },
  status: { type: 'string', enum: ['ok', 'empty', 'partial', 'failed', 'disabled', 'unavailable', 'blocked', 'unsupported', 'not_implemented', 'domain_excluded'] },
  reason: { type: ['string', 'null'] }, provider: text, backend: text, retrieval_mode: { type: 'string', enum: ['native', 'archive', 'mixed', 'web-index'] },
  via: text, cache_hit: flag, in_flight: flag, details_truncated: flag, note: text, warnings: { type: 'array', items: text },
  engine_stats: COMMUNITY_ENGINE_STATS_SCHEMA, engines_used: { type: 'array', items: text },
  usage: usageSchema,
  diagnostics: object({
    postprocessing: object(Object.fromEntries(['removed', 'unknown_dates', 'unknown_authors', 'invalid_identity'].map(key => [key, count]))),
    discovery: text, scopes: { type: 'array', maxItems: 5, items: text }, coverage: text, stop_reason: text,
    from_utc: { type: 'number' }, before_utc: { type: 'number' }, pages_requested: count, collected: count, timestamp_boundary_loss_possible: flag,
    indexed_candidates: count, unavailable_content: count, detail_requests: count, invalid_notes: count, aborted_by_policy: count, blocked_redirects: count,
  }),
}, ['platform', 'status', 'reason'])
export const EVIDENCE_PROVENANCE_SCHEMA = object({
  engine: text, rank: { type: 'integer', minimum: 1 }, variant: text, url: text, title: text, snippet: text, published: { type: ['string', 'null'] },
  platform: { type: 'string', enum: COMMUNITY_PLATFORMS }, provider: text, backend: text,
  retrieval_mode: { type: 'string', enum: ['native', 'archive', 'mixed', 'web-index'] }, content_type: text,
}, ['engine', 'rank'])

function numericStats(stats) {
  return Object.fromEntries(Object.entries(stats ?? {}).slice(0, 32).filter(([name]) => /^[a-z][a-z0-9_-]{0,63}$/i.test(name)).map(([name, raw]) => {
    const stat = { used: raw?.used === true }
    for (const key of ['attempts', 'successes', 'errors']) if (Number.isSafeInteger(raw?.[key]) && raw[key] >= 0) stat[key] = raw[key]
    if (typeof raw?.note === 'string') stat.note = raw.note.slice(0, 300)
    return [name, stat]
  }))
}
/** Typed route/coverage observations only; no checkpoint hash or raw/config/session. */
export function summarizeCommunityChannel(channel) {
  const out = { platform: channel.platform, status: channel.status, reason: typeof channel.reason === 'string' ? channel.reason.slice(0, 300) : null }
  for (const key of ['provider', 'backend', 'retrieval_mode', 'via', 'note']) if (typeof channel[key] === 'string') out[key] = channel[key].slice(0, key === 'note' ? 300 : 96)
  for (const key of ['cache_hit', 'in_flight']) if (typeof channel[key] === 'boolean') out[key] = channel[key]
  if (channel.engine_stats) out.engine_stats = numericStats(channel.engine_stats)
  if (Array.isArray(channel.engines_used)) out.engines_used = channel.engines_used.filter(value => typeof value === 'string').slice(0, 32)
  if (Array.isArray(channel.warnings)) out.warnings = channel.warnings.slice(0, 12).map(value => String(value).slice(0, 300))
  if (channel.execution?.usage) {
    out.usage = {}
    for (const [key, value] of Object.entries(channel.execution.usage).slice(0, 24)) {
      if (!/^[A-Za-z0-9_]{1,32}$/.test(key)) continue
      if (value === null || Number.isSafeInteger(value) && value >= 0 || usageFlags.includes(key) && typeof value === 'boolean') out.usage[key] = value
    }
  }
  if (channel.diagnostics) {
    const source = channel.diagnostics, diagnostics = {}
    for (const key of ['discovery', 'coverage', 'stop_reason']) if (typeof source[key] === 'string') diagnostics[key] = source[key].slice(0, 300)
    for (const key of ['from_utc', 'before_utc']) if (Number.isFinite(source[key])) diagnostics[key] = source[key]
    for (const key of ['pages_requested', 'collected', 'indexed_candidates', 'unavailable_content', 'detail_requests', 'invalid_notes', 'aborted_by_policy', 'blocked_redirects']) if (Number.isSafeInteger(source[key]) && source[key] >= 0) diagnostics[key] = source[key]
    if (typeof source.timestamp_boundary_loss_possible === 'boolean') diagnostics.timestamp_boundary_loss_possible = source.timestamp_boundary_loss_possible
    if (Array.isArray(source.scopes)) diagnostics.scopes = source.scopes.filter(value => typeof value === 'string' && /^[A-Za-z0-9_]{2,21}$/.test(value)).slice(0, 5)
    if (source.postprocessing) diagnostics.postprocessing = Object.fromEntries(['removed', 'unknown_dates', 'unknown_authors', 'invalid_identity'].filter(key => Number.isSafeInteger(source.postprocessing[key]) && source.postprocessing[key] >= 0).map(key => [key, source.postprocessing[key]]))
    out.diagnostics = diagnostics
  }
  return out
}

/** Preserve original source/rank and route labels, never arbitrary provider fields. */
export function publicEvidenceProvenance(entries) {
  return (Array.isArray(entries) ? entries : []).flatMap(entry => {
    if (typeof entry?.engine !== 'string' || !Number.isSafeInteger(entry.rank) || entry.rank < 1) return []
    const out = { engine: entry.engine.slice(0, 96), rank: entry.rank }
    for (const key of ['variant', 'url', 'title', 'provider', 'backend', 'content_type']) if (typeof entry[key] === 'string') out[key] = entry[key].slice(0, key === 'url' ? 2000 : key === 'title' ? 500 : 96)
    if (COMMUNITY_PLATFORMS.includes(entry.platform)) out.platform = entry.platform
    if (['native', 'archive', 'mixed', 'web-index'].includes(entry.retrieval_mode)) out.retrieval_mode = entry.retrieval_mode
    if (typeof entry.published === 'string' || entry.published === null) out.published = entry.published
    return [out]
  }).slice(0, 64)
}
