#!/usr/bin/env node
import './isolate-tests.mjs'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { readFileSync, writeFileSync } from 'node:fs'
import { communitySearch } from '../lib/community/service.mjs'
import { redditArcticProvider } from '../lib/community/providers/reddit.mjs'
import { searchBoostHome } from '../lib/config-paths.mjs'
import { runXSearch, runFused, clearAllCaches } from '../lib/runtime.mjs'
import { MCP_POLICY_TEXT } from '../adapters/mcp/policy.mjs'
import { communityCapabilities, communityRegistry } from '../lib/community/config.mjs'
import { COMMUNITY_SEARCH_INPUT } from '../lib/community/schemas.mjs'

const snapshot = () => ({ fingerprint: 'review', capability: { availableEngines: ['bing'], x: { official: { available: true }, fallback: { available: true } } }, engines: {
  bing: { available: () => true, search: async () => [] },
} })
const archiveArgs = { query: 'alpha', subreddits: ['reviewalpha', 'reviewzebra'], from_date: '2026-01-01', to_date: '2026-02-01', max_pages: 1, max_results: 5 }
const scopeRequests = []
let sequence = 0
const fetchArchive = async url => {
  const u = new URL(url), scope = u.searchParams.get('subreddit'), before = Number(u.searchParams.get('before'))
  scopeRequests.push(scope)
  return Response.json({ data: Array.from({ length: 100 }, (_, i) => ({ id: (++sequence).toString(36), subreddit: scope, created_utc: before - i - 1, title: 'Alpha evidence', selftext: 'sample' })) })
}
const archive = (args = {}, context = {}) => redditArcticProvider.search({ ...archiveArgs, ...args }, { fetchImpl: fetchArchive, ...context })
for (let i = 0; i < 6; i++) await archive()
assert.deepEqual(scopeRequests, ['reviewalpha', 'reviewzebra', 'reviewalpha', 'reviewzebra', 'reviewalpha', 'reviewzebra'])
const two = await archive({ max_pages: 2 })
assert.deepEqual(scopeRequests.slice(-2), ['reviewalpha', 'reviewzebra'])
assert.equal(two.diagnostics.pages_requested, 2)
const path = join(searchBoostHome(), 'cache', 'community', 'reddit', `${two.diagnostics.checkpoint}.json`)
let stored = JSON.parse(readFileSync(path, 'utf8'))
assert.equal(stored.scope_turn, 8)
// Legacy checkpoints without the new turn remain reusable and repair on save.
delete stored.scope_turn; writeFileSync(path, JSON.stringify(stored))
await archive()
assert.equal(JSON.parse(readFileSync(path, 'utf8')).scope_turn, 1)
// Exhausted scopes are skipped without spending a page; failed scopes do not
// pin every later resume to the same scope (no same-call failover roulette).
stored = JSON.parse(readFileSync(path, 'utf8')); stored.windows[0].done = true; writeFileSync(path, JSON.stringify(stored))
await archive()
assert.equal(scopeRequests.at(-1), 'reviewzebra')
const failureScopes = []
const otherArgs = { subreddits: ['failurealpha', 'failurezebra'] }
await archive(otherArgs, { fetchImpl: async url => { failureScopes.push(new URL(url).searchParams.get('subreddit')); return Response.json({}, { status: 429 }) } })
await archive(otherArgs, { fetchImpl: async url => { failureScopes.push(new URL(url).searchParams.get('subreddit')); return Response.json({ data: [] }) } })
assert.deepEqual(failureScopes, ['failurealpha', 'failurezebra'])
// Two collectors start with the same checkpoint, finish in reverse order and
// merge under the real file lock; the stale writer must not rewind rotation.
const concurrentArgs = { subreddits: ['concurrentalpha', 'concurrentzebra'] }
let release; const held = new Promise(resolve => { release = resolve }); let reached
const atFetch = new Promise(resolve => { reached = resolve })
const slow = archive(concurrentArgs, { fetchImpl: async url => { reached(); await held; return fetchArchive(url) } })
await atFetch
const fast = await archive(concurrentArgs, { fetchImpl: fetchArchive })
await archive(concurrentArgs, { fetchImpl: fetchArchive })
release(); await slow
const concurrentPath = join(searchBoostHome(), 'cache', 'community', 'reddit', `${fast.diagnostics.checkpoint}.json`)
const concurrent = JSON.parse(readFileSync(concurrentPath, 'utf8'))
assert.equal(concurrent.scope_turn, 2)
assert.equal(concurrent.rows.length, 300)
await archive(concurrentArgs)
assert.equal(scopeRequests.at(-1), 'concurrentalpha')
console.log('ok: C3 persisted fair scope rotation for 1/2-page budgets, legacy checkpoints, exhaustion, failure and concurrent stale-writer merge')

