import { extractCards } from './extract.js'
let running = false
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const searchUrl = (platform, query) => ({
  bilibili: `https://search.bilibili.com/all?keyword=${encodeURIComponent(query)}`,
  zhihu: `https://www.zhihu.com/search?type=content&q=${encodeURIComponent(query)}`,
  xiaohongshu: `https://www.xiaohongshu.com/search_result?keyword=${encodeURIComponent(query)}&source=web_search_result_notes`,
})[platform]
async function collect(job, isActive) {
  const url = searchUrl(job.platform, job.query)
  if (!url || typeof job.query !== 'string' || job.query.length > 2000 || !Number.isInteger(job.max_results) || job.max_results < 1 || job.max_results > 50) return { status: 'invalid', items: [] }
  const tab = await chrome.tabs.create({ url, active: false })
  try {
    // Do not act on redirects to login/security pages, scroll/click, or export cookies.
    for (let attempt = 0; attempt < 15; attempt++) {
      const settings = await chrome.storage.local.get(['enabled'])
      if (!settings.enabled || !await isActive()) return { status: 'disabled', items: [] }
      await pause(1000)
      const current = await chrome.tabs.get(tab.id)
      if (current.status !== 'complete') continue
      if (!current.url || new URL(current.url).origin !== new URL(url).origin) return { status: 'blocked', items: [] }
      const [result] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: extractCards, args: [job.platform, job.max_results] })
      if (result?.result?.status === 'blocked' || result?.result?.items?.length) return result.result
    }
    // No cards can also mean a changed DOM or access gate; never fabricate successful exhaustion.
    return { status: 'unavailable', items: [] }
  } finally { await chrome.tabs.remove(tab.id).catch(() => {}) }
}
async function run() {
  if (running) return
  running = true
  try {
    for (;;) {
      const cfg = await chrome.storage.local.get(['enabled', 'endpoint', 'token'])
      if (!cfg.enabled || !cfg.token || !/^http:\/\/127\.0\.0\.1:\d+$/.test(cfg.endpoint)) break
      try {
        const headers = { Authorization: `Bearer ${cfg.token}`, 'Content-Type': 'application/json' }
        const response = await fetch(`${cfg.endpoint}/next`, { headers, signal: AbortSignal.timeout(28_000) })
        if (!response.ok) { await pause(2000); continue }
        const job = await response.json()
        if (!job.id) continue
        let result
        try { result = await collect(job, async () => (await fetch(`${cfg.endpoint}/active/${job.id}`, { headers, signal: AbortSignal.timeout(5000) })).ok) } catch { result = { status: 'unavailable', items: [] } }
        await fetch(`${cfg.endpoint}/result`, { method: 'POST', headers, body: JSON.stringify({ id: job.id, ...result }), signal: AbortSignal.timeout(5000) })
      } catch { await pause(2000) }
    }
  } finally { running = false }
}
chrome.runtime.onMessage.addListener((message, _sender, reply) => {
  if (message?.action === 'start') { void run(); reply({ started: true }) }
})
// Resume only a user-enabled bridge; installing the extension itself never enables it.
chrome.runtime.onStartup.addListener(() => void run())
