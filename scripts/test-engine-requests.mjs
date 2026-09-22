import { __setUndiciLoaderForTests, closeFetchDispatchers } from '../lib/search/ipv4-fetch.js'
// Engine request bodies — assert what actually goes on the wire.
//
// A parameter an adapter drops, renames or misspells is invisible to a test that
// only reads the adapter's return value, so these cases inspect the real HTTP
// body. Hermetic: globalThis.fetch is replaced, no key is used against a live API.
import assert from 'node:assert/strict'

const { engineRegistry } = await import('../lib/search/engines.js')

const originalFetch = globalThis.fetch
__setUndiciLoaderForTests(async () => ({ ...await import('undici'), fetch: (...args) => globalThis.fetch(...args) }))
const calls = []
globalThis.fetch = async (input, init = {}) => {
  calls.push({ url: new URL(String(input)), body: init.body ? JSON.parse(init.body) : null, headers: init.headers })
  return new Response(JSON.stringify({ results: [], web: { results: [] }, code: 0, data: { results: [{ title: '', url: 'https://example.org/doc', snippet: 'summary', content: 'body' }] } }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}
let count = 0
const test = async (name, fn) => { await fn(); count++; console.log(`ok: ${name}`) }
const lastCall = () => calls[calls.length - 1]

try {
  const engines = engineRegistry({ exa: 'fixture-key', tavily: 'fixture-key', brave: 'fixture-key' })

  await test('exa sends the documented startPublishedDate for recency', async () => {
    await engines.exa.search('fixture query', 3, { recency: 'week' })
    const { url, body } = lastCall()
    assert.equal(url.href, 'https://api.exa.ai/search')
    assert.equal(body.query, 'fixture query')
    assert.equal(body.publishedAfter, undefined, 'publishedAfter is not part of the Exa search schema')
    assert.match(body.startPublishedDate, /^\d{4}-\d{2}-\d{2}/)
    const days = Math.round((Date.now() - Date.parse(body.startPublishedDate)) / 86_400_000)
    assert.ok(days >= 6 && days <= 8, `week recency should reach back ~7 days, got ${days}`)
  })

  await test('exa omits the date filter when no recency was requested', async () => {
    await engines.exa.search('fixture query', 3, {})
    assert.equal(lastCall().body.startPublishedDate, undefined)
  })

  await test('tavily and brave keep their own documented recency fields', async () => {
    await engines.tavily.search('fixture query', 3, { recency: 'month' })
    assert.equal(lastCall().body.time_range, 'month')
    await engines.brave.search('fixture query', 3, { recency: 'month' })
    assert.equal(lastCall().url.searchParams.get('freshness'), 'pm')
  })

  await test('AnySearch pool readiness, optional auth and bounded documented envelope', async () => {
    const anonymous = engineRegistry({}).anysearch
    assert.equal(anonymous.available(), true)
    assert.equal(anonymous.availableForPool('api'), false)
    assert.equal(engineRegistry({}, new Set()).anysearch.available(), false)
    const keyed = engineRegistry({ anysearch: 'fixture-key' }).anysearch
    for (const pool of ['free', 'api', 'hybrid']) {
      const rows = await keyed.search('fixture query', 20, { enginePool: pool })
      assert.equal(lastCall().url.href, 'https://api.anysearch.com/v1/search')
      assert.deepEqual(lastCall().body, { query: 'fixture query', max_results: 10, format: 'json' })
      assert.equal(lastCall().headers.authorization, pool === 'free' ? undefined : 'Bearer fixture-key')
      assert.equal(rows[0].content, 'body')
    }
    await anonymous.search('query', 3, { enginePool: 'hybrid' })
    assert.equal(lastCall().headers.authorization, undefined)
  })
  await test('AnySearch runtime forwards pool auth and caches anonymous/keyed requests separately', async () => {
    const { runFused, invalidateSearchCaches } = await import('../lib/runtime.mjs')
    invalidateSearchCaches()
    const engines = engineRegistry({ anysearch: 'fixture-key' })
    const snapshot = () => ({ engines, fingerprint: 'anysearch-fixture', capability: { x: { official: { available: false } } } })
    for (const pool of ['free', 'api', 'hybrid']) {
      const before = calls.length
      const out = await runFused({ query: 'fixture', enginePool: pool, engineList: ['anysearch'], complexity: 'simple' }, { snapshot })
      assert.equal(calls.length, before + 1)
      assert.equal(lastCall().headers.authorization, pool === 'free' ? undefined : 'Bearer fixture-key')
      assert.equal(out.results[0].engineRanks.anysearch, 1)
      assert.equal(out.results[0].scoreVersion, 'consensus-v2.1')
      assert.equal((await runFused({ query: 'fixture', enginePool: pool, engineList: ['anysearch'], complexity: 'simple' }, { snapshot })).cacheHit, true)
    }
    invalidateSearchCaches()
  })
  await test('JSON API adapters preserve positions before dropping malformed result entries', async () => {
    const saved = globalThis.fetch
    try {
      globalThis.fetch = async () => Response.json({ code: 0, data: { results: [null, { title: 'valid', url: 'https://example.org' }] } })
      const rows = await engineRegistry({}).anysearch.search('fixture', 5)
      assert.equal(rows.length, 1)
      assert.equal(rows[0].providerRank, 2)
    } finally { globalThis.fetch = saved }
  })
  await test('AnySearch quota/business/malformed errors never echo credential-bearing bodies', async () => {
    const saved = globalThis.fetch
    try {
      for (const status of [401, 402, 403, 429, 502]) {
        globalThis.fetch = async () => new Response('username=SECRET password=SECRET api_key=SECRET', { status })
        await assert.rejects(() => engineRegistry({}).anysearch.search('query', 3), (err) => err.message === `anysearch http ${status}`)
      }
      globalThis.fetch = async () => Response.json({ code: -1, message: 'api_key=SECRET', data: { results: [] } })
      await assert.rejects(() => engineRegistry({}).anysearch.search('query', 3), /invalid or unsuccessful response/)
      globalThis.fetch = async () => new Response('SECRET malformed')
      await assert.rejects(() => engineRegistry({}).anysearch.search('query', 3), (err) => err.message === 'anysearch: invalid JSON response')
    } finally { globalThis.fetch = saved }
  })

  console.log(`\n${count} engine request tests passed.`)
} finally {
  globalThis.fetch = originalFetch
  await closeFetchDispatchers(); __setUndiciLoaderForTests(null)
}
