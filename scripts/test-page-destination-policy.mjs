import './isolate-tests.mjs'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { assertStaticHttpUrl, guardedFetch, __setFixtureAllowlistForTests } from '../lib/search/ssrf.js'

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
  // The JS-only fixture allowlist permits the first hop; localhost must still
  // be rejected on redirect before a second request reaches the fixture.
  __setFixtureAllowlistForTests(['127.0.0.1'])
  server.removeAllListeners('request')
  server.on('request', (_req, res) => { requests++; res.writeHead(302, { location: `http://localhost:${port}/private` }); res.end() })
  await assert.rejects(guardedFetch(`http://127.0.0.1:${port}/`, { env: {} }), error => error.kind === 'blocked_host')
  assert.equal(requests, 1)
  console.log('ok: static, DNS and redirect destinations blocked before connection using owned loopback only')
} finally {
  __setFixtureAllowlistForTests(null)
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
}
