#!/usr/bin/env node
import './isolate-tests.mjs'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { readFileSync } from 'node:fs'
import { createCommunityBrowserBridge } from '../lib/community/browser-bridge.mjs'
import { browserProvider } from '../lib/community/providers/browser.mjs'
import { extractCards } from '../browser/community-bridge/extract.js'

const token = 'a'.repeat(64), headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
const server = createCommunityBrowserBridge({ token, timeoutMs: 250 })
server.listen(0, '127.0.0.1'); await once(server, 'listening')
const origin = `http://127.0.0.1:${server.address().port}`
const post = (path, value, opts = {}) => fetch(`${origin}${path}`, { method: 'POST', headers, body: JSON.stringify(value), ...opts })
try {
  assert.equal((await fetch(`${origin}/next`)).status, 401)
  assert.equal((await fetch(`${origin}/next`, { headers: { Authorization: 'Bearer wrong' } })).status, 401)
  assert.equal((await post('/search', { platform: 'zhihu', query: 'alpha', max_results: 5, script: 'evil()' })).status, 400)
  assert.equal((await post('/search', { platform: 'x', query: 'alpha', max_results: 5 })).status, 400)
  process.env.FIXTURE_BROWSER_TOKEN = token
  const pending = browserProvider('zhihu').search({ query: 'alpha', max_results: 5 }, { backendConfig: { endpoint: origin, token_env: 'FIXTURE_BROWSER_TOKEN' }, fetchImpl: fetch })
  const job = await (await fetch(`${origin}/next`, { headers })).json()
  assert.equal(job.platform, 'zhihu'); assert.equal(job.script, undefined)
  assert.equal((await fetch(`${origin}/active/${job.id}`, { headers })).status, 200)
  assert.equal((await post('/result', { id: job.id, status: 'ok', items: [{ url: 'https://www.zhihu.com/question/123', title: 'alpha', text: 'evidence', published: null, author: null }] })).status, 200)
  const out = await pending
  assert.equal(out.via, 'browser'); assert.equal(out.items[0].title, 'alpha')
  assert.equal((await fetch(`${origin}/active/${job.id}`, { headers })).status, 404)
  console.log('ok: real loopback transport, token authorization, fixed read-only tasks and model-safe normalization')

  const controller = new AbortController()
  const waiting = post('/search', { platform: 'bilibili', query: 'alpha', max_results: 5 }, { signal: controller.signal })
  const cancelJob = await (await fetch(`${origin}/next`, { headers })).json()
  controller.abort(); await assert.rejects(() => waiting)
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal((await fetch(`${origin}/active/${cancelJob.id}`, { headers })).status, 404)
  assert.equal((await post('/result', { id: cancelJob.id, status: 'ok', items: [] })).status, 404)
  const expiring = post('/search', { platform: 'xiaohongshu', query: 'alpha', max_results: 5 })
  await (await fetch(`${origin}/next`, { headers })).json()
  assert.equal((await expiring).status, 503)
  console.log('ok: cancellation removes queued/claimed work, late replies are refused and request deadlines remain bounded')
} finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }

const originalDocument = globalThis.document
try {
  globalThis.document = { body: { innerText: '' }, querySelectorAll: () => [{ href: 'https://www.zhihu.com/question/1?tracking=secret', textContent: ' Alpha ', getAttribute: () => null, closest: () => ({ textContent: 'Alpha practical card' }) }] }
  const cards = extractCards('zhihu', 5)
  assert.equal(cards.items[0].url, 'https://www.zhihu.com/question/1')
  assert.equal(cards.items[0].published, null)
  globalThis.document = { body: { innerText: '' }, querySelectorAll: () => [{ href: 'https://www.zhihu.com/question/1', textContent: 'Unrelated navigation', getAttribute: () => null, closest: () => null, parentElement: { textContent: 'not a search card' } }] }
  assert.equal(extractCards('zhihu', 5).items.length, 0, 'navigation links outside recognized cards are not search evidence')
  globalThis.document = { body: { innerText: '请先登录 安全验证' }, querySelectorAll: () => [] }
  assert.equal(extractCards('xiaohongshu', 5).status, 'blocked')
} finally { globalThis.document = originalDocument }
const manifest = JSON.parse(readFileSync(new URL('../browser/community-bridge/manifest.json', import.meta.url)))
assert.deepEqual(manifest.permissions, ['storage', 'scripting'])
assert.equal(manifest.host_permissions.includes('<all_urls>'), false)
const background = readFileSync(new URL('../browser/community-bridge/background.js', import.meta.url), 'utf8')
assert.doesNotMatch(background, /chrome\.cookies|eval\(|new Function|\.click\(|localStorage|executeScript.*code:/)
assert.match(background, /\/active\//)
console.log('ok: DOM-card fixtures, unknown-date honesty, login/security detection, narrow extension permissions and no arbitrary code/login/cookie actions')
