import './isolate-tests.mjs'
// Hermetic Firecrawl v2/search integration: wire contract and result mapping.
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
let respond = () => Response.json({ success: true, data: { web: [] } })
globalThis.fetch = async (raw, init = {}) => {
  const url = new URL(String(raw))
  assert.ok(['api.firecrawl.dev', 'gateway.example'].includes(url.hostname), `forbidden live/unmocked host: ${url.hostname}`)
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
  delete process.env.FIRECRAWL_API_KEY
  respond = () => Response.json({ success: true, data: { web: [] } })
}
const web = (...rows) => Response.json({ success: true, data: { web: rows } })
const engine = (bases) => engineRegistry({ firecrawl: 'fixture-key' }, null, bases).firecrawl
let tests = 0
const test = async (name, fn) => { reset(); await fn(); tests++; console.log(`ok: ${name}`) }

try {
  await test('Firecrawl is a keyed api-pool engine with the documented endpoint', async () => {
    assert.equal(KEY_NAMES.includes('firecrawl'), true)
    assert.equal(ENV_MAP.firecrawl, 'FIRECRAWL_API_KEY')
    assert.equal(ENGINE_POOLS.free.includes('firecrawl'), false)
    assert.equal(ENGINE_POOLS.api.includes('firecrawl'), true)
    assert.equal(ENGINE_POOLS.hybrid.filter((n) => n === 'firecrawl').length, 1)
    assert.equal(ENGINE_BASE_URLS.firecrawl, 'https://api.firecrawl.dev')
    assert.equal(engineSearchUrl('firecrawl'), 'https://api.firecrawl.dev/v2/search')
    assert.equal(engineRegistry({}).firecrawl.available(), false)
    assert.equal(engine().available(), true)
    assert.equal(engineRegistry({ firecrawl: 'k' }, new Set()).firecrawl.available(), false)
  })

  await test('request uses POST, Bearer auth and the documented limit field', async () => {
    respond = () => web({ url: 'https://a.example/1', title: 'A' })
    await engine().search('alpha beta', 7, { enginePool: 'api' })
    const { url, init, body } = lastCall()
    assert.equal(url.href, 'https://api.firecrawl.dev/v2/search')
    assert.equal(init.method, 'POST')
    assert.equal(init.headers.authorization, 'Bearer fixture-key')
    assert.equal(init.headers['content-type'], 'application/json')
    assert.deepEqual(body, { query: 'alpha beta', limit: 7 })
    // Credential-bearing service requests must never follow a cross-origin hop.
    assert.equal(init.redirect, 'error')
  })

  await test('custom gateway keeps its path prefix', async () => {
    respond = () => web({ url: 'https://a.example/1' })
    await engine({ firecrawl: 'https://gateway.example/pool/v2/' }).search('alpha', 3)
    assert.equal(lastCall().url.href, 'https://gateway.example/pool/v2/v2/search')
    assert.equal(lastCall().url.hostname, 'gateway.example')
  })

  await test('documented v2 shape maps data.web rows and preserves provider positions', async () => {
    respond = () => web(
      { url: 'https://a.example/1', title: '  First   title ', description: 'first description', position: 1 },
      { url: 'https://a.example/2', title: 'Second', description: 'second description', position: 2 },
    )
    const rows = await engine().search('alpha', 5)
    assert.deepEqual(rows, [
      { providerRank: 1, title: 'First title', url: 'https://a.example/1', snippet: 'first description', content: undefined, published: null },
      { providerRank: 2, title: 'Second', url: 'https://a.example/2', snippet: 'second description', content: undefined, published: null },
    ])
  })

  await test('a bare data array is accepted as well', async () => {
    respond = () => Response.json({ success: true, data: [{ url: 'https://b.example/1', title: 'Bare' }] })
    const rows = await engine().search('alpha', 5)
    assert.equal(rows.length, 1)
    assert.equal(rows[0].url, 'https://b.example/1')
    assert.equal(rows[0].providerRank, 1)
  })

  await test('rows without a url are dropped without renumbering survivors', async () => {
    respond = () => web(
      { title: 'no url' },
      null,
      { url: 'https://c.example/3', title: 'Third' },
    )
    const rows = await engine().search('alpha', 5)
    assert.equal(rows.length, 1)
    assert.equal(rows[0].url, 'https://c.example/3')
    assert.equal(rows[0].providerRank, 3, 'original provider position survives malformed neighbours')
  })

  await test('results are sliced to the requested count', async () => {
    respond = () => web(...Array.from({ length: 6 }, (_, i) => ({ url: `https://d.example/${i + 1}`, title: `T${i + 1}` })))
    const rows = await engine().search('alpha', 2)
    assert.deepEqual(rows.map((r) => r.url), ['https://d.example/1', 'https://d.example/2'])
  })

  await test('published falls back to the news-style date field', async () => {
    respond = () => web(
      { url: 'https://e.example/1', publishedDate: '2026-01-02T00:00:00Z' },
      { url: 'https://e.example/2', date: '2 days ago' },
      { url: 'https://e.example/3' },
    )
    const rows = await engine().search('alpha', 5)
    assert.deepEqual(rows.map((r) => r.published), ['2026-01-02T00:00:00Z', '2 days ago', null])
  })

  await test('markdown supplies content and snippet only when the gateway returns it', async () => {
    respond = () => web({ url: 'https://f.example/1', markdown: 'long body text' })
    const rows = await engine().search('alpha', 5)
    assert.equal(rows[0].content, 'long body text')
    assert.equal(rows[0].snippet, 'long body text')
    assert.equal(rows[0].title, '')
  })

  await test('a 200 envelope with success:false is a failure, never an empty success', async () => {
    respond = () => Response.json({ success: false, error: 'SECRET provider detail' })
    await assert.rejects(engine().search('alpha', 3), (err) => {
      assert.equal(err.message, 'firecrawl: unsuccessful response')
      assert.equal(err.message.includes('SECRET'), false)
      return true
    })
  })

  await test('a success envelope without a usable data shape is a failure, not an empty result', async () => {
    // A provider/gateway that answers 200 but omits the result container must not
    // be counted as a successful empty retrieval. Legitimate empty shapes stay empty.
    for (const payload of [
      { success: true },
      { success: true, data: null },
      { success: true, data: 'not-an-array' },
      { success: true, data: { news: [{ url: 'https://n.example/1' }] } },
      {},
    ]) {
      respond = () => Response.json(payload)
      await assert.rejects(engine().search('alpha', 3), (err) => {
        assert.equal(err.message, 'firecrawl: invalid or unsuccessful response', `payload ${JSON.stringify(payload)}`)
        return true
      })
    }
    for (const payload of [{ success: true, data: [] }, { success: true, data: { web: [] } }]) {
      respond = () => Response.json(payload)
      assert.deepEqual(await engine().search('alpha', 3), [], `payload ${JSON.stringify(payload)} stays a valid empty result`)
    }
  })

  await test('a malformed success envelope reaches fused_search as a provider error', async () => {
    writeKeysFile({ firecrawl: 'fixture-key' })
    respond = () => Response.json({ success: true })
    const failed = await runFused({ query: 'alpha', enginePool: 'api', engineList: ['firecrawl'], complexity: 'simple' })
    assert.equal(failed.engineStats.firecrawl.errors, 1)
    assert.equal(failed.engineStats.firecrawl.successes, 0)
    assert.match(failed.warnings.join(' '), /firecrawl: 1\/1 attempts failed/)
  })

  await test('HTTP errors and malformed JSON stay safe and never echo bodies', async () => {
    for (const status of [400, 401, 403, 429, 500]) {
      respond = () => new Response('SECRET error body', { status })
      await assert.rejects(engine().search('alpha', 3), (err) => err.message === `firecrawl http ${status}`)
    }
    respond = () => new Response('SECRET malformed JSON')
    await assert.rejects(engine().search('alpha', 3), (err) => {
      assert.equal(err.message.includes('SECRET'), false)
      return true
    })
    await assert.rejects(engineRegistry({}).firecrawl.search('alpha', 3), /missing API key/)
  })

  await test('an empty web list is a successful empty retrieval', async () => {
    respond = () => web()
    assert.deepEqual(await engine().search('alpha', 3), [])
  })

  await test('fused_search reports provider failure instead of a silent empty result', async () => {
    writeKeysFile({ firecrawl: 'fixture-key' })
    respond = () => Response.json({ success: false, error: 'SECRET provider detail' })
    const failed = await runFused({ query: 'alpha', enginePool: 'api', engineList: ['firecrawl'], complexity: 'simple' })
    assert.equal(failed.engineStats.firecrawl.errors, 1)
    assert.equal(failed.engineStats.firecrawl.successes, 0)
    assert.match(failed.warnings.join(' '), /firecrawl: 1\/1 attempts failed/)
    assert.equal(JSON.stringify(failed).includes('SECRET'), false)
  })

  await test('fused_search maps a real envelope into ranked evidence', async () => {
    writeKeysFile({ firecrawl: 'fixture-key' })
    respond = () => web(
      { url: 'https://g.example/1', title: 'Alpha result', description: 'alpha evidence', position: 1 },
      { url: 'https://g.example/2', title: 'Second', description: 'more evidence', position: 2 },
    )
    const out = await runFused({ query: 'alpha', enginePool: 'api', engineList: ['firecrawl'], complexity: 'simple' })
    assert.deepEqual(out.enginesUsed, ['firecrawl'])
    assert.equal(out.engineStats.firecrawl.successes, 1)
    assert.equal(out.results[0].engineRanks.firecrawl, 1)
    assert.equal(out.results[0].provenance[0].engine, 'firecrawl')
  })

  await test('routing excludes Firecrawl without a key and warns instead of falling back', async () => {
    const route = resolveSearchRoute({ enginePool: 'api', engines: engineRegistry({}) })
    assert.equal(route.engineNames.includes('firecrawl'), false)
    assert.match(route.warnings.join(' '), /firecrawl unavailable/)
    assert.equal(calls.length, 0)
  })

  console.log(`\n${tests} Firecrawl integration groups passed (no live API calls).`)
} finally {
  globalThis.fetch = originalFetch
  await closeFetchDispatchers(); __setUndiciLoaderForTests(null)
}
