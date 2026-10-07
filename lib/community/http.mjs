import { ipv4Fetch } from '../search/ipv4-fetch.js'

/** Shared policy-aware JSON transport. No raw errors, credentials or response bodies escape. */
export async function communityJson(url, { signal, fetchImpl = ipv4Fetch, method = 'GET', headers = {}, body, timeout = 20_000, maxBytes = 2_000_000 } = {}) {
  signal?.throwIfAborted()
  const combined = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout)
  const response = await fetchImpl(url, { method, redirect: 'error', signal: combined, headers: { Accept: 'application/json', ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
  if (!response.ok) { await response.body?.cancel?.(); throw Object.assign(new Error(`Community HTTP ${response.status}`), { kind: response.status === 429 ? 'rate_limited' : [401, 403, 412].includes(response.status) ? 'access_denied' : 'http_error' }) }
  const reader = response.body?.getReader?.()
  let text
  if (reader) {
    const chunks = []; let size = 0
    try {
      for (;;) {
        combined.throwIfAborted()
        const { value, done } = await reader.read(); if (done) break
        size += value.byteLength
        if (size > maxBytes) throw Object.assign(new Error('Community response too large'), { kind: 'response_too_large' })
        chunks.push(Buffer.from(value))
      }
      text = Buffer.concat(chunks).toString('utf8')
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
  } else { text = await response.text(); if (Buffer.byteLength(text) > maxBytes) throw new Error('Community response too large') }
  signal?.throwIfAborted()
  return JSON.parse(text)
}
export function safeCommunityReason(error) {
  return ['rate_limited', 'access_denied', 'http_error', 'response_too_large'].includes(error?.kind) ? error.kind : 'retrieval_failed'
}
