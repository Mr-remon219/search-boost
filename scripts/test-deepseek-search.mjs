import './isolate-tests.mjs'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import * as z from 'zod'
import { fusedSearchInput } from '../adapters/mcp/schemas.mjs'
import { engineRegistry } from '../lib/search/engines.js'
import { ENGINE_POOLS, RANKING_WEIGHTS, resolveSearchRoute } from '../lib/search/routing.js'
import { __setUndiciLoaderForTests, closeFetchDispatchers } from '../lib/search/ipv4-fetch.js'
import { runFused, invalidateSearchCaches } from '../lib/runtime.mjs'
import { runtimeSnapshot } from '../lib/search/capability.js'
import { configNestedPath, configFlatPath } from '../lib/config-paths.mjs'
import { readKeys, writeKeysFile, readKeysRouting, keyStatus, unsetKey } from '../lib/keys.mjs'
import { runKeysWizard, formatKeyStatusLines } from '../lib/installer/keys-wizard.mjs'

const name = 'deepseek-search', key = 'fixture-secret-123456'
const originalFetch = globalThis.fetch
__setUndiciLoaderForTests(async () => ({ ...await import('undici'), fetch: (...args) => globalThis.fetch(...args) }))
const calls = []
const item = (url = 'https://docs.example/alpha') => ({ type: 'web_search_result', url, title: ' Alpha ', page_age: '2026-10-01' })
const payload = () => ({ content: [
  { type: 'web_search_tool_result', content: [item()] },
  { type: 'text', text: 'Do not use generated prose as a snippet.', citations: [{ url: item().url, cited_text: ' cited evidence ' }] },
] })
let respond = () => Response.json(payload())
globalThis.fetch = async (raw, init) => {
  const url = new URL(String(raw))
  assert.ok(['api.deepseek.com', 'gateway.example'].includes(url.hostname), 'no live/unmocked hosts')
  calls.push({ url, init })
  return respond(url, init)
}
const engine = () => engineRegistry({ [name]: key })[name]
try {
  assert.equal(ENGINE_POOLS.free.includes(name), false)
  for (const pool of ['api', 'hybrid']) {
    assert.ok(ENGINE_POOLS[pool].includes(name))
    for (const ranking of ['balanced', 'research', 'fresh']) assert.equal(RANKING_WEIGHTS[pool][ranking][name], 1)
  }
  const route = extra => resolveSearchRoute({ enginePool: 'free', engineList: [name], engines: engineRegistry({ [name]: key }), ...extra })
  assert.deepEqual(route().effectiveWeights, { [name]: 1 })
  assert.deepEqual(route({ engineWeights: { [name]: .7 } }).effectiveWeights, { [name]: .7 })
  assert.throws(() => route({ engineWeights: { [name]: -1 } }), /Invalid engine_weights/)
  assert.ok(z.object(fusedSearchInput).safeParse({ query: 'alpha', engines: [name], engine_weights: { [name]: 0 } }).success)
  assert.equal(engineRegistry({})[name].available(), false)
  assert.equal(engineRegistry({ [name]: key }, new Set())[name].available(), false)

  const rows = await engine().search('中文 & C++', 5)
  const { url, init } = calls.at(-1)
  assert.equal(url.href, 'https://api.deepseek.com/anthropic/v1/messages')
  assert.equal(init.method, 'POST'); assert.equal(init.redirect, 'error')
  assert.equal(init.headers['x-api-key'], key); assert.equal(init.headers.authorization, `Bearer ${key}`)
  assert.equal(init.headers['anthropic-version'], '2023-06-01')
  assert.ok(init.signal instanceof AbortSignal)
  const body = JSON.parse(init.body)
  assert.equal(body.model, 'deepseek-v4-flash')
  assert.equal(body.thinking.type, 'disabled')
  assert.deepEqual(body.tools, [{ type: 'web_search_20250305', name: 'web_search', max_uses: 1 }])
  assert.ok(body.messages[0].content[0].text.endsWith('中文 & C++'))
  assert.equal(rows[0].snippet, 'cited evidence'); assert.equal(rows[0].providerRank, 1)
  assert.equal(rows[0].published, '2026-10-01')
  respond = () => Response.json({ content: [{ type: 'web_search_tool_result', content: [null, item('javascript:bad'), item(), item(), item('https://docs.example/beta')] }] })
  assert.deepEqual((await engine().search('alpha', 2)).map(r => r.providerRank), [2, 4])

  // A store containing only the new key is authoritative over stale legacy data.
  const canonical = configNestedPath('keys')
  mkdirSync(dirname(canonical), { recursive: true })
  writeFileSync(canonical, JSON.stringify({ [name]: key }))
  writeFileSync(configFlatPath('keys'), JSON.stringify({ tavily: 'stale' }))
  assert.equal(readKeys()[name], key); assert.equal(readKeys().tavily, undefined)
  assert.deepEqual(readKeysRouting().enabledNames, [name])
  assert.ok(!formatKeyStatusLines().join('\n').includes(key))
  writeKeysFile({ enabledEngines: ['tavily'] })
  assert.equal(runtimeSnapshot().engines[name].available(), false)
  await runKeysWizard(null, { enable: [name], baseUrls: { [name]: 'https://gateway.example/prefix/v1/' } })
  assert.equal(runtimeSnapshot().engines[name].available(), true)
  respond = () => Response.json(payload())
  const args = { query: 'alpha site:docs.example', enginePool: 'api', engineList: [name], complexity: 'simple' }
  const out = await runFused(args)
  assert.deepEqual(out.enginesUsed, [name]); assert.equal(out.results.length, 1)
  assert.equal(calls.at(-1).url.pathname, '/prefix/v1/messages')
  assert.ok(JSON.parse(calls.at(-1).init.body).messages[0].content[0].text.includes('site:docs.example'))
  assert.equal((await runFused(args)).cacheHit, true)
  const before = calls.length
  assert.deepEqual((await runFused({ ...args, engineWeights: { [name]: 0 } })).results, [])
  assert.equal(calls.length, before + 1, 'zero weight still calls provider')
  assert.ok((await runFused({ ...args, engineWeights: { [name]: .5 } })).results[0].score < out.results[0].score)
  await runKeysWizard(null, { disable: [name] })
  unsetKey(name)
  process.env.DEEPSEEK_API_KEY = key
  assert.equal(keyStatus()[name].source, 'env')
  assert.equal(runtimeSnapshot().engines[name].available(), false, 'env cannot bypass disabled routing')

  for (const status of [401, 402, 403, 429, 500]) {
    respond = () => new Response('SECRET provider body', { status })
    const n = calls.length
    await assert.rejects(engine().search('alpha', 3), e => e.message === `deepseek-search http ${status}`)
    assert.equal(calls.length, n + 1)
  }
  respond = () => new Response('SECRET invalid json')
  await assert.rejects(engine().search('alpha', 3), /invalid JSON response/)
  for (const bad of [null, {}, { content: [{ type: 'text', text: 'fabricated sources' }] }, { content: [{ type: 'web_search_tool_result', content: { type: 'web_search_tool_result_error', error_code: 'SECRET' } }] }]) {
    respond = () => Response.json(bad)
    await assert.rejects(engine().search('alpha', 3), e => e.message.startsWith('deepseek-search:') && !e.message.includes('SECRET'))
  }
  respond = () => Response.json({ content: [{ type: 'web_search_tool_result', content: [] }] })
  assert.deepEqual(await engine().search('alpha', 3), [])
  respond = () => new Response('x'.repeat(8_000_001))
  await assert.rejects(engine().search('alpha', 3), e => e.kind === 'response_too_large')
  const controller = new AbortController()
  let started
  const ready = new Promise(resolve => { started = resolve })
  respond = (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }); started()
  })
  const pending = engine().search('alpha', 3, { signal: controller.signal })
  const rejected = assert.rejects(pending)
  await ready; controller.abort(); await rejected
  console.log('DeepSeek Search: routing, weights, schema, transport, mapping, config, cache, safe errors and cancellation passed (no live API calls).')
} finally {
  globalThis.fetch = originalFetch
  invalidateSearchCaches()
  await closeFetchDispatchers(); __setUndiciLoaderForTests(null)
}
