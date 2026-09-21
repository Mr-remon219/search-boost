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
const MAX_DISPATCHERS = 64
const retiringDispatchers = new Set()

function retire(dispatcher) {
  retiringDispatchers.add(dispatcher)
  Promise.resolve().then(() => dispatcher.close?.() ?? dispatcher.destroy?.())
    .catch(() => {}).finally(() => retiringDispatchers.delete(dispatcher))
}

function remember(key, dispatcher) {
  dispatcherCache.set(key, dispatcher)
  while (dispatcherCache.size > MAX_DISPATCHERS) {
    const oldest = dispatcherCache.keys().next().value
    const removed = dispatcherCache.get(oldest)
    dispatcherCache.delete(oldest)
    retire(removed)
  }
  return dispatcher
}
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
  for (const dispatcher of dispatcherCache.values()) retire(dispatcher)
  dispatcherCache.clear()
  undiciPromise = null
}

/**
 * Close every cached dispatcher. Long-lived hosts call this on shutdown; tests
 * call it so keep-alive sockets do not keep the process alive.
 */
export async function closeFetchDispatchers() {
  const dispatchers = [...new Set([...dispatcherCache.values(), ...retiringDispatchers])]
  dispatcherCache.clear()
  await Promise.all(dispatchers.map(async (dispatcher) => {
    try {
      if (typeof dispatcher.destroy === 'function') await dispatcher.destroy()
      else if (typeof dispatcher.close === 'function') await dispatcher.close()
    } catch { /* best effort */ }
  }))
}

/** Proxy URL from the process environment (compat export; policy lives in net-policy). */
export function envProxyUrl(kind = 'https') {
  const policy = proxyPolicy()
  return kind === 'http' ? policy.httpProxy : policy.httpsProxy
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
  const policy = proxyPolicy()
  if (policy.error) throw policy.error
  const key = `service:${JSON.stringify([policy.httpProxy, policy.httpsProxy, policy.noProxy, autoSelectFamilyEnabled()])}`
  if (dispatcherCache.has(key)) return dispatcherCache.get(key)
  const undici = await loadUndici()
  // Concurrent first calls share the dispatcher created after the lazy import.
  if (dispatcherCache.has(key)) return dispatcherCache.get(key)
  if (policy.mode === 'proxy' && typeof undici.EnvHttpProxyAgent !== 'function') {
    throw new NetworkPolicyError('proxy transport unavailable: refusing a direct connection', NET_ERROR_KINDS.transportUnavailable)
  }
  const dispatcher = policy.mode === 'proxy'
    ? new undici.EnvHttpProxyAgent({
      connect: connectorOptions(),
      httpProxy: policy.httpProxy,
      httpsProxy: policy.httpsProxy,
      noProxy: policy.noProxy,
    })
    : new undici.Agent({ connect: connectorOptions() })
  return remember(key, dispatcher)
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
  if (dispatcherCache.has(key)) return dispatcherCache.get(key)
  const dispatcher = new undici.Agent({ connect: connectorOptions({ lookup: pinnedLookup(addresses) }) })
  return remember(key, dispatcher)
}

/** Fetch and dispatcher MUST come from the same Undici instance. Host processes
 * (notably Pi) can replace globalThis.fetch with an incompatible major version. */
export async function ipv4Fetch(url, init = {}) {
  const dispatcher = await serviceDispatcher()
  const undici = await loadUndici()
  const headers = new undici.Headers(init.headers)
  const sensitive = init.body != null || [...headers.keys()].some((name) =>
    /^(authorization|cookie|x-api-key|api-key|x-subscription-token)$/i.test(name))
  // A 307/308 can resend API keys in a POST body or custom header to another
  // origin. Never silently forward a credential-bearing service request.
  const redirect = sensitive && init.redirect !== 'manual' ? 'error' : (init.redirect ?? 'follow')
  return undici.fetch(url, { ...init, redirect, dispatcher })
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
      `page fetch through ${policy.source} cannot pin the validated address with the bundled Undici transport; refusing to fetch the page directly`,
      NET_ERROR_KINDS.proxyUnsupported,
      { detail: 'pinned_through_proxy_unsupported' },
    )
  }
  const dispatcher = await pinnedDispatcher(options.addresses)
  const undici = await loadUndici()
  return undici.fetch(url, {
    headers: options.headers,
    signal: options.signal,
    redirect: options.redirect ?? 'manual',
    dispatcher,
  })
}
