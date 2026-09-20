// SSRF guard for fetch_page's local fallback.
//
// Two kinds of checks, deliberately separate:
//   * STATIC checks (scheme, embedded credentials, localhost/internal names, IP
//     literals in private space) need no DNS and are what a cache hit or the
//     third-party Jina path can apply.
//   * RESOLUTION checks need a bounded DNS wait, and their result is PINNED to
//     the connection: the address that was validated is the address the
//     connector uses. Re-resolving at connect time is what opens the
//     check-then-connect (DNS rebinding) gap.
//
// Clash/mihomo/sing-box TUN fake-IP (198.18.0.0/15) is no longer trusted
// automatically: a synthetic address does not prove the final destination is
// public. Trusted-TUN compatibility is an explicit opt-in
// (SEARCH_BOOST_TRUSTED_TUN=1) that depends on the TUN's real routing.

import { BlockList, isIP } from 'node:net'
import { fetchPinned } from './ipv4-fetch.js'
import { NET_ERROR_KINDS, NetworkPolicyError, isNetworkPolicyError, lookupBounded, classifyFetchError } from './net-policy.mjs'

const v4 = new BlockList()
v4.addSubnet('0.0.0.0', 8, 'ipv4')
v4.addSubnet('10.0.0.0', 8, 'ipv4')
v4.addSubnet('100.64.0.0', 10, 'ipv4')
v4.addSubnet('127.0.0.0', 8, 'ipv4')
v4.addSubnet('169.254.0.0', 16, 'ipv4')
v4.addSubnet('172.16.0.0', 12, 'ipv4')
v4.addSubnet('192.168.0.0', 16, 'ipv4')
v4.addSubnet('198.18.0.0', 15, 'ipv4')
v4.addSubnet('224.0.0.0', 4, 'ipv4')
v4.addAddress('255.255.255.255', 'ipv4')

const v6 = new BlockList()
v6.addAddress('::', 'ipv6')
v6.addAddress('::1', 'ipv6')
v6.addSubnet('fe80::', 10, 'ipv6')
v6.addSubnet('fc00::', 7, 'ipv6')
v6.addSubnet('ff00::', 8, 'ipv6')

const BLOCKED_HOSTS = new Set([
  'localhost',
  'metadata.google.internal',
  'metadata.google.com',
])

/** Default per-stage DNS budget; callers can lower it, never raise it past the deadline. */
export const DNS_BUDGET_MS = 5_000

export class SsrfError extends Error {
  constructor(message, kind = NET_ERROR_KINDS.blockedAddress) {
    super(message)
    this.name = 'SsrfError'
    this.kind = kind
  }
}

export function isSsrfError(err) {
  return err instanceof SsrfError || (err instanceof Error && err.name === 'SsrfError')
}

/**
 * Test hook: addresses a fixture may connect to (local servers in the network
 * suite). It is a JS-only injection — never read from the environment, never
 * reachable from tool input — so production keeps blocking loopback/private
 * space. Passing null restores strict behaviour.
 * @param {string[] | null} addresses
 */
export function __setFixtureAllowlistForTests(addresses) {
  fixtureAllowlist = addresses ? new Set(addresses) : null
}

/** @type {Set<string> | null} */
let fixtureAllowlist = null

/** Blocklist check plus the fixture-only allowlist. */
function isBlockedAddress(address) {
  if (fixtureAllowlist?.has(address)) return false
  return isBlockedIp(address)
}

/** Strip IPv6 brackets so `[::1]` is judged as the address it is. */
export function normalizeHost(hostname) {
  const raw = String(hostname ?? '').trim().toLowerCase()
  if (raw.startsWith('[') && raw.endsWith(']')) return raw.slice(1, -1)
  return raw
}

