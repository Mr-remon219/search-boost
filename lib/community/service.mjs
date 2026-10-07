import { communityRegistry, readCommunityConfig } from './config.mjs'
import { createXPipeline } from '../search/x/x-pipeline.js'
import { matchesDomains, resultKey } from '../search/results.js'
import { COMMUNITY_SEARCH_INPUT, COMMUNITY_OUTPUT, validateCommunity } from './schemas.mjs'
import { PLATFORM_DOMAINS } from './selection.mjs'
import { safeCommunityReason } from './http.mjs'

function dateSeconds(value) {
  if (value === undefined) return null
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) throw new Error('Community dates must be real YYYY-MM-DD UTC dates')
  return Date.parse(value) / 1000
}
export function communityExecution(channels, requested = true) {
  const active = channels.filter(c => ['ok', 'empty', 'partial', 'failed'].includes(c.status)), passed = active.some(c => ['ok', 'empty', 'partial'].includes(c.status))
  const degraded = channels.some(c => !['ok', 'empty', 'domain_excluded'].includes(c.status))
  const outcome = !requested ? 'not_requested' : !active.length ? channels.every(c => c.status === 'domain_excluded') ? 'domain_excluded' : channels.some(c => c.status === 'blocked') ? 'blocked' : 'unavailable'
    : degraded ? passed ? 'partial' : 'failed' : active.some(c => c.status === 'ok') ? 'succeeded' : 'empty'
  const legacy = channels.length === 1 ? channels[0].execution : null, inFlight = active.some(c => c.in_flight)
  const usage = { ...(legacy?.usage ?? { logicCalls: active.filter(c => !c.cache_hit && !c.in_flight).length, engineRequests: active.reduce((n, c) => n + Object.values(c.engine_stats ?? {}).reduce((s, stat) => s + (stat.attempts ?? 0), 0), 0), httpAttempts: null }), officialAttempted: active.some(c => c.execution?.usage?.officialAttempted), fallbackAttempted: active.some(c => c.execution?.usage?.fallbackAttempted), dispatchedNow: active.some(c => !c.cache_hit && !c.in_flight), ...(legacy ? {} : { inFlight }) }
  return { requested, effective: active.length > 0, outcome, cacheHit: active.length > 0 && active.every(c => c.cache_hit), inFlight,
    reason: legacy?.reason ?? (['failed', 'partial', 'unavailable', 'blocked'].includes(outcome) ? 'community_incomplete' : outcome === 'domain_excluded' ? 'community_domain_excluded' : null), usage: active.length ? usage : null }
}

