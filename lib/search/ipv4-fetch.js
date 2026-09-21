// Shared transport: configured proxies resolve destinations; direct routes use
// normal local DNS. Five connection failures on a proxy route permit an explicit
// direct fallback. TLS, configuration and HTTP-status failures do not switch
// routes. Page requests also have an optional same-route curl compatibility
// fallback; curl never means silently bypassing proxy settings.

import { setTimeout as delay } from 'node:timers/promises'
import { curlPageFetch } from './curl-fetch.mjs'

import {
  NET_ERROR_KINDS,
  NetworkPolicyError,
  autoSelectFamilyEnabled,
  pinnedLookup,
  proxyPolicy,
  proxyRouteFor,
} from './net-policy.mjs'

/** @type {Promise<any> | null} */
let undiciPromise = null
/** @type {Map<string, any>} */
const dispatcherCache = new Map()
const MAX_DISPATCHERS = 64
export const PROXY_ATTEMPTS = 5
const PROXY_CONNECT_TIMEOUT_MS = 2_000
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
 * Undici 6 treats UND_ERR_SOCKET from a tunnel connector as recoverable and
 * reconnects internally without rejecting fetch. Surface CONNECT failures so
 * our five-attempt counter (and not an unbounded internal loop) owns retries.
 */
function proxyClientFactory(undici) {
  return (url, options) => {
    const client = new undici.Client(url, { ...options, headersTimeout: PROXY_CONNECT_TIMEOUT_MS })
    const connect = client.connect.bind(client)
    client.connect = (opts) => connect(opts).catch((err) => {
      if (['UND_ERR_SOCKET', 'ECONNRESET', 'UND_ERR_HEADERS_TIMEOUT'].includes(err.code)) {
        const failure = new Error('proxy tunnel connection failed', { cause: err })
        failure.code = 'SB_PROXY_CONNECT_FAILURE'
        throw failure
      }
      throw err
    })
    return client
  }
}

/**
 * Dispatcher for fixed services: honours HTTP(S)_PROXY / NO_PROXY, keeps Node's
 * address-family selection. An unsupported proxy (e.g. SOCKS) or an invalid
 * proxy URL fails here, explicitly.
 */
async function serviceDispatcher(policy) {
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
      proxyTls: connectorOptions({ timeout: PROXY_CONNECT_TIMEOUT_MS }),
      requestTls: connectorOptions({ timeout: PROXY_CONNECT_TIMEOUT_MS }),
      clientFactory: proxyClientFactory(undici),
      httpProxy: policy.httpProxy,
      httpsProxy: policy.httpsProxy,
      noProxy: policy.noProxy,
    })
    : new undici.Agent({ connect: connectorOptions() })
  return remember(key, dispatcher)
}

/** A forced proxy connection using the already-selected route snapshot. */
async function delegatedDispatcher(proxyUrl) {
  if (!proxyUrl) throw new NetworkPolicyError('missing selected proxy', NET_ERROR_KINDS.proxyConfig)
  const key = `delegated:${JSON.stringify([proxyUrl, autoSelectFamilyEnabled()])}`
  if (dispatcherCache.has(key)) return dispatcherCache.get(key)
  const undici = await loadUndici()
  if (dispatcherCache.has(key)) return dispatcherCache.get(key)
  if (typeof undici.ProxyAgent !== 'function') {
    throw new NetworkPolicyError('proxy transport unavailable: refusing a direct connection', NET_ERROR_KINDS.transportUnavailable)
  }
  return remember(key, new undici.ProxyAgent({
    uri: proxyUrl,
    proxyTls: connectorOptions({ timeout: PROXY_CONNECT_TIMEOUT_MS }),
    requestTls: connectorOptions({ timeout: PROXY_CONNECT_TIMEOUT_MS }),
    clientFactory: proxyClientFactory(undici),
  }))
}

