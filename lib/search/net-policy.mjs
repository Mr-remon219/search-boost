// Network policy: one place that decides HOW a request is transported and what
// has been verified about its destination.
//
// Two trust scopes share this transport but not the same checks:
//   * FIXED SERVICES (r.jina.ai, engine APIs, the user-configured Jev endpoint):
//     the destination is part of the configuration, so there is no target-page
//     DNS pre-check — only the transport policy (proxy, dual stack, deadline).
//   * ARBITRARY PAGES (fetch_page's local fallback): the destination comes from
//     the user/model, so the address is resolved once, validated, and then
//     PINNED to the connection. The connector may only use that snapshot — it
//     never lets the system resolver answer again, which closes the
//     check-then-connect (DNS rebinding) gap.
//
// Errors carry a stable kind so callers and diagnostics can tell a DNS timeout
// from a blocked address, a proxy misconfiguration, a TLS failure or a cancel.

import { lookup as dnsLookup } from 'node:dns'
import { getDefaultAutoSelectFamily } from 'node:net'
import { isIP } from 'node:net'

export const NET_ERROR_KINDS = {
  blockedHost: 'blocked_host',
  blockedAddress: 'blocked_address',
  dnsTimeout: 'dns_timeout',
  dnsTemporary: 'dns_temporary',
  dnsNotFound: 'dns_not_found',
  dnsFailure: 'dns_failure',
  connectRefused: 'connect_refused',
  connectTimeout: 'connect_timeout',
  tls: 'tls',
  proxyConfig: 'proxy_config',
  proxyUnsupported: 'proxy_unsupported',
  transportUnavailable: 'transport_unavailable',
  cancelled: 'cancelled',
  deadline: 'deadline',
  tooManyRedirects: 'too_many_redirects',
  responseTooLarge: 'response_too_large',
  http: 'http_error',
  unsupported: 'unsupported',
}

export class NetworkPolicyError extends Error {
  /**
   * @param {string} message
   * @param {string} kind
   * @param {{ detail?: string, cause?: unknown }} [extra]
   */
  constructor(message, kind, extra = {}) {
    super(message)
    this.name = 'NetworkPolicyError'
    this.kind = kind
    this.detail = extra.detail ?? null
    if (extra.cause !== undefined) this.cause = extra.cause
  }
}

export function isNetworkPolicyError(err) {
  return err instanceof NetworkPolicyError || (err instanceof Error && err.name === 'NetworkPolicyError')
}

/** Proxy variables are unrelated to API-key variables and must stay supported. */
export function proxyPolicy(env = process.env) {
  const pick = (names) => {
    for (const name of names) {
      const value = env[name]
      if (typeof value === 'string' && value.trim()) return { value: value.trim(), name }
    }
    return null
  }
  const https = pick(['https_proxy', 'HTTPS_PROXY'])
  const http = pick(['http_proxy', 'HTTP_PROXY'])
  const all = pick(['all_proxy', 'ALL_PROXY'])
  // Match EnvHttpProxyAgent's HTTP -> HTTPS fallback, with ALL_PROXY as the
  // explicit last resort. Pass empty strings too: Undici must not re-read an
  // unnormalized environment variable after this policy has validated it.
  const httpRoute = http ?? all
  const httpsRoute = https ?? http ?? all
  const chosen = httpsRoute ?? httpRoute
  const result = {
    mode: chosen ? 'proxy' : 'direct',
    url: chosen?.value ?? null,
    source: chosen?.name ?? null,
    httpProxy: httpRoute?.value ?? '',
    httpsProxy: httpsRoute?.value ?? '',
    noProxy: env.no_proxy ?? env.NO_PROXY ?? '',
  }
  for (const route of new Set([httpsRoute, httpRoute].filter(Boolean))) {
    let protocol
    try {
      const url = new URL(route.value)
      if (!url.hostname) throw new Error('missing hostname')
      protocol = url.protocol.replace(':', '')
    } catch {
      return { ...result, error: new NetworkPolicyError(`proxy variable ${route.name} is not a valid URL`, NET_ERROR_KINDS.proxyConfig, { detail: 'invalid_url' }) }
    }
    if (protocol !== 'http' && protocol !== 'https') {
      return { ...result, protocol, error: new NetworkPolicyError(
        `proxy ${route.name}=${protocol}:// is not supported; use an HTTP/mixed proxy port`,
        NET_ERROR_KINDS.proxyUnsupported, { detail: protocol },
      ) }
    }
    if (route === chosen) result.protocol = protocol
  }
  return result
}

/** Node's Happy Eyeballs default; explicit here so the policy is visible. */
export function autoSelectFamilyEnabled() {
  try {
    return getDefaultAutoSelectFamily() !== false
  } catch {
    return true
  }
}

/**
 * A bounded, cancellable DNS wait. `dns.lookup` itself cannot be cancelled, so
 * the late result is always consumed (never left as an unhandled rejection) and
 * the caller is told the wait timed out. The number of outstanding lookups is
 * bounded by the caller's concurrency, not by an unbounded race per attempt.
 * @param {string} hostname
 * @param {{ timeoutMs?: number, signal?: AbortSignal, lookupImpl?: Function }} [options]
 * @returns {Promise<Array<{ address: string, family: number }>>}
 */
