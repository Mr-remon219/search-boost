#!/usr/bin/env node
// Release-audit regressions: real loopback proxy traffic plus hermetic boundary
// cases. No external service, user configuration or real credential is used.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { connect } from 'node:net'
import { getEventListeners } from 'node:events'
import { proxyPolicy, NET_ERROR_KINDS } from '../lib/search/net-policy.mjs'
import { ipv4Fetch, fetchPinned, closeFetchDispatchers, resetFetchDispatcher, __setUndiciLoaderForTests } from '../lib/search/ipv4-fetch.js'
import { isBlockedIp, resolveValidatedAddresses, guardedFetch } from '../lib/search/ssrf.js'
import { fetchPage, makePageCache, toFetchPageResult } from '../lib/search/fetch.js'
import { runAdaptiveLoop } from '../lib/search/adaptive/loop.mjs'
import { renderAdaptiveSummary } from '../lib/search/adaptive/describe.js'
import { createJevClient } from '../lib/jev/client.mjs'

const proxyNames = ['http_proxy', 'HTTP_PROXY', 'https_proxy', 'HTTPS_PROXY', 'all_proxy', 'ALL_PROXY', 'no_proxy', 'NO_PROXY']
const saved = Object.fromEntries(proxyNames.map((key) => [key, process.env[key]]))
const originalFetch = globalThis.fetch
let passed = 0
let failed = 0
const cleanProxy = () => { for (const key of proxyNames) delete process.env[key] }
async function test(name, fn) {
  cleanProxy()
  resetFetchDispatcher()
  try {
    await fn()
    passed++
    console.log(`ok: ${name}`)
  } catch (err) {
    failed++
    console.error(`FAIL: ${name}\n${err.stack ?? err}`)
  } finally {
    globalThis.fetch = originalFetch
    await closeFetchDispatchers()
    __setUndiciLoaderForTests(null)
  }
}
async function listen(server) {
  const sockets = new Set()
  server.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)) })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  return {
    port: server.address().port,
    close: () => new Promise((resolve) => { for (const socket of sockets) socket.destroy(); server.close(resolve) }),
  }
}
async function withProxy(fn) {
  const origin = await listen(createServer((_req, res) => res.end('through a real tunnel')))
  const tunnels = []
  const upstreams = new Set()
  const server = createServer((_req, res) => { res.statusCode = 400; res.end() })
  server.on('connect', (req, client, head) => {
    tunnels.push(req.url)
    const [host, port] = req.url.split(':')
    const upstream = connect(Number(port), host, () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length) upstream.write(head)
      upstream.pipe(client); client.pipe(upstream)
    })
    upstreams.add(upstream)
    upstream.on('close', () => upstreams.delete(upstream))
    upstream.on('error', () => client.destroy())
    client.on('error', () => upstream.destroy())
    client.on('close', () => upstream.destroy())
  })
  const proxy = await listen(server)
  try { await fn({ origin, proxy, tunnels }) } finally {
    await closeFetchDispatchers()
    for (const socket of upstreams) socket.destroy()
    await proxy.close(); await origin.close()
  }
}
const timeout = () => AbortSignal.timeout(3_000)

