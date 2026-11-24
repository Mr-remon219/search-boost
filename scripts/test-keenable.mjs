import './isolate-tests.mjs'
// Hermetic Keenable v1/search integration: wire contract and result mapping.
// Never uses a real credential or calls the live provider.
import assert from 'node:assert/strict'
import { mkdirSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'
import { engineRegistry } from '../lib/search/engines.js'
import { ENGINE_POOLS, resolveSearchRoute } from '../lib/search/routing.js'
import { ENGINE_BASE_URLS, engineSearchUrl } from '../lib/engine-endpoints.mjs'
import { __setUndiciLoaderForTests, closeFetchDispatchers } from '../lib/search/ipv4-fetch.js'
import { runFused, invalidateSearchCaches } from '../lib/runtime.mjs'
import { configNestedPath, configFlatPath } from '../lib/config-paths.mjs'
import { writeKeysFile, KEY_NAMES, ENV_MAP } from '../lib/keys.mjs'

const originalFetch = globalThis.fetch
__setUndiciLoaderForTests(async () => ({ ...await import('undici'), fetch: (...args) => globalThis.fetch(...args) }))
const calls = []
let respond = () => Response.json({ query: 'alpha', mode: 'pro', results: [] })
globalThis.fetch = async (raw, init = {}) => {
  const url = new URL(String(raw))
  assert.ok(['api.keenable.ai', 'gateway.example'].includes(url.hostname), `forbidden live/unmocked host: ${url.hostname}`)
  calls.push({ url, init, body: init.body ? JSON.parse(init.body) : null })
  return respond(url, init)
}
const lastCall = () => calls[calls.length - 1]
const reset = () => {
  invalidateSearchCaches(); calls.length = 0
  for (const file of [configNestedPath('keys'), configFlatPath('keys')]) {
    mkdirSync(dirname(file), { recursive: true })
    for (const suffix of ['', '.initialized', '.lock']) rmSync(file + suffix, { force: true })
  }
  delete process.env.KEENABLE_API_KEY
  respond = () => Response.json({ query: 'alpha', mode: 'pro', results: [] })
}
const results = (...rows) => Response.json({ query: 'alpha', mode: 'pro', results: rows })
const engine = (bases) => engineRegistry({ keenable: 'fixture-key' }, null, bases).keenable
let tests = 0
const test = async (name, fn) => { reset(); await fn(); tests++; console.log(`ok: ${name}`) }

try {
  await test('Keenable is a keyed api-pool engine with the documented endpoint', async () => {
    assert.equal(KEY_NAMES.includes('keenable'), true)
    assert.equal(ENV_MAP.keenable, 'KEENABLE_API_KEY')
    assert.equal(ENGINE_POOLS.free.includes('keenable'), false)
    assert.equal(ENGINE_POOLS.api.includes('keenable'), true)
    assert.equal(ENGINE_POOLS.hybrid.filter((n) => n === 'keenable').length, 1)
    assert.equal(ENGINE_BASE_URLS.keenable, 'https://api.keenable.ai')
    assert.equal(engineSearchUrl('keenable'), 'https://api.keenable.ai/v1/search')
    assert.equal(engineRegistry({}).keenable.available(), false)
    assert.equal(engine().available(), true)
    assert.equal(engineRegistry({ keenable: 'k' }, new Set()).keenable.available(), false)
  })

  await test('request sends POST, X-API-Key and a bounded max_results', async () => {
    respond = () => results({ url: 'https://a.example/1', title: 'A' })
    await engine().search('alpha beta', 7, { enginePool: 'api' })
    const { url, init, body } = lastCall()
    assert.equal(url.href, 'https://api.keenable.ai/v1/search')
    assert.equal(init.method, 'POST')
    assert.equal(init.headers['x-api-key'], 'fixture-key')
    assert.equal(init.headers['content-type'], 'application/json')
    assert.deepEqual(body, { query: 'alpha beta', max_results: 7 })
    assert.equal(init.redirect, 'error')
  })

  await test('max_results stays inside the documented 1..50 range', async () => {
    respond = () => results()
    for (const [asked, sent] of [[1, 1], [10, 10], [50, 50], [80, 50], [0, 1], [-3, 1]]) {
      await engine().search('alpha', asked)
      assert.equal(lastCall().body.max_results, sent, `count ${asked} must be sent as ${sent}`)
    }
  })

  await test('custom gateway keeps its path prefix', async () => {
    respond = () => results({ url: 'https://a.example/1' })
    await engine({ keenable: 'https://gateway.example/pool/v1/' }).search('alpha', 3)
    assert.equal(lastCall().url.href, 'https://gateway.example/pool/v1/v1/search')
    assert.equal(lastCall().url.hostname, 'gateway.example')
  })

  await test('documented results shape maps every field and keeps provider positions', async () => {
    respond = () => results(
      { title: '  First   title ', url: 'https://a.example/1', description: 'short summary', snippet: 'longer excerpt', published_at: '2026-01-02T03:04:05Z' },
      { title: 'Second', url: 'https://a.example/2', description: 'only a description' },
    )
    const rows = await engine().search('alpha', 5)
    assert.deepEqual(rows, [
      { providerRank: 1, title: 'First title', url: 'https://a.example/1', snippet: 'longer excerpt', published: '2026-01-02T03:04:05Z' },
      { providerRank: 2, title: 'Second', url: 'https://a.example/2', snippet: 'only a description', published: null },
    ])
  })

  await test('snippet falls back to description when the excerpt is absent', async () => {
    respond = () => results({ url: 'https://b.example/1', description: 'fallback text' })
    const rows = await engine().search('alpha', 5)
    assert.equal(rows[0].snippet, 'fallback text')
  })

  await test('rows without a url are dropped without renumbering survivors', async () => {
    respond = () => results({ title: 'no url' }, null, { url: 'https://c.example/3', title: 'Third' })
    const rows = await engine().search('alpha', 5)
    assert.equal(rows.length, 1)
    assert.equal(rows[0].url, 'https://c.example/3')
    assert.equal(rows[0].providerRank, 3, 'original provider position survives malformed neighbours')
  })

  await test('results are sliced to the requested count', async () => {
    respond = () => results(...Array.from({ length: 6 }, (_, i) => ({ url: `https://d.example/${i + 1}`, title: `T${i + 1}` })))
    const rows = await engine().search('alpha', 2)
    assert.deepEqual(rows.map((r) => r.url), ['https://d.example/1', 'https://d.example/2'])
  })

  await test('an empty results array is a successful empty retrieval', async () => {
    respond = () => results()
    assert.deepEqual(await engine().search('alpha', 3), [])
  })

  await test('HTTP errors and malformed envelopes stay safe and never echo bodies', async () => {
    for (const status of [400, 401, 403, 429, 500]) {
      respond = () => new Response('SECRET error body', { status })
      await assert.rejects(engine().search('alpha', 3), (err) => err.message === `keenable http ${status}`)
    }
    respond = () => new Response('SECRET malformed JSON')
    await assert.rejects(engine().search('alpha', 3), (err) => {
      assert.equal(err.message, 'keenable: invalid JSON response')
      assert.equal(err.message.includes('SECRET'), false)
      return true
    })
    for (const value of [{ error: 'Authentication failed', message: 'SECRET' }, {}, { results: {} }, { results: 'nope' }, null]) {
      respond = () => Response.json(value)
      await assert.rejects(engine().search('alpha', 3), (err) => {
        assert.equal(err.message, 'keenable: invalid or unsuccessful response')
        assert.equal(err.message.includes('SECRET'), false)
        return true
      })
    }
  })

  await test('a missing key is refused locally without a request', async () => {
    await assert.rejects(engineRegistry({}).keenable.search('alpha', 3), /missing API key/)
    assert.equal(calls.length, 0)
  })

  await test('fused_search reports provider failure instead of a silent empty result', async () => {
    writeKeysFile({ keenable: 'fixture-key' })
    respond = () => Response.json({ error: 'Internal failure', message: 'SECRET provider detail' })
    const failed = await runFused({ query: 'alpha', enginePool: 'api', engineList: ['keenable'], complexity: 'simple' })
    assert.equal(failed.engineStats.keenable.errors, 1)
    assert.equal(failed.engineStats.keenable.successes, 0)
    assert.match(failed.warnings.join(' '), /keenable: 1\/1 attempts failed/)
    assert.equal(JSON.stringify(failed).includes('SECRET'), false)
  })

  await test('fused_search maps a real envelope into ranked evidence', async () => {
    writeKeysFile({ keenable: 'fixture-key' })
    respond = () => results(
      { title: 'Alpha result', url: 'https://g.example/1', snippet: 'alpha evidence' },
      { title: 'Second', url: 'https://g.example/2', description: 'more evidence' },
    )
    const out = await runFused({ query: 'alpha', enginePool: 'api', engineList: ['keenable'], complexity: 'simple' })
    assert.deepEqual(out.enginesUsed, ['keenable'])
    assert.equal(out.engineStats.keenable.successes, 1)
    assert.equal(out.results[0].engineRanks.keenable, 1)
    assert.equal(out.results[0].provenance[0].engine, 'keenable')
  })

  await test('routing excludes Keenable without a key and warns instead of falling back', async () => {
    const route = resolveSearchRoute({ enginePool: 'api', engines: engineRegistry({}) })
    assert.equal(route.engineNames.includes('keenable'), false)
    assert.match(route.warnings.join(' '), /keenable unavailable/)
    assert.equal(calls.length, 0)
  })

  console.log(`\n${tests} Keenable integration groups passed (no live API calls).`)
} finally {
  globalThis.fetch = originalFetch
  await closeFetchDispatchers(); __setUndiciLoaderForTests(null)
}