export function lookupBounded(hostname, options = {}) {
  const timeoutMs = options.timeoutMs ?? 5_000
  const lookupImpl = options.lookupImpl ?? ((host, opts, cb) => dnsLookup(host, opts, cb))
  const signal = options.signal ?? null
  return new Promise((resolve, reject) => {
    let settled = false
    let timer = null
    const finish = (fn, value) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      signal?.removeEventListener?.('abort', onAbort)
      fn(value)
    }
    const onAbort = () => finish(reject, new NetworkPolicyError(`lookup cancelled for ${hostname}`, NET_ERROR_KINDS.cancelled))
    if (signal?.aborted) {
      onAbort()
      return
    }
    signal?.addEventListener?.('abort', onAbort, { once: true })
    timer = setTimeout(() => {
      finish(reject, new NetworkPolicyError(`dns lookup timed out after ${timeoutMs}ms for ${hostname}`, NET_ERROR_KINDS.dnsTimeout))
    }, timeoutMs)
    // The deadline timer is deliberately NOT unref'd: it must fire even when the
    // hanging lookup is the only pending work, otherwise the "bounded" wait would
    // never end in an idle process.
    // The callback always consumes the result, including after a timeout, so no
    // late rejection is left floating.
    const done = (err, records) => {
      if (err) {
        finish(reject, classifyDnsError(err, hostname))
        return
      }
      const list = (Array.isArray(records) ? records : [records])
        .filter((record) => record && typeof record.address === 'string')
        .map((record) => ({ address: record.address, family: record.family ?? isIP(record.address) }))
      if (!list.length) {
        finish(reject, new NetworkPolicyError(`dns lookup returned no address for ${hostname}`, NET_ERROR_KINDS.dnsFailure))
        return
      }
      finish(resolve, list)
    }
    try {
      lookupImpl(hostname, { all: true, verbatim: true }, done)
    } catch (err) {
      finish(reject, classifyDnsError(err, hostname))
    }
  })
}

/** DNS failures are told apart instead of collapsing into "fetch failed". */
export function classifyDnsError(err, hostname) {
  const code = err?.code ?? err?.cause?.code ?? null
  const kinds = {
    EAI_AGAIN: NET_ERROR_KINDS.dnsTemporary,
    ENOTFOUND: NET_ERROR_KINDS.dnsNotFound,
    EAI_NODATA: NET_ERROR_KINDS.dnsNotFound,
    EAI_NONAME: NET_ERROR_KINDS.dnsNotFound,
    ETIMEOUT: NET_ERROR_KINDS.dnsTimeout,
    ETIMEDOUT: NET_ERROR_KINDS.dnsTimeout,
  }
  const kind = kinds[code] ?? NET_ERROR_KINDS.dnsFailure
  return new NetworkPolicyError(`dns lookup failed for ${hostname}${code ? ` (${code})` : ''}`, kind, { detail: code, cause: err })
}

/**
 * Classify a transport failure using the controlled `error.cause.code`, not just
 * "fetch failed".
 * @param {unknown} err
 * @param {{ signal?: AbortSignal | null }} [context]
 */
export function classifyFetchError(err, context = {}) {
  if (isNetworkPolicyError(err)) return err
  if (context.signal?.aborted) {
    return new NetworkPolicyError('request cancelled', NET_ERROR_KINDS.cancelled, { cause: err })
  }
  const code = err?.cause?.code ?? err?.code ?? null
  const kinds = {
    EAI_AGAIN: NET_ERROR_KINDS.dnsTemporary,
    ENOTFOUND: NET_ERROR_KINDS.dnsNotFound,
    EAI_NODATA: NET_ERROR_KINDS.dnsNotFound,
    EAI_NONAME: NET_ERROR_KINDS.dnsNotFound,
    ETIMEOUT: NET_ERROR_KINDS.dnsTimeout,
    ECONNREFUSED: NET_ERROR_KINDS.connectRefused,
    ECONNRESET: NET_ERROR_KINDS.connectRefused,
    ETIMEDOUT: NET_ERROR_KINDS.connectTimeout,
    UND_ERR_CONNECT_TIMEOUT: NET_ERROR_KINDS.connectTimeout,
    UND_ERR_HEADERS_TIMEOUT: NET_ERROR_KINDS.connectTimeout,
    UND_ERR_BODY_TIMEOUT: NET_ERROR_KINDS.connectTimeout,
    CERT_HAS_EXPIRED: NET_ERROR_KINDS.tls,
    DEPTH_ZERO_SELF_SIGNED_CERT: NET_ERROR_KINDS.tls,
    SELF_SIGNED_CERT_IN_CHAIN: NET_ERROR_KINDS.tls,
    UNABLE_TO_VERIFY_LEAF_SIGNATURE: NET_ERROR_KINDS.tls,
    ERR_TLS_CERT_ALTNAME_INVALID: NET_ERROR_KINDS.tls,
  }
  const kind = kinds[code] ?? NET_ERROR_KINDS.connectRefused
  const detail = code ? String(code) : (err instanceof Error ? err.message : String(err))
  return new NetworkPolicyError(`request failed: ${detail}`, kind, { detail, cause: err })
}

/**
 * A lookup that can only ever answer with the already-validated snapshot.
 * Undici's connector calls this for the destination; the system resolver is not
 * consulted again, so the address that was checked is the address that is used.
 * @param {Array<{ address: string, family: number }>} addresses
 */
export function pinnedLookup(addresses) {
  const snapshot = addresses.map((entry) => ({ address: entry.address, family: entry.family ?? isIP(entry.address) }))
  return (hostname, options, callback) => {
    const wantFamily = options?.family === 4 || options?.family === 6 ? options.family : null
    const usable = wantFamily ? snapshot.filter((entry) => entry.family === wantFamily) : snapshot
    if (!usable.length) {
      const err = new NetworkPolicyError(`no validated address for ${hostname}`, NET_ERROR_KINDS.blockedAddress, { detail: 'no_validated_address' })
      err.code = 'ENOTFOUND'
      callback(err)
      return
    }
    if (options?.all) callback(null, usable)
    else callback(null, usable[0].address, usable[0].family)
  }
}
