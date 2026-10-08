import './isolate-tests.mjs'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import piExtension from '../adapters/pi/index.js'
import { clearAllCaches, runXSearch, invalidateSearchCaches } from '../lib/runtime.mjs'
import { fetchPage, makePageCache } from '../lib/search/fetch.js'
import { __setUndiciLoaderForTests, closeFetchDispatchers } from '../lib/search/ipv4-fetch.js'

const tools = new Map()
piExtension({ registerTool: t => tools.set(t.name, t), registerCommand() {}, on() {} })
const originalFetch = globalThis.fetch, OriginalDate = globalThis.Date
const undici = await import('undici')
let server
try {
  process.env.XAI_API_KEY = 'xai-fixture-not-a-real-secret'
  let calls = 0, ready
  const started = new Promise(resolve => { ready = resolve })
  __setUndiciLoaderForTests(async () => ({ ...undici, fetch: (...args) => globalThis.fetch(...args) }))
  globalThis.fetch = async (url, options) => {
    assert.equal(String(url), 'https://api.x.ai/v1/responses', 'no fallback/upstream requests are allowed in this regression')
    calls++
    if (calls === 1) return new Promise((resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true })
      ready()
    })
    return new Response(JSON.stringify({ output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ username: 'alice', name: 'Alice', id: '123', bio: 'fixture user' }) }] }] }), { headers: { 'content-type': 'application/json' } })
  }
  clearAllCaches()
  const abort = new AbortController(), args = { engines: ['x'], type: 'user', username: 'alice' }
  const first = tools.get('community_search').execute('cancelled', args, abort.signal)
  await started
  abort.abort()
  await assert.rejects(first, /abort/i)
  const retried = await tools.get('community_search').execute('immediate-retry', args)
  assert.equal(retried.details.results, 1, JSON.stringify(retried))
  assert.equal(calls, 2, 'immediate retry must start a new HTTP request')
  const cached = await tools.get('community_search').execute('cache', args)
  assert.equal(cached.details.channels[0].cache_hit, true); assert.equal(calls, 2)
  console.log('ok: public Pi community X cancels then immediately retries with fresh HTTP; cache and credential redaction remain correct')

  // Deliberately hold the old provider after abort, then settle it while its
  // replacement is still active. This checks identity-safe registry cleanup.
  invalidateSearchCaches()
  const snapshot = () => ({ fingerprint: 'old-cleanup', engines: {}, capability: { x: { official: { available: false } } } })
  const open = [], signals = []
  const fallbackSearch = ({ signal }) => new Promise(resolve => { signals.push(signal); open.push(() => resolve({ via: 'fixture', data: [] })) })
  const params = { type: 'keyword', query: 'old cleanup identity' }, opts = { snapshot, fallbackSearch }
  const oldAbort = new AbortController()
  const old = runXSearch(params, { ...opts, signal: oldAbort.signal })
  oldAbort.abort()
  await assert.rejects(old)
  const replacement = runXSearch(params, opts)
  assert.equal(open.length, 2); assert.equal(signals[0].aborted, true)
  open[0]()
  await new Promise(resolve => setImmediate(resolve))
  const joiner = runXSearch(params, opts)
  assert.equal(open.length, 2, 'old settlement must not remove the new registry entry')
  open[1]()
  await replacement
  assert.equal((await joiner).inFlight, true)
  console.log('ok: last-waiter abort retires its flight; old settlement cannot delete a live replacement')

  globalThis.fetch = originalFetch
  __setUndiciLoaderForTests(null)
  await closeFetchDispatchers()
  delete process.env.XAI_API_KEY
  let requests = 0, now = Date.parse('2026-10-01T01:00:00Z')
  server = createServer((req, res) => { requests++; res.setHeader('content-type', 'text/html'); res.end('<p>' + 'Actual fetched document text. '.repeat(3000) + '</p>') })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  globalThis.Date = class extends OriginalDate {
    constructor(...args) { super(...(args.length ? args : [now])) }
    static now() { return now }
  }
  clearAllCaches()
  const url = `http://127.0.0.1:${server.address().port}/document`
  const page = tools.get('fetch_page')
  const read = params => page.execute('read', { url, ...params })
  const initial = await read({})
  const fetched = '2026-10-01T01:00:00.000Z'
  assert.equal(initial.details.fetchedAt, fetched)
  assert.match(initial.content[0].text, new RegExp(fetched.replaceAll('.', '\\.')))
  assert.ok(initial.details.nextOffset)
  now += 12 * 3600_000
  for (const params of [{}, { offset: initial.details.nextOffset }, { focus: 'document' }]) {
    const result = await read(params)
    assert.equal(result.details.via, 'cache')
    assert.equal(result.details.fetchedAt, fetched)
    assert.ok(result.content[0].text.includes('fetched: ' + fetched))
  }
  assert.equal(requests, 1)
  now += 13 * 3600_000
  const expired = await read({})
  assert.equal(requests, 2)
  assert.equal(expired.details.fetchedAt, new OriginalDate(now).toISOString())
  assert.notEqual(expired.details.fetchedAt, fetched)
  const legacy = makePageCache()
  legacy.set('page:' + url, 'Historical cached page text. '.repeat(8))
  assert.equal((await fetchPage(url, undefined, legacy)).fetched_at, null, 'historical cache has unknown time, never an invented current time')
  console.log('ok: public Pi cache/focus/offset reads preserve fetch time; only actual expired refetch updates it; legacy time is unknown')
} finally {
  globalThis.fetch = originalFetch; globalThis.Date = OriginalDate
  delete process.env.XAI_API_KEY
  __setUndiciLoaderForTests(null)
  await closeFetchDispatchers()
  if (server) await new Promise(resolve => server.close(resolve))
}
