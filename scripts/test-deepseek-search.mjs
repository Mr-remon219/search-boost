import './isolate-tests.mjs'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import * as z from 'zod'
import { fusedSearchInput } from '../adapters/mcp/schemas.mjs'
import { engineRegistry } from '../lib/search/engines.js'
import { ENGINE_POOLS, RANKING_WEIGHTS, resolveSearchRoute } from '../lib/search/routing.js'
import { DEEPSEEK_SEARCH_ENDPOINT, LEGACY_DEEPSEEK_MESSAGES_BASE, deepseekSearch, retryWaitMs } from '../lib/search/deepseek-search.js'
import { __setUndiciLoaderForTests, closeFetchDispatchers } from '../lib/search/ipv4-fetch.js'
import { runFused, fusedHitToJson, fusedResultIsError, invalidateSearchCaches } from '../lib/runtime.mjs'
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
  const fixedNow = Date.parse('2026-11-25T00:00:00.000Z')
  async function retryCase(retryAfter, now = fixedNow) {
    const sleeps = []
    let fetches = 0
    let error
    try {
      await deepseekSearch('alpha', 3, { now: () => now }, { [name]: key }, {}, {
        fetchImpl: async () => { fetches += 1; return new Response('SECRET', { status: 429, headers: { 'retry-after': retryAfter } }) },
        sleep: async (ms) => { sleeps.push(ms) },
      })
    } catch (err) { error = err }
    return { fetches, sleeps, kind: error?.kind }
  }
  const integerStop = await retryCase('2')
  assert.equal(integerStop.fetches, 1)
  assert.deepEqual(integerStop.sleeps, [])
  const integerRetry = await retryCase('1')
  assert.equal(integerRetry.fetches, 3)
  assert.deepEqual(integerRetry.sleeps, [1000, 1000])
  const past = await retryCase(new Date(fixedNow - 86_400_000).toUTCString())
  assert.equal(past.fetches, 3)
  assert.deepEqual(past.sleeps, [0, 0])
  const future = await retryCase(new Date(fixedNow + 120_000).toUTCString())
  assert.equal(future.fetches, 1, 'a Retry-After 120s in the future stops instead of the 20/40ms backoff')
  assert.deepEqual(future.sleeps, [])
  const invalid = await retryCase('not-a-date')
  assert.equal(invalid.fetches, 1)
  assert.deepEqual(invalid.sleeps, [])
  const decimalStop = await retryCase('1.5')
  assert.equal(decimalStop.fetches, 1, 'Retry-After 1.5 is 1500ms and stops; it is not the date 2001-01-05')
  assert.deepEqual(decimalStop.sleeps, [])
  const decimalWait = await retryCase('0.5')
  assert.equal(decimalWait.fetches, 3)
  assert.deepEqual(decimalWait.sleeps, [500, 500])
  assert.equal(retryWaitMs(1, '1.5', fixedNow), null)
  assert.equal(retryWaitMs(1, '1', fixedNow), 1000)
  const cancelSleeps = []
  let cancelFetches = 0
  const cancelSignal = AbortSignal.abort()
  await assert.rejects(deepseekSearch('alpha', 3, { signal: cancelSignal }, { [name]: key }, {}, {
    fetchImpl: async () => { cancelFetches += 1; return new Response('SECRET', { status: 429, headers: { 'retry-after': '1' } }) },
    sleep: async (ms) => { cancelSleeps.push(ms) },
  }), e => e.kind === 'cancelled')
  assert.equal(cancelFetches, 0)
  assert.deepEqual(cancelSleeps, [])

  respond = () => Response.json({ results: [
    { url: 'https://null.example/a', title: 'Null title', snippet: 's', summary: null },
    { url: 'https://missing.example/a', title: 'Missing title', snippet: '' },
    { url: 'https://empty.example/a', title: 'Empty title', snippet: 'ui', summary: '' },
  ] })
  const shaped = await engine().search('alpha', 5)
  assert.equal(shaped.find(row => row.url.includes('null.')).summary, null)
  assert.equal(Object.hasOwn(shaped.find(row => row.url.includes('missing.')), 'summary'), false)
  assert.equal(shaped.find(row => row.url.includes('empty.')).summary, '')
  const keyed = () => ({ engines: engineRegistry({ [name]: key }), routing: { enabledNames: [name], keys: { [name]: key } }, fingerprint: 'keyed-shape', capability: {} })
  const beforeShape = calls.length
  const fusedShape = await runFused({ query: 'shape', enginePool: 'api', engineList: [name], complexity: 'simple' }, { snapshot: keyed })
  for (const host of ['null', 'missing', 'empty']) {
    const row = fusedHitToJson(fusedShape.results.find(item => item.url.startsWith('https://' + host + '.')))
    assert.ok(row, host)
    if (host === 'missing') assert.equal(Object.hasOwn(row, 'summary'), false)
    if (host === 'null') assert.equal(row.summary, null)
    if (host === 'empty') assert.equal(row.summary, '')
  }
  respond = () => Response.json({ results: [] })
  const emptyOk = await runFused({ query: 'empty-ok', enginePool: 'api', engineList: [name], complexity: 'simple' }, { snapshot: keyed })
  assert.equal(emptyOk.results.length, 0)
  assert.equal(emptyOk.engineStats[name].successes, 1)
  assert.equal(fusedResultIsError(emptyOk), false)
  assert.match(emptyOk.warnings.join('\n'), /no matches/)
  const beforeNoKey = calls.length
  const noKey = await runFused({ query: 'no-key', engineList: [name], complexity: 'simple' }, { snapshot: () => ({ engines: engineRegistry({}), routing: { enabledNames: [] }, fingerprint: 'nokey', capability: {} }) })
  assert.equal(calls.length, beforeNoKey, 'missing key does not send a request')
  assert.equal(fusedResultIsError(noKey), true)
  assert.equal(noKey.enginesUsed.length, 0)
  assert.equal(noKey.enginePool, 'api', 'an unavailable named API is not reported as the free pool')
  assert.match(noKey.routeExplanation, /engine_pool=api did not run/)
  assert.doesNotMatch(noKey.warnings.join('\n'), /requested free pool/)
  assert.ok(beforeShape < calls.length)
  assert.doesNotMatch(noKey.warnings.join('\n'), /empty success/)

  console.log('DeepSeek Search API: routing, one protocol, bounds, retries, empty success and cancellation passed (fixture transport, no live API).')
} finally {
  globalThis.fetch = originalFetch
  invalidateSearchCaches()
  await closeFetchDispatchers(); __setUndiciLoaderForTests(null)
}
