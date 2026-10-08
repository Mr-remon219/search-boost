import './isolate-tests.mjs'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { ENGINE_BASE_URLS } from '../lib/engine-endpoints.mjs'
import { fetchEngineQuota, parseTavilyQuota, parseBraveQuota, parseTinyfishQuota, quotaAvailability, quotaIdentity, QUOTA_PROVIDERS } from '../lib/engine-quota.mjs'
import { ConsoleModel, renderConsole, displayWidth } from '../lib/console-tui.mjs'
import { searchBoostHome } from '../lib/config-paths.mjs'

let count = 0
async function test(name, fn) { await fn(); count++; console.log(`ok: ${name}`) }
const routing = () => ({ keys: { tavily: 'fixture-tavily-secret', brave: 'fixture-brave-secret', exa: 'fixture-exa-secret', anysearch: 'fixture-anysearch-secret', tinyfish: 'fixture-tinyfish-secret' }, baseUrls: { ...ENGINE_BASE_URLS }, enabledNames: ['tavily', 'brave', 'exa', 'anysearch', 'tinyfish'] })
const tavily = { key: { usage: 150, limit: 1000 }, account: { plan_usage: 500, plan_limit: 15000, paygo_usage: 25, paygo_limit: 100 } }
const wallet = { available_balance: '21.440001', currency: 'USD', as_of: '2026-08-10T18:04:11.220Z', auto_reload: { state: 'on' }, agent_top_up_url: 'https://evil.example/top-up', rates: null }
const jsonResponse = (value, options) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' }, ...options })
const tick = () => new Promise(resolve => setImmediate(resolve))
const key = (model, name, text = '') => model.handleKey(text, { name })
async function consent(model) { key(model, 'down'); key(model, 'return'); await tick() }

