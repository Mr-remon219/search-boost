#!/usr/bin/env node
import './isolate-tests.mjs'
import assert from 'node:assert/strict'
import { createBridgeWorker } from '../browser/community-bridge/background.js'

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
const until = async predicate => { for (let i = 0; i < 300; i++) { if (predicate()) return; await new Promise(r => setImmediate(r)) } throw new Error('Worker fixture did not reach checkpoint') }
const event = () => { const handlers = []; return { addListener: h => handlers.push(h), emit: (...args) => handlers.forEach(h => h(...args)) } }
const job = id => ({ id, platform: 'zhihu', query: id, max_results: 5 })
const cards = { status: 'ok', items: [{ url: 'https://www.zhihu.com/question/1', title: 'Alpha', text: 'card' }] }
function fixture(options = {}) {
  const store = { enabled: true, endpoint: 'http://127.0.0.1:19826', token: 'a'.repeat(32), ...options.store }
  const counts = { next: 0, created: [], extracted: 0, posts: [], removed: [] }
  const tabs = new Map((options.tabs ?? []).map(t => [t.id, t]))
  const pending = deferred()
  const chrome = {
    storage: { onChanged: event(), local: {
      get: async keys => Object.fromEntries(keys.map(k => [k, store[k]])),
      async set(values) { const changes = {}; for (const [key, value] of Object.entries(values)) { changes[key] = { oldValue: store[key], newValue: value }; store[key] = value } chrome.storage.onChanged.emit(changes, 'local') },
    } },
    runtime: { onMessage: event(), onStartup: event(), onInstalled: event() },
    tabs: {
      async create(args) { counts.created.push(args); const tab = { id: 100 + counts.created.length, status: 'complete', ...args }; tabs.set(tab.id, tab); return tab },
      async get(id) { await options.onGet?.(); return tabs.get(id) },
      async remove(id) { counts.removed.push(id); tabs.delete(id) },
      async query() { return [...tabs.values()] },
    },
    scripting: { async executeScript() { counts.extracted++; return [{ result: options.extract ? await options.extract() : cards }] } },
  }
  const fetchImpl = async (url, init) => {
    const path = new URL(url).pathname
    if (path === '/result') { counts.posts.push(JSON.parse(init.body)); await chrome.storage.local.set({ enabled: false }); return { ok: true } }
    if (path.startsWith('/active/')) return { ok: true }
    assert.equal(path, '/next')
    const n = ++counts.next
    const promise = options.next ? options.next(n) : pending.promise
    const data = await new Promise((resolve, reject) => {
      const abort = () => reject(init.signal.reason)
      if (!options.ignoreAbort) init.signal.addEventListener('abort', abort, { once: true })
      Promise.resolve(promise).then(value => { init.signal.removeEventListener('abort', abort); resolve(value) }, reject)
    })
    return { ok: true, json: async () => data }
  }
  const worker = createBridgeWorker({ chrome, fetchImpl, pause: options.pause ?? (async (_ms, signal) => signal.throwIfAborted()), uuid: () => 'a-b-c' })
  return { chrome, counts, worker, pending, store }
}

// The old /next response can arrive even if the transport ignores abort.
{
  const f = fixture({ ignoreAbort: true })
  await until(() => f.counts.next === 1)
  await f.chrome.storage.local.set({ enabled: false })
  f.pending.resolve(job('late'))
  await f.worker.settled()
  assert.equal(f.counts.created.length, 0)
  assert.equal(f.counts.extracted, 0)
  assert.equal(f.counts.posts.length, 0)
}
console.log('ok: C1 late long-poll replies after Disable never create a platform tab')

{
  const waiting = deferred(); let paused = false
  const f = fixture({ next: () => job('delay'), pause: async () => { paused = true; await waiting.promise } })
  await until(() => paused)
  await f.chrome.storage.local.set({ enabled: false })
  waiting.resolve()
  await f.worker.settled()
  assert.equal(f.counts.extracted, 0)
  assert.equal(f.counts.posts.length, 0)
  assert.deepEqual(f.counts.removed, [101])
  assert.equal(f.store.ownedTabUrl, null)
}
{
  let f
  f = fixture({ next: () => job('pre-extract'), onGet: () => f.chrome.storage.local.set({ enabled: false }) })
  await until(() => f.counts.removed.length)
  await f.worker.settled()
  assert.equal(f.counts.extracted, 0)
  assert.equal(f.counts.posts.length, 0)
}
{
  const extraction = deferred()
  const f = fixture({ next: () => job('in-extract'), extract: () => extraction.promise })
  await until(() => f.counts.extracted)
  await f.chrome.storage.local.set({ enabled: false })
  extraction.resolve(cards)
  await f.worker.settled()
  assert.equal(f.counts.posts.length, 0, 'already-started script results are discarded after Disable')
  assert.deepEqual(f.counts.removed, [101])
}
console.log('ok: C1 Disable during delay, immediately before extraction and in-flight extraction suppresses evidence and closes owned tabs')

{
  const old = deferred()
  const f = fixture({ ignoreAbort: true, next: n => n === 1 ? old.promise : job('new-generation') })
  await until(() => f.counts.next === 1)
  await f.chrome.storage.local.set({ enabled: false })
  await f.chrome.storage.local.set({ enabled: true })
  old.resolve(job('old-generation'))
  await until(() => f.counts.posts.length === 1)
  await f.worker.settled()
  assert.equal(f.counts.next, 2)
  assert.equal(f.counts.created.length, 1)
  assert.ok(f.counts.created[0].url.includes('new-generation'))
  assert.deepEqual(f.counts.posts.map(p => p.id), ['new-generation'])
}
{
  const f = fixture()
  await until(() => f.counts.next === 1)
  await f.chrome.storage.local.set({ token: 'b'.repeat(32), enabled: false })
  await f.worker.settled()
  assert.equal(f.counts.created.length, 0)
}
console.log('ok: C1 rapid Disable/Enable cannot reuse old work; configuration changes abort pending transport')

{
  const f = fixture({ store: { enabled: undefined } })
  await f.worker.resume()
  f.chrome.runtime.onInstalled.emit({ reason: 'install' })
  await new Promise(r => setImmediate(r))
  assert.equal(f.counts.next, 0, 'first installation never grants consent')
}
{
  const owned = 'https://www.zhihu.com/search?type=content&q=old#searchboost-community-a-b-c'
  const f = fixture({ store: { ownedTabUrl: owned }, tabs: [{ id: 7, url: owned }, { id: 8, url: 'https://www.zhihu.com/search?type=content&q=user' }] })
  await until(() => f.counts.next === 1)
  assert.deepEqual(f.counts.removed, [7], 'worker-load recovery closes only provably owned interrupted tabs')
  f.chrome.runtime.onInstalled.emit({ reason: 'update' })
  f.chrome.runtime.onStartup.emit()
  f.chrome.runtime.onMessage.emit({ action: 'start' }, {}, () => {})
  await new Promise(r => setImmediate(r))
  assert.equal(f.counts.next, 1, 'Reload/update/start signals do not duplicate loops')
  await f.chrome.storage.local.set({ enabled: false })
  await f.worker.settled()
}
console.log('ok: C7 saved consent resumes on worker load without popup clicks, install stays off, reload cleanup preserves user tabs and start is single-flight')
