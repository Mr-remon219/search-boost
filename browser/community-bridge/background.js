import { extractCards } from './extract.js'

const searchUrl = (platform, query) => ({
  bilibili: `https://search.bilibili.com/all?keyword=${encodeURIComponent(query)}`,
  zhihu: `https://www.zhihu.com/search?type=content&q=${encodeURIComponent(query)}`,
  xiaohongshu: `https://www.xiaohongshu.com/search_result?keyword=${encodeURIComponent(query)}&source=web_search_result_notes`,
})[platform]
const cancelled = () => new DOMException('Bridge authorization changed', 'AbortError')
function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    const done = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); resolve() }
    const abort = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(cancelled()) }
    const timer = setTimeout(done, ms)
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
  })
}

/** One cancellable authorization generation; injected IO makes lifecycle tests behavioral. */
export function createBridgeWorker({ chrome, fetchImpl = fetch, pause = delay, uuid = () => crypto.randomUUID() }) {
  let current = null
  // Serialize complete generations (including tab cleanup). A quick re-enable
  // cannot resurrect old work or let its finally clear a replacement's state.
  let draining = Promise.resolve(), recovering
  const valid = cfg => cfg.enabled === true && typeof cfg.token === 'string' && cfg.token.length >= 32 && /^http:\/\/127\.0\.0\.1:\d+$/.test(cfg.endpoint)
  const settings = () => chrome.storage.local.get(['enabled', 'endpoint', 'token'])
  const guard = async session => {
    session.controller.signal.throwIfAborted()
    const cfg = await settings()
    session.controller.signal.throwIfAborted()
    if (!valid(cfg) || cfg.endpoint !== session.cfg.endpoint || cfg.token !== session.cfg.token || current !== session) throw cancelled()
  }
  const request = async (session, path, init = {}, timeout = 5000) => {
    await guard(session)
    const controller = new AbortController()
    const abort = () => controller.abort(cancelled())
    session.controller.signal.addEventListener('abort', abort, { once: true })
    const timer = setTimeout(abort, timeout)
    try {
      session.controller.signal.throwIfAborted()
      const response = await fetchImpl(`${session.cfg.endpoint}${path}`, { ...init,
        headers: { Authorization: `Bearer ${session.cfg.token}`, 'Content-Type': 'application/json' }, signal: controller.signal })
      const data = response.ok && path === '/next' ? await response.json() : null
      await guard(session)
      return { ok: response.ok, data }
    } finally { clearTimeout(timer); session.controller.signal.removeEventListener('abort', abort) }
  }
  const active = async (session, id) => {
    const response = await request(session, `/active/${encodeURIComponent(id)}`)
    if (!response.ok) throw cancelled()
    await guard(session)
  }
  async function collect(session, job) {
    const base = searchUrl(job.platform, job.query)
    if (!base || typeof job.query !== 'string' || job.query.length > 2000 || !Number.isInteger(job.max_results) || job.max_results < 1 || job.max_results > 50) return { status: 'invalid', items: [] }
    await active(session, job.id)
    // Persist an opaque ownership marker BEFORE creation, so worker restart can
    // safely identify a leftover tab without closing a user's unrelated tabs.
    const url = `${base}#searchboost-community-${uuid()}`
    await chrome.storage.local.set({ ownedTabUrl: url })
    let tab
    try {
      await guard(session)
      tab = await chrome.tabs.create({ url, active: false })
      await guard(session)
      // No redirects to login/security pages, scroll/click or cookie export.
      for (let attempt = 0; attempt < 15; attempt++) {
        await active(session, job.id)
        await pause(1000, session.controller.signal)
        await active(session, job.id)
        const latest = await chrome.tabs.get(tab.id)
        await guard(session)
        if (latest.status !== 'complete') continue
        if (!latest.url || new URL(latest.url).origin !== new URL(base).origin) return { status: 'blocked', items: [] }
        await guard(session)
        const [result] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: extractCards, args: [job.platform, job.max_results] })
        await active(session, job.id)
        if (result?.result?.status === 'blocked' || result?.result?.items?.length) return result.result
      }
      return { status: 'unavailable', items: [] }
    } finally {
      if (tab) await chrome.tabs.remove(tab.id).catch(() => {})
      await chrome.storage.local.set({ ownedTabUrl: null })
    }
  }
  async function loop(session) {
    try {
      for (;;) {
        await guard(session)
        try {
          const response = await request(session, '/next', {}, 28_000)
          if (!response.ok) { await pause(2000, session.controller.signal); continue }
          const job = response.data
          if (!job?.id || typeof job.id !== 'string') continue
          await active(session, job.id)
          let result
          try { result = await collect(session, job) }
          catch { await guard(session); result = { status: 'unavailable', items: [] } }
          await active(session, job.id)
          await request(session, '/result', { method: 'POST', body: JSON.stringify({ id: job.id, ...result }) })
        } catch {
          await guard(session)
          await pause(2000, session.controller.signal)
        }
      }
    } catch { /* Disable/config changes terminate this generation, never post old evidence. */ }
    finally { if (current === session) current = null }
  }
  function stop() { current?.controller.abort(cancelled()) }
  async function resume() {
    await recovering
    await draining
    const cfg = await settings()
    if (current || !valid(cfg)) return
    const session = { cfg, controller: new AbortController() }
    current = session
    draining = loop(session)
  }
  async function recover() {
    const { ownedTabUrl } = await chrome.storage.local.get(['ownedTabUrl'])
    if (typeof ownedTabUrl !== 'string' || !/^https:\/\/(search\.bilibili\.com\/all\?|www\.zhihu\.com\/search\?|www\.xiaohongshu\.com\/search_result\?)[^#]*#searchboost-community-[a-z0-9-]+$/i.test(ownedTabUrl)) return
    const tabs = await chrome.tabs.query({ url: ['https://search.bilibili.com/*', 'https://www.zhihu.com/*', 'https://www.xiaohongshu.com/*'] })
    for (const tab of tabs) if (tab.url === ownedTabUrl || tab.pendingUrl === ownedTabUrl) await chrome.tabs.remove(tab.id).catch(() => {})
    // If a site removed the marker or the user navigated away, ownership cannot
    // be established on recovery: leave that tab alone, rather than guess.
    await chrome.storage.local.set({ ownedTabUrl: null })
  }
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !['enabled', 'endpoint', 'token'].some(k => changes[k] && changes[k].oldValue !== changes[k].newValue)) return
    stop()
    void resume()
  })
  chrome.runtime.onMessage.addListener((message, _sender, reply) => {
    if (message?.action === 'start') { void resume(); reply({ started: true }) }
    if (message?.action === 'stop') { stop(); reply({ stopped: true }) }
  })
  chrome.runtime.onStartup.addListener(() => void resume())
  chrome.runtime.onInstalled.addListener(() => void resume())
  // Restore saved consent on every worker load, including unpacked Reload;
  // first installation with no saved enabled=true remains off.
  recovering = recover().catch(() => {})
  void resume()
  return { stop, resume, settled: async () => { await recovering; await draining } }
}
if (typeof chrome !== 'undefined') createBridgeWorker({ chrome })