await test('Tavily key, plan and PAYGO ceilings are separate; unknown, zero and overage are not fabricated', () => {
  const data = parseTavilyQuota(tavily)
  assert.deepEqual(data.metrics.map(m => m.remaining), [850, 14500, 75])
  assert.deepEqual(parseTavilyQuota({ key: { usage: 120, limit: 100 } }).metrics[0], { id: 'key', unit: 'credits', used: 120, limit: 100, remaining: 0 })
  assert.equal(parseTavilyQuota({ key: { usage: 2, limit: null } }).metrics[0].remaining, null)
  assert.equal(parseTavilyQuota({ key: { usage: 2, limit: null } }).metrics[0].unlimited, true, 'Tavily explicitly documents a null key limit as unlimited')
  assert.equal(parseTavilyQuota({ key: { usage: 0, limit: 0 } }).metrics[0].remaining, 0)
  for (const bad of [{}, { key: { usage: 2 } }, { key: { usage: '2', limit: 100 } }, { key: { usage: -1, limit: 100 } }, { key: { usage: 2, limit: Infinity } }]) assert.throws(() => parseTavilyQuota(bad))
})
await test('Brave chooses a long rate-limit window by policy, not header position or per-second remaining', () => {
  const headers = new Headers({ 'x-ratelimit-limit': '15000, 1', 'x-ratelimit-remaining': '14523, 0', 'x-ratelimit-policy': '15000;w=2592000, 1;w=1' })
  const data = parseBraveQuota(headers)
  assert.equal(data.metrics[0].remaining, 14523); assert.equal(data.metrics[0].used, 477)
  assert.equal(data.metrics[0].windowSeconds, 2592000)
  const unlimited = parseBraveQuota(new Headers({ 'x-ratelimit-limit': '1, 0', 'x-ratelimit-remaining': '0, 0', 'x-ratelimit-policy': '1;w=1, 0;w=2592000' }))
  assert.equal(unlimited.metrics[0].unlimited, true); assert.equal(unlimited.metrics[0].remaining, null)
  const burst = parseBraveQuota(new Headers({ 'x-ratelimit-limit': '1', 'x-ratelimit-remaining': '0', 'x-ratelimit-policy': '1;w=1' }))
  assert.equal(burst.note, 'no_long_window'); assert.deepEqual(burst.metrics, [])
  headers.set('x-ratelimit-remaining', '20000, 0'); assert.throws(() => parseBraveQuota(headers))
  assert.throws(() => parseBraveQuota(new Headers()))
})
await test('TinyFish wallet projects only monetary data; negative/zero are valid and top-up instructions never escape', () => {
  const data = parseTinyfishQuota(wallet)
  assert.equal(data.metrics[0].remaining, 21.440001); assert.equal(data.metrics[0].unit, 'USD')
  assert.equal(data.note, 'account_wallet_not_search_quota')
  assert.doesNotMatch(JSON.stringify(data), /top-up|evil|auto_reload/)
  assert.equal(parseTinyfishQuota({ ...wallet, available_balance: '-0.75' }).metrics[0].remaining, -.75)
  assert.equal(parseTinyfishQuota({ ...wallet, available_balance: '0' }).metrics[0].remaining, 0)
  for (const bad of [{ ...wallet, currency: 'XYZ' }, { ...wallet, available_balance: 'secret-key' }, { ...wallet, as_of: 'invalid' }]) assert.throws(() => parseTinyfishQuota(bad))
})
await test('only verified official endpoints receive their own effective key; Brave requires explicit paid-probe consent', async () => {
  const inputs = routing(), calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, init })
    assert.equal(init.method, 'GET'); assert.equal(init.redirect, 'error'); assert.ok(init.signal)
    if (url.includes('tavily')) { assert.equal(init.headers.Authorization, `Bearer ${inputs.keys.tavily}`); return jsonResponse(tavily) }
    if (url.includes('brave')) {
      assert.equal(init.headers['X-Subscription-Token'], inputs.keys.brave)
      return new Response('search-results-must-not-be-rendered', { headers: { 'x-ratelimit-limit': '1, 15000', 'x-ratelimit-remaining': '0, 14000', 'x-ratelimit-policy': '1;w=1, 15000;w=2592000' } })
    }
    assert.equal(url, 'https://agent.tinyfish.ai/v1/wallet'); assert.equal(init.headers['X-API-Key'], inputs.keys.tinyfish)
    return jsonResponse(wallet)
  }
  for (const name of ['tavily', 'tinyfish']) assert.equal((await fetchEngineQuota(name, inputs, { fetchImpl, now: () => 100 })).status, 'ok')
  assert.equal((await fetchEngineQuota('brave', inputs, { fetchImpl })).status, 'probe_consent_required')
  assert.equal(calls.length, 2)
  const brave = await fetchEngineQuota('brave', inputs, { fetchImpl, allowPaidProbe: true })
  assert.equal(brave.metrics[0].remaining, 14000); assert.equal(calls.length, 3)
  assert.doesNotMatch(JSON.stringify(brave), /search-results/)
  for (const name of ['exa', 'anysearch']) assert.notEqual((await fetchEngineQuota(name, inputs, { fetchImpl })).status, 'ok')
  assert.equal(calls.length, 3, 'unsupported engines never guess an endpoint')
  for (const name of Object.keys(inputs.keys)) assert.doesNotMatch(JSON.stringify(brave), new RegExp(inputs.keys[name]))
})
await test('custom gateways and missing keys are blocked before dispatch; routing disable does not hide quota', async () => {
  const inputs = routing(); let calls = 0
  const fetchImpl = async () => { calls++; return jsonResponse(tavily) }
  inputs.enabledNames = []
  assert.equal((await fetchEngineQuota('tavily', inputs, { fetchImpl })).status, 'ok')
  inputs.baseUrls.tavily = 'https://gateway.example/api'
  assert.equal((await fetchEngineQuota('tavily', inputs, { fetchImpl })).status, 'custom_gateway')
  inputs.keys.tavily = null
  assert.equal((await fetchEngineQuota('tavily', inputs, { fetchImpl })).status, 'no_key')
  assert.equal(calls, 1)
  const original = routing(), changed = routing(); changed.keys.tavily = 'changed-key'
  assert.notEqual(quotaIdentity('tavily', original), quotaIdentity('tavily', changed))
  assert.equal(quotaAvailability('exa', original), 'service_key_required')
})
await test('HTTP failures, oversized/invalid responses, rate limiting and cancellation disclose no raw secrets', async () => {
  const inputs = routing()
  for (const [code, status] of [[401, 'auth_error'], [403, 'auth_error'], [429, 'rate_limited'], [500, 'http_error'], [302, 'http_error']]) {
    const result = await fetchEngineQuota('tavily', inputs, { fetchImpl: async () => new Response('fixture-tavily-secret', { status: code, headers: { 'retry-after': '120000' } }) })
    assert.equal(result.status, status); assert.doesNotMatch(JSON.stringify(result), /fixture-tavily-secret/)
    if (code === 429) assert.equal(result.retryAfterMs, 120000000, 'never shorten provider retry interval')
  }
  assert.equal((await fetchEngineQuota('tinyfish', inputs, { fetchImpl: async () => new Response('', { status: 404 }) })).status, 'wallet_unavailable')
  for (const body of ['{fixture-tavily-secret', 'x'.repeat(65537), JSON.stringify({ key: { usage: 'fixture-tavily-secret', limit: 100 } })]) {
    const result = await fetchEngineQuota('tavily', inputs, { fetchImpl: async () => new Response(body) })
    assert.equal(result.status, 'invalid_response'); assert.doesNotMatch(JSON.stringify(result), /fixture-tavily-secret/)
  }
  const network = await fetchEngineQuota('tavily', inputs, { fetchImpl: async () => { throw new Error('policy blocked fixture-tavily-secret') } })
  assert.deepEqual(network, { status: 'network_error', metrics: [] })
  const controller = new AbortController(); controller.abort()
  let calls = 0
  const cancelled = await fetchEngineQuota('tavily', inputs, { signal: controller.signal, fetchImpl: async () => { calls++ } })
  assert.equal(cancelled.status, 'cancelled'); assert.equal(calls, 0)
})