/**
 * Dispatcher pinned to an already-validated address snapshot. Only usable
 * on a direct route (including NO_PROXY) — see the module header.
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

/** Explicit direct service route: never consult proxy environment variables. */
async function directDispatcher() {
  const key = `direct:${autoSelectFamilyEnabled()}`
  if (dispatcherCache.has(key)) return dispatcherCache.get(key)
  const undici = await loadUndici()
  if (dispatcherCache.has(key)) return dispatcherCache.get(key)
  return remember(key, new undici.Agent({ connect: connectorOptions() }))
}

// Retry only connection failures, not TLS/policy/configuration errors or HTTP
// responses. Ambiguous failures after sending are replayed only for GET/HEAD;
// POST search APIs can be replayed on pre-connect failure with reusable bodies.
function retryableProxyFailure(err, safeMethod, depth = 0) {
  if (!err || depth > 5) return false
  if (err.code === 'SB_PROXY_CONNECT_FAILURE') return true
  if (err.kind) return [NET_ERROR_KINDS.connectRefused, NET_ERROR_KINDS.dnsFailure].includes(err.kind)
    || (safeMethod && (err.kind === NET_ERROR_KINDS.connectTimeout
      || (err.kind === NET_ERROR_KINDS.transportError && ['CURL_GOT_NOTHING', 'CURL_SEND_ERROR', 'CURL_RECV_ERROR'].includes(err.code))))
  if (err.errors?.length) return err.errors.every((item) => retryableProxyFailure(item, safeMethod, depth + 1))
  if (err.cause) return retryableProxyFailure(err.cause, safeMethod, depth + 1)
  if (['ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH', 'ENETDOWN',
    'ENOTFOUND', 'EAI_AGAIN', 'EAI_NODATA', 'EAI_NONAME', 'UND_ERR_CONNECT_TIMEOUT'].includes(err.code)) return true
  // These are CONNECT failures reported by Undici, not target HTTP statuses.
  if (err.code === 'UND_ERR_ABORTED' && /^Proxy response \((502|503|504)\) !== 200 when HTTP Tunneling$/.test(err.message)) return true
  return safeMethod && ['ECONNRESET', 'ETIMEDOUT', 'UND_ERR_SOCKET', 'UND_ERR_HEADERS_TIMEOUT'].includes(err.code)
}

function checkProxyAbort(signal) {
  if (signal?.aborted) throw new NetworkPolicyError('proxy retry interrupted',
    signal.reason?.name === 'TimeoutError' ? NET_ERROR_KINDS.deadline : NET_ERROR_KINDS.cancelled, { cause: signal.reason })
}

/** Five proxy attempts in total, then one direct attempt. Never reset the caller's deadline. */
async function withProxyFallback(proxyRequest, directRequest, { signal, safeMethod = true, replayable = true }) {
  for (let attempt = 1; attempt <= PROXY_ATTEMPTS; attempt++) {
    checkProxyAbort(signal)
    try {
      return await proxyRequest()
    } catch (err) {
      checkProxyAbort(signal)
      if (!replayable || !retryableProxyFailure(err, safeMethod)) throw err
      if (attempt < PROXY_ATTEMPTS) {
        try { await delay(100 * 2 ** (attempt - 1), undefined, { signal }) }
        catch (waitError) { checkProxyAbort(signal); throw waitError }
        continue
      }
      checkProxyAbort(signal)
      // No URL/proxy credentials in diagnostics. This switch is user-authorized.
      process.emitWarning('Proxy connection failed 5 times; trying a direct connection (local egress IP may be visible).', {
        code: 'SEARCH_BOOST_DIRECT_FALLBACK',
      })
      try {
        return await directRequest()
      } catch (directError) {
        checkProxyAbort(signal)
        directError.proxyCause = err
        directError.proxyAttempts = PROXY_ATTEMPTS
        throw directError
      }
    }
  }
}

/** Fetch and dispatcher MUST come from the same Undici instance. Host processes
 * (notably Pi) can replace globalThis.fetch with an incompatible major version. */