export function isBlockedIp(address) {
  let value = normalizeHost(address)
  const family = isIP(value)
  if (family === 6) value = normalizeHost(new URL(`http://[${value}]/`).hostname)
  if (family === 4) return v4.check(value, 'ipv4')
  if (family === 6) {
    // IPv4-mapped IPv6 must be judged by its IPv4 value: ::ffff:127.0.0.1 and
    // the hex-normalized ::ffff:7f00:1 are both loopback.
    const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(value)
    if (mapped) return v4.check(mapped[1], 'ipv4')
    const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(value)
    if (mappedHex) {
      const high = parseInt(mappedHex[1], 16)
      const low = parseInt(mappedHex[2], 16)
      const dotted = `${(high >> 8) & 0xff}.${high & 0xff}.${(low >> 8) & 0xff}.${low & 0xff}`
      return v4.check(dotted, 'ipv4')
    }
    return v6.check(value, 'ipv6')
  }
  return true
}

/** Synthetic TUN address range (RFC 2544); never public by itself. */
export function isTunFakeIp(ip) {
  if (isIP(ip) !== 4) return false
  const [a, b] = ip.split('.').map(Number)
  return a === 198 && (b === 18 || b === 19)
}

/**
 * Trusted-TUN mode is explicit opt-in. Without it, a hostname that resolves into
 * the fake-IP range is treated as blocked (it is not a verified public address).
 * @param {Record<string, string | undefined>} [env]
 */
export function trustedTunMode(env = process.env) {
  const on = (value) => value === '1' || value === 'true'
  return on(env.SEARCH_BOOST_TRUSTED_TUN ?? '')
    || on(env.SEARCH_BOOST_ALLOW_TUN_FAKEIP ?? '')
    || on(env.DSH_SEARCH_ALLOW_TUN_FAKEIP ?? '')
}

