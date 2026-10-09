import { proxyRouteFor } from '../search/net-policy.mjs'
import { assertPublicHttpUrl, readLimitedBytes } from '../search/ssrf.js'
import { pageFetch } from '../search/ipv4-fetch.js'

/** Browser generates its own site requests; policy-owned transport sends one hop.
 * Never fulfill a 3xx: Chromium auto-continues redirects outside route handlers.
 * Redirects fail closed until a cookie/origin-correct redirect driver is available.
 */
export async function fulfillNativeRequest(route, { signal, env = process.env, fetchHop = pageFetch, validateUrl = assertPublicHttpUrl, allow, login = false, cookiesFor } = {}) {
  const request = route.request(), url = request.url(), method = request.method()
  if (!allow(url, method) || !login && ['media', 'image', 'font'].includes(request.resourceType())) return route.abort()
  const combined = signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000)
  combined.throwIfAborted()
  const policy = proxyRouteFor(url, env)
  const resolved = policy.route === 'direct' ? await validateUrl(url, { signal: combined, env }) : null
  const headers = await request.allHeaders()
  // Routed requests may lack network-stack Cookie headers, including HttpOnly.
  // The owned browser cookie store is authoritative; never reuse another origin's header.
  delete headers.cookie
  if (cookiesFor) {
    const cookies = await cookiesFor(url)
    if (cookies.length) headers.cookie = cookies.map(cookie => cookie.name + '=' + cookie.value).join('; ')
  }
  // Transport owns framing/compression. No log or subprocess contains request body.
  for (const name of ['host', 'connection', 'content-length', 'accept-encoding', 'proxy-authorization']) delete headers[name]
  const body = request.postDataBuffer()
  if (body?.byteLength > 1_000_000) return route.abort()
  const response = await fetchHop(url, { route: policy, addresses: resolved?.validatedAddresses, signal: combined, headers, method,
    ...(body != null ? { body } : {}), allowDirectFallback: false })
  if (response.status >= 300 && response.status < 400 && response.status !== 304) {
    await response.body?.cancel?.().catch(() => {})
    throw Object.assign(new Error('Native redirect blocked; no browser-controlled second hop'), { kind: 'redirect_blocked' })
  }
  const output = await readLimitedBytes(response, 8_000_000)
  combined.throwIfAborted()
  const responseHeaders = Object.fromEntries(response.headers)
  delete responseHeaders['content-encoding']; delete responseHeaders['content-length']; delete responseHeaders['transfer-encoding']
  const cookies = response.headers.getSetCookie?.()
  if (cookies?.length) responseHeaders['set-cookie'] = cookies.join('\n')
  return route.fulfill({ status: response.status, headers: responseHeaders, body: output })
}