try {
  await test('ALL_PROXY alone must reach the real HTTP proxy, not the origin directly', () => withProxy(async ({ origin, proxy, tunnels }) => {
    process.env.ALL_PROXY = `http://127.0.0.1:${proxy.port}`
    const res = await ipv4Fetch(`http://127.0.0.1:${origin.port}/all`, { signal: timeout() })
    assert.equal(await res.text(), 'through a real tunnel')
    assert.deepEqual(tunnels, [`127.0.0.1:${origin.port}`])
  }))
  await test('empty lowercase proxy variables cannot shadow a valid uppercase proxy', () => withProxy(async ({ origin, proxy, tunnels }) => {
    process.env.http_proxy = '  '
    process.env.HTTP_PROXY = `http://127.0.0.1:${proxy.port}`
    const res = await ipv4Fetch(`http://127.0.0.1:${origin.port}/case`, { signal: timeout() })
    await res.text()
    assert.equal(tunnels.length, 1)
  }))
  await test('NO_PROXY is honored with ALL_PROXY and proxy changes do not reuse stale direct dispatchers', () => withProxy(async ({ origin, proxy, tunnels }) => {
    const url = `http://127.0.0.1:${origin.port}/refresh`
    await (await ipv4Fetch(url, { signal: timeout() })).text()
    process.env.ALL_PROXY = `http://127.0.0.1:${proxy.port}`
    await (await ipv4Fetch(url, { signal: timeout() })).text()
    assert.equal(tunnels.length, 1, 'the previously cached direct agent must not bypass the new proxy')
    process.env.NO_PROXY = '127.0.0.1'
    await (await ipv4Fetch(url, { signal: timeout() })).text()
    assert.equal(tunnels.length, 1, 'the explicit bypass list must be honored')
  }))
  await test('every effective proxy is validated, not just the preferred HTTPS variable', () => {
    assert.equal(proxyPolicy({ HTTPS_PROXY: 'http://localhost:1', HTTP_PROXY: 'socks5://localhost:2' }).error?.kind, NET_ERROR_KINDS.proxyUnsupported)
  })
  await test('a missing proxy-agent implementation cannot silently create a direct Agent', async () => {
    process.env.ALL_PROXY = 'http://localhost:9'
    let fetched = false
    __setUndiciLoaderForTests(async () => ({ ...await import('undici'), fetch: (...args) => globalThis.fetch(...args) }))
    globalThis.fetch = async () => { fetched = true; return new Response('must not be reached') }
    __setUndiciLoaderForTests(async () => ({ fetch: (...args) => globalThis.fetch(...args), Agent: class {} }))
    await assert.rejects(ipv4Fetch('https://service.example/'), (err) => err.kind === NET_ERROR_KINDS.transportUnavailable)
    assert.equal(fetched, false)
  })
  await test('expanded IPv4-mapped IPv6 DNS answers cannot bypass the private-address block', async () => {
    for (const address of ['0:0:0:0:0:ffff:7f00:1', '0:0:0:0:0:ffff:10.0.0.1', '::ffff:127.0.0.1']) {
      assert.equal(isBlockedIp(address), true, address)
      await assert.rejects(resolveValidatedAddresses('mapped.example', {
        lookupImpl: (_host, _opts, cb) => cb(null, [{ address, family: 6 }]),
      }), (err) => err.kind === NET_ERROR_KINDS.blockedAddress)
    }
    assert.equal(isBlockedIp('0:0:0:0:0:ffff:0808:0808'), false)
  })
  await test('each redirect body is released before the next pinned hop', async () => {
    let cancelled = false
    let calls = 0
    __setUndiciLoaderForTests(async () => ({ ...await import('undici'), fetch: (...args) => globalThis.fetch(...args) }))
    globalThis.fetch = async () => {
      if (++calls === 1) return new Response(new ReadableStream({ cancel() { cancelled = true } }), { status: 302, headers: { location: '/next' } })
      assert.equal(cancelled, true)
      return new Response('done')
    }
    const res = await guardedFetch('https://redirect.example/', { lookupImpl: (_h, _o, cb) => cb(null, [{ address: '93.184.216.34', family: 4 }]) })
    assert.equal(await res.text(), 'done')
  })
  await test('Jina failure followed by local HTML uses the local provenance and HTML cleaner', async () => {
    __setUndiciLoaderForTests(async () => ({ ...await import('undici'), fetch: (...args) => globalThis.fetch(...args) }))
    globalThis.fetch = async (url) => String(url).startsWith('https://r.jina.ai/')
      ? new Response('unavailable', { status: 503 })
      : new Response(`<html><style>SECRET_STYLE</style><script>SECRET_SCRIPT</script><body><h1>Reference</h1><p>${'Useful reference material. '.repeat(10)}</p></body></html>`)
    const page = await fetchPage('https://93.184.216.34/reference', undefined, makePageCache())
    assert.equal(page.via, 'local')
    assert.match(page.content, /Useful reference/)
    assert.doesNotMatch(page.content, /SECRET_SCRIPT|SECRET_STYLE|<html>/)
  })
  await test('an unavailable transport is a tool failure, never an empty successful page', async () => {
    __setUndiciLoaderForTests(async () => { throw new Error('missing dependency') })
    await assert.rejects(fetchPage('https://reader-only.invalid/', undefined, makePageCache()), (err) => err.kind === NET_ERROR_KINDS.transportUnavailable)
  })
  await test('no-engine adaptive calls release the host abort listener on every early return', async () => {
    const controller = new AbortController()
    for (let i = 0; i < 3; i++) {
      const result = await runAdaptiveLoop({ questions: ['fixture'] }, { jev: { ask() { throw new Error('must not call') } }, signal: controller.signal, snapshot: () => ({ capability: {}, engines: {} }) })
      assert.equal(result.stopReason, 'no_engines')
      assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
    }
  })
  await test('adaptive summaries never claim a failed threshold comparison or nonexistent structured evidence', () => {
    const summary = renderAdaptiveSummary({ questions: [{ id: 'q1', question: 'test', status: 'insufficient', assessed: true, coverage: { probability: 0.2, threshold: 0.8 }, evidence: [{ evidenceId: 'e1', url: 'https://a.example/' }, { evidenceId: 'e2', url: 'https://b.example/' }, { evidenceId: 'e3', url: 'https://c.example/' }], evidenceCount: 5 }], usage: {} })
    assert.doesNotMatch(summary, /0\.2 > 0\.8/)
    assert.match(summary, /1 more.*structured/)
    assert.match(summary, /2.*omitted/)
  })
  await test('focus merges overlapping paragraph windows without duplicated evidence', () => {
    const text = 'Context\n\nneedle first\n\nneedle second\n\nTail'
    assert.equal(toFetchPageResult('https://a.example/', 'cache', text, 'needle', true, Date.now()).content, text)
  })
  await test('pinned page failures preserve DNS, TLS and connection-timeout diagnostics', async () => {
    for (const [code, kind] of [['EAI_AGAIN', 'dns_temporary'], ['ENOTFOUND', 'dns_not_found'], ['CERT_HAS_EXPIRED', 'tls'], ['UND_ERR_CONNECT_TIMEOUT', 'connect_timeout']]) {
      __setUndiciLoaderForTests(async () => ({ ...await import('undici'), fetch: (...args) => globalThis.fetch(...args) }))
    globalThis.fetch = async () => { throw new TypeError('fetch failed', { cause: Object.assign(new Error('fixture'), { code }) }) }
      await assert.rejects(guardedFetch('https://93.184.216.34/'), (err) => err.kind === kind)
    }
  })
  await test('pinned dispatcher cache retires old connections and shutdown closes the rest', async () => {
    let live = 0
    __setUndiciLoaderForTests(async () => ({ fetch: (...args) => globalThis.fetch(...args), Agent: class {
      constructor() { live++; this.closed = false }
      async close() { if (!this.closed) { this.closed = true; live-- } }
      async destroy() { await this.close() }
    } }))
    globalThis.fetch = async () => new Response('fixture')
    for (let i = 1; i <= 80; i++) {
      await fetchPinned('https://public.example/', { addresses: [{ address: `8.8.8.${i}`, family: 4 }] })
    }
    await new Promise((resolve) => setImmediate(resolve))
    assert.ok(live <= 64, `unbounded dispatcher cache: ${live}`)
    await closeFetchDispatchers()
    assert.equal(live, 0)
  })
  await test('Jev error hints, unknown answer IDs and model metadata cannot echo the authorization key', async () => {
    const key = 'SENTINEL-KEY-never-echo'
    const questions = { q: { type: 'noul', criteria: {} } }
    for (const body of [{ error: key }, { detail: { field: key } }]) {
      const client = createJevClient({ baseUrl: 'https://jev.example', apiKey: key, maxRetries: 0, fetchImpl: async () => new Response(JSON.stringify(body), { status: 422 }) })
      await assert.rejects(client.ask({ questions }), (err) => !JSON.stringify(err).includes(key))
    }
    const client = createJevClient({ baseUrl: 'https://jev.example', apiKey: key, maxRetries: 0, fetchImpl: async () => new Response(JSON.stringify({ model: key, answers: { [key]: { type: 'noul', noul: 1 }, q: { type: 'noul', noul: 0.9 } } })) })
    const result = await client.ask({ questions })
    assert.equal(result.entries.get('q').value, 0.9)
    assert.ok(!JSON.stringify(result).includes(key))
    assert.ok(!JSON.stringify(client.usage()).includes(key))
  })
} finally {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  globalThis.fetch = originalFetch
  await closeFetchDispatchers()
}
console.log(`\n${passed} release audit regressions passed; ${failed} failed.`)
process.exitCode = failed ? 1 : 0
