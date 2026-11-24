import './isolate-tests.mjs'
// Hermetic TinyFish Search integration: actual transport, config and routing;
// never use real credentials or call a live provider.
import assert from 'node:assert/strict'
import * as z from 'zod'
import { fusedSearchInput } from '../adapters/mcp/schemas.mjs'
import { NET_ERROR_KINDS } from '../lib/search/net-policy.mjs'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { engineRegistry, ENGINE_ORDER } from '../lib/search/engines.js'
import { ENGINE_POOLS, FUSED_ROUTING_PROPERTIES, resolveSearchRoute } from '../lib/search/routing.js'
import { engineSearchUrl } from '../lib/engine-endpoints.mjs'
import { __setUndiciLoaderForTests, closeFetchDispatchers } from '../lib/search/ipv4-fetch.js'
import { runFused, invalidateSearchCaches } from '../lib/runtime.mjs'
import { runtimeSnapshot } from '../lib/search/capability.js'
import { configNestedPath, configFlatPath } from '../lib/config-paths.mjs'
import { readKeys, readKeysRouting, keyStatus, writeKeysFile, unsetKey, KEY_NAMES, ENV_MAP } from '../lib/keys.mjs'
import { runKeysWizard, formatKeyStatusLines } from '../lib/installer/keys-wizard.mjs'
import { checkApiKeyedPool, checkFreeEnginePool } from '../lib/doctor/checks/engines.mjs'

