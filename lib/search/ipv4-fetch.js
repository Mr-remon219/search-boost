// Transport for every outbound request.
//
// One policy, two trust scopes (see net-policy.mjs):
//   * `ipv4Fetch` — FIXED SERVICES (engine APIs, r.jina.ai, the Jev endpoint, X
//     endpoints). The destination is configuration, so there is no target-page
//     DNS pre-check; the proxy (when configured) resolves the destination, which
//     is the trust scope the user chose by configuring it.
//   * `fetchPinned` — ARBITRARY PAGES. The caller resolved and validated an
//     address snapshot, and the connector may only answer with that snapshot:
//     the system resolver is never consulted again, closing the
//     check-then-connect gap. Through an HTTP proxy the locked Undici release
//     cannot pin the destination (ProxyAgent's `connect` only affects the proxy
//     hop, and CONNECT carries a hostname), so that path fails with an explicit
//     `proxy_unsupported` reason instead of silently connecting directly.
//
// The name `ipv4Fetch` is kept for compatibility, but the family is no longer
// forced to IPv4: the connector uses Node's Happy Eyeballs (autoSelectFamily),
// so an unreachable IPv6 path falls back to IPv4 and vice versa.
//
// Undici is loaded lazily because Core is also imported inside host processes
// where the dependency tree may not resolve. That case is an explicit
// `transport_unavailable` failure — never a silent downgrade to plain fetch,
// which would bypass the user's proxy and the address policy.

import {
  NET_ERROR_KINDS,
  NetworkPolicyError,
  autoSelectFamilyEnabled,
  pinnedLookup,
  proxyPolicy,
} from './net-policy.mjs'

/** @type {Promise<any> | null} */
let undiciPromise = null
/** @type {Map<string, any>} */
const dispatcherCache = new Map()
/** Test hook: replace the lazy transport loader (never used in production paths). */
let undiciLoader = () => import('undici')

export function __setUndiciLoaderForTests(loader) {
  undiciLoader = loader ?? (() => import('undici'))
  resetFetchDispatcher()
}

function loadUndici() {
  if (!undiciPromise) {
    undiciPromise = undiciLoader().catch((err) => {
      undiciPromise = null
      throw new NetworkPolicyError(
        'undici transport unavailable: refusing to fall back to plain fetch (it would bypass the configured proxy and address policy)',
        NET_ERROR_KINDS.transportUnavailable,
        { detail: err instanceof Error ? err.message : String(err), cause: err },
      )
    })
  }
  return undiciPromise
}

/** Drop cached dispatchers/transport so a later env change is picked up (tests). */
export function resetFetchDispatcher() {
  dispatcherCache.clear()
  undiciPromise = null
}

/** Proxy URL from the process environment (compat export; policy lives in net-policy). */
export function envProxyUrl(kind = 'https') {
  const policy = proxyPolicy()
  if (policy.mode !== 'proxy') return ''
  if (kind === 'http') {
    const http = process.env.http_proxy ?? process.env.HTTP_PROXY
    if (http?.trim()) return http.trim()
  }
  return policy.url ?? ''
}

/** Connector options shared by every dispatcher: dual stack, no forced family. */
function connectorOptions(extra = {}) {
  return {
    autoSelectFamily: autoSelectFamilyEnabled(),
    ...extra,
  }
}

/**
 * Dispatcher for fixed services: honours HTTP(S)_PROXY / NO_PROXY, keeps Node's
 * address-family selection. An unsupported proxy (e.g. SOCKS) or an invalid
 * proxy URL fails here, explicitly.
 */
async function serviceDispatcher() {
  const cached = dispatcherCache.get('service')
  if (cached) return cached
  const undici = await loadUndici()
  const policy = proxyPolicy()
  if (policy.error) throw policy.error
  const dispatcher = policy.mode === 'proxy' && typeof undici.EnvHttpProxyAgent === 'function'
    ? new undici.EnvHttpProxyAgent({
      connect: connectorOptions(),
      ...(process.env.http_proxy || process.env.HTTP_PROXY
        ? { httpProxy: (process.env.http_proxy ?? process.env.HTTP_PROXY).trim() }
        : {}),
      ...(process.env.https_proxy || process.env.HTTPS_PROXY
        ? { httpsProxy: (process.env.https_proxy ?? process.env.HTTPS_PROXY).trim() }
        : {}),
    })
    : new undici.Agent({ connect: connectorOptions() })
  dispatcherCache.set('service', dispatcher)
  return dispatcher
}

/**
 * Dispatcher pinned to an already-validated address snapshot. Only usable
 * without a proxy — see the module header.
 * @param {Array<{ address: string, family: number }>} addresses
 */
async function pinnedDispatcher(addresses) {
  const key = `pinned:${addresses.map((entry) => `${entry.address}/${entry.family}`).join(',')}`
  const cached = dispatcherCache.get(key)
  if (cached) return cached
  const undici = await loadUndici()
  const dispatcher = new undici.Agent({ connect: connectorOptions({ lookup: pinnedLookup(addresses) }) })
  dispatcherCache.set(key, dispatcher)
  return dispatcher
}

/** fetch through the fixed-service transport. */
export async function ipv4Fetch(url, init = {}) {
  const dispatcher = await serviceDispatcher()
  return fetch(url, { ...init, dispatcher })
}

/**
 * fetch an arbitrary page through a pinned, validated address snapshot.
 * @param {string} url
 * @param {{ addresses: Array<{ address: string, family: number }>, signal?: AbortSignal, headers?: Record<string, string>, redirect?: 'manual'|'follow' }} options
 */
export async function fetchPinned(url, options) {
  const policy = proxyPolicy()
  if (policy.error) throw policy.error
  if (policy.mode === 'proxy') {
    // No bypass: an explicit, reportable limitation instead of a silent direct
    // connection or an unverified proxy hop.
    throw new NetworkPolicyError(
      `page fetch through ${policy.source} cannot pin the validated address with Undici ${'6.27.0'}; refusing to fetch the page directly`,
      NET_ERROR_KINDS.proxyUnsupported,
      { detail: 'pinned_through_proxy_unsupported' },
    )
  }
  const dispatcher = await pinnedDispatcher(options.addresses)
  return fetch(url, {
    headers: options.headers,
    signal: options.signal,
    redirect: options.redirect ?? 'manual',
    dispatcher,
  })
}