export async function ipv4Fetch(url, init = {}) {
  const env = { ...process.env }
  const route = proxyRouteFor(url, env)
  const dispatcher = await serviceDispatcher(proxyPolicy(env))
  const undici = await loadUndici()
  const headers = new undici.Headers(init.headers)
  const sensitive = init.body != null || [...headers.keys()].some((name) =>
    /^(authorization|cookie|x-api-key|api-key|x-subscription-token)$/i.test(name))
  // A 307/308 can resend API keys in a POST body or custom header to another
  // origin. Never silently forward a credential-bearing service request.
  const redirect = sensitive && init.redirect !== 'manual' ? 'error' : (init.redirect ?? 'follow')
  const request = () => undici.fetch(url, { ...init, redirect, dispatcher })
  if (route.route !== 'proxy') return request()
  return withProxyFallback(request, async () => undici.fetch(url, {
    ...init, redirect, dispatcher: await directDispatcher(),
  }), {
    signal: init.signal,
    safeMethod: ['GET', 'HEAD'].includes(String(init.method ?? 'GET').toUpperCase()),
    replayable: init.body == null || typeof init.body === 'string' || init.body instanceof URLSearchParams || ArrayBuffer.isView(init.body),
  })
}

/**
 * Compatibility entry point: select transport for a page. Supplied addresses
 * are used only on direct routes; a configured proxy resolves the target itself.
 */
export async function fetchPinned(url, options) {
  return pageFetch(url, { ...options, route: proxyRouteFor(url, options.env) })
}

function curlEligible(err, route) {
  if (err?.kind) return err.kind === NET_ERROR_KINDS.transportUnavailable
  const code = err?.cause?.code ?? err?.code ?? ''
  // curl performs its own normal certificate verification with its trust store;
  // this is same-route compatibility, never --insecure or a direct-route trigger.
  if (/CERT|TLS|SSL/i.test(code)) return true
  if (/ABORT/i.test(code)) return false
  // A refused/timed-out proxy is a routing failure, not an Undici compatibility
  // issue: let the five-attempt policy handle it without doubling TCP attempts.
  if (route.route === 'proxy' && retryableProxyFailure(err, true)) return false
  return retryableProxyFailure(err, true) || /^(HPE_|UND_ERR_HTTP2|UND_ERR_RES_CONTENT_LENGTH_MISMATCH)/.test(code)
}

/**
 * Fetch a single hop under a captured route. The guard owns URL checks
 * and redirects; this layer must never follow a hop without those checks.
 * @param {string} url
 * @param {{ route: { route: string, proxyUrl: string | null }, addresses?: Array<{ address: string, family: number }> | null, signal?: AbortSignal, headers?: Record<string, string>, redirect?: string, onDirectFallback?: Function, transport?: string }} options
 */
export async function pageFetch(url, options) {
  const request = async (route, addresses) => {
    if (options.transport === 'curl') return curlPageFetch(url, { ...options, route, addresses })
    try {
      const dispatcher = route.route === 'proxy'
        ? await delegatedDispatcher(route.proxyUrl) : addresses?.length ? await pinnedDispatcher(addresses) : await directDispatcher()
      const undici = await loadUndici()
      return await undici.fetch(url, {
        headers: options.headers, signal: options.signal, redirect: 'manual', dispatcher,
      })
    } catch (err) {
      if (options.signal?.aborted || !curlEligible(err, route)) throw err
      try { return await curlPageFetch(url, { ...options, route, addresses }) } catch (curlError) {
        // Missing curl must not hide the usable primary transport's diagnosis.
        if (curlError.kind === NET_ERROR_KINDS.transportUnavailable) throw err
        curlError.primaryCause = err
        throw curlError
      }
    }
  }
  const directRequest = async () => {
    options.signal?.throwIfAborted()
    const addresses = options.addresses // legacy fetchPinned callers only
    return request({ route: 'direct', proxyUrl: null }, addresses)
  }
  if (options.route.route === 'direct') return directRequest()
  if (options.route.route !== 'proxy') throw new NetworkPolicyError('invalid page route', NET_ERROR_KINDS.unsupported)
  return withProxyFallback(() => request(options.route, null), () => {
    options.onDirectFallback?.()
    return directRequest()
  }, { signal: options.signal })
}
