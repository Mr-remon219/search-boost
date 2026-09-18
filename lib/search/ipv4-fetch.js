// IPv4-forced fetch for Node built-in fetch (Undici).
// Windows undici defaults to IPv6-first DNS; some hosts (bing.com, x.com) time out on v6.
// Node fetch ignores https.Agent — pass an Undici dispatcher instead.
//
// `undici` is loaded lazily: the MCP server always has it (package dependency),
// but Core is also imported inside host processes (pi extension loader, DSH
// bundle) where the dependency tree may not be resolvable. Degrade to plain
// fetch there instead of failing to load the whole search chain.

import * as dns from 'node:dns'

/** @type {Promise<unknown | null> | null} */
let dispatcherPromise = null

function loadDispatcher() {
  if (dispatcherPromise) return dispatcherPromise
  dispatcherPromise = import('undici')
    .then(({ Agent }) => new Agent({
      connect: {
        lookup: (hostname, options, callback) => {
          dns.lookup(hostname, { ...options, family: 4 }, callback)
        },
      },
    }))
    .catch(() => null)
  return dispatcherPromise
}

/** fetch through the IPv4-forced Undici dispatcher (plain fetch when undici is unavailable). */
export async function ipv4Fetch(url, init = {}) {
  const dispatcher = await loadDispatcher()
  return dispatcher ? fetch(url, { ...init, dispatcher }) : fetch(url, init)
}
