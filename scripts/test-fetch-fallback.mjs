#!/usr/bin/env node
// Hermetic origin/proxy + real optional curl. No external sites or user credentials.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { connect } from 'node:net'
import { spawnSync, execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { gzipSync } from 'node:zlib'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { fetchPage, makePageCache } from '../lib/search/fetch.js'
import { guardedFetch } from '../lib/search/ssrf.js'
import { curlPageFetch, __setCurlSpawnForTests } from '../lib/search/curl-fetch.mjs'
import { __setUndiciLoaderForTests, closeFetchDispatchers } from '../lib/search/ipv4-fetch.js'
import { NET_ERROR_KINDS } from '../lib/search/net-policy.mjs'

const envNames = Object.keys(process.env).filter((k) => /^(http|https|all|no)_proxy$/i.test(k))
const env = Object.fromEntries(envNames.map((k) => [k, process.env[k]]))
for (const k of envNames) delete process.env[k]
const undici = await import('undici')
const direct = { route: 'direct', proxyUrl: null }
const prose = 'Useful documentation with enough substance for extraction. '.repeat(20)
const html = `<html><head><style>SECRET_STYLE</style></head><body><h1>Reference</h1><script>SECRET_SCRIPT</script><p>${prose}</p></body></html>`
let passed = 0
const run = promisify(execFile)
async function fixture(handler, onConnect) {
  const sockets = new Set(), requests = []
  const server = createServer((req, res) => { requests.push(req.url); handler(req, res) })
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)) })
  if (onConnect) server.on('connect', onConnect)
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  return { port: server.address().port, requests, close: () => new Promise((r) => { for (const s of sockets) s.destroy(); server.close(r) }) }
}
async function test(name, action) {
  try { await action(); passed++; console.log(`ok: ${name}`) }
  catch (err) { process.exitCode = 1; console.error(`FAIL: ${name}\n${err.stack}`) }
  finally { await closeFetchDispatchers(); __setUndiciLoaderForTests(null); __setCurlSpawnForTests(null) }
}
const origin = await fixture((req, res) => {
  if (req.url === '/relative-redirect') { res.writeHead(302, { location: '/docs/page' }); res.end(); return }
  if (req.url === '/docs/page') { res.end(`<a href="sibling">Sibling</a><p>${prose}</p>`); return }
  if (req.url === '/redirect') { res.writeHead(302, { location: '/gzip' }); res.end(); return }
  if (req.url === '/bad-redirect') { res.writeHead(302, { location: 'file:///etc/passwd' }); res.end(); return }
  if (req.url === '/hang') return
  if (req.url === '/huge') { res.end('a'.repeat(8_100_000)); return }
  if (req.url === '/gzip') { res.writeHead(200, { 'content-encoding': 'gzip' }); res.end(gzipSync(html)); return }
  res.writeHead(200, { 'content-type': 'text/html' }); res.end(html)
})
const url = `http://127.0.0.1:${origin.port}/page`
try {
  await test('origin fast path cleans HTML, skips Jina, and caches without another request', async () => {
    const seen = []
    __setUndiciLoaderForTests(async () => ({ ...undici, fetch: (u, opts) => {
      seen.push(String(u)); assert.equal(String(u), url); return undici.fetch(u, opts)
    } }))
    const cache = makePageCache()
    const result = await fetchPage(url, undefined, cache)
    assert.equal(result.via, 'local')
    assert.match(result.content, /Useful documentation/)
    assert.doesNotMatch(result.content, /SECRET_|<html>/)
    assert.equal((await fetchPage(url, undefined, cache)).via, 'cache')
    assert.equal(seen.length, 1)
  })

  await test('redirected origin links resolve against the final URL', async () => {
    const result = await fetchPage(`http://127.0.0.1:${origin.port}/relative-redirect`, undefined, makePageCache())
    assert.ok(result.content.includes(`http://127.0.0.1:${origin.port}/docs/sibling`))
  })

  await test('an origin-stage timeout may still use the reader within the total budget', async () => {
    const seen = []
    __setUndiciLoaderForTests(async () => ({ ...undici, fetch: async (u) => {
      seen.push(String(u))
      if (String(u).startsWith('https://r.jina.ai/')) return new Response(prose)
      const err = new Error('origin stage timed out')
      err.name = 'NetworkPolicyError'; err.kind = NET_ERROR_KINDS.deadline
      throw err
    } }))
    assert.equal((await fetchPage(url, undefined, makePageCache())).via, 'jina')
    assert.equal(seen.length, 2)
  })

  await test('a failed optional reader does not discard short useful origin content', async () => {
    __setUndiciLoaderForTests(async () => ({ ...undici, fetch: async (u) => {
      if (String(u).startsWith('https://r.jina.ai/')) {
        const err = new Error('reader TLS failed'); err.name = 'NetworkPolicyError'; err.kind = NET_ERROR_KINDS.tls; throw err
      }
      return new Response('<p>Short but useful.</p>')
    } }))
    const result = await fetchPage(url, undefined, makePageCache())
    assert.equal(result.via, 'local')
    assert.match(result.content, /Short but useful/)
    assert.equal(result.limitation.kind, NET_ERROR_KINDS.tls)
  })

  await test('missing curl preserves the primary transport diagnostic and uses the reader backup', async () => {
    __setCurlSpawnForTests(() => { throw new Error('not installed') })
    const seen = []
    __setUndiciLoaderForTests(async () => ({ ...undici, fetch: async (u) => {
      seen.push(String(u))
      if (String(u).startsWith('https://r.jina.ai/')) return new Response(prose)
      throw Object.assign(new Error('incompatible parser'), { code: 'HPE_INVALID_HEADER_TOKEN' })
    } }))
    const result = await fetchPage(url, undefined, makePageCache())
    assert.equal(result.via, 'jina')
    assert.equal(seen.length, 2)
  })

  await test('malformed curl output is a transport failure, allowing the reader backup', async () => {
    __setCurlSpawnForTests((_cmd, _args, opts) => spawn(process.execPath, ['-e', 'process.stdout.write("not HTTP headers")'], opts))
    __setUndiciLoaderForTests(async () => ({ ...undici, fetch: async (u) => {
      if (String(u).startsWith('https://r.jina.ai/')) return new Response(prose)
      throw Object.assign(new Error('incompatible parser'), { code: 'HPE_INVALID_HEADER_TOKEN' })
    } }))
    const result = await fetchPage(url, undefined, makePageCache())
    assert.equal(result.via, 'jina')
  })

  if (spawnSync('curl', ['-q', '--version'], { stdio: 'ignore' }).status !== 0) {
    console.log('skip: real curl compatibility/benchmark fixtures — optional curl is not installed')
  } else {
    await test('curl handles an origin that the primary HTTP parser rejects, with full cleanup', async () => {
      let calls = 0
      __setUndiciLoaderForTests(async () => ({ ...undici, fetch: async (u) => {
        assert.equal(String(u), url, 'Jina must not run after curl succeeds')
        calls++
        throw Object.assign(new Error('incompatible parser'), { code: 'HPE_INVALID_HEADER_TOKEN' })
      } }))
      const page = await fetchPage(url, undefined, makePageCache())
      assert.equal(calls, 1)
      assert.equal(page.via, 'local')
      assert.match(page.content, /Useful documentation/)
      assert.doesNotMatch(page.content, /SECRET_|<html>/)
    })

    await test('curl still works if the Undici dependency cannot load', async () => {
      __setUndiciLoaderForTests(async () => { throw new Error('missing module') })
      const page = await fetchPage(url, undefined, makePageCache())
      assert.equal(page.via, 'local')
      assert.match(page.content, /Useful documentation/)
    })

    await test('curl direct mode ignores ambient proxy variables and curlrc', async () => {
      const home = mkdtempSync(join(tmpdir(), 'sb-curlrc-'))
      const saved = { CURL_HOME: process.env.CURL_HOME, ALL_PROXY: process.env.ALL_PROXY }
      writeFileSync(join(home, '.curlrc'), 'proxy = "http://127.0.0.1:1"\nurl = "http://127.0.0.1:1/extra"\n')
      process.env.CURL_HOME = home
      process.env.ALL_PROXY = 'http://127.0.0.1:1'
      try {
        const res = await curlPageFetch(url, { route: direct })
        assert.match(await res.text(), /Useful documentation/)
      } finally {
        for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
        rmSync(home, { recursive: true, force: true })
      }
    })

    await test('curl uses the selected proxy and remote DNS, despite ambient NO_PROXY', async () => {
      const connects = [], upstreams = new Set()
      const proxy = await fixture((_req, res) => { res.writeHead(400); res.end() }, (req, client, head) => {
        connects.push(req.url)
        const upstream = connect(origin.port, '127.0.0.1', () => {
          client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
          if (head.length) upstream.write(head)
          upstream.pipe(client); client.pipe(upstream)
        })
        upstreams.add(upstream)
        client.on('close', () => upstream.destroy())
        upstream.on('error', () => client.destroy())
        client.on('error', () => upstream.destroy())
      })
      process.env.NO_PROXY = '*'
      try {
        const res = await curlPageFetch(`http://proxy-dns-only.invalid:${origin.port}/`, {
          route: { route: 'proxy', proxyUrl: `http://127.0.0.1:${proxy.port}` },
        })
        assert.match(await res.text(), /Useful documentation/)
        assert.deepEqual(connects, [`proxy-dns-only.invalid:${origin.port}`])
      } finally { delete process.env.NO_PROXY; for (const s of upstreams) s.destroy(); await proxy.close() }
    })

    await test('curl redirects remain per-hop and compressed bodies are decoded', async () => {
      const res = await guardedFetch(`http://127.0.0.1:${origin.port}/redirect`, { transport: 'curl', env: {} })
      assert.match(await res.text(), /Useful documentation/)
      await assert.rejects(guardedFetch(`http://127.0.0.1:${origin.port}/bad-redirect`, { transport: 'curl', env: {} }),
        (err) => err.kind === NET_ERROR_KINDS.blockedHost)
    })

    await test('curl cancellation kills the request promptly and oversized output fails', async () => {
      const controller = new AbortController()
      const start = performance.now()
      const pending = curlPageFetch(`http://127.0.0.1:${origin.port}/hang`, { route: direct, signal: controller.signal })
      const timer = setTimeout(() => controller.abort(), 40)
      try { await assert.rejects(pending, (err) => err.kind === NET_ERROR_KINDS.cancelled) } finally { clearTimeout(timer) }
      assert.ok(performance.now() - start < 2000)
      await assert.rejects(curlPageFetch(`http://127.0.0.1:${origin.port}/huge`, { route: direct }),
        (err) => err.kind === NET_ERROR_KINDS.responseTooLarge)
    })

    await test('streaming-body failure also retries the origin through curl', async () => {
      __setUndiciLoaderForTests(async () => ({ ...undici, fetch: async () => new Response(new ReadableStream({
        start(c) { c.error(Object.assign(new Error('body socket closed'), { code: 'UND_ERR_SOCKET' })) },
      })) }))
      const page = await fetchPage(url, undefined, makePageCache())
      assert.equal(page.via, 'local')
      assert.match(page.content, /Useful documentation/)
    })

    await test('body retry shares the origin deadline and leaves time for reader backup', async () => {
      const nativeTimeout = AbortSignal.timeout
      let stageSignals = 0
      AbortSignal.timeout = (ms) => nativeTimeout(ms === 20_000 ? (++stageSignals === 1 ? 180 : 1000) : ms)
      try {
        __setUndiciLoaderForTests(async () => ({ ...undici, fetch: async (u) => {
          if (String(u).startsWith('https://r.jina.ai/')) return new Response(prose)
          return new Response(new ReadableStream({ start(c) {
            setTimeout(() => c.error(Object.assign(new Error('body reset'), { code: 'UND_ERR_SOCKET' })), 40)
          } }))
        } }))
        const start = performance.now()
        const page = await fetchPage(`http://127.0.0.1:${origin.port}/hang`, undefined, makePageCache())
        assert.equal(page.via, 'jina')
        assert.ok(performance.now() - start < 700, 'retry must not receive a fresh stage budget')
      } finally { AbortSignal.timeout = nativeTimeout }
    })

    await test('loopback timing sample compares the fast path, raw curl, and cache', async () => {
      const originMs = [], curlMs = [], cachedMs = []
      const cache = makePageCache()
      await fetchPage(url, undefined, cache) // warm connection and cache
      for (let i = 0; i < 12; i++) {
        let t = performance.now()
        await fetchPage(url, undefined, makePageCache())
        originMs.push(performance.now() - t)
        t = performance.now()
        await run('curl', ['-q', '--silent', '--proxy', '', '--noproxy', '*', '--max-time', '5', url])
        curlMs.push(performance.now() - t)
        t = performance.now()
        await fetchPage(url, undefined, cache)
        cachedMs.push(performance.now() - t)
      }
      const median = (a) => Number(a.sort((x, y) => x - y)[Math.floor(a.length / 2)].toFixed(2))
      console.log('timing (loopback only, warmed Undici, no universal speed claim):', JSON.stringify({
        originWithCleanupMs: median(originMs), rawCurlMs: median(curlMs), cacheMs: median(cachedMs),
      }))
    })
  }
} finally {
  await closeFetchDispatchers(); await origin.close()
  __setUndiciLoaderForTests(null); __setCurlSpawnForTests(null)
  for (const [k, v] of Object.entries(env)) process.env[k] = v
}
console.log(`${passed} fetch fallback tests passed`)