const fixed = '2026-01-15T12:00:00Z'
const posts = Array.from({ length: 30 }, (_, i) => ({ url: `https://x.com/alice/status/${((BigInt(Date.parse(fixed)) - 1288834974657n) << 22n) + BigInt(i)}`, text: 'alpha evidence', created_at: fixed, username: 'alice' }))
let officialCalls = 0, fallbackCalls = 0
const deps = { snapshot, officialSearch: async () => { officialCalls++; return { credential: 'fixture', data: posts } }, fallbackSearch: async () => { fallbackCalls++; return { via: 'fixture', data: [] } } }
const xSearch = (args, options) => runXSearch(args, { ...options, ...deps })
clearAllCaches()
const args = { engines: ['x'], query: 'alpha', max_results: 20 }
const direct = await communitySearch(args, { snapshot, xSearch })
assert.equal(direct.results, 20)
assert.equal(direct.channels[0].execution.outcome, 'succeeded')
assert.equal(officialCalls, 1); assert.equal(fallbackCalls, 1)
const reused = await communitySearch(args, { snapshot, xSearch })
assert.equal(reused.channels[0].cache_hit, true)
assert.equal(reused.channels[0].execution.usage.dispatchedNow, false)
assert.equal(officialCalls, 1)
const legacy = await runXSearch({ query: 'alpha', max_results: 20 }, deps)
assert.equal(legacy.results, 10)
assert.equal(legacy.communityExecution, undefined, 'legacy public shape/cap unchanged')
for (const max_results of [11, 30]) {
  assert.equal((await communitySearch({ ...args, max_results }, { snapshot, xSearch })).results, max_results)
}
const semantic = await communitySearch({ ...args, type: 'semantic' }, { snapshot, xSearch })
assert.equal(semantic.results, 20)
for (const filters of [{ allowed_x_handles: ['bob'] }, { excluded_x_handles: ['alice'] }, { from_date: '2026-02-01' }, { to_date: '2025-12-31' }]) {
  const filtered = await communitySearch({ ...args, ...filters }, { snapshot, xSearch })
  assert.equal(filtered.results, 0, 'larger community cap does not bypass filters')
}
clearAllCaches()
const partial = await communitySearch(args, { snapshot, xSearch: (a, options) => runXSearch(a, { ...options, snapshot,
  officialSearch: async () => { throw new Error('fixture failure') }, fallbackSearch: async () => ({ via: 'fixture', data: posts }) }) })
assert.equal(partial.results, 20)
assert.equal(partial.status, 'partial')
assert.equal(partial.channels[0].execution.outcome, 'partial')
console.log('ok: C4 real X orchestration returns 20 with strict filters and execution facts, cached usage is reused, legacy cap remains 10 and primary failure is partial')

const dates = ['2020-01-01', null, '2026-10-07']
const webSearch = async () => ({ results: dates.map((published, i) => ({ url: `https://www.zhihu.com/question/${10 + i}`, title: ['old', 'unknown', 'new'][i] + ' alpha', snippet: 'alpha evidence', published, engineRanks: { bing: i + 1 } })) })
const dateArgs = { engines: ['zhihu'], query: 'alpha', from_date: '2026-10-06' }
const soft = await communitySearch(dateArgs, { snapshot, webSearch, softDates: true })
assert.deepEqual(soft.items.map(i => i.published), dates)
const strict = await communitySearch(dateArgs, { snapshot, webSearch })
assert.deepEqual(strict.items.map(i => i.published), ['2026-10-07'])
clearAllCaches()
const fused = await runFused({ query: 'alpha', community: ['zhihu'], recency: 'day', maxResults: 10 }, { snapshot,
  communityService: (a, ctx) => communitySearch(a, { ...ctx, webSearch }) })
assert.equal(fused.funnel.fusionRows, 3, 'real fused path keeps known-old, unknown and recent non-X candidates before normal diversity selection')
assert.ok(fused.results.some(r => r.url.endsWith('/10')))
console.log('ok: C5 soft fused recency retains old and unknown non-X evidence; explicit direct dates remain fail-closed')

for (const platform of communityCapabilities(snapshot().capability).platforms) {
  assert.equal(platform.supported, true)
  assert.ok(MCP_POLICY_TEXT.includes(platform.platform))
}
assert.equal(COMMUNITY_SEARCH_INPUT.properties.max_results.maximum, 30)
assert.ok(communityRegistry.get('reddit-arctic'))
assert.match(MCP_POLICY_TEXT, /1–30/)
assert.match(MCP_POLICY_TEXT, /another enabled, configuration-ready X instance/)
assert.match(MCP_POLICY_TEXT, /Legacy true selects X only; false or \[\] disables/)
assert.match(MCP_POLICY_TEXT, /no ready X instance, community X and fused\/Adaptive X are unavailable/)
assert.doesNotMatch(MCP_POLICY_TEXT, /not-implemented|Only existing-x|does not yet change|still boolean|initial slice/)
console.log('ok: C6 model-visible MCP policy agrees with five-platform registry, selection schema, shared disable and readiness limits')