/** Host-neutral shared orchestration. No facade recursion, code loading or config writes. */
export async function communitySearch(input, context = {}) {
  validateCommunity(COMMUNITY_SEARCH_INPUT, input)
  const started = Date.now(), type = input.type ?? 'keyword', limit = input.max_results ?? 5
  if (type !== 'keyword' && (input.engines.length !== 1 || input.engines[0] !== 'x')) throw new Error('This operation requires engines=["x"]')
  if ((type === 'keyword' || type === 'semantic') && !input.query?.trim()) throw new Error('Search query required')
  if (type === 'user' && !(input.username || input.query)?.trim()) throw new Error('X account required')
  if (type === 'thread' && !input.post_id?.trim()) throw new Error('X post_id required')
  if (type !== 'user' && input.username !== undefined) throw new Error('username requires user mode')
  if (type !== 'thread' && input.post_id !== undefined) throw new Error('post_id requires thread mode')
  if (!input.engines.includes('x') && ['allowed_x_handles', 'excluded_x_handles', 'model', 'reasoning_effort'].some(key => input[key] !== undefined)) throw new Error('X-only fields require the X platform')
  if (!input.engines.includes('reddit') && ['subreddits', 'max_pages'].some(key => input[key] !== undefined)) throw new Error('Reddit-only fields require the Reddit platform')
  const from = dateSeconds(input.from_date), to = dateSeconds(input.to_date)
  if (from !== null && to !== null && from > to) throw new Error('from_date must not exceed to_date')
  if (input.engines.includes('x')) createXPipeline({ ...input, type, max_results: limit }, limit)
  context.signal?.throwIfAborted()
  const registry = context.registry ?? communityRegistry, config = context.config ?? readCommunityConfig(registry)
  const state = context.snapshot?.() ?? { capability: {} }
  const channels = await Promise.all(input.engines.map(async platform => {
    const implemented = registry.list().some(provider => provider.platform === platform)
    if (!implemented) return { platform, status: 'not_implemented', reason: 'Platform not implemented', items: [], warnings: [] }
    const domains = PLATFORM_DOMAINS[platform]
    if (context.includeDomains?.length || context.excludeDomains?.length) {
      // A platform root is only a coarse prefilter; exact post/subdomain/path constraints apply again below.
      const excluded = domains.every(d => context.excludeDomains?.some(e => d === e || d.endsWith(`.${e}`)))
      const included = !context.includeDomains?.length || domains.some(d => context.includeDomains.some(e => e === d || e.endsWith(`.${d}`) || d.endsWith(`.${e}`)))
      if (excluded || !included || (platform === 'x' && !matchesDomains('https://x.com/', context.includeDomains ?? [], context.excludeDomains ?? []))) return { platform, status: 'domain_excluded', reason: 'Domain constraints exclude this platform', items: [], warnings: [] }
    }
    if (platform === 'x' && state.capability?.x?.blocked) return { platform, status: 'blocked', reason: 'X blocked by host authorization', items: [], warnings: [] }
    const candidates = config.backends.filter(backend => registry.get(backend.provider).platform === platform && backend.enabled)
    if (!candidates.length) return { platform, status: 'disabled', reason: 'No enabled backend instance', items: [], warnings: [] }
    const available = candidates.find(backend => registry.get(backend.provider).describeAvailability(state.capability, backend.config).ready)
    if (!available) return { platform, status: 'unavailable', reason: 'No backend is configuration-ready', items: [], warnings: [] }
    const provider = registry.get(available.provider)
    if (!provider.operations.includes(type)) return { platform, status: 'unsupported', reason: 'Backend does not support this operation', items: [], warnings: [] }
    try {
      const out = await provider.search({ ...input, type, max_results: limit }, { ...context, backendConfig: available.config, snapshot: () => state })
      context.signal?.throwIfAborted()
      let droppedDates = 0
      const items = (out.items ?? []).filter(item => {
        if (!item.url || !matchesDomains(item.url, context.includeDomains ?? [], context.excludeDomains ?? [])) return false
        if (platform === 'x' || (from === null && to === null)) return true
        const date = Date.parse(item.published ?? item.created_at ?? '') / 1000
        if (!Number.isFinite(date)) { droppedDates++; return context.softDates === true }
        return (from === null || date >= from) && (to === null || date < to + 86400)
      }).map(item => ({ ...item, platform, provider: provider.id, backend: available.id, retrieval_mode: provider.retrievalMode,
        content_type: item.content_type ?? (type === 'user' ? 'account' : 'post') }))
      return { platform, provider: provider.id, backend: available.id, retrieval_mode: provider.retrievalMode,
        status: out.via === 'error' ? 'failed' : out.communityExecution ? (out.communityExecution.outcome === 'partial' ? 'partial' : out.communityExecution.outcome === 'failed' ? 'failed' : items.length ? 'ok' : 'empty') : out.warnings?.length || out.error ? 'partial' : items.length ? 'ok' : 'empty',
        via: out.via ?? 'unknown', cache_hit: Boolean(out.cacheHit), engine_stats: out.engineStats ?? {}, engines_used: out.enginesUsed ?? [],
        ...(out.inFlight ? { in_flight: true } : {}), ...(out.communityExecution ? { execution: out.communityExecution } : {}),
        ...(out.diagnostics ? { diagnostics: out.diagnostics } : {}), ...(out.error ? { reason: 'retrieval_failed' } : {}), ...(out.note ? { note: out.note } : {}),
        items, warnings: [...(out.warnings ?? []), ...(droppedDates && !context.softDates ? [`${droppedDates} rows excluded: publication date unverified`] : [])] }
    } catch (error) {
      context.signal?.throwIfAborted()
      return { platform, provider: provider.id, backend: available.id, status: 'failed', reason: safeCommunityReason(error), items: [], warnings: [] }
    }
  }))
  context.signal?.throwIfAborted()
  // Fair interleaving before the final total cap; a first platform cannot consume every slot.
  const items = [], seen = new Set()
  for (let i = 0; channels.some(c => i < c.items.length); i++) for (const channel of channels) {
    const item = channel.items[i]; if (!item) continue
    const key = resultKey(item); if (!seen.has(key)) { seen.add(key); items.push(item) }
  }
  const kept = context.candidateMode ? items : items.slice(0, limit), degraded = channels.some(channel => !['ok', 'empty', 'domain_excluded'].includes(channel.status))
  const succeeded = channels.some(channel => ['ok', 'empty', 'partial'].includes(channel.status))
  return validateCommunity(COMMUNITY_OUTPUT, {
    schema_version: 1, status: degraded ? (succeeded ? 'partial' : 'failed') : kept.length ? 'ok' : 'empty', results: kept.length, items: kept,
    channels: channels.map(({ items: _items, ...channel }) => channel),
    warnings: [...new Set(channels.flatMap(channel => [...channel.warnings, ...(!['ok', 'empty'].includes(channel.status) ? [`${channel.platform}: ${channel.status}${channel.reason ? ` (${channel.reason})` : ''}`] : [])]))], took_ms: Date.now() - started,
  })
}
