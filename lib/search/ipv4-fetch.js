// IPv4-forced fetch for Node built-in fetch (Undici).
// Windows undici defaults to IPv6-first DNS; some hosts (bing.com, x.com) time out on v6.
// Node fetch ignores https.Agent — pass an Undici dispatcher instead.

import { Agent } from 'undici'
import * as dns from 'node:dns'

const ipv4Dispatcher = new Agent({
  connect: {
    lookup: (hostname, options, callback) => {
      dns.lookup(hostname, { ...options, family: 4 }, callback)
    },
  },
})

/** fetch through the IPv4-forced Undici dispatcher. */
export function ipv4Fetch(url, init = {}) {
  return fetch(url, { ...init, dispatcher: ipv4Dispatcher })
}
