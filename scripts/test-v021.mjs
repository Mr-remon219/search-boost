#!/usr/bin/env node
/** v0.2.1 repairs: real CLI/config/process/loopback HTTP boundaries, plus typed
 * provider response fixtures. Never consumes a real credential or the host HOME. */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { connect } from 'node:net'
const root = resolve(import.meta.dirname, '..'), temp = mkdtempSync(join(tmpdir(), 'sb-v021-'))
process.env.HOME = process.env.USERPROFILE = join(temp, 'home')
process.env.SEARCH_BOOST_HOME = join(process.env.HOME, '.search-boost')
process.env.PI_CODING_AGENT_DIR = join(process.env.HOME, '.pi', 'agent')
for (const name of Object.keys(process.env)) if (/^(SEARCH_BOOST_(KEYS|LAYER|XAUTH|XGUEST)_FILE|TYPESAFE_API_KEY|AI_GATEWAY_API_KEY|XAI_API_KEY|TAVILY_API_KEY|BRAVE_API_KEY|EXA_API_KEY)$/i.test(name) || /^(http|https|all|no)_proxy$/i.test(name)) delete process.env[name]
mkdirSync(process.env.HOME, { recursive: true })
const { ipv4Fetch, closeFetchDispatchers, __setUndiciLoaderForTests } = await import('../lib/search/ipv4-fetch.js')
const { fetchPage, makePageCache } = await import('../lib/search/fetch.js')
const { createJevClient } = await import('../lib/jev/client.mjs')
const { runCommand } = await import('../lib/upgrade/process.mjs')
const { setCodexNativeSearch, codexRootSearchDisabled } = await import('../lib/codex-native.mjs')
const { resultKey } = await import('../lib/search/results.js')
const { preprocessQuery } = await import('../lib/search/fusion.js')
const { classifyFetchError } = await import('../lib/search/net-policy.mjs')
const { normalizeJevBaseUrl } = await import('../lib/jev-config.mjs')
const undici = await import('undici')
const originalFetch = globalThis.fetch
const records = []
async function test(name, action) {
  const start = Date.now()
  try { await action(); records.push({ name, ok: true, ms: Date.now() - start }); console.log('ok:', name) }
  catch (err) { records.push({ name, ok: false, error: err.message }); console.error('FAIL:', name, err.stack); process.exitCode = 1 }
  finally { globalThis.fetch = originalFetch; await closeFetchDispatchers(); __setUndiciLoaderForTests(null) }
}
function cli(args, env = process.env) {
  const r = spawnSync(process.execPath, [join(root, 'cli.mjs'), ...args], { cwd: temp, env, encoding: 'utf8', timeout: 20000 })
  if (r.error) throw r.error
  return { code: r.status, text: r.stdout + r.stderr }
}
function save(file, text) { mkdirSync(resolve(file, '..'), { recursive: true }); writeFileSync(file, text) }
const keyPath = join(process.env.HOME, '.search-boost', 'config', 'keys.json')
async function listening(server) {
  const sockets = new Set()
  server.on('connection', s => { sockets.add(s); s.on('close', () => sockets.delete(s)) })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  return { url: `http://127.0.0.1:${server.address().port}`, close: async () => {
    for (const s of sockets) s.destroy(); await new Promise(r => server.close(r))
  } }
}
try {
  await test('U01 malformed host JSON is rejected without losing the original bytes', () => {
    const file = join(process.env.HOME, '.cursor', 'mcp.json'), text = '{"mcpServers":{"user":{"command":"custom"}},}'
    save(file, text); const out = cli(['install', '-t', 'cursor', '-y']); assert.notEqual(out.code, 0); assert.equal(readFileSync(file, 'utf8'), text)
    rmSync(file)
  })
  await test('U02 user-owned Pi extension survives install conflict and uninstall', () => {
    const file = join(process.env.PI_CODING_AGENT_DIR, 'extensions', 'search-boost.js'), text = '// My user extension\n'
    save(file, text); assert.notEqual(cli(['install', '-t', 'pi', '-y']).code, 0); assert.equal(readFileSync(file, 'utf8'), text)
    assert.equal(cli(['uninstall', '-t', 'pi', '-y']).code, 0); assert.equal(readFileSync(file, 'utf8'), text); rmSync(file)
  })
  await test('U03 page version query parameters cannot alias each other in the cache', async () => {
    let calls = 0
    __setUndiciLoaderForTests(async () => ({ ...undici, fetch: async url => { calls++; return new undici.Response(('Requested ' + decodeURIComponent(String(url)) + '\n').repeat(3)) } }))
    const cache = makePageCache(); const first = await fetchPage('https://example.com/doc?ref=v1', undefined, cache)
    const second = await fetchPage('https://example.com/doc?ref=v2', undefined, cache)
    assert.notEqual(resultKey({ url: 'https://example.com/doc?ref=v1' }), resultKey({ url: 'https://example.com/doc?ref=v2' }))
    assert.equal(calls, 2); assert.match(first.content, /ref=v1/); assert.match(second.content, /ref=v2/)
    assert.equal((await fetchPage('https://example.com/doc?ref=v2#heading', undefined, cache)).via, 'cache')
  })
  await test('U04 root TOML is effective, idempotent, and restored byte-for-byte', () => {
    for (const before of ['web_search = "live"\n[mcp_servers.other]\ncommand="x"\n', '[mcp_servers.other]\ncommand="x"\n', 'instructions="""\n[not-a-table]\nweb_search="fake"\n"""\nweb_search = "cached"\n[foo]\na=1\n']) {
      const after = setCodexNativeSearch(before, true); assert(codexRootSearchDisabled(after)); assert.equal(setCodexNativeSearch(after, true), after); assert.equal(setCodexNativeSearch(after, false), before)
    }
    const legacy = 'web_search="live"\n[mcp_servers.other]\ncommand="x"\n# SEARCH_BOOST_WEB_SEARCH_START\nweb_search="disabled"\n# SEARCH_BOOST_WEB_SEARCH_END\n'
    assert(!codexRootSearchDisabled(legacy)); assert(codexRootSearchDisabled(setCodexNativeSearch(legacy, true)))
    assert.equal(setCodexNativeSearch('web_search="disabled"\n', false), 'web_search="disabled"\n')
  })
  await test('U05 exact phrases retain quoted OR and site text', () => {
    const result = preprocessQuery('"a OR b site:literal.com" site:filter.com OR "other phrase"')
    assert.equal(result.cleaned, '"a OR b site:literal.com"'); assert.deepEqual(result.includeDomains, ['filter.com']); assert.deepEqual(result.alternatives, ['"other phrase"'])
  })
  await test('U06 project-scoped Grok install/uninstall touches the selected scope only', () => {
    assert.equal(cli(['install', '-t', 'grok', '--scope', 'project', '--skip-grok-plugin', '-y']).code, 0)
    const path = join(temp, '.grok', 'config.toml'); assert(existsSync(path)); assert.match(readFileSync(path, 'utf8'), /search-boost/)
    assert.equal(cli(['uninstall', '-t', 'grok', '--scope', 'project', '--skip-grok-plugin', '-y']).code, 0)
    assert(!existsSync(path) || !readFileSync(path, 'utf8').includes('mcp_servers.search-boost'))
  })
  await test('U07 missing DSH returns failure rather than fictitious successful installation', () => {
    const out = cli(['install', '-t', 'dsh', '-y'], { ...process.env, PATH: join(temp, 'empty-bin') }); assert.notEqual(out.code, 0); assert.doesNotMatch(out.text, /\[ok\] dsh/)
  })
  await test('U08/U09 combined keys + routing are atomic; malformed batch makes no partial write', () => {
    assert.equal(cli(['config', 'keys', '--set', 'tavily=fixture', '--engines', 'tavily']).code, 0)
    const before = readFileSync(keyPath, 'utf8'); const doc = JSON.parse(before); assert.equal(doc.tavily, 'fixture'); assert.deepEqual(doc.enabledEngines, ['tavily'])
    assert.notEqual(cli(['config', 'keys', '--set', 'tavily=changed', '--set', 'typo=bad']).code, 0); assert.equal(readFileSync(keyPath, 'utf8'), before)
  })
  await test('U11 dry-run rejects invalid values and never claims Saved or Removed', () => {
    assert.notEqual(cli(['config', 'keys', '--set', 'notAnEngine=bad', '--dry-run']).code, 0)
    assert.notEqual(cli(['config', 'x', '--set-xai-key', 'invalid', '--dry-run']).code, 0)
    const out = cli(['config', 'jev', '--clear', '--dry-run']); assert.equal(out.code, 0); assert.doesNotMatch(out.text, /Removed Jev/)
  })
  await test('PI01 real transport survives host fetch replacement; proxy actually receives traffic', async () => {
    const origin = await listening(createServer((_req, res) => res.end('origin response')))
    const sockets = new Set(); let tunnels = 0
    const server = createServer()
    server.on('connect', (req, client, head) => {
      tunnels++; const target = new URL('http://' + req.url)
      const upstream = connect(Number(target.port), target.hostname, () => { client.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (head.length) upstream.write(head); upstream.pipe(client); client.pipe(upstream) })
      sockets.add(upstream); upstream.on('close', () => sockets.delete(upstream)); upstream.on('error', () => client.destroy()); client.on('close', () => upstream.destroy()); client.on('error', () => upstream.destroy())
    })
    const proxy = await listening(server)
    globalThis.fetch = async () => { throw new Error('host fetch must never be called with our dispatcher') }
    try { process.env.ALL_PROXY = proxy.url; const res = await ipv4Fetch(origin.url, { signal: AbortSignal.timeout(3000) }); assert.equal(await res.text(), 'origin response'); assert.equal(tunnels, 1) }
    finally { delete process.env.ALL_PROXY; await closeFetchDispatchers(); for (const s of sockets) s.destroy(); await proxy.close(); await origin.close() }
  })
  await test('credential-bearing 307 redirect cannot forward API keys to another service', async () => {
    let leaked = 0
    const destination = await listening(createServer((_req, res) => { leaked++; res.end('bad') }))
    const source = await listening(createServer((_req, res) => { res.writeHead(307, { location: destination.url }); res.end() }))
    try {
      await assert.rejects(ipv4Fetch(source.url, { method: 'POST', body: '{"api_key":"fixture"}', signal: AbortSignal.timeout(2000) }))
      await assert.rejects(ipv4Fetch(source.url, { headers: { 'x-api-key': 'fixture' }, signal: AbortSignal.timeout(2000) }))
      assert.equal(leaked, 0)
    } finally { await closeFetchDispatchers(); await source.close(); await destination.close() }
  })
  await test('J01 official SDK maps Boolean/Choice confidence and explicit usage', async () => {
    let calls = 0
    const client = createJevClient({ baseUrl: 'https://ai-gateway.vercel.sh/v1', apiKey: 'fixture', fetchImpl: async (url, init) => {
      calls++; assert.equal(new URL(url).origin, 'https://ai-gateway.vercel.sh'); assert.equal(init.redirect, 'manual')
      const body = JSON.parse(init.body); assert.equal(body.questions.yes.type, 'boolean'); assert.equal(body.api_key, undefined)
      return Response.json({ answers: { yes: { type: 'boolean', probability: .95 }, choose: { type: 'choice', choice: 'a', probabilities: { a: .8, b: .2 } } }, usage: { inputTokens: 123, outputTokens: 7 }, providerMetadata: { typesafe: { confidence: { choose: .73 } } } })
    } })
    const out = await client.ask({ state: 'provided evidence', questions: { yes: { type: 'noul', instructions: 'Is evidence present?' }, choose: { type: 'choice', instructions: 'Pick', criteria: { a: 'First', b: 'Second' } } } })
    assert.equal(calls, 1); assert.equal(out.entries.get('yes').value, .95); assert.equal(out.entries.get('choose').confidence, .73); assert.equal(client.usage().inputTokens, 123)
  })
  await test('J03 Retry-After 60 is never shortened; J04 phase attempts are not cumulative', async () => {
    let time = 0; const times = []
    const c = createJevClient({ baseUrl: 'https://service.example/v1', apiKey: 'fixture', now: () => time, sleep: async ms => { time += ms }, fetchImpl: async () => { times.push(time); return times.length === 1 ? new Response('', { status: 429, headers: { 'retry-after': '60' } }) : Response.json({ answers: { q: { type: 'noul', noul: .9 } } }) } })
    const req = { state: 'a', questions: { q: { type: 'noul' } } }; assert.equal((await c.ask(req)).attempts, 2); assert.deepEqual(times, [0, 60000]); assert.equal((await c.ask(req)).attempts, 1)
    const limited = createJevClient({ baseUrl: 'https://service.example', apiKey: 'fixture', maxAskMs: 500, fetchImpl: async () => new Response('', { status: 429, headers: { 'retry-after': '60' } }) })
    await assert.rejects(limited.ask(req), e => e.kind === 'rate_limited' && e.detail === 'retry_after_exceeds_budget'); assert.equal(limited.usage().httpAttempts, 1)
  })
  await test('Jev malformed endpoints cannot echo embedded credentials and query secrets', () => {
    for (const url of ['https://u:secret@example.com', 'https://example.com?key=secret', 'https://example.com#secret']) assert.throws(() => normalizeJevBaseUrl(url), e => !e.message.includes('secret'))
    assert.equal(classifyFetchError(new TypeError('local dispatcher mismatch')).kind, 'transport_error')
  })
  await test('UP02 hung subprocess reaches an independent deadline and tree cleanup', async () => {
    const start = Date.now(); const result = await runCommand(process.execPath, ['-e', 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'], { timeoutMs: 150, killGraceMs: 150, closeGraceMs: 100 })
    assert.equal(result.code, 124); assert(Date.now() - start < 3000)
    if (process.platform !== 'win32') {
      const result = await runCommand(process.execPath, ['-e', 'require("child_process").spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:["ignore",1,2]});setTimeout(()=>process.exit(0),25)'], { timeoutMs: 3000, killGraceMs: 100, closeGraceMs: 100 })
      assert.equal(result.code, 125)
    }
  })
} finally {
  await closeFetchDispatchers(); globalThis.fetch = originalFetch
  if (process.env.SEARCH_BOOST_TEST_REPORT) writeFileSync(process.env.SEARCH_BOOST_TEST_REPORT, JSON.stringify(records, null, 2))
  rmSync(temp, { recursive: true, force: true })
}
console.log(`${records.filter(r => r.ok).length}/${records.length} v0.2.1 boundary regressions passed`)
