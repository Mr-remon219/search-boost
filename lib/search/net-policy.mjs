// Transport policy: proxy environment parsing, per-URL routes, error taxonomy
// and compatibility DNS helpers. Normal page requests no longer apply a private
// destination blocklist or pre-resolve/pin direct DNS; the local network and the
// configured proxy own destination access control.

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
  transportError: 'transport_error',
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

/**
 * NO_PROXY matching with the same rules the installed Undici release applies in
 * `EnvHttpProxyAgent`, so this decision matches the transport's own reading:
 * entries split on comma/whitespace, an entry may be `host:port`, `*` means
 * "never proxy", and an entry starting with `.` or `*` matches by suffix while
 * anything else only matches exactly. IPv6 hosts keep their brackets.
 * @param {string} hostname
 * @param {number} [port]
 * @param {string} [noProxy]
 */
export function noProxyMatches(hostname, port, noProxy = '') {
  const value = String(noProxy ?? '')
  if (value === '*') return true
  const entries = value.split(/[,\s]/).filter(Boolean)
  if (!entries.length) return false
  const host = String(hostname ?? '').toLowerCase()
  for (const entry of entries) {
    const parsed = /^(.+):(\d+)$/.exec(entry)
    const entryHost = (parsed ? parsed[1] : entry).toLowerCase()
    const entryPort = parsed ? Number.parseInt(parsed[2], 10) : 0
    if (entryPort && entryPort !== port) continue
    if (!/^[.*]/.test(entryHost)) {
      if (host === entryHost) return true
    } else if (host.endsWith(entryHost.replace(/^\*/, ''))) return true
  }
  return false
}

/**
 * Snapshot the route for one URL/hop. Match the service transport's protocol
 * selection and NO_PROXY semantics. Keep the selected proxy URL with the route
 * so an environment change during DNS/import cannot silently change transport.
 * @param {string | URL} url
 * @param {Record<string, string | undefined>} [env]
 */
export function proxyRouteFor(url, env = process.env) {
  const parsed = new URL(url)
  const policy = proxyPolicy(env)
  if (policy.error) throw policy.error
  const proxyUrl = parsed.protocol === 'https:' ? policy.httpsProxy : policy.httpProxy
  const port = Number.parseInt(parsed.port, 10) || (parsed.protocol === 'https:' ? 443 : 80)
  if (!proxyUrl || noProxyMatches(parsed.hostname, port, policy.noProxy)) {
    return { route: 'direct', proxyUrl: null }
  }
  return { route: 'proxy', proxyUrl }
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
  const kind = kinds[code] ?? NET_ERROR_KINDS.transportError
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
