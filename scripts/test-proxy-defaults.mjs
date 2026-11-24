import './isolate-tests.mjs'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { connect } from 'node:net'
import { spawnSync } from 'node:child_process'
import { guardedFetch, __setFixtureAllowlistForTests } from '../lib/search/ssrf.js'
import { ipv4Fetch, fetchPinned, closeFetchDispatchers, __setUndiciLoaderForTests } from '../lib/search/ipv4-fetch.js'
import { fetchPage, makePageCache } from '../lib/search/fetch.js'

__setFixtureAllowlistForTests(['127.0.0.1'])
const names = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy', 'SEARCH_BOOST_TRUSTED_PROXY', 'SEARCH_BOOST_PROXY_DIRECT_FALLBACK']
function configure(env = {}) {
  for (const key of names) delete process.env[key]
  Object.assign(process.env, env)
}
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
async function origin(redirect = false) {
  const requests = []
  const server = createServer((req, res) => {
    requests.push(req.url)
    if (redirect && req.url === '/start') res.writeHead(302, { location: typeof redirect === 'string' ? redirect : `http://redirect-fixture.invalid:${server.address().port}/end` })
    res.end('owned public-page fixture content '.repeat(20))
  })
  await listen(server)
  return { port: server.address().port, requests, close: () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve) }) }
}
async function proxy(fail = false) {
  const connects = [], sockets = new Set()
  const server = createServer()
  server.on('connection', s => { sockets.add(s); s.on('close', () => sockets.delete(s)) })
  server.on('connect', (req, socket, head) => {
    connects.push(req.url)
    if (fail) { socket.end('HTTP/1.1 502 Fixture unavailable\r\nContent-Length: 0\r\n\r\n'); return }
    const port = Number(req.url.slice(req.url.lastIndexOf(':') + 1))
    const upstream = connect(port, '127.0.0.1', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length) upstream.write(head)
      socket.pipe(upstream); upstream.pipe(socket)
    })
    upstream.on('error', () => socket.destroy()); socket.on('error', () => upstream.destroy()); socket.on('close', () => upstream.destroy())
  })
  await listen(server)
  return { port: server.address().port, connects, close: () => new Promise(resolve => { for (const s of sockets) s.destroy(); server.close(resolve) }) }
}
const dns = (_host, _options, cb) => cb(null, [{ address: '127.0.0.1', family: 4 }])
const curl = spawnSync('curl', ['-q', '--version'], { stdio: 'ignore' }).status === 0
let groups = 0
async function test(name, fn) { configure(); await fn(); groups++; console.log(`ok: ${name}`) }
try {
  await test('untrusted proxies fail before sockets, including curl, fallback-only and cached pages', async () => {
    const o = await origin(), p = await proxy()
    try {
      const url = `http://owned-fixture.invalid:${o.port}/`
      for (const transport of [undefined, 'curl']) for (const flag of [undefined, '0', 'false']) {
        const env = { HTTP_PROXY: `http://127.0.0.1:${p.port}`, SEARCH_BOOST_PROXY_DIRECT_FALLBACK: '1', ...(flag ? { SEARCH_BOOST_TRUSTED_PROXY: flag } : {}) }
        await assert.rejects(guardedFetch(url, { env, transport, lookupImpl: dns }), e => e.kind === 'proxy_trust_required')
        await assert.rejects(fetchPinned(url, { env }), e => e.kind === 'proxy_trust_required')
      }
      configure({ HTTP_PROXY: `http://127.0.0.1:${p.port}` })
      const cache = makePageCache(); cache.set(`page:${url}`, 'cached fixture '.repeat(20))
      await assert.rejects(fetchPage(url, undefined, cache), e => e.kind === 'proxy_trust_required')
      assert.equal(p.connects.length, 0); assert.equal(o.requests.length, 0)
    } finally { await p.close(); await o.close() }
  })
  await test('trusted proxy DNS delegation works without enabling direct fallback', async () => {
    const o = await origin(), p = await proxy()
    try {
      for (const transport of curl ? [undefined, 'curl'] : [undefined]) {
        const res = await guardedFetch(`http://proxy-owned.invalid:${o.port}/`, { env: { HTTP_PROXY: `http://127.0.0.1:${p.port}`, SEARCH_BOOST_TRUSTED_PROXY: '1' }, transport, lookupImpl: () => { throw Error('no local target DNS') } })
        assert.match(await res.text(), /owned public-page/)
      }
      assert.equal(o.requests.length, curl ? 2 : 1)
    } finally { await p.close(); await o.close() }
  })
  await test('trusted proxy failure stays closed by default in Undici and curl', async () => {
    for (const transport of curl ? [undefined, 'curl'] : [undefined]) {
      const o = await origin(), p = await proxy(true)
      try {
        await assert.rejects(guardedFetch(`http://failed-owned.invalid:${o.port}/`, { env: { HTTP_PROXY: `http://127.0.0.1:${p.port}`, SEARCH_BOOST_TRUSTED_PROXY: 'true' }, transport, lookupImpl: dns }), e => e.kind === 'proxy_fallback_disabled')
        assert.equal(p.connects.length, 5); assert.equal(o.requests.length, 0)
      } finally { await p.close(); await o.close() }
    }
  })
  await test('both opt-ins permit validated direct fallback, not a second target lookup', async () => {
    for (const transport of curl ? [undefined, 'curl'] : [undefined]) {
      const o = await origin(), p = await proxy(true); let lookups = 0
      try {
        const res = await guardedFetch(`http://fallback-owned.invalid:${o.port}/`, { env: { HTTP_PROXY: `http://127.0.0.1:${p.port}`, SEARCH_BOOST_TRUSTED_PROXY: '1', SEARCH_BOOST_PROXY_DIRECT_FALLBACK: '1' }, transport, lookupImpl: (...a) => { lookups++; dns(...a) } })
        assert.match(await res.text(), /owned public-page/); assert.equal(lookups, 1); assert.equal(o.requests.length, 1); assert.equal(p.connects.length, 5)
      } finally { await p.close(); await o.close() }
    }
  })
  await test('redirects cannot enter an untrusted proxy from NO_PROXY direct', async () => {
    const o = await origin(true), p = await proxy()
    try {
      await assert.rejects(guardedFetch(`http://127.0.0.1:${o.port}/start`, { env: { HTTP_PROXY: `http://127.0.0.1:${p.port}`, NO_PROXY: '127.0.0.1' } }), e => e.kind === 'proxy_trust_required')
      assert.equal(o.requests.length, 1); assert.equal(p.connects.length, 0)
    } finally { await p.close(); await o.close() }
  })
  await test('explicit proxy and direct opt-ins do not authorize private redirects or DNS', async () => {
    for (const transport of curl ? [undefined, 'curl'] : [undefined]) {
      const o = await origin('http://10.0.0.1/'), p = await proxy()
      try {
        await assert.rejects(guardedFetch(`http://owned-private-redirect.invalid:${o.port}/start`, { env: { HTTP_PROXY: `http://127.0.0.1:${p.port}`, SEARCH_BOOST_TRUSTED_PROXY: '1', SEARCH_BOOST_PROXY_DIRECT_FALLBACK: '1' }, transport }), e => e.kind === 'blocked_address')
        assert.equal(p.connects.length, 1); assert.equal(o.requests.length, 1)
      } finally { await p.close(); await o.close() }
      const failed = await proxy(true)
      try {
        await assert.rejects(guardedFetch('http://private-dns-fixture.invalid/', { env: { HTTP_PROXY: `http://127.0.0.1:${failed.port}`, SEARCH_BOOST_TRUSTED_PROXY: '1', SEARCH_BOOST_PROXY_DIRECT_FALLBACK: '1' }, transport, lookupImpl: (_h, _o, cb) => cb(null, [{ address: '10.0.0.1', family: 4 }]) }), e => e.kind === 'blocked_address')
        assert.equal(failed.connects.length, 5)
      } finally { await failed.close() }
    }
  })
  await test('fixed API proxies and explicit direct service gateways need no page trust flag', async () => {
    const o = await origin(), p = await proxy()
    try {
      configure({ HTTP_PROXY: `http://127.0.0.1:${p.port}` })
      assert.match(await (await ipv4Fetch(`http://fixed-api.invalid:${o.port}/`, { method: 'POST', body: '{}', headers: { 'x-api-key': 'fixture-not-real' } })).text(), /owned public-page/)
      configure(); assert.match(await (await ipv4Fetch(`http://127.0.0.1:${o.port}/gateway`)).text(), /owned public-page/)
      assert.equal(o.requests.length, 2)
    } finally { configure(); await p.close(); await o.close() }
  })
  await test('fixed-service proxy failure also requires a separate direct opt-in', async () => {
    const o = await origin(), p = await proxy(true)
    try {
      configure({ HTTP_PROXY: `http://127.0.0.1:${p.port}` })
      await assert.rejects(ipv4Fetch(`http://127.0.0.1:${o.port}/`), e => e.kind === 'proxy_fallback_disabled')
      assert.equal(o.requests.length, 0)
      process.env.SEARCH_BOOST_PROXY_DIRECT_FALLBACK = '1'
      assert.match(await (await ipv4Fetch(`http://127.0.0.1:${o.port}/`)).text(), /owned public-page/)
      assert.equal(o.requests.length, 1)
    } finally { configure(); await p.close(); await o.close() }
  })
  await test('Jina cannot bypass page proxy trust or a disabled direct fallback', async () => {
    const original = globalThis.fetch; const seen = []
    __setUndiciLoaderForTests(async () => ({ ...await import('undici'), fetch: async (url, init) => { if (String(url).startsWith('https://r.jina.ai/')) assert.equal(init.redirect, 'error'); seen.push(String(url)); return new Response('unavailable', { status: 503 }) } }))
    try {
      configure({ HTTPS_PROXY: 'http://127.0.0.1:9' })
      await assert.rejects(fetchPage('http://93.184.216.34/', undefined, makePageCache()), e => e.kind === 'proxy_trust_required')
      assert.deepEqual(seen, ['http://93.184.216.34/'])
      configure(); seen.length = 0
      await assert.rejects(fetchPage('http://93.184.216.34/', undefined, makePageCache()))
      assert.equal(seen.length, 2); assert(seen[1].startsWith('https://r.jina.ai/'))
    } finally { configure(); globalThis.fetch = original; __setUndiciLoaderForTests(null) }
    const o = await origin(), p = await proxy(true)
    try {
      configure({ HTTP_PROXY: `http://127.0.0.1:${p.port}`, SEARCH_BOOST_TRUSTED_PROXY: '1' })
      await assert.rejects(fetchPage(`http://reader-owned.invalid:${o.port}/`, undefined, makePageCache()), e => e.kind === 'proxy_fallback_disabled')
      assert.equal(p.connects.length, 5); assert.equal(o.requests.length, 0)
    } finally { configure(); await p.close(); await o.close() }
  })
} finally { configure(); __setFixtureAllowlistForTests(null); await closeFetchDispatchers() }
console.log(`${groups} proxy-default groups passed; curl=${curl ? 'tested' : 'unavailable, compatible cases skipped'}; owned sockets only`)
