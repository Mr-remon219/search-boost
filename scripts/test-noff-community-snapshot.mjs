#!/usr/bin/env node
import './isolate-tests.mjs'
import { __setUndiciLoaderForTests, closeFetchDispatchers } from '../lib/search/ipv4-fetch.js'
/**
 * N_off snapshot + community channel tests (M2/T15/T16).
 *
 * Uses the genuine shared core: real runFused snapshot selection, real
 * runXSearch orchestration/cache/single-flight, real mergeCommunityResults and
 * the real credential-free fallback chain. Only provider transports (hosted
 * xAI tool, engine HTTP, publish.x.com oEmbed) are fixtures, so no network,
 * credential or user configuration is touched.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const temp = mkdtempSync(join(tmpdir(), 'sb-noff-community-'))
process.env.HOME = process.env.USERPROFILE = join(temp, 'home')
process.env.SEARCH_BOOST_HOME = join(temp, 'state')
process.env.PI_CODING_AGENT_DIR = join(temp, 'pi')
for (const key of ['KEYS', 'LAYER', 'XAUTH', 'XGUEST']) process.env[`SEARCH_BOOST_${key}_FILE`] = join(temp, `${key}.json`)
process.env.SEARCH_BOOST_LAYER = 'free'
for (const key of ['TAVILY_API_KEY', 'BRAVE_API_KEY', 'EXA_API_KEY', 'ANYSEARCH_API_KEY', 'PI_SEARCH_TAVILY_KEY', 'PI_SEARCH_BRAVE_KEY', 'PI_SEARCH_EXA_KEY', 'XAI_API_KEY']) delete process.env[key]
mkdirSync(process.env.HOME)

const runtime = await import('../lib/runtime.mjs')
const { ENGINE_POOLS } = await import('../lib/search/routing.js')
const { createXPipeline } = await import('../lib/search/x/x-pipeline.js')
const { fallbackXSearch } = await import('../lib/search/x/xfallback.js')

const FIXED = '2026-01-15T12:00:00Z'
const idAt = (date, seq = 0) => (((BigInt(Date.parse(date)) - 1288834974657n) << 22n) + BigInt(seq)).toString()
const post = (name, seq) => ({ url: `https://x.com/${name}/status/${idAt(FIXED, seq)}`, text: 'alpha beta developer community evidence', created_at: FIXED })

let auth = true
let enabled = new Set(ENGINE_POOLS.hybrid)
let engineFailure = new Set()
let webRows = 2
let xPosts = [post('alice', 1), post('bob', 2)]
let officialPosts = [post('carol', 3)]
let officialFailure = false
let officialEmpty = false
let officialHold = null
let fallbackFailure = false
let fallbackEmpty = false
let fallbackPlain = false
let blocked = false
let fallbackAvailable = true
let engineCalls = []
const officialCalls = { count: 0 }
const fallbackCalls = { count: 0 }

const engines = Object.fromEntries(ENGINE_POOLS.hybrid.map((name) => [name, {
  available: () => enabled.has(name),
  async search(query, count) {
    engineCalls.push({ name, query, count })
    if (engineFailure.has(name)) throw new Error('fixture engine unavailable')
    if (query.startsWith('site:x.com')) {
      return xPosts.slice(0, count).map((p) => ({ url: p.url, title: 'Author on X: alpha beta community evidence', snippet: p.text, created_at: p.created_at }))
    }
    return Array.from({ length: Math.min(webRows, count) }, (_, i) => ({ url: `https://${name.replace('-', '')}-docs.example/${i}`, title: 'alpha beta reference', snippet: 'alpha beta implementation evidence' }))
  },
}]))

const snapshot = () => ({
  engines,
  fingerprint: JSON.stringify([[...enabled].sort(), [...engineFailure].sort(), auth, webRows, xPosts.length, blocked, fallbackAvailable]),
  capability: { x: { official: { available: auth, source: auth ? 'fixture' : 'none' }, fallback: { available: fallbackAvailable }, ...(blocked ? { blocked: true } : {}) } },
})

const fakeOfficial = async () => {
  officialCalls.count++
  if (officialFailure) throw new Error('hosted fixture unavailable')
  if (officialHold) await officialHold
  return { credential: 'fixture', data: officialEmpty ? [] : officialPosts }
}
const fakeFallback = async (args) => {
  fallbackCalls.count++
  if (fallbackFailure) throw new Error('fallback fixture unavailable')
  if (fallbackEmpty) return { type: 'keyword', data: [], via: 'engines' }
  if (fallbackPlain) return { type: 'keyword', data: xPosts, via: 'oembed' }
  return fallbackXSearch(args)
}
const xSearch = (args, opts) => runtime.runXSearch(args, { ...opts, snapshot, officialSearch: fakeOfficial, fallbackSearch: fakeFallback })
const xSearchDirect = (args = {}) => runtime.runXSearch(
  { type: 'keyword', query: 'alpha beta', max_results: 30, ...args },
  { candidateMode: true, snapshot, officialSearch: fakeOfficial, fallbackSearch: fakeFallback },
)
const fused = (args) => runtime.runFused(
  { query: 'alpha beta', complexity: 'medium', engineList: ['bing', 'ddg'], maxResults: 32, maxResultsCap: 32, ...args },
  { snapshot, xSearch },
)
const snapshotFused = (args) => fused({ candidateSelection: 'snapshot', community: true, ...args })

const reset = () => {
  runtime.invalidateSearchCaches()
  auth = true
  enabled = new Set(ENGINE_POOLS.hybrid)
  engineFailure = new Set()
  webRows = 2
  xPosts = [post('alice', 1), post('bob', 2)]
  officialPosts = [post('carol', 3)]
  officialFailure = false
  officialEmpty = false
  officialHold = null
  fallbackFailure = false
  fallbackEmpty = false
  fallbackPlain = false
  blocked = false
  fallbackAvailable = true
  engineCalls = []
  officialCalls.count = 0
  fallbackCalls.count = 0
}

const OUTCOMES = new Set(['not_requested', 'domain_excluded', 'unavailable', 'blocked', 'succeeded', 'empty', 'failed', 'partial', 'not_run'])
const RECORD_FIELDS = ['requested', 'effective', 'outcome', 'reason', 'cacheHit', 'inFlight', 'usage']
const USAGE_FIELDS = ['logicCalls', 'dispatchedNow', 'officialAttempted', 'fallbackAttempted', 'engineRequests', 'engineErrors', 'enginesUsed', 'enhancementAttempts', 'enhancementErrors', 'httpAttempts', 'tokens']
const sorted = (values) => [...values].sort()
function assertExecutionContract(record) {
  assert.deepEqual(sorted(Object.keys(record)), sorted(RECORD_FIELDS))
  assert.equal(typeof record.requested, 'boolean')
  assert.equal(typeof record.effective, 'boolean')
  assert.ok(OUTCOMES.has(record.outcome), `unknown outcome ${record.outcome}`)
  assert.equal(typeof record.cacheHit, 'boolean')
  assert.equal(typeof record.inFlight, 'boolean')
  if (record.reason !== null) assert.ok(/^[a-z][a-z0-9_]{2,40}$/.test(record.reason), `unbounded reason ${record.reason}`)
  if (record.usage === null) {
    assert.ok(!['succeeded', 'empty'].includes(record.outcome), 'an unobserved branch is never reported as a clean success')
    return
  }
  assert.deepEqual(sorted(Object.keys(record.usage)), sorted(USAGE_FIELDS))
  assert.ok([0, 1].includes(record.usage.logicCalls))
  assert.equal(typeof record.usage.dispatchedNow, 'boolean')
  for (const field of ['engineRequests', 'engineErrors', 'enhancementAttempts', 'enhancementErrors']) {
    assert.ok(record.usage[field] === null || Number.isSafeInteger(record.usage[field]), `${field} must be a bounded counter or null`)
  }
  assert.ok(Array.isArray(record.usage.enginesUsed) && record.usage.enginesUsed.every((name) => typeof name === 'string'))
  const expectedUnknown = record.usage.dispatchedNow ? null : 0
  assert.equal(record.usage.httpAttempts, expectedUnknown, 'provider HTTP is unknown on dispatch, but reuse dispatches no new HTTP')
  assert.equal(record.usage.tokens, expectedUnknown, 'provider billing is unknown on dispatch, but reuse incurs no new provider call')
}

const originalFetch = globalThis.fetch
__setUndiciLoaderForTests(async () => ({ ...await import('undici'), fetch: (...args) => globalThis.fetch(...args) }))
let oembedStatus = 'ok'
globalThis.fetch = async (raw) => {
  const url = new URL(String(raw))
  assert.equal(url.hostname, 'publish.x.com', 'tests must never reach a live service')
  if (oembedStatus === 'fail') return new Response('', { status: 404 })
  const id = new URL(url.searchParams.get('url')).pathname.split('/').pop()
  const found = [...officialPosts, ...xPosts].find((p) => p.url.endsWith(`/${id}`))
  return found
    ? Response.json({ author_name: 'Fixture author', author_url: found.url.split('/status/')[0], html: `<blockquote>alpha beta oEmbed full text ${id}</blockquote>` })
    : new Response('', { status: 404 })
}

let tests = 0
async function test(name, fn) {
  reset()
  await fn()
  tests++
  console.log(`ok: ${name}`)
}

try {
  await test('snapshot ranks web and X together on original score and caps the declared pool at 32', async () => {
    webRows = 20
    xPosts = []
    officialPosts = [post('carol', 3), post('dave', 4), post('erin', 5)]
    const out = await snapshotFused({ maxResults: 32 })
    assert.equal(out.results.length, 32, 'one bounded global pool, not per-engine quotas')
    assert.equal(out.truncated, true)
    assert.equal(out.results[0].url, officialPosts[0].url, 'the best X row is appended last upstream yet wins the global order')
    assert.ok(out.results[0].engines.includes('x-official'))
    assert.ok(out.results.some((row) => row.engines.includes('x-official')), 'high-score X rows survive the global truncation')
    assert.ok(out.funnel.engineRowsRaw >= 32, 'the web leg alone would have filled a flat concatenation cut')
    assert.equal(out.funnel.uniqueCandidates, 40)
    const scores = out.results.map((row) => row.score)
    assert.deepEqual(scores, [...scores].sort((a, b) => b - a), 'global descending score order')
    assert.equal(new Set(out.results.map((row) => row.url)).size, 32, 'URL dedupe keeps one row per link')
    // 43 upstream candidates (40 web + 3 X) against a 32 cap: a flat concatenation cut would drop every X row.
    assert.equal(out.funnel.fusionRows, 43)
    assert.equal(out.funnel.selectedRows, 32)
    assertExecutionContract(out.communityExecution)
  })

  await test('the snapshot is not cut by max_results while ordinary fused selection is untouched', async () => {
    webRows = 8
    xPosts = []
    officialPosts = [post('carol', 3)]
    const snapshotOut = await snapshotFused({ maxResults: 6 })
    assert.equal(snapshotOut.results.length, 17, 'candidateLimit rows (16 web + 1 X) are declared, not max_results')
    assert.equal(snapshotOut.truncated, false)
    runtime.invalidateSearchCaches()
    webRows = 30
    const ordinary = await runtime.runFused({ query: 'alpha beta', complexity: 'medium', engineList: ['bing', 'ddg'], maxResults: 6 }, { snapshot, xSearch })
    assert.equal(ordinary.results.length, 4, 'ordinary fused keeps its diversity-limited selection')
    assert.equal(ordinary.results.filter((row) => row.url.includes('bing-docs.example')).length, 2, 'ordinary sparse-domain cap still applies')
    assert.ok(!('contributionWeights' in ordinary), 'snapshot metadata must not leak into ordinary fused')
    assert.ok(!('communityExecution' in ordinary))
    runtime.invalidateSearchCaches()
    const kept = await snapshotFused({ maxResults: 6, engineList: ['bing'] })
    assert.equal(kept.results.length, 9, 'same-domain rows stay in the declared snapshot beyond max_results')
    assert.equal(kept.results.filter((row) => row.url.includes('bing-docs.example')).length, 8, 'no diversity cap is applied to the snapshot')
  })

  await test('contributionWeights reports only the sources that really contributed', async () => {
    webRows = 3
    xPosts = []
    const off = await snapshotFused({ community: false, engineWeights: { bing: 0 } })
    assert.deepEqual(off.contributionWeights, { ddg: off.effectiveWeights.ddg })
    assert.equal(off.effectiveWeights.bing, 0, 'the public effectiveWeights meaning is unchanged')
    assert.ok(!('x-official' in off.contributionWeights))
    assert.ok(!('x-fallback' in off.contributionWeights))

    // Hosted X rows keep their real x-official provenance at weight 1.
    runtime.invalidateSearchCaches()
    const on = await snapshotFused({ community: true })
    assert.equal(on.contributionWeights['x-official'], 1)
    assert.ok(on.results.some((row) => row.engines.includes('x-official')))
    assert.ok(!('x-fallback' in on.contributionWeights), 'engine-attributed fallback rows keep their web provenance instead of an invented x-fallback vote')
    assert.ok(Object.values(on.contributionWeights).every((weight) => Number.isFinite(weight) && weight > 0), 'zero-weight engines never widen eligibility')

    // A fallback transport without its own engine ranks is a real x-fallback contribution.
    runtime.invalidateSearchCaches()
    fallbackPlain = true
    officialEmpty = true
    officialPosts = []
    xPosts = [post('alice', 1)]
    const fallbackOnly = await snapshotFused({ community: true })
    assert.equal(fallbackOnly.contributionWeights['x-fallback'], 1)
    assert.ok(!('x-official' in fallbackOnly.contributionWeights), 'a source that returned no kept row is not provenance')
    assert.ok(fallbackOnly.results.some((row) => row.engines.includes('x-fallback')))
  })

  await test('communityExecution vocabulary: not_requested, domain_excluded, blocked, unavailable', async () => {
    webRows = 2
    const off = await snapshotFused({ community: false })
    assert.deepEqual(off.communityExecution, { requested: false, effective: false, outcome: 'not_requested', cacheHit: false, inFlight: false, reason: null, usage: null })
    assertExecutionContract(off.communityExecution)

    runtime.invalidateSearchCaches()
    const excluded = await snapshotFused({ includeDomains: ['docs.example'] })
    assert.equal(excluded.communityExecution.outcome, 'domain_excluded')
    assert.equal(excluded.communityExecution.effective, false)
    assert.equal(excluded.communityExecution.requested, true)
    assert.equal(officialCalls.count + fallbackCalls.count, 0, 'a deterministic domain restriction is never bypassed to gather more results')
    assert.match(excluded.warnings.join(' '), /domain filters exclude X/)
    assertExecutionContract(excluded.communityExecution)

    runtime.invalidateSearchCaches()
    blocked = true
    const denied = await snapshotFused({})
    assert.equal(denied.communityExecution.outcome, 'blocked')
    assert.equal(denied.communityExecution.reason, 'capability_blocked')
    assert.equal(denied.communityExecution.effective, false)
    assert.equal(officialCalls.count + fallbackCalls.count, 0)
    assert.ok(denied.results.length > 0, 'web results are still delivered')
    assertExecutionContract(denied.communityExecution)

    runtime.invalidateSearchCaches()
    blocked = false
    auth = false
    fallbackAvailable = false
    const none = await snapshotFused({})
    assert.equal(none.communityExecution.outcome, 'unavailable')
    assert.equal(none.communityExecution.reason, 'x_branch_unavailable')
    assert.equal(officialCalls.count + fallbackCalls.count, 0)
    assertExecutionContract(none.communityExecution)

    // An X branch that throws before it can attest its own result is a failure.
    runtime.invalidateSearchCaches()
    auth = true
    fallbackAvailable = true
    const broken = await runtime.runFused(
      { query: 'alpha beta', complexity: 'medium', engineList: ['bing'], maxResults: 32, maxResultsCap: 32, candidateSelection: 'snapshot', community: true },
      { snapshot, xSearch: () => { throw new Error('fixture x branch exploded') } },
    )
    assert.equal(broken.communityExecution.outcome, 'failed')
    assert.equal(broken.communityExecution.reason, 'channel_failed')
    assert.equal(broken.communityExecution.effective, true)
    assert.equal(broken.communityExecution.usage, null)
    assert.ok(broken.results.length > 0, 'usable web results are still delivered')
    assertExecutionContract(broken.communityExecution)

    // Without credentials the credential-free fallback is still a usable branch.
    runtime.invalidateSearchCaches()
    auth = false
    fallbackAvailable = true
    xPosts = [post('alice', 1)]
    const fallbackOnly = await snapshotFused({})
    assert.equal(fallbackOnly.communityExecution.outcome, 'succeeded')
    assert.equal(officialCalls.count, 0)
    assert.ok(fallbackCalls.count > 0)
  })

  await test('communityExecution classifies the earliest settled X branches, not notes or via strings', async () => {
    // Planned credential-free fallback (no official credentials): normal operation.
    auth = false
    xPosts = [post('alice', 1), post('bob', 2)]
    const planned = await snapshotFused({})
    assert.equal(planned.communityExecution.outcome, 'succeeded')
    assert.equal(planned.communityExecution.reason, null)
    assert.deepEqual([planned.communityExecution.usage.officialAttempted, planned.communityExecution.usage.fallbackAttempted], [false, true])
    assert.ok(planned.communityExecution.usage.engineRequests > 0)
    assert.ok(planned.communityExecution.usage.enginesUsed.length > 0)
    assert.ok(planned.results.length > 0)
    assertExecutionContract(planned.communityExecution)

    // One dispatched engine down while others answer: partial.
    runtime.invalidateSearchCaches()
    engineFailure = new Set(['bing'])
    const partial = await snapshotFused({})
    assert.equal(partial.communityExecution.outcome, 'partial')
    assert.equal(partial.communityExecution.reason, 'engine_failures')
    assert.equal(partial.communityExecution.usage.engineErrors, 1)
    assert.ok(partial.results.length > 0, 'usable web and community results are still delivered')
    assertExecutionContract(partial.communityExecution)

    // A configured hosted channel that fails while the fallback answers: partial.
    runtime.invalidateSearchCaches()
    engineFailure = new Set()
    auth = true
    officialFailure = true
    xPosts = [post('alice', 1)]
    officialPosts = []
    const officialDown = await snapshotFused({})
    assert.equal(officialDown.communityExecution.outcome, 'partial')
    assert.equal(officialDown.communityExecution.reason, 'official_failed')

    // Hosted and fallback channels answered with nothing: empty, not a failure.
    runtime.invalidateSearchCaches()
    officialFailure = false
    officialEmpty = true
    officialPosts = []
    xPosts = []
    const empty = await snapshotFused({})
    assert.equal(empty.communityExecution.outcome, 'empty')
    assert.equal(empty.communityExecution.reason, 'no_results')

    // All dispatched channels fail: failed, and a failed run is never cached as a success.
    runtime.invalidateSearchCaches()
    officialFailure = true
    fallbackFailure = true
    const failed = await snapshotFused({})
    assert.equal(failed.communityExecution.outcome, 'failed')
    assert.equal(failed.communityExecution.reason, 'channel_failures')
    assert.equal(failed.communityExecution.cacheHit, false)
    const firstDispatch = officialCalls.count
    runtime.invalidateSearchCaches()
    officialFailure = true
    fallbackFailure = true
    const failedAgain = await snapshotFused({})
    assert.equal(failedAgain.communityExecution.outcome, 'failed')
    assert.equal(officialCalls.count, firstDispatch + 1, 'a failed community run is not cached, so the next call dispatches again')

    // Every dispatched engine failed: failed, never a clean empty result.
    runtime.invalidateSearchCaches()
    auth = false
    fallbackFailure = false
    engineFailure = new Set(ENGINE_POOLS.free)
    const enginesDown = await snapshotFused({})
    assert.equal(enginesDown.communityExecution.outcome, 'failed')
    assert.equal(enginesDown.communityExecution.reason, 'engine_failures')

    // No engine can be dispatched at all: unavailable, not a silent empty result.
    runtime.invalidateSearchCaches()
    enabled = new Set()
    engineFailure = new Set()
    const noEngines = await snapshotFused({ community: true, engineList: ['bing'] })
    assert.equal(noEngines.communityExecution.outcome, 'unavailable')
    assert.equal(noEngines.communityExecution.reason, 'no_engines')
    assertExecutionContract(noEngines.communityExecution)

    // Hosted channel answers while the fallback leg is down: partial.
    runtime.invalidateSearchCaches()
    enabled = new Set(ENGINE_POOLS.hybrid)
    auth = true
    officialFailure = false
    officialEmpty = false
    officialPosts = [post('carol', 3)]
    fallbackFailure = true
    const webDown = await snapshotFused({})
    assert.equal(webDown.communityExecution.outcome, 'partial')
    assert.equal(webDown.communityExecution.reason, 'fallback_failed')
    assertExecutionContract(webDown.communityExecution)
  })

  await test('oEmbed enhancement failure keeps base posts, is disclosed, and never becomes partial', async () => {
    oembedStatus = 'fail'
    auth = false
    xPosts = [post('alice', 1), post('bob', 2)]
    const direct = await xSearchDirect()
    assert.equal(direct.communityExecution.outcome, 'succeeded')
    assert.equal(direct.communityExecution.usage.enhancementAttempts, 2)
    assert.equal(direct.communityExecution.usage.enhancementErrors, 2)
    assert.match(direct.note ?? '', /oEmbed enhancement/)
    assert.ok(direct.items.every((item) => item.text.length > 0 && !item.text.includes('oEmbed full text')), 'base engine text is retained, never upgraded or claimed as full text')
    assertExecutionContract(direct.communityExecution)

    runtime.invalidateSearchCaches()
    const fusedOut = await snapshotFused({})
    assert.equal(fusedOut.communityExecution.outcome, 'succeeded')
    assert.ok(fusedOut.warnings.some((warning) => /oEmbed enhancement/.test(warning)))

    oembedStatus = 'ok'
    runtime.invalidateSearchCaches()
    const upgraded = await xSearchDirect()
    assert.equal(upgraded.communityExecution.usage.enhancementErrors, 0)
    assert.ok(upgraded.items.some((item) => item.text.includes('oEmbed full text')))
  })

  await test('cache and single-flight reuse keep the recorded outcome and never claim a fresh dispatch', async () => {
    auth = false
    engineFailure = new Set(['bing'])
    const first = await snapshotFused({})
    assert.equal(first.communityExecution.outcome, 'partial')
    assert.equal(first.communityExecution.cacheHit, false)
    assert.equal(first.communityExecution.usage.dispatchedNow, true)
    const second = await snapshotFused({})
    assert.equal(second.cacheHit, true, 'the snapshot result itself is reused')
    assert.equal(second.communityExecution.outcome, 'partial', 'a cached partial stays partial')
    assert.equal(second.communityExecution.cacheHit, true)
    assert.equal(second.communityExecution.usage.dispatchedNow, false)
    assert.equal(second.communityExecution.usage.logicCalls, 0)
    assert.equal(second.communityExecution.usage.officialAttempted, false)
    assert.equal(second.communityExecution.usage.fallbackAttempted, false)
    assert.equal(second.communityExecution.usage.engineRequests, 0)
    assert.equal(second.communityExecution.usage.enhancementAttempts, 0)
    assert.equal(second.communityExecution.usage.httpAttempts, 0)
    assert.equal(second.communityExecution.usage.tokens, 0)
    assert.equal(officialCalls.count, 0, 'the planned fallback never dispatched the hosted tool')

    runtime.invalidateSearchCaches()
    const dispatchesBefore = fallbackCalls.count
    const one = await xSearchDirect()
    assert.equal(fallbackCalls.count, dispatchesBefore + 1)
    const two = await xSearchDirect()
    assert.equal(two.cacheHit, true)
    assert.equal(two.communityExecution.cacheHit, true)
    assert.equal(two.communityExecution.inFlight, false)
    assert.equal(two.communityExecution.outcome, one.communityExecution.outcome)
    assert.equal(two.communityExecution.usage.dispatchedNow, false)
    assert.equal(two.communityExecution.usage.logicCalls, 0)
    assert.equal(fallbackCalls.count, dispatchesBefore + 1, 'no duplicate X dispatch on a cache hit')
  })

  await test('candidate cache entries without a channel record are incompatible, never reused as observation', async () => {
    auth = false
    const args = { type: 'keyword', query: 'alpha beta', max_results: 30 }
    const maxResults = 30
    const params = createXPipeline({ ...args, type: 'keyword' }, maxResults).params
    const stale = runtime.xSearchCacheKey('keyword', params, maxResults, snapshot().fingerprint, true)
    runtime.X_CACHE.keyword.set(stale, { via: 'parallel', credential: 'stale', items: [], results: 0, engineStats: {}, enginesUsed: [], cacheHit: false })
    const out = await xSearchDirect(args)
    assert.equal(out.cacheHit ?? false, false, 'a record-less candidate entry is not served as a cache hit')
    assert.ok(out.results > 0, 'the real channel run is recomputed')
    assert.ok(out.communityExecution)
    assert.equal(fallbackCalls.count, 1)

    const ordinaryKey = runtime.xSearchCacheKey('keyword', params, maxResults, snapshot().fingerprint, false)
    assert.notEqual(stale, ordinaryKey, 'candidate and ordinary x_search cache partitions stay separate')
  })

  await test('a concurrent candidate call reuses the in-flight run; ordinary x_search never joins it', async () => {
    let release
    officialHold = new Promise((resolve) => { release = resolve })
    const args = { type: 'keyword', query: 'alpha beta', max_results: 30 }
    const first = xSearchDirect(args)
    const second = xSearchDirect(args)
    const ordinary = runtime.runXSearch(args, { snapshot, officialSearch: fakeOfficial, fallbackSearch: fakeFallback })
    release()
    officialHold = null
    const [a, b, c] = await Promise.all([first, second, ordinary])
    assert.equal(b.inFlight, true)
    assert.equal(b.communityExecution.inFlight, true)
    assert.equal(b.communityExecution.cacheHit, false)
    assert.equal(b.communityExecution.usage.dispatchedNow, false)
    assert.equal(b.communityExecution.usage.officialAttempted, false)
    assert.equal(b.communityExecution.usage.fallbackAttempted, false)
    assert.equal(b.communityExecution.usage.engineRequests, 0)
    assert.equal(b.communityExecution.usage.httpAttempts, 0)
    assert.equal(a.communityExecution.outcome, b.communityExecution.outcome)
    assertExecutionContract(b.communityExecution)
    assert.ok(!('communityExecution' in c), 'ordinary x_search output keeps its public shape')
    assert.equal(officialCalls.count, 2, 'the ordinary call is a separate dispatch, not the candidate flight')
  })

  await test('snapshot and ordinary results never share a cache entry; community on/off stay partitioned', async () => {
    const ordinary = await runtime.runFused({ query: 'alpha beta', complexity: 'medium', engineList: ['bing'], maxResults: 6, community: true }, { snapshot, xSearch })
    const snapshotOut = await snapshotFused({ engineList: ['bing'], community: true })
    assert.equal(snapshotOut.cacheHit, false, 'a snapshot run must not read an ordinary fused entry')
    assert.ok(snapshotOut.communityExecution)
    assert.equal((await snapshotFused({ engineList: ['bing'], community: true })).cacheHit, true)
    assert.equal((await runtime.runFused({ query: 'alpha beta', complexity: 'medium', engineList: ['bing'], maxResults: 6, community: true }, { snapshot, xSearch })).cacheHit, true)
    const off = await snapshotFused({ engineList: ['bing'], community: false })
    assert.equal(off.cacheHit, false, 'community on/off never share a snapshot entry')
    assert.equal(off.communityExecution.outcome, 'not_requested')
    assert.equal(ordinary.communityExecution, undefined)
  })

  await test('one fused call runs every declared engine variant plus X in a single pass; usage growth never blocks', async () => {
    webRows = 20
    engineFailure = new Set()
    // hybrid pool × 3 declared variants = 24 web requests, plus the parallel X
    // fallback leg over the same requested engines = 8 more, 32 observed requests
    // in ONE fused call, past the removed 20-attempt / 16-logical / token caps.
    // Nothing here may stop the run, and no extra round may be issued.
    const out = await snapshotFused({ enginePool: 'hybrid', engineList: ENGINE_POOLS.hybrid, complexity: 'complex', ranking: 'balanced', queries: ['alpha beta guide', 'alpha beta benchmark'], maxResults: 32 })
    const webCalls = engineCalls.filter((call) => !call.query.startsWith('site:x.com'))
    const xCalls = engineCalls.filter((call) => call.query.startsWith('site:x.com'))
    assert.equal(webCalls.length, ENGINE_POOLS.hybrid.length * 3, 'every declared engine variant ran once')
    assert.equal(xCalls.length, ENGINE_POOLS.hybrid.length, 'the parallel X fallback leg ran once over the requested engines')
    assert.equal(engineCalls.length, webCalls.length + xCalls.length, 'no additional rounds, retries or loops')
    assert.equal(out.funnel.engineRowsRaw, ENGINE_POOLS.hybrid.length * 3 * 20, 'all declared variant rows were collected')
    assert.ok(out.funnel.uniqueCandidates > 32, 'more candidates than the cap were processed, not early-stopped')
    assert.equal(out.results.length, 32)
    assert.equal(out.truncated, true)
    assert.equal(out.communityExecution.outcome, 'succeeded')
    assert.equal(out.communityExecution.usage.engineRequests, ENGINE_POOLS.hybrid.length, 'usage is observed, not a gate')
  })

  await test('an aborted caller signal stops the snapshot and X chains before any dispatch', async () => {
    const controller = new AbortController()
    controller.abort(new Error('caller cancelled'))
    await assert.rejects(() => fused({ candidateSelection: 'snapshot', community: true, signal: controller.signal }))
    assert.equal(engineCalls.length, 0, 'no engine request is dispatched')
    assert.equal(officialCalls.count + fallbackCalls.count, 0, 'no X request is dispatched')
    await assert.rejects(() => runtime.runXSearch({ type: 'keyword', query: 'alpha beta' }, { signal: controller.signal, candidateMode: true, snapshot, officialSearch: fakeOfficial, fallbackSearch: fakeFallback }))
    assert.equal(officialCalls.count + fallbackCalls.count, 0)
  })

  await test('provider faults are attempted once per declared variant and reported, never retried into a loop', async () => {
    engineFailure = new Set(['bing'])
    const out = await snapshotFused({ engineList: ['bing', 'ddg'], complexity: 'medium', queries: ['alpha beta guide'] })
    const webCalls = engineCalls.filter((call) => !call.query.startsWith('site:x.com'))
    const xCalls = engineCalls.filter((call) => call.query.startsWith('site:x.com'))
    // medium = 2 declared variants → each requested engine is attempted once per
    // variant on the web leg and once by the parallel X leg, never retried into a loop.
    assert.equal(webCalls.filter((call) => call.name === 'bing').length, 2)
    assert.equal(webCalls.filter((call) => call.name === 'ddg').length, 2)
    assert.equal(xCalls.length, 2)
    assert.equal(out.engineStats.bing.successes, 0)
    assert.match(out.warnings.join(' '), /bing: 2\/2 attempts failed/)
    assert.ok(out.results.length > 0, 'healthy engine and X rows are still delivered as a real partial result')
  })

  await test('snapshot keeps upstream rows for judgement while ordinary fused keeps its own selection', async () => {    webRows = 6
    xPosts = []
    const ordinary = await runtime.runFused({ query: 'alpha beta', complexity: 'medium', engineList: ['bing', 'ddg'], maxResults: 32, maxResultsCap: 32 }, { snapshot, xSearch })
    assert.equal(ordinary.results.filter((row) => row.url.includes('bing-docs.example')).length, 2, 'ordinary sparse-domain cap is unchanged')
    runtime.invalidateSearchCaches()
    const snapshotOut = await snapshotFused({ community: true })
    const urls = snapshotOut.results.map((row) => row.url)
    assert.equal(new Set(urls).size, urls.length, 'duplicate links are deduped exactly once')
    assert.equal(urls.filter((url) => url.includes('docs.example')).length, 12, 'same-domain candidates stay in the declared snapshot')
    assert.ok(urls.some((url) => url.includes('x.com')), 'the community row shares the same declared snapshot')
    assert.ok(snapshotOut.results.every((row) => row.safetyState === undefined && row.valueLevel === undefined), 'the snapshot is pre-judgement: no screening state is invented or dropped here')
  })

  console.log(`\n${tests} N_off snapshot/community groups passed.`)
} finally {
  globalThis.fetch = originalFetch
  await closeFetchDispatchers()
  __setUndiciLoaderForTests(null)
  rmSync(temp, { recursive: true, force: true })
}
