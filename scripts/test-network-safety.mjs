#!/usr/bin/env node
// Network policy regressions (B5): validated-address pinning, bounded DNS,
// per-hop redirect checks, dual-stack fallback, proxy selection and the
// explicit limitations where the locked Undici release cannot satisfy a policy.
//
// Local servers and injected resolvers are fixtures only: loopback is reachable
// here because the test injects the address snapshot directly. Production
// validation still blocks loopback/private/metadata targets.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createServer as createHttpServer } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { connect as netConnect } from 'node:net'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let count = 0
const skipped = []
const test = async (name, fn) => {
  try {
    // A watchdog so a hang fails loudly instead of stalling the suite.
    let timer = null
    const guard = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out after ${TEST_TIMEOUT_MS}ms`)), TEST_TIMEOUT_MS)
    })
    try {
      await Promise.race([fn(), guard])
    } finally {
      clearTimeout(timer)
    }
    count++
    console.log(`ok: ${name}`)
  } catch (err) {
    console.error(`FAIL: ${name}\n${err instanceof Error ? err.stack : err}`)
    process.exitCode = 1
  }
}
const skip = (name, reason) => { skipped.push(`${name} (${reason})`); console.log(`skip: ${name} — ${reason}`) }

const savedEnv = {}
const TEST_TIMEOUT_MS = 20_000
const clearNetworkEnv = () => {
  for (const name of ['http_proxy', 'HTTP_PROXY', 'https_proxy', 'HTTPS_PROXY', 'all_proxy', 'ALL_PROXY', 'no_proxy', 'NO_PROXY', 'SEARCH_BOOST_TRUSTED_TUN', 'SEARCH_BOOST_ALLOW_TUN_FAKEIP', 'DSH_SEARCH_ALLOW_TUN_FAKEIP']) {
    if (!(name in savedEnv)) savedEnv[name] = process.env[name]
    delete process.env[name]
  }
}
clearNetworkEnv()

const { NET_ERROR_KINDS, NetworkPolicyError, lookupBounded, pinnedLookup, proxyPolicy, autoSelectFamilyEnabled } = await import('../lib/search/net-policy.mjs')
const { fetchPinned, ipv4Fetch, resetFetchDispatcher, closeFetchDispatchers, __setUndiciLoaderForTests } = await import('../lib/search/ipv4-fetch.js')
const { assertStaticHttpUrl, isBlockedIp, isTunFakeIp, resolveValidatedAddresses, guardedFetch, trustedTunMode, __setFixtureAllowlistForTests } = await import('../lib/search/ssrf.js')
const { fetchPage, makePageCache } = await import('../lib/search/fetch.js')

// Fixture-only: the local servers below live on loopback, which production
// validation blocks. This is a JS injection, never an environment switch.
__setFixtureAllowlistForTests(['127.0.0.1', '::1'])

/**
 * A real tunneling HTTP proxy: CONNECT is forwarded to the actual target and
 * bytes are piped both ways. A canned response would be timing-sensitive, and
 * the point of the test is that our transport really routes through a proxy.
 */
function startTunnelProxy() {
  return new Promise((resolve) => {
    const connects = []
    const sockets = new Set()
    const server = createHttpServer((req, res) => {
      res.writeHead(400)
      res.end('this fixture is a CONNECT tunnel')
    })
    server.on('connection', (socket) => {
      sockets.add(socket)
      socket.on('close', () => sockets.delete(socket))
    })
    server.on('connect', (req, clientSocket, head) => {
      sockets.add(clientSocket)
      clientSocket.on('close', () => sockets.delete(clientSocket))
      connects.push(req.url)
      const [host, port] = String(req.url).split(':')
      const upstream = netConnect(Number(port), host, () => {
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        if (head?.length) upstream.write(head)
        upstream.pipe(clientSocket)
        clientSocket.pipe(upstream)
      })
      upstream.on('error', () => clientSocket.destroy())
      clientSocket.on('error', () => upstream.destroy())
    })
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        connects,
        close: () => new Promise((r) => {
          for (const socket of sockets) socket.destroy()
          sockets.clear()
          server.closeAllConnections?.()
          server.close(r)
        }),
      })
    })
  })
}

/**
 * Start an HTTP server that records requests; returns { port, requests, close }.
 * It handles both shapes a proxy client can use: absolute-form requests and a
 * CONNECT tunnel (Undici 6.x uses CONNECT even for http:// targets), so the
 * fixture proves the request really went through the proxy.
 */
function startRecorder(handler) {
  return new Promise((resolve) => {
    const requests = []
    const sockets = new Set()
    const server = createHttpServer((req, res) => {
      requests.push({ method: req.method, url: req.url, host: req.headers.host })
      if (handler) handler(req, res)
      else { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('fixture body '.repeat(20)) }
    })
    server.on('connection', (socket) => {
      sockets.add(socket)
      socket.on('close', () => sockets.delete(socket))
    })
    server.on('connect', (req, clientSocket) => {
      sockets.add(clientSocket)
      clientSocket.on('close', () => sockets.delete(clientSocket))
      // CONNECT target is "host:port"; record it and answer with a canned response.
      requests.push({ method: 'CONNECT', url: req.url, host: req.url })
      if (handler) {
        handler(req, clientSocket)
        return
      }
      const body = 'tunneled fixture body '.repeat(10)
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      clientSocket.write(`HTTP/1.1 200 OK\r\ncontent-type: text/plain\r\ncontent-length: ${body.length}\r\nconnection: close\r\n\r\n${body}`)
      clientSocket.end()
    })
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        requests,
        close: () => new Promise((r) => {
          // Tunneled (CONNECT) sockets are not covered by closeAllConnections(), so
          // destroy every socket this fixture ever accepted.
          for (const socket of sockets) socket.destroy()
          sockets.clear()
          server.closeAllConnections?.()
          server.close(r)
        }),
      })
    })
  })
}

try {
  // -------------------------------------------------------------------------
  // DNS budget and error taxonomy
  // -------------------------------------------------------------------------

  await test('a hanging DNS lookup is bounded and classified as a timeout', async () => {
    const started = Date.now()
    const never = () => { /* never calls back */ }
    await assert.rejects(
      lookupBounded('hang.example', { timeoutMs: 150, lookupImpl: never }),
      (err) => err.kind === NET_ERROR_KINDS.dnsTimeout,
    )
    assert.ok(Date.now() - started < 2_000, 'the wait must be bounded by the budget')
  })

  await test('a late DNS answer after the budget is consumed, not left as an unhandled rejection', async () => {
    const rejections = []
    const onRejection = (err) => rejections.push(err)
    process.on('unhandledRejection', onRejection)
    let lateCallback = null
    const slow = (host, opts, cb) => { lateCallback = cb }
    await assert.rejects(lookupBounded('late.example', { timeoutMs: 80, lookupImpl: slow }), (err) => err.kind === NET_ERROR_KINDS.dnsTimeout)
    // The abandoned lookup answers afterwards.
    lateCallback(null, [{ address: '93.184.216.34', family: 4 }])
    await new Promise((r) => setTimeout(r, 50))
    process.removeListener('unhandledRejection', onRejection)
    assert.deepEqual(rejections, [], 'a late answer must not surface as an unhandled rejection')
  })

  await test('temporary DNS failures, missing names and timeouts are told apart', async () => {
    const fail = (code) => (host, opts, cb) => { const err = new Error(code); err.code = code; cb(err) }
    await assert.rejects(lookupBounded('a.example', { timeoutMs: 200, lookupImpl: fail('EAI_AGAIN') }), (err) => err.kind === NET_ERROR_KINDS.dnsTemporary)
    await assert.rejects(lookupBounded('b.example', { timeoutMs: 200, lookupImpl: fail('ENOTFOUND') }), (err) => err.kind === NET_ERROR_KINDS.dnsNotFound)
    await assert.rejects(lookupBounded('c.example', { timeoutMs: 200, lookupImpl: fail('ETIMEOUT') }), (err) => err.kind === NET_ERROR_KINDS.dnsTimeout)
  })

  // -------------------------------------------------------------------------
  // Pinning: what was validated is what is connected to
  // -------------------------------------------------------------------------

  await test('the validated snapshot is what the connector may answer with', async () => {
    const lookup = pinnedLookup([{ address: '93.184.216.34', family: 4 }])
    const all = await new Promise((resolve, reject) => lookup('rebind.example', { all: true }, (err, records) => (err ? reject(err) : resolve(records))))
    assert.deepEqual(all, [{ address: '93.184.216.34', family: 4 }])
    const single = await new Promise((resolve, reject) => lookup('rebind.example', { family: 4 }, (err, address) => (err ? reject(err) : resolve(address))))
    assert.equal(single, '93.184.216.34')
    await assert.rejects(
      new Promise((resolve, reject) => lookup('rebind.example', { family: 6 }, (err) => (err ? reject(err) : resolve()))),
      /no validated address/,
    )
  })

  await test('a rebinding resolver cannot swap the address between check and connect', async () => {
    let calls = 0
    const flaky = (host, opts, cb) => {
      calls++
      // First answer: public. Any later answer: private (a classic rebinding attempt).
      cb(null, calls === 1 ? [{ address: '93.184.216.34', family: 4 }] : [{ address: '127.0.0.1', family: 4 }])
    }
    const addresses = await resolveValidatedAddresses('rebind.example', { timeoutMs: 500, lookupImpl: flaky })
    assert.deepEqual(addresses, [{ address: '93.184.216.34', family: 4 }])
    const lookup = pinnedLookup(addresses)
    const answered = await new Promise((resolve, reject) => lookup('rebind.example', { all: true }, (err, records) => (err ? reject(err) : resolve(records))))
    assert.deepEqual(answered, [{ address: '93.184.216.34', family: 4 }], 'the connector must not re-resolve')
    assert.equal(calls, 1, 'resolution happens exactly once per hop')
  })

  await test('a private answer is rejected before any connection', async () => {
    const privateResolver = (host, opts, cb) => cb(null, [{ address: '10.0.0.7', family: 4 }])
    await assert.rejects(
      resolveValidatedAddresses('internal.example', { timeoutMs: 500, lookupImpl: privateResolver }),
      (err) => err.kind === NET_ERROR_KINDS.blockedAddress,
    )
  })

  await test('a mixed public/private answer is rejected, not accepted because one address is public', async () => {
    const mixed = (host, opts, cb) => cb(null, [{ address: '93.184.216.34', family: 4 }, { address: '169.254.169.254', family: 4 }])
    await assert.rejects(
      resolveValidatedAddresses('mixed.example', { timeoutMs: 500, lookupImpl: mixed }),
      (err) => err.kind === NET_ERROR_KINDS.blockedAddress,
    )
  })

  // -------------------------------------------------------------------------
  // Static checks, IPv6 forms and fake-IP policy
  // -------------------------------------------------------------------------

  await test('IPv4-mapped IPv6 literals are judged by their IPv4 value', () => {
    // Literal blocking is production behaviour: run it without the fixture allowlist.
    __setFixtureAllowlistForTests(null)
    try {
      assert.equal(isBlockedIp('::ffff:127.0.0.1'), true)
      assert.equal(isBlockedIp('::ffff:10.0.0.1'), true)
      assert.equal(isBlockedIp('::ffff:169.254.169.254'), true)
      assert.equal(isBlockedIp('::ffff:93.184.216.34'), false)
      assert.throws(() => assertStaticHttpUrl('http://[::ffff:127.0.0.1]/'), /blocked address/)
      assert.throws(() => assertStaticHttpUrl('http://127.0.0.1/'), /blocked address/)
      assert.throws(() => assertStaticHttpUrl('http://[::1]/'), /blocked address/)
    } finally {
      __setFixtureAllowlistForTests(['127.0.0.1', '::1'])
    }
  })

  await test('static checks reject credentials, non-http schemes and internal names without DNS', () => {
    assert.throws(() => assertStaticHttpUrl('http://user:pass@example.com/'), /credentials/)
    assert.throws(() => assertStaticHttpUrl('file:///etc/passwd'), /http\(s\)/)
    assert.throws(() => assertStaticHttpUrl('http://localhost/'), /blocked host/)
    assert.throws(() => assertStaticHttpUrl('http://metadata.google.internal/'), /blocked host/)
    assert.throws(() => assertStaticHttpUrl('http://svc.internal/'), /blocked host/)
    // A normal public name passes the static check with no DNS involved: a lookup
    // for `.invalid` could never succeed, so passing proves none was attempted.
    assert.ok(assertStaticHttpUrl('http://this-name-cannot-resolve.invalid/'), 'static checks must not need DNS')
  })

  await test('fake-IP is not trusted by default and requires an explicit trusted-TUN opt-in', async () => {
    const fakeIp = (host, opts, cb) => cb(null, [{ address: '198.18.0.5', family: 4 }])
    assert.equal(isTunFakeIp('198.18.0.5'), true)
    await assert.rejects(
      resolveValidatedAddresses('tun.example', { timeoutMs: 500, lookupImpl: fakeIp, env: {} }),
      (err) => err.kind === NET_ERROR_KINDS.blockedAddress,
      'strict mode must not treat a synthetic address as public',
    )
    const allowed = await resolveValidatedAddresses('tun.example', { timeoutMs: 500, lookupImpl: fakeIp, env: { SEARCH_BOOST_TRUSTED_TUN: '1' } })
    assert.deepEqual(allowed, [{ address: '198.18.0.5', family: 4 }])
    assert.equal(trustedTunMode({ SEARCH_BOOST_TRUSTED_TUN: '1' }), true)
    assert.equal(trustedTunMode({}), false)
    // A literal fake-IP in the URL is blocked even in trusted-TUN mode.
    assert.throws(() => assertStaticHttpUrl('http://198.18.0.5/'), /blocked address/)
  })

  // -------------------------------------------------------------------------
  // Transport: pinning, dual stack, Host/SNI, TLS verification
  // -------------------------------------------------------------------------

  await test('a pinned request reaches the injected address and keeps the logical Host', async () => {
    const server = await startRecorder()
    try {
      const res = await fetchPinned(`http://logical.example:${server.port}/pinned`, {
        addresses: [{ address: '127.0.0.1', family: 4 }],
        headers: { 'user-agent': 'fixture' },
      })
      assert.equal(res.status, 200)
      assert.equal(server.requests.length, 1)
      assert.equal(server.requests[0].host, `logical.example:${server.port}`, 'the logical Host must be preserved')
      assert.equal(server.requests[0].url, '/pinned')
    } finally {
      await server.close()
    }
  })

  await test('dual stack: an unreachable IPv6 address falls back to IPv4', async () => {
    const server = await startRecorder()
    try {
      assert.equal(autoSelectFamilyEnabled(), true, 'the transport must not force a single family')
      const res = await fetchPinned(`http://dual.example:${server.port}/`, {
        addresses: [{ address: '::1', family: 6 }, { address: '127.0.0.1', family: 4 }],
      })
      assert.equal(res.status, 200, 'the IPv4 address must be tried after IPv6 is refused')
      assert.equal(server.requests.length, 1)
    } finally {
      await server.close()
    }
  })

  await test('TLS verification stays enabled for a pinned HTTPS connection', async (t) => {
    let pem
    try {
      pem = makeSelfSignedCert()
    } catch (err) {
      skip('TLS verification stays enabled for a pinned HTTPS connection', `openssl unavailable: ${err.message}`)
      return
    }
    const server = createHttpsServer({ key: pem.key, cert: pem.cert }, (req, res) => { res.writeHead(200); res.end('tls fixture') })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = server.address().port
    try {
      await assert.rejects(
        fetchPinned(`https://tls.example:${port}/`, { addresses: [{ address: '127.0.0.1', family: 4 }] }),
        (err) => /certificate|self.signed|unable to verify|CERT|TLS/i.test(String(err?.message ?? err)) || /CERT|TLS/i.test(String(err?.cause?.code ?? '')),
        'a self-signed certificate must fail: verification is not disabled',
      )
    } finally {
      await new Promise((resolve) => server.close(resolve))
      rmSync(pem.dir, { recursive: true, force: true })
    }
  })

  // -------------------------------------------------------------------------
  // Redirects are re-validated per hop
  // -------------------------------------------------------------------------

  await test('a redirect into a blocked address is rejected before connecting', async () => {
    const server = await startRecorder((req, res) => {
      res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' })
      res.end()
    })
    try {
      await assert.rejects(
        guardedFetch(`http://redirect.example:${server.port}/`, {
          lookupImpl: (host, opts, cb) => cb(null, [{ address: '127.0.0.1', family: 4 }]),
          timeoutMs: 3_000,
        }),
        (err) => err.kind === NET_ERROR_KINDS.blockedAddress,
      )
    } finally {
      await server.close()
    }
  })

  await test('a redirect chain is bounded', async () => {
    const server = await startRecorder((req, res) => {
      res.writeHead(302, { location: `/hop${Math.random()}` })
      res.end()
    })
    try {
      await assert.rejects(
        guardedFetch(`http://loop.example:${server.port}/`, {
          lookupImpl: (host, opts, cb) => cb(null, [{ address: '127.0.0.1', family: 4 }]),
          maxHops: 3,
          timeoutMs: 3_000,
        }),
        (err) => err.kind === NET_ERROR_KINDS.tooManyRedirects,
      )
      assert.equal(server.requests.length, 3, 'exactly the allowed number of hops is attempted')
    } finally {
      await server.close()
    }
  })

  // -------------------------------------------------------------------------
  // Proxy selection: real routing, NO_PROXY, unsupported protocols
  // -------------------------------------------------------------------------

  await test('proxy variable precedence and SOCKS rejection are explicit', () => {
    const policy = proxyPolicy({ https_proxy: 'http://127.0.0.1:1', http_proxy: 'http://127.0.0.1:2', all_proxy: 'http://127.0.0.1:3' })
    assert.equal(policy.mode, 'proxy')
    assert.equal(policy.source, 'https_proxy', 'https_proxy wins for https traffic')
    const upper = proxyPolicy({ HTTP_PROXY: 'http://127.0.0.1:4' })
    assert.equal(upper.source, 'HTTP_PROXY')
    const both = proxyPolicy({ HTTP_PROXY: 'http://127.0.0.1:5', http_proxy: 'http://127.0.0.1:6' })
    assert.equal(both.source, 'http_proxy', 'lowercase wins, as Undici reads it')
    const socks = proxyPolicy({ https_proxy: 'socks5://127.0.0.1:1080' })
    assert.equal(socks.error?.kind, NET_ERROR_KINDS.proxyUnsupported)
    const invalid = proxyPolicy({ https_proxy: 'not a url' })
    assert.equal(invalid.error?.kind, NET_ERROR_KINDS.proxyConfig)
  })

  await test('a configured HTTP proxy is really used for fixed-service requests', async () => {
    // A real origin behind a real CONNECT tunnel: the response body can only
    // arrive if the request was routed through the proxy.
    const origin = await startRecorder()
    const proxy = await startTunnelProxy()
    const previous = { ...process.env }
    try {
      process.env.http_proxy = `http://127.0.0.1:${proxy.port}`
      process.env.https_proxy = `http://127.0.0.1:${proxy.port}`
      // A CI runner may pre-set NO_PROXY for loopback; this fixture needs the
      // proxy to be used for its own target.
      delete process.env.no_proxy
      delete process.env.NO_PROXY
      resetFetchDispatcher()
      const res = await ipv4Fetch(`http://127.0.0.1:${origin.port}/fixed-service`)
      const body = await res.text()
      assert.equal(res.status, 200)
      assert.ok(
        proxy.connects.includes(`127.0.0.1:${origin.port}`),
        `the proxy must see a CONNECT for the target: ${JSON.stringify(proxy.connects)}`,
      )
      assert.equal(origin.requests.length, 1, 'the origin must be reached through the tunnel')
      assert.match(body, /fixture body/)
    } finally {
      for (const key of ['http_proxy', 'https_proxy', 'no_proxy', 'NO_PROXY']) {
        if (previous[key] === undefined) delete process.env[key]
        else process.env[key] = previous[key]
      }
      resetFetchDispatcher()
      await proxy.close()
      await origin.close()
    }
  })

  await test('NO_PROXY keeps a direct path for the listed host', async () => {
    const target = await startRecorder()
    const deadProxy = await startRecorder()
    const previous = { ...process.env }
    try {
      process.env.http_proxy = `http://127.0.0.1:${deadProxy.port}`
      process.env.https_proxy = `http://127.0.0.1:${deadProxy.port}`
      process.env.no_proxy = '127.0.0.1'
      resetFetchDispatcher()
      const res = await ipv4Fetch(`http://127.0.0.1:${target.port}/direct`)
      assert.equal(res.status, 200)
      assert.equal(target.requests.length, 1, 'the direct target must be reached')
      assert.equal(deadProxy.requests.length, 0, 'NO_PROXY hosts must not go through the proxy')
    } finally {
      for (const key of ['http_proxy', 'https_proxy', 'no_proxy']) {
        if (previous[key] === undefined) delete process.env[key]
        else process.env[key] = previous[key]
      }
      resetFetchDispatcher()
      await target.close()
      await deadProxy.close()
    }
  })

  await test('an unsupported proxy never falls back to a direct connection', async () => {
    const target = await startRecorder()
    const previous = { ...process.env }
    try {
      process.env.all_proxy = `socks5://127.0.0.1:${target.port}`
      process.env.http_proxy = `socks5://127.0.0.1:${target.port}`
      process.env.https_proxy = `socks5://127.0.0.1:${target.port}`
      resetFetchDispatcher()
      await assert.rejects(ipv4Fetch(`http://127.0.0.1:${target.port}/bypass`), (err) => err.kind === NET_ERROR_KINDS.proxyUnsupported)
      assert.equal(target.requests.length, 0, 'a SOCKS proxy must not become a direct connection')
    } finally {
      for (const key of ['all_proxy', 'http_proxy', 'https_proxy']) {
        if (previous[key] === undefined) delete process.env[key]
        else process.env[key] = previous[key]
      }
      resetFetchDispatcher()
      await target.close()
    }
  })

  await test('an unavailable transport fails explicitly instead of using plain fetch', async () => {
    const target = await startRecorder()
    try {
      __setUndiciLoaderForTests(async () => { throw new Error('undici is not resolvable here') })
      await assert.rejects(ipv4Fetch(`http://127.0.0.1:${target.port}/fallback`), (err) => err.kind === NET_ERROR_KINDS.transportUnavailable)
      assert.equal(target.requests.length, 0, 'the request must not bypass the transport policy')
    } finally {
      __setUndiciLoaderForTests(null)
      resetFetchDispatcher()
      await target.close()
    }
  })

  await test('an arbitrary page fetch through a proxy reports a limitation instead of bypassing it', async () => {
    const previous = { ...process.env }
    try {
      process.env.https_proxy = 'http://127.0.0.1:9'
      resetFetchDispatcher()
      await assert.rejects(
        fetchPinned('http://page.example/', { addresses: [{ address: '93.184.216.34', family: 4 }] }),
        (err) => err.kind === NET_ERROR_KINDS.proxyUnsupported,
      )
    } finally {
      if (previous.https_proxy === undefined) delete process.env.https_proxy
      else process.env.https_proxy = previous.https_proxy
      resetFetchDispatcher()
    }
  })

  // -------------------------------------------------------------------------
  // fetch_page order: cache and the third-party reader do not resolve the target
  // -------------------------------------------------------------------------

  await test('a cache hit returns content without resolving the target name', async () => {
    const cache = makePageCache()
    const url = 'http://cache-only.invalid/page'
    cache.set(`page:${url}`, 'cached fixture body '.repeat(10))
    const res = await fetchPage(url, undefined, cache)
    assert.equal(res.via, 'cache')
    assert.equal(res.cacheHit, true)
    assert.match(res.content, /cached fixture body/)
  })

  await test('the reader path does not resolve the target name locally', async () => {
    const originalFetch = globalThis.fetch
    __setUndiciLoaderForTests(async () => ({ ...await import('undici'), fetch: (...args) => globalThis.fetch(...args) }))
    const seen = []
    globalThis.fetch = async (url) => {
      seen.push(String(url))
      return new Response('reader body '.repeat(20), { status: 200, headers: { 'content-type': 'text/markdown' } })
    }
    try {
      const cache = makePageCache()
      // `.invalid` can never resolve: succeeding proves no local lookup happened.
      const res = await fetchPage('http://reader-only.invalid/page', undefined, cache)
      assert.equal(seen.length, 1)
      assert.match(seen[0], /^https:\/\/r\.jina\.ai\//, 'the request goes to the reader service')
      assert.ok(
        seen[0].includes(encodeURIComponent('http://reader-only.invalid/page')),
        `the reader must receive the target URL: ${seen[0]}`,
      )
      assert.equal(res.via, 'jina')
      assert.match(res.content, /reader body/)
    } finally {
      globalThis.fetch = originalFetch
      __setUndiciLoaderForTests(null)
    }
  })

  await test('a cancelled page fetch starts no request at all', async () => {
    const originalFetch = globalThis.fetch
    __setUndiciLoaderForTests(async () => ({ ...await import('undici'), fetch: (...args) => globalThis.fetch(...args) }))
    let calls = 0
    globalThis.fetch = async () => { calls++; return new Response('x') }
    try {
      const controller = new AbortController()
      controller.abort(new Error('cancelled by the caller'))
      await assert.rejects(fetchPage('http://cancel.example/', undefined, makePageCache(), controller.signal), (err) => err.kind === NET_ERROR_KINDS.cancelled)
      assert.equal(calls, 0, 'no request may start after a cancel')
    } finally {
      globalThis.fetch = originalFetch
      __setUndiciLoaderForTests(null)
    }
  })
} finally {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  // Keep-alive sockets from the proxy/agent dispatchers would otherwise hold the
  // process open after the last assertion (and stall a CI step).
  await closeFetchDispatchers()
  resetFetchDispatcher()
}

/** Self-signed cert for the TLS-verification test (fixture only). */
function makeSelfSignedCert() {
  const dir = mkdtempSync(join(tmpdir(), 'sb-tls-fixture-'))
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem'), '-days', '1', '-subj', '/CN=tls.example'], { stdio: 'ignore' })
  return { dir, key: readFileSync(join(dir, 'key.pem'), 'utf8'), cert: readFileSync(join(dir, 'cert.pem'), 'utf8') }
}

console.log(`\n${count} network policy tests passed.${skipped.length ? `\nskipped: ${skipped.join('; ')}` : ''}`)
if (process.exitCode) console.error('FAILURES PRESENT')
// Explicit exit: a stray keep-alive handle must not turn a green suite into a
// stuck CI step.
process.exit(process.exitCode ? 1 : 0)