function blockedHost(hostname) {
  const host = String(hostname ?? '').replace(/\.$/, '').toLowerCase()
  if (!host) return true
  if (BLOCKED_HOSTS.has(host)) return true
  if (host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return true
  return false
}

/**
 * Static URL check: no DNS, no network. Safe for a cache hit or a third-party
 * reader path that never connects locally.
 * @param {string} url
 * @returns {URL}
 */
export function assertStaticHttpUrl(url) {
  let parsed
  try {
    parsed = new URL(String(url).trim())
  } catch {
    throw new SsrfError('fetch_page: invalid url', NET_ERROR_KINDS.blockedHost)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new SsrfError('fetch_page: url must be http(s)', NET_ERROR_KINDS.blockedHost)
  }
  if (parsed.username || parsed.password) {
    throw new SsrfError('fetch_page: url must not include credentials', NET_ERROR_KINDS.blockedHost)
  }
  if (blockedHost(parsed.hostname)) {
    throw new SsrfError(`fetch_page: blocked host ${parsed.hostname}`, NET_ERROR_KINDS.blockedHost)
  }
  if (isIP(normalizeHost(parsed.hostname)) && isBlockedAddress(normalizeHost(parsed.hostname))) {
    throw new SsrfError(`fetch_page: blocked address ${parsed.hostname}`, NET_ERROR_KINDS.blockedAddress)
  }
  return parsed
}

/**
 * Bounded, cancellable resolution + address validation.
 * Returns the validated snapshot the connection must be pinned to.
 * @param {string} hostname
 * @param {{ signal?: AbortSignal | null, timeoutMs?: number, lookupImpl?: Function, env?: Record<string, string|undefined> }} [options]
 * @returns {Promise<Array<{ address: string, family: number }>>}
 */
export async function resolveValidatedAddresses(hostname, options = {}) {
  const records = await lookupBounded(hostname, {
    timeoutMs: options.timeoutMs ?? DNS_BUDGET_MS,
    signal: options.signal ?? null,
    lookupImpl: options.lookupImpl,
  })
  const trustedTun = trustedTunMode(options.env ?? process.env)
  const viaTun = trustedTun
    && records.some((record) => isTunFakeIp(record.address))
    && records.every((record) => isBlockedAddress(record.address) === isTunFakeIp(record.address))
  if (!viaTun) {
    for (const record of records) {
      if (isBlockedAddress(record.address)) {
        throw new SsrfError(`fetch_page: blocked address ${record.address} (${hostname})`, NET_ERROR_KINDS.blockedAddress)
      }
    }
  }
  return records
}

/**
 * Static check + bounded resolution + validation. Compatibility entry point; the
 * validated snapshot is returned on the URL object as `validatedAddresses` so a
 * caller can pin the connection to it.
 * @param {string} url
 * @param {{ signal?: AbortSignal | null, timeoutMs?: number, lookupImpl?: Function, env?: Record<string, string|undefined> }} [options]
 */
export async function assertPublicHttpUrl(url, options = {}) {
  const parsed = assertStaticHttpUrl(url)
  const host = normalizeHost(parsed.hostname)
  if (isIP(host)) {
    parsed.validatedAddresses = [{ address: host, family: isIP(host) }]
    return parsed
  }
  parsed.validatedAddresses = await resolveValidatedAddresses(host, options)
  return parsed
}

export function mergeSignals(userSignal, timeoutMs) {
  const timeout = AbortSignal.timeout(timeoutMs)
  if (userSignal && typeof userSignal.addEventListener === 'function') {
    try {
      return AbortSignal.any([userSignal, timeout])
    } catch {
      return timeout
    }
  }
  return timeout
}

/** One deadline for every hop: resolution, connect, TLS, headers and body. */
function deadlineSignal(signal, timeoutMs) {
  return mergeSignals(signal, timeoutMs)
}

/**
 * Fetch an arbitrary page with every redirect hop re-validated and the
 * connection pinned to the validated address snapshot.
 * @param {string} url
 * @param {{ headers?: Record<string, string>, timeoutMs?: number, signal?: AbortSignal | null, maxHops?: number, lookupImpl?: Function, env?: Record<string,string|undefined> }} [options]
 */
export async function guardedFetch(url, options = {}) {
  const { headers, timeoutMs = 20_000, signal = null, maxHops = 5, lookupImpl, env } = options
  const combined = deadlineSignal(signal, timeoutMs)
  let current = String(url).trim()
  for (let hop = 0; hop < maxHops; hop++) {
    if (combined.aborted) {
      throw new SsrfError('fetch_page: cancelled before the next hop', signal?.aborted ? NET_ERROR_KINDS.cancelled : NET_ERROR_KINDS.deadline)
    }
    const parsed = assertStaticHttpUrl(current)
    const host = normalizeHost(parsed.hostname)
    const addresses = isIP(host)
      ? [{ address: host, family: isIP(host) }]
      : await resolveValidatedAddresses(host, { signal: combined, timeoutMs: DNS_BUDGET_MS, lookupImpl, env })
    if (combined.aborted) {
      throw new SsrfError('fetch_page: cancelled before connecting', signal?.aborted ? NET_ERROR_KINDS.cancelled : NET_ERROR_KINDS.deadline)
    }
    let res
    try {
      res = await fetchPinned(current, { addresses, headers, signal: combined, redirect: 'manual' })
    } catch (err) {
      if (isNetworkPolicyError(err)) throw err
      if (isSsrfError(err)) throw err
      const classified = classifyFetchError(err, { signal: combined })
      const kind = combined.aborted
        ? (signal?.aborted ? NET_ERROR_KINDS.cancelled : NET_ERROR_KINDS.deadline)
        : classified.kind
      throw new SsrfError(`fetch_page: ${classified.message}`, kind)
    }
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location')
      try { await res.body?.cancel() } catch { /* release this hop before following */ }
      if (!location) throw new SsrfError(`fetch_page: redirect without location (${res.status})`, NET_ERROR_KINDS.http)
      current = new URL(location, current).href
      continue
    }
    return res
  }
  throw new SsrfError('fetch_page: too many redirects', NET_ERROR_KINDS.tooManyRedirects)
}

export async function readLimited(res, maxBytes) {
  if (!res.body || typeof res.body.getReader !== 'function') {
    const text = await res.text()
    if (Buffer.byteLength(text) > maxBytes) throw new SsrfError('fetch_page: response too large', NET_ERROR_KINDS.responseTooLarge)
    return text
  }
  const reader = res.body.getReader()
  const chunks = []
  let n = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    n += value.byteLength
    if (n > maxBytes) {
      try { await reader.cancel() } catch { /* ignore */ }
      throw new SsrfError('fetch_page: response too large', NET_ERROR_KINDS.responseTooLarge)
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8')
}