const originalFetch = globalThis.fetch
__setUndiciLoaderForTests(async () => ({ ...await import('undici'), fetch: (...args) => globalThis.fetch(...args) }))
const calls = []
const hit = (position, url = `https://docs.example/${position}`) => ({ position, url, title: ' Alpha title ', snippet: ' alpha evidence ', date: '2026-10-01' })
let respond = () => Response.json({ results: [hit(1)] })
globalThis.fetch = async (raw, init = {}) => {
  const url = new URL(String(raw))
  assert.ok(['api.search.tinyfish.ai', 'gateway.example'].includes(url.hostname), `forbidden live/unmocked host: ${url.hostname}`)
  calls.push({ url, init })
  return respond(url, init)
}
const reset = () => {
  invalidateSearchCaches(); calls.length = 0
  for (const file of [configNestedPath('keys'), configFlatPath('keys')]) {
    for (const suffix of ['', '.initialized', '.lock']) rmSync(file + suffix, { force: true })
  }
  delete process.env.TINYFISH_API_KEY
  respond = () => Response.json({ results: [hit(1)] })
}
const route = (pool, keys = { tinyfish: 'fixture-key' }, enabled = null, extra = {}) => resolveSearchRoute({ enginePool: pool, engines: engineRegistry(keys, enabled), ...extra })
let tests = 0
const test = async (name, fn) => { reset(); await fn(); tests++; console.log(`ok: ${name}`) }
try {
  await test('TinyFish is keyed API-only; Yahoo is removed; overrides retain cross-pool semantics', async () => {
    assert.equal(KEY_NAMES.includes('tinyfish'), true)
    assert.equal(ENV_MAP.tinyfish, 'TINYFISH_API_KEY')
    assert.equal(ENGINE_POOLS.free.includes('tinyfish'), false)
    assert.equal(ENGINE_POOLS.api.includes('tinyfish'), true)
    assert.equal(ENGINE_POOLS.hybrid.filter(n => n === 'tinyfish').length, 1)
    assert.equal(ENGINE_ORDER.includes('yahoo'), false)
    assert.equal(FUSED_ROUTING_PROPERTIES.engines.items.enum.includes('yahoo'), false)
    assert.equal(Object.hasOwn(FUSED_ROUTING_PROPERTIES.engine_weights.properties, 'yahoo'), false)
    const input = z.object(fusedSearchInput)
    assert.equal(input.safeParse({ query: 'alpha', engines: ['tinyfish'], engine_weights: { tinyfish: 1 } }).success, true)
    assert.equal(input.safeParse({ query: 'alpha', engines: ['yahoo'] }).success, false)
    assert.equal(input.safeParse({ query: 'alpha', engine_weights: { yahoo: 1 } }).success, false)
    for (const pool of ['free', 'api', 'hybrid']) {
      assert.equal(route(pool).engineNames.includes('tinyfish'), pool !== 'free')
      assert.equal(route(pool, {}).engineNames.includes('tinyfish'), false)
      assert.equal(route(pool, { tinyfish: 'fixture-key' }, new Set()).engineNames.includes('tinyfish'), false)
    }
    assert.deepEqual(route('free', undefined, null, { engineList: ['tinyfish'] }).effectiveWeights, { tinyfish: 1 })
    assert.throws(() => route('api', undefined, null, { engineList: ['yahoo'] }), /Unknown search engine/)
    assert.throws(() => route('api', undefined, null, { engineWeights: { yahoo: 0 } }), /Invalid engine_weights/)
    const out = await runFused({ query: 'alpha', enginePool: 'api', engineList: ['tinyfish'] })
    assert.deepEqual(out.enginesUsed, [])
    assert.match(out.warnings.join(' '), /tinyfish unavailable/)
    assert.equal(calls.length, 0)
  })

  await test('documented GET, root path, key header, encoding, native domains and recency', async () => {
    const engine = engineRegistry({ tinyfish: 'fixture-key' }).tinyfish
    assert.equal(engine.nativeDomains, true)
    for (const [recency, minutes] of Object.entries({ day: 1440, week: 10080, month: 43200, year: 525600 })) {
      await engine.search('中文 & C++ / docs?', 20, { recency, includeDomains: ['docs.example', 'github.com'], excludeDomains: ['noise.example'], depth: 'advanced' })
      const { url, init } = calls.at(-1)
      assert.equal(url.origin, 'https://api.search.tinyfish.ai')
      assert.equal(url.pathname, '/')
      assert.equal(url.searchParams.get('query'), '中文 & C++ / docs?')
      assert.equal(url.searchParams.get('include_domains'), 'docs.example,github.com')
      assert.equal(url.searchParams.get('exclude_domains'), 'noise.example')
      assert.equal(url.searchParams.get('recency_minutes'), String(minutes))
      assert.deepEqual([...url.searchParams.keys()].sort(), ['exclude_domains', 'include_domains', 'query', 'recency_minutes'])
      assert.equal(init.method, 'GET')
      assert.equal(init.body, undefined)
      assert.equal(init.headers['X-API-Key'], 'fixture-key')
      assert.ok(init.signal instanceof AbortSignal)
    }
    await engine.search('alpha', 5)
    assert.equal(calls.at(-1).url.search, '?query=alpha')
    assert.equal(calls.length, 5, 'no pagination/fetch/retry for a large count')
    const custom = engineRegistry({ tinyfish: 'fixture-key' }, null, { tinyfish: 'https://gateway.example/prefix/v1///' })
    assert.equal(engineSearchUrl('tinyfish', { tinyfish: 'https://gateway.example/prefix/v1///' }), 'https://gateway.example/prefix/v1/')
    await custom.tinyfish.search('alpha', 3)
    assert.equal(calls.at(-1).url.pathname, '/prefix/v1/')
    assert.equal(calls.at(-1).init.headers['X-API-Key'], 'fixture-key')
  })

  await test('provider positions survive malformed cards, slicing, duplicate URLs and domain filtering', async () => {
    respond = () => Response.json({ results: [null, hit(1, 'javascript:bad'), hit(7), hit(20), hit(30, 'https://other.example/doc'), { ...hit(2), position: 0 }] })
    const rows = await engineRegistry({ tinyfish: 'fixture-key' }).tinyfish.search('alpha', 2)
    assert.deepEqual(rows.map(r => r.providerRank), [7, 20])
    assert.equal(rows[0].title, 'Alpha title')
    assert.equal(rows[0].published, '2026-10-01')
    writeKeysFile({ tinyfish: 'fixture-key' })
    const out = await runFused({ query: 'alpha site:docs.example', enginePool: 'api', complexity: 'simple', maxResults: 5 })
    assert.ok(out.results.length > 0)
    assert.ok(out.results.every(r => r.domain === 'docs.example'))
    assert.deepEqual(out.results.map(r => r.engineRanks.tinyfish).sort((a, b) => a - b), [7, 20])
    assert.equal(calls.at(-1).url.searchParams.get('query'), 'alpha', 'native domains do not get duplicated site hints')
    assert.equal(calls.at(-1).url.searchParams.get('include_domains'), 'docs.example')
    respond = () => Response.json({ results: [hit(8, 'https://docs.example/shared'), hit(3, 'https://docs.example/shared'), { ...hit(10), date: undefined }] })
    const dedup = await runFused({ query: 'alpha duplicate', enginePool: 'api', complexity: 'simple' })
    assert.equal(dedup.results.find(r => r.url.endsWith('/shared')).engineRanks.tinyfish, 3)
    assert.equal(dedup.results.find(r => r.url.endsWith('/10')).published, undefined, 'public results omit unknown dates')
  })

  await test('each variant uses one request; caches, overrides and key/base changes are isolated', async () => {
    writeKeysFile({ tinyfish: 'fixture-key' })
    const args = { query: 'alpha', queries: ['alpha guide', 'alpha release'], enginePool: 'api', complexity: 'complex' }
    const first = await runFused(args)
    assert.deepEqual(first.enginesUsed, ['tinyfish'])
    assert.equal(first.engineStats.tinyfish.attempts, 3)
    assert.equal(calls.length, 3)
    assert.equal((await runFused(args)).cacheHit, true)
    assert.equal(calls.length, 3)
    const before = first.results[0].score
    const custom = await runFused({ ...args, engineWeights: { tinyfish: .5 } })
    assert.equal(custom.cacheHit, false)
    assert.ok(custom.results[0].score < before)
    assert.equal(calls.length, 6)
    const zero = await runFused({ ...args, engineWeights: { tinyfish: 0 } })
    assert.equal(calls.length, 9, 'zero weight still invokes the engine')
    assert.deepEqual(zero.results, [])
    const fingerprint = runtimeSnapshot().fingerprint
    writeKeysFile({ tinyfish: 'replacement-fixture-key', baseUrls: { tinyfish: 'https://gateway.example/api' } })
    assert.notEqual(runtimeSnapshot().fingerprint, fingerprint)
    assert.equal((await runFused(args)).cacheHit, false)
    assert.equal(calls.at(-1).url.pathname, '/api/')
    assert.equal(calls.at(-1).init.headers['X-API-Key'], 'replacement-fixture-key')
    const controller = new AbortController(); controller.abort()
    const n = calls.length
    await assert.rejects(runFused({ ...args, signal: controller.signal }))
    assert.equal(calls.length, n)
  })

  await test('TinyFish-only canonical store wins over stale copies; env, masking, CLI and disabling work', async () => {
    const canonical = configNestedPath('keys')
    mkdirSync(dirname(canonical), { recursive: true })
    writeFileSync(canonical, JSON.stringify({ tinyfish: 'tinyfish-fixture-secret-123456' }))
    writeFileSync(configFlatPath('keys'), JSON.stringify({ tavily: 'stale-fixture-key' }))
    assert.equal(readKeys().tinyfish, 'tinyfish-fixture-secret-123456')
    assert.equal(readKeys().tavily, undefined)
    assert.deepEqual(readKeysRouting().enabledNames, ['tinyfish'])
    assert.equal(keyStatus().tinyfish.source, 'file')
    assert.ok(formatKeyStatusLines().join('\n').includes('tinyfish'))
    assert.ok(!formatKeyStatusLines().join('\n').includes('tinyfish-fixture-secret'))
    const cap = runtimeSnapshot().capability
    assert.ok(cap.pools.api.includes('tinyfish') && cap.pools.hybrid.includes('tinyfish'))
    assert.equal(cap.pools.free.includes('tinyfish'), false)
    assert.equal(cap.availableEngines.includes('yahoo'), false)
    assert.ok(!JSON.stringify(cap).includes('fixture-secret'))
    assert.deepEqual(checkApiKeyedPool({}).details.available, ['tinyfish'])
    assert.ok(!checkFreeEnginePool({}).details.available.includes('yahoo'))
    writeKeysFile({ enabledEngines: ['tavily'] })
    assert.equal(runtimeSnapshot().capability.availableEngines.includes('tinyfish'), false, 'old whitelist is never expanded')
    await runKeysWizard(null, { engines: 'tinyfish', baseUrls: { tinyfish: 'https://gateway.example/v1' } })
    assert.equal(runtimeSnapshot().capability.availableEngines.includes('tinyfish'), true)
    await runKeysWizard(null, { disable: ['tinyfish'] })
    assert.equal(runtimeSnapshot().capability.availableEngines.includes('tinyfish'), false)
    unsetKey('tinyfish')
    assert.equal(readKeys().tinyfish, undefined, 'deleting last key must not resurrect old files')
    assert.equal(readKeys().tavily, undefined)
    process.env.TINYFISH_API_KEY = 'env-fixture-key'
    assert.equal(keyStatus().tinyfish.source, 'env')
    assert.equal(runtimeSnapshot().capability.availableEngines.includes('tinyfish'), false, 'environment key does not bypass routing')
    await runKeysWizard(null, { enable: ['tinyfish'] })
    assert.equal(runtimeSnapshot().capability.availableEngines.includes('tinyfish'), true)
  })

  await test('in-flight cancellation reaches the transport, and response size limits survive JSON parsing', async () => {
    const engine = engineRegistry({ tinyfish: 'fixture-key' }).tinyfish
    const controller = new AbortController()
    let reached
    const started = new Promise(resolve => { reached = resolve })
    respond = (_url, init) => new Promise((_resolve, reject) => {
      assert.equal(init.signal.aborted, false)
      init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true })
      reached()
    })
    const pending = engine.search('alpha', 3, { signal: controller.signal })
    const rejection = assert.rejects(pending, err => err.name === 'AbortError' || err.kind === NET_ERROR_KINDS.cancelled)
    await started; controller.abort(); await rejection
    assert.equal(calls.length, 1)
    assert.equal(calls[0].init.signal.aborted, true)
    respond = () => new Response('x'.repeat(8_000_001))
    await assert.rejects(engine.search('alpha', 3), err => err.kind === NET_ERROR_KINDS.responseTooLarge)
  })

  await test('HTTP/access/quota and invalid responses are safe, never retried or treated as empty success', async () => {
    const engine = engineRegistry({ tinyfish: 'fixture-key' }).tinyfish
    for (const status of [401, 402, 403, 429, 500, 503]) {
      const before = calls.length
      respond = () => {
        const res = new Response('key=SECRET server message', { status, headers: { 'retry-after': '60' } })
        res.text = res.json = res.body.getReader = () => { throw new Error('error body must not be read') }
        return res
      }
      await assert.rejects(engine.search('alpha', 3), err => err.message === `tinyfish http ${status}${status === 429 ? '; retry after 60s' : ''}`)
      assert.equal(calls.length, before + 1)
    }
    respond = () => new Response('SECRET malformed JSON')
    await assert.rejects(engine.search('alpha', 3), err => err.message === 'tinyfish: invalid JSON response')
    for (const value of [{ error: { message: 'SECRET' }, results: [] }, {}, { results: {} }, null]) {
      respond = () => Response.json(value)
      await assert.rejects(engine.search('alpha', 3), err => err.message === 'tinyfish: invalid or unsuccessful response')
    }
    respond = () => Response.json({ results: [] })
    assert.deepEqual(await engine.search('alpha', 3), [])
    await assert.rejects(engineRegistry({}).tinyfish.search('alpha', 3), /missing API key/)
    writeKeysFile({ tinyfish: 'fixture-key' })
    respond = () => new Response('SECRET', { status: 429 })
    const failed = await runFused({ query: 'alpha', enginePool: 'api', complexity: 'simple' })
    assert.equal(failed.engineStats.tinyfish.errors, 1)
    assert.match(failed.warnings.join(' '), /tinyfish http 429/)
    assert.equal(JSON.stringify(failed).includes('SECRET'), false)
  })
  console.log(`\n${tests} TinyFish Search integration groups passed (no live API calls).`)
} finally {
  globalThis.fetch = originalFetch
  await closeFetchDispatchers(); __setUndiciLoaderForTests(null)
}
