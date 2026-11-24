import { createServer } from 'node:http'
import { randomUUID, timingSafeEqual } from 'node:crypto'

/** User-started local bridge. Requests contain data only, never executable scripts. */
export function createCommunityBrowserBridge({ token, timeoutMs = 50_000 } = {}) {
  if (typeof token !== 'string' || token.length < 32) throw new Error('A private bridge token is required')
  const jobs = new Map(); let waiter = null
  const authorized = value => {
    const expected = Buffer.from(`Bearer ${token}`), received = Buffer.from(value ?? '')
    return received.length === expected.length && timingSafeEqual(received, expected)
  }
  const send = (res, code, value) => { if (!res.destroyed && !res.writableEnded) { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Allow-Methods': 'GET, POST' }); res.end(JSON.stringify(value)) } }
  function dispatch() {
    if (!waiter) return
    const job = [...jobs.values()].find(j => !j.claimed)
    if (!job) return
    job.claimed = true; clearTimeout(waiter.timer)
    send(waiter.res, 200, { id: job.id, platform: job.platform, query: job.query, max_results: job.max_results }); waiter = null
  }
  async function body(req) {
    const chunks = []; let bytes = 0
    for await (const chunk of req) { bytes += chunk.length; if (bytes > 2_000_000) throw new Error('Request too large'); chunks.push(chunk) }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  }
  const server = createServer(async (req, res) => {
    if (req.method === 'OPTIONS') {
      const origin = req.headers.origin ?? ''
      if (!origin.startsWith('chrome-extension://')) return send(res, 403, { status: 'denied' })
      return send(res, 204, {})
    }
    if (!authorized(req.headers.authorization)) return send(res, 401, { status: 'denied' })
    try {
      if (req.method === 'GET' && req.url === '/next') {
        if (waiter) return send(res, 409, { status: 'busy' })
        const timer = setTimeout(() => { if (waiter?.res === res) waiter = null; send(res, 200, {}) }, 25_000)
        waiter = { res, timer }; res.on('close', () => { if (waiter?.res === res) { clearTimeout(timer); waiter = null } }); dispatch(); return
      }
      if (req.method === 'GET' && /^\/active\/[a-f0-9-]{36}$/.test(req.url)) return send(res, jobs.has(req.url.slice(8)) ? 200 : 404, {})
      if (req.method === 'POST' && req.url === '/search') {
        const args = await body(req)
        if (Object.keys(args).some(k => !['platform', 'query', 'max_results'].includes(k)) || !['bilibili', 'zhihu', 'xiaohongshu'].includes(args.platform)
          || typeof args.query !== 'string' || !args.query.trim() || args.query.length > 2000 || !Number.isInteger(args.max_results) || args.max_results < 1 || args.max_results > 50) return send(res, 400, { status: 'invalid' })
        if (jobs.size >= 8) return send(res, 429, { status: 'busy' })
        const id = randomUUID(), timer = setTimeout(() => { jobs.delete(id); send(res, 503, { status: 'unavailable' }) }, timeoutMs)
        const job = { ...args, id, res, timer, claimed: false }; jobs.set(id, job)
        res.on('close', () => { clearTimeout(timer); jobs.delete(id) }); dispatch(); return
      }
      if (req.method === 'POST' && req.url === '/result') {
        const result = await body(req), job = jobs.get(result.id)
        if (!job?.claimed) return send(res, 404, { status: 'expired' })
        if (Object.keys(result).some(k => !['id', 'status', 'items'].includes(k)) || !['ok', 'blocked', 'disabled', 'invalid', 'unavailable'].includes(result.status)
          || !Array.isArray(result.items) || result.items.length > 100 || result.items.some(r => !r || typeof r.url !== 'string' || typeof r.title !== 'string' || typeof r.text !== 'string' || r.url.length > 4000 || r.text.length > 8000)) return send(res, 400, { status: 'invalid' })
        jobs.delete(result.id); clearTimeout(job.timer); send(job.res, 200, { status: result.status, items: result.items }); return send(res, 200, { status: 'accepted' })
      }
      send(res, 404, { status: 'not_found' })
    } catch { send(res, 400, { status: 'invalid' }) }
  })
  server.requestTimeout = 60_000; server.headersTimeout = 10_000
  server.on('close', () => { if (waiter) clearTimeout(waiter.timer); waiter = null; for (const j of jobs.values()) { clearTimeout(j.timer); send(j.res, 503, { status: 'unavailable' }) }; jobs.clear() })
  return server
}
