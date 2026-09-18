// IPv4-forced fetch for Node built-in fetch (Undici).
// Windows undici defaults to IPv6-first DNS; some hosts (bing.com, x.com) time out on v6.
// Node fetch ignores https.Agent — pass an Undici dispatcher instead.
//
// A custom Agent also bypasses NODE_USE_ENV_PROXY. When HTTP(S)_PROXY /
// ALL_PROXY is set (Clash/mihomo commonly listen on 7890), use
// EnvHttpProxyAgent so Core actually goes through the proxy. Destination DNS
// is done by the proxy; IPv4 lookup still applies to the proxy host and to
// NO_PROXY targets.
//
// `undici` is loaded lazily: the MCP server always has it (package dependency),
// but Core is also imported inside host processes (pi extension loader, DSH
// bundle) where the dependency tree may not be resolvable. Degrade to plain
// fetch there instead of failing to load the whole search chain.

import * as dns from 'node:dns'

/** @type {Promise<unknown | null> | null} */
let dispatcherPromise = null

function firstEnv(names) {
  for (const name of names) {
    const value = process.env[name]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

/**
 * Proxy URL from the process environment.
 * Lowercase vars win (same rule as undici EnvHttpProxyAgent).
 * @param {'http' | 'https'} [kind]
 */
export function envProxyUrl(kind = 'https') {
  if (kind === 'http') {
    return firstEnv(['http_proxy', 'HTTP_PROXY', 'all_proxy', 'ALL_PROXY'])
  }
  return firstEnv(['https_proxy', 'HTTPS_PROXY', 'http_proxy', 'HTTP_PROXY', 'all_proxy', 'ALL_PROXY'])
}

function ipv4Connect() {
  return {
    lookup: (hostname, options, callback) => {
      dns.lookup(hostname, { ...options, family: 4 }, callback)
    },
  }
}

function loadDispatcher() {
  if (dispatcherPromise) return dispatcherPromise
  dispatcherPromise = import('undici')
    .then((undici) => {
      const connect = ipv4Connect()
      const httpProxy = envProxyUrl('http')
      const httpsProxy = envProxyUrl('https')
      if ((httpProxy || httpsProxy) && typeof undici.EnvHttpProxyAgent === 'function') {
        return new undici.EnvHttpProxyAgent({
          connect,
          ...(httpProxy ? { httpProxy } : {}),
          ...(httpsProxy ? { httpsProxy } : {}),
        })
      }
      return new undici.Agent({ connect })
    })
    .catch(() => null)
  return dispatcherPromise
}

/** Drop the cached dispatcher so a later env change is picked up (tests). */
export function resetFetchDispatcher() {
  dispatcherPromise = null
}

/** fetch through the IPv4-forced Undici dispatcher (plain fetch when undici is unavailable). */
export async function ipv4Fetch(url, init = {}) {
  const dispatcher = await loadDispatcher()
  return dispatcher ? fetch(url, { ...init, dispatcher }) : fetch(url, init)
}
