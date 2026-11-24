import './isolate-tests.mjs'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import * as z from 'zod'
import { fusedSearchInput } from '../adapters/mcp/schemas.mjs'
import { engineRegistry } from '../lib/search/engines.js'
import { ENGINE_POOLS, RANKING_WEIGHTS, resolveSearchRoute } from '../lib/search/routing.js'
import { DEEPSEEK_SEARCH_ENDPOINT, LEGACY_DEEPSEEK_MESSAGES_BASE, deepseekSearch } from '../lib/search/deepseek-search.js'
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
const hit = (url = 'https://docs.example/alpha', extra = {}) => ({
  rerank_score: 2.4, title: ' Alpha ', url, snippet: ' short ui ', summary: ' agent summary ',
  content: 'page body that must stay out unless requested', site_name: 'Example', site_icon: 'https://docs.example/icon',
  date: '2026-10-01T00:00:00Z', authority: 3, ...extra,
})
const payload = (results = [hit()]) => ({ results })
let respond = () => Response.json(payload())
globalThis.fetch = async (raw, init) => {
  const url = new URL(String(raw))
  assert.ok(['api.deepseek.com', 'gateway.example'].includes(url.hostname), 'no live/unmocked hosts')
  calls.push({ url, init })
  return respond(url, init)
}
const engine = (keys = { [name]: key }, bases) => engineRegistry(keys, null, bases)[name]
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

  const beforeMissing = calls.length
  await assert.rejects(engine({}).search('alpha', 3), /missing API key/)
  assert.equal(calls.length, beforeMissing, 'missing key makes no request')

  const rows = await engine().search('DeepSeek site:github.com OR site:huggingface.co', 5)
  const { url, init } = calls.at(-1)
  assert.equal(url.href, DEEPSEEK_SEARCH_ENDPOINT)
  assert.equal(init.method, 'POST'); assert.equal(init.redirect, 'error')
  assert.equal(init.headers.authorization, `Bearer ${key}`)
  assert.equal(init.headers['x-api-key'], undefined)
  assert.equal(init.headers['anthropic-version'], undefined)
  assert.ok(init.signal instanceof AbortSignal)
  const body = JSON.parse(init.body)
  assert.equal(body.query, 'DeepSeek site:github.com OR site:huggingface.co')
  assert.equal(body.count, 5)
  assert.equal(body.need_content, false)
  assert.equal(body.ori_question, undefined)
  assert.equal(body.localization, undefined)
  assert.equal(body.model, undefined)
  assert.equal(body.messages, undefined)
  assert.equal(body.tools, undefined)
  assert.equal(rows[0].snippet, ' short ui ')
  assert.equal(rows[0].summary, ' agent summary ')
  assert.equal(rows[0].content, undefined)
  assert.equal(rows[0].providerRank, 1)
  assert.equal(rows[0].published, '2026-10-01T00:00:00Z')
  assert.equal(rows[0].siteName, 'Example')
  assert.equal(rows[0].authority, 3)

  respond = () => Response.json(payload([
    null, { ...hit(), url: 'javascript:bad' }, hit(), hit(), { ...hit(), url: 'https://user:pw@docs.example/secret' }, { ...hit(), url: 'https://docs.example/beta', title: null, snippet: null, summary: null, date: null, site_name: null, authority: null, rerank_score: null },
  ]))
  const mapped = await engine().search('alpha', 2)
  assert.deepEqual(mapped.map(r => r.providerRank), [3, 6])
  assert.equal(mapped[1].title, '')
  assert.equal(mapped[1].snippet, '')
  assert.equal(mapped[1].summary, null)
  assert.equal(mapped[1].published, null)
  assert.equal(mapped[1].siteName, null)

  const canonical = configNestedPath('keys')
  mkdirSync(dirname(canonical), { recursive: true })
  writeFileSync(canonical, JSON.stringify({ [name]: key }))
  writeFileSync(configFlatPath('keys'), JSON.stringify({ tavily: 'stale' }))
  assert.equal(readKeys()[name], key); assert.equal(readKeys().tavily, undefined)
  assert.deepEqual(readKeysRouting().enabledNames, [name])
  assert.ok(!formatKeyStatusLines().join('\n').includes(key))
  assert.match(formatKeyStatusLines().join('\n'), /\/v1\/tools\/search/)
  assert.doesNotMatch(formatKeyStatusLines().join('\n'), /未配齐/)
  writeKeysFile({ enabledEngines: ['tavily'] })
  assert.equal(runtimeSnapshot().engines[name].available(), false)
  await runKeysWizard(null, { enable: [name], baseUrls: { [name]: 'https://gateway.example/prefix' } })
  assert.equal(runtimeSnapshot().engines[name].available(), true)
  respond = () => Response.json(payload())
  const args = { query: 'alpha site:docs.example', enginePool: 'api', engineList: [name], complexity: 'simple' }
  const out = await runFused(args)
  assert.deepEqual(out.enginesUsed, [name]); assert.equal(out.results.length, 1)
  assert.equal(calls.at(-1).url.href, 'https://gateway.example/prefix/v1/tools/search')
  assert.equal(JSON.parse(calls.at(-1).init.body).query, 'alpha site:docs.example')
  assert.equal(out.results[0].summary, 'agent summary')
  assert.equal(out.results[0].snippet, 'short ui')
  assert.match(out.routeExplanation, /listed engines/)
  assert.match(out.routeExplanation, /\/v1\/tools\/search/)
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
  delete process.env.DEEPSEEK_API_KEY

  const noRetry = [400, 401, 402, 403, 404, 413]
  for (const status of noRetry) {
    respond = () => new Response('SECRET provider body', { status, headers: { 'retry-after': '0' } })
    const n = calls.length
    await assert.rejects(engine().search('alpha', 3), e => e.kind === `http_${status}` && !e.message.includes('SECRET'))
    assert.equal(calls.length, n + 1, `${status} is not retried`)
  }
  for (const status of [408, 429, 500, 504]) {
    let n = 0
    respond = () => { n += 1; return new Response('SECRET', { status, headers: status === 429 ? { 'retry-after': '0' } : {} }) }
    const start = calls.length
    await assert.rejects(engine().search('alpha', 3), e => e.kind === `http_${status}`)
    assert.equal(calls.length, start + 3, `${status} retries twice then stops`)
    assert.equal(n, 3)
  }
  respond = () => new Response('SECRET', { status: 429, headers: { 'retry-after': '30' } })
  const limited = calls.length
  await assert.rejects(engine().search('alpha', 3), e => e.kind === 'http_429')
  assert.equal(calls.length, limited + 1, 'a long Retry-After does not schedule another attempt')

  respond = () => new Response('SECRET invalid json')
  await assert.rejects(engine().search('alpha', 3), /invalid JSON response/)
  for (const bad of [null, {}, { content: [{ type: 'text', text: 'fabricated sources' }] }, { results: { type: 'web_search_tool_result' } }]) {
    respond = () => Response.json(bad)
    await assert.rejects(engine().search('alpha', 3), e => e.message.startsWith('deepseek-search:') && !e.message.includes('SECRET') && !e.message.includes('fabricated'))
  }
  respond = () => Response.json({ results: [] })
  assert.deepEqual(await engine().search('alpha', 3), [])
  const long = `测${'a'.repeat(128)}`
  const none = calls.length
  await assert.rejects(engine().search(long, 3), /not truncated/)
  await assert.rejects(engine().search('   ', 3), /not truncated/)
  await assert.rejects(engine().search('alpha', 0), /count/)
  await assert.rejects(engine().search('alpha', 51), /count/)
  assert.equal(calls.length, none, 'invalid query or count makes no request')
  respond = () => Response.json(payload())
  const opted = await engine().search('alpha', 3, { needContent: true, oriQuestion: '为什么', localization: '203.0.113.8' })
  const optedBody = JSON.parse(calls.at(-1).init.body)
  assert.equal(optedBody.need_content, true)
  assert.equal(optedBody.ori_question, '为什么')
  assert.equal(optedBody.localization, undefined)
  assert.equal(opted[0].content.includes('page body'), true)
  respond = () => Response.json(payload())
  const legacyCalls = calls.length
  await engine({ [name]: key }, { [name]: LEGACY_DEEPSEEK_MESSAGES_BASE }).search('alpha', 3)
  assert.equal(calls.at(-1).url.href, DEEPSEEK_SEARCH_ENDPOINT)
  assert.equal(JSON.parse(calls.at(-1).init.body).model, undefined)
  assert.equal(calls.length, legacyCalls + 1, 'the stored 0.3.0 default base uses Search once')
  const customLegacy = calls.length
  await assert.rejects(engine({ [name]: key }, { [name]: 'https://gateway.example/anthropic/v1' }).search('alpha', 3), /retired messages endpoint/)
  assert.equal(calls.length, customLegacy, 'a custom messages base is not called')
  respond = () => new Response('x'.repeat(8_000_001))
  await assert.rejects(engine().search('alpha', 3), e => e.kind === 'response_too_large')
  const controller = new AbortController()
  let started
  const ready = new Promise(resolve => { started = resolve })
  respond = (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true }); started()
  })
  const pending = engine().search('alpha', 3, { signal: controller.signal })
  const rejected = assert.rejects(pending)
  await ready; controller.abort(); await rejected
  const controller2 = new AbortController()
  let fetches = 0
  await assert.rejects(deepseekSearch('alpha', 3, { signal: controller2.signal }, { [name]: key }, {}, {
    fetchImpl: async () => { fetches += 1; return new Response('no', { status: 503 }) },
    sleep: () => { controller2.abort(); return Promise.reject(Object.assign(new Error('deepseek-search: cancelled'), { kind: 'cancelled' })) },
  }), e => e.kind === 'cancelled')
  assert.equal(fetches, 1, 'cancel does not start another attempt')
  console.log('DeepSeek Search API: routing, one protocol, bounds, retries, empty success and cancellation passed (fixture transport, no live API).')
} finally {
  globalThis.fetch = originalFetch
  invalidateSearchCaches()
  await closeFetchDispatchers(); __setUndiciLoaderForTests(null)
}
