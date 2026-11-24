import './isolate-tests.mjs'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { assertStaticHttpUrl, guardedFetch, isBlockedIp, __setFixtureAllowlistForTests } from '../lib/search/ssrf.js'

let requests = 0, proxyAttempts = 0
const server = createServer((_req, res) => { requests++; res.end('owned loopback fixture') })
server.on('connect', (_req, socket) => { proxyAttempts++; socket.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n') })
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
try {
  const port = server.address().port
  await assert.rejects(guardedFetch(`http://127.0.0.1:${port}/`, { env: {} }), error => error.kind === 'blocked_address')
  assert.equal(requests, 0, 'blocked target must not receive requests')
  for (const url of ['http://localhost/', 'http://metadata.google.internal/', 'http://svc.internal/', 'http://[::ffff:127.0.0.1]/']) {
    assert.throws(() => assertStaticHttpUrl(url), error => ['blocked_host', 'blocked_address'].includes(error.kind))
  }
  await assert.rejects(guardedFetch(`http://rebind.invalid:${port}/`, {
    env: {}, lookupImpl: (_host, _opts, cb) => cb(null, [{ address: '127.0.0.1', family: 4 }]),
  }), error => error.kind === 'blocked_address')
  assert.equal(requests, 0)
  await assert.rejects(guardedFetch(`http://rebind.invalid:${port}/`, {
    env: { SEARCH_BOOST_TRUSTED_PROXY: '1', SEARCH_BOOST_PROXY_DIRECT_FALLBACK: '1', http_proxy: `http://127.0.0.1:${port}` },
    lookupImpl: (_host, _opts, cb) => cb(null, [{ address: '127.0.0.1', family: 4 }]),
  }), error => error.kind === 'blocked_address')
  assert.equal(proxyAttempts, 5, 'retry budget exhausted before validated direct fallback')
  assert.equal(requests, 0, 'fallback cannot connect to a private DNS answer')
  // IPv6 transition forms embed an IPv4 destination; NAT64/6to4 gateways or a
  // dual-stack kernel may deliver them to that IPv4 host. Judge the embedded
  // address, and keep public destinations reachable on IPv6-only networks.
  const nonGlobal = ['::127.0.0.1', '::7f00:1', '::ffff:0:7f00:1', '64:ff9b::7f00:1', '64:ff9b::a9fe:a9fe', '64:ff9b::a00:1',
    '64:ff9b:1::7f00:1', '2002:7f00:1::1', '2002:a9fe:a9fe::1', 'fec0::1', '100::1', '2001:db8::1',
    '192.0.0.1', '192.0.2.1', '198.51.100.1', '203.0.113.1', '240.0.0.1']
  for (const address of nonGlobal) {
    assert.equal(isBlockedIp(address), true, `${address} is not a public destination`)
    const host = address.includes(':') ? `[${address}]` : address
    assert.throws(() => assertStaticHttpUrl(`http://${host}:${port}/`), error => error.kind === 'blocked_address', address)
    await assert.rejects(guardedFetch(`http://owned-answer.invalid:${port}/`, {
      env: {}, lookupImpl: (_host, _opts, cb) => cb(null, [{ address, family: address.includes(':') ? 6 : 4 }]),
    }), error => error.kind === 'blocked_address', address)
  }
  assert.equal(requests, 0, 'embedded/non-global answers never reach the owned fixture')
  for (const address of ['64:ff9b::808:808', '2002:808:808::1', '2606:4700::1111', '93.184.216.34']) assert.equal(isBlockedIp(address), false, `${address} remains public`)
  // The JS-only fixture allowlist permits the first hop; localhost must still
  // be rejected on redirect before a second request reaches the fixture.
  __setFixtureAllowlistForTests(['127.0.0.1'])
  server.removeAllListeners('request')
  server.on('request', (_req, res) => { requests++; res.writeHead(302, { location: `http://localhost:${port}/private` }); res.end() })
  await assert.rejects(guardedFetch(`http://127.0.0.1:${port}/`, { env: {} }), error => error.kind === 'blocked_host')
  assert.equal(requests, 1)
  server.removeAllListeners('request')
  server.on('request', (_req, res) => { requests++; res.writeHead(302, { location: `http://[64:ff9b::7f00:1]:${port}/private` }); res.end() })
  await assert.rejects(guardedFetch(`http://127.0.0.1:${port}/`, { env: {} }), error => error.kind === 'blocked_address')
  assert.equal(requests, 2, 'redirect to an embedded loopback address is refused before connecting')
  console.log('ok: static, DNS and redirect destinations blocked before connection using owned loopback only')
} finally {
  __setFixtureAllowlistForTests(null)
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
}