await test('mid-body transport failures stay network errors without exposing response or exception secrets', async () => {
  for (const name of ['tavily', 'tinyfish']) {
    const result = await fetchEngineQuota(name, routing(), { fetchImpl: async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode('{"secret":"fixture-secret"')); },
      pull(controller) { controller.error(new Error('socket closed fixture-secret')); },
    })) })
    assert.deepEqual(result, { status: 'network_error', metrics: [] })
    assert.doesNotMatch(JSON.stringify(result), /fixture-secret/)
  }
})
await test('Retry-After preserves dates and fails closed for unrepresentable waits', async () => {
  const now = () => Date.parse('2026-10-08T00:00:00Z')
  const query = retry => fetchEngineQuota('tavily', routing(), { now, fetchImpl: async () => new Response('', { status: 429, headers: { 'retry-after': retry } }) })
  assert.equal((await query('Thu, 08 Oct 2026 00:02:00 GMT')).retryAfterMs, 120000)
  assert.equal((await query('99999999999999999999999')).retryAfterMs, Infinity)
  assert.equal((await query('9'.repeat(400))).retryAfterMs, Infinity)
  for (const value of ['nonsense', '0']) assert.equal((await query(value)).retryAfterMs, undefined)
})

let homeId = 0
async function modelFixture(fn) {
  const home = process.env.SEARCH_BOOST_HOME
  process.env.SEARCH_BOOST_HOME = join(process.env.HOME, `quota-${++homeId}`)
  try { await fn() } finally { if (home === undefined) delete process.env.SEARCH_BOOST_HOME; else process.env.SEARCH_BOOST_HOME = home }
}
function makeModel({ dryRun = false, run, now = () => 200000, inputs = routing() } = {}) {
  return new ConsoleModel({ language: 'en', dryRun, services: { readKeysRouting: () => inputs, now,
    fetchEngineQuota: run ?? (async name => ({ status: 'ok', ...(name === 'tavily' ? parseTavilyQuota(tavily) : name === 'tinyfish' ? parseTinyfishQuota(wallet) : parseBraveQuota(new Headers({ 'x-ratelimit-limit': '1,15000', 'x-ratelimit-remaining': '0,14000', 'x-ratelimit-policy': '1;w=1,15000;w=2592000' }))), checkedAt: now() })) } })
}
await test('console alone exposes quota details/overview; browsing, default cancel and dry-run make no calls or writes', () => modelFixture(async () => {
  let calls = 0
  const model = makeModel({ run: async () => { calls++; throw new Error('not authorized') } })
  model.navigate(1)
  assert.equal(model.rows[0].id, 'tavily', 'existing first engine and edit shortcut are unchanged')
  assert.equal(model.rows.at(-1).id, 'quota-overview')
  model.rows[0].actions.find(a => a.id === 'quota-view').run()
  assert.equal(model.modal.kind, 'quota'); assert.deepEqual(model.modal.names, ['tavily'])
  assert.match(renderConsole(model, { columns: 120, rows: 32, color: false }), /Not queried/)
  key(model, 'escape'); key(model, 'u')
  assert.equal(model.modal.index, 0); assert.match(model.modal.description, /api.tavily.com\/usage/)
  key(model, 'return'); await tick(); assert.equal(calls, 0)
  const dry = makeModel({ dryRun: true, run: async () => { calls++; } })
  dry.requestQuota(); await consent(dry); assert.equal(calls, 0); assert.match(dry.notice, /dry-run/)
  assert.equal(existsSync(searchBoostHome()), false)
  const quick = ['tui.mjs', 'keys-wizard.mjs'].map(name => readFileSync(new URL(`../lib/installer/${name}`, import.meta.url), 'utf8')).join('\n')
  assert.doesNotMatch(quick, /engine-quota|fetchEngineQuota|quota-overview/)
}))
await test('an unrepresentable provider retry interval blocks further queries in this session', () => modelFixture(async () => {
  let calls = 0, time = 200000
  const model = makeModel({ now: () => time, run: async () => { calls++; return { status: 'rate_limited', metrics: [], retryAfterMs: Infinity } } })
  model.requestQuota(['tavily']); await consent(model)
  assert.equal(calls, 1)
  time += 86400000
  model.requestQuota(['tavily']); await consent(model)
  assert.equal(calls, 1, 'do not retry early after overflow')
}))
await test('explicit consent shows Brave cost and TinyFish destination; bulk queries are independent and cached', () => modelFixture(async () => {
  let calls = [], time = 200000
  const model = makeModel({ now: () => time, run: async (name, inputs, opts) => {
    calls.push(name); assert.equal(opts.allowPaidProbe, name === 'brave')
    if (name === 'brave') throw new Error('fixture-brave-secret')
    return { status: 'ok', ...(name === 'tavily' ? parseTavilyQuota(tavily) : parseTinyfishQuota(wallet)), checkedAt: time }
  } })
  model.requestQuota()
  assert.match(model.modal.description.split('\n')[0], /1 real search/)
  assert.match(model.modal.description, /agent.tinyfish.ai\/v1\/wallet/)
  assert.match(model.modal.options[1].label, /Brave uses 1 search/)
  assert.match(renderConsole(model, { columns: 54, rows: 16, color: false }), /Brave/)
  assert.match(renderConsole(model, { columns: 54, rows: 16, color: false }), /PgUp/)
  let destinationVisible = false
  for (let i = 0; i < 80; i++) {
    key(model, 'pagedown')
    const visible = renderConsole(model, { columns: 54, rows: 16, color: false }).split('\n').map(line => (line.split(' │ ')[1] ?? '').trim()).join('')
    if (visible.includes('agent.tinyfish.ai/v1/wallet')) destinationVisible = true
  }
  assert.equal(destinationVisible, true, 'even the minimum terminal can inspect every destination before consenting')
  assert.equal(calls.length, 0)
  await consent(model)
  assert.deepEqual(calls.sort(), ['brave', 'tavily', 'tinyfish'])
  assert.equal(model.quotaState('tavily').status, 'ok'); assert.equal(model.quotaState('brave').status, 'network_error')
  assert.doesNotMatch(renderConsole(model, { columns: 120, rows: 32 }), /fixture-brave-secret/)
  model.requestQuota(); await consent(model); assert.equal(calls.length, 3)
  time += 60000; model.requestQuota(); await consent(model); assert.equal(calls.length, 6)
  assert.equal(existsSync(searchBoostHome()), false)
}))
await test('rate-limit retry intervals, changed credentials and gateways invalidate or block cached requests', () => modelFixture(async () => {
  const inputs = routing(); let calls = 0, time = 200000
  const model = makeModel({ inputs, now: () => time, run: async () => { calls++; return { status: 'rate_limited', metrics: [], retryAfterMs: 180000 } } })
  model.requestQuota(['tavily']); await consent(model)
  time += 90000; model.requestQuota(['tavily']); await consent(model); assert.equal(calls, 1)
  time += 90000; model.requestQuota(['tavily']); await consent(model); assert.equal(calls, 2)
  inputs.keys.tavily = 'new-effective-key'; model.reload(); assert.equal(model.quotaState('tavily').status, 'idle')
  model.requestQuota(['tavily']); inputs.keys.tavily = 'changed-during-confirmation'; await consent(model)
  assert.equal(calls, 2); assert.match(model.notice, /failed/)
  inputs.baseUrls.tavily = 'https://gateway.example'; model.reload()
  assert.equal(model.quotaState('tavily').status, 'custom_gateway')
  model.requestQuota(['tavily']); assert.equal(model.modal.kind, 'quota'); assert.equal(calls, 2)
}))
await test('Escape cancels requests; late responses are discarded and cancellation still enforces the cooldown', () => modelFixture(async () => {
  let complete, calls = 0
  const model = makeModel({ run: (name, inputs, opts) => { calls++; assert.ok(opts.signal); return new Promise(resolve => { complete = resolve }) } })
  model.requestQuota(['tavily']); await consent(model)
  const signal = model.quotaTask.controller.signal
  key(model, 'escape'); assert.equal(signal.aborted, true)
  complete({ status: 'ok', ...parseTavilyQuota(tavily), checkedAt: 200000 }); await tick()
  assert.equal(model.quotaTask, null); assert.notEqual(model.quotaState('tavily').status, 'ok')
  model.requestQuota(['tavily']); await consent(model); assert.equal(calls, 1)
}))
await test('a key changed during an in-flight request never receives an old-key quota snapshot', () => modelFixture(async () => {
  const inputs = routing(); let complete
  const model = makeModel({ inputs, run: () => new Promise(resolve => { complete = resolve }) })
  model.requestQuota(['tavily']); await consent(model)
  inputs.keys.tavily = 'replaced-in-flight-key'
  complete({ status: 'ok', ...parseTavilyQuota(tavily), checkedAt: 200000 }); await tick()
  assert.equal(model.quotaTask, null)
  assert.equal(model.quotaState('tavily').status, 'idle')
  assert.match(model.notice, /unavailable/)
  assert.doesNotMatch(renderConsole(model, { columns: 120, rows: 32 }), /850|fixture-tavily-secret/)
}))
await test('quota cards remain bounded, bilingual and readable in wide/tight terminals with no ANSI in no-color mode', () => modelFixture(async () => {
  const model = makeModel()
  model.navigate(1); model.requestQuota(); await consent(model)
  const grid = renderConsole(model, { columns: 180, rows: 32, color: false })
  for (const engine of Object.keys(QUOTA_PROVIDERS)) assert.match(grid, new RegExp(engine), 'wide overview shows all engines without scrolling')
  assert.match(grid, /850/); assert.match(grid, /14,000/); assert.match(grid, /\$21\.440001/)
  assert.doesNotMatch(grid, /\x1b|fixture-|evil|top-up/)
  const compact = renderConsole(model, { columns: 120, rows: 32, color: false })
  assert.match(compact, /API quota overview/, 'middle list is retained, not replaced by the quota view')
  key(model, 'end')
  assert.match(renderConsole(model, { columns: 120, rows: 32, color: false }), /\$21\.440001/, 'right-pane overview is scrollable when all cards do not fit')
  const bottom = model.modal.scroll
  for (let i = 0; i < 20; i++) key(model, 'pagedown')
  assert.equal(model.modal.scroll, bottom, 'scroll is clamped to the visible card extent')
  key(model, 'up'); assert.equal(model.modal.scroll, bottom - 1)
  for (const language of ['en', 'zh-CN']) {
    model.language = language; model.reload()
    for (const columns of [54, 80, 100, 112, 120, 160, 180]) for (const rows of [16, 24, 32, 40]) for (const color of [false, true]) {
      model.showQuotaOverview()
      key(model, 'pagedown')
      const lines = renderConsole(model, { columns, rows, color }).split('\n')
      assert.ok(lines.length <= rows - 1)
      for (const line of lines) assert.ok(displayWidth(line) <= columns - 1, `${columns}x${rows}: ${line}`)
      model.showQuotaOverview(['tavily'])
      assert.match(renderConsole(model, { columns: 120, rows: 40, color: false }), /14,500/)
    }
  }
}))
console.log(`\n${count} quota groups passed (offline fixtures; no real keys or paid searches used).`)
