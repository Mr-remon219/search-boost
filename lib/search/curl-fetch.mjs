// Optional page transport. This is NOT an escape hatch around the URL guard:
// callers supply an explicit proxy or direct route. Direct DNS belongs to the OS.
import { spawn } from 'node:child_process'
import { isIP } from 'node:net'
import { NET_ERROR_KINDS, NetworkPolicyError } from './net-policy.mjs'

const MAX_BODY = 8_000_000
const MAX_HEADERS = 64_000
let spawnCurl = spawn
export function __setCurlSpawnForTests(fn) { spawnCurl = fn ?? spawn }

function quoted(value) {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r/g, '\\r').replace(/\n/g, '\\n').replace(/\t/g, '\\t')}"`
}

function curlError(exitCode) {
  const kinds = { 5: NET_ERROR_KINDS.dnsFailure, 6: NET_ERROR_KINDS.dnsFailure,
    7: NET_ERROR_KINDS.connectRefused, 28: NET_ERROR_KINDS.connectTimeout,
    35: NET_ERROR_KINDS.tls, 51: NET_ERROR_KINDS.tls, 58: NET_ERROR_KINDS.tls,
    60: NET_ERROR_KINDS.tls, 77: NET_ERROR_KINDS.tls, 90: NET_ERROR_KINDS.tls,
    63: NET_ERROR_KINDS.responseTooLarge }
  // Do not echo stderr: it may contain proxy credentials or sensitive URLs.
  const err = new NetworkPolicyError(`curl page fetch failed (exit ${exitCode})`, kinds[exitCode] ?? NET_ERROR_KINDS.transportError)
  err.code = { 52: 'CURL_GOT_NOTHING', 55: 'CURL_SEND_ERROR', 56: 'CURL_RECV_ERROR' }[exitCode]
  return err
}

function responseFrom(bytes) {
  let offset = 0
  while (true) {
    const end = bytes.indexOf('\r\n\r\n', offset)
    if (end < 0) throw new NetworkPolicyError('curl response headers invalid', NET_ERROR_KINDS.transportError)
    if (end + 4 > MAX_HEADERS) throw new NetworkPolicyError('curl response headers too large', NET_ERROR_KINDS.responseTooLarge)
    const lines = bytes.subarray(offset, end).toString('latin1').split('\r\n')
    const status = Number(/^HTTP\/\S+ (\d{3})/.exec(lines.shift())?.[1])
    offset = end + 4
    if (status >= 100 && status < 200 && status !== 101) continue
    if (status < 200 || status > 599 || !status) throw new NetworkPolicyError('invalid curl HTTP status', NET_ERROR_KINDS.http)
    const headers = new Headers()
    for (const line of lines) {
      const colon = line.indexOf(':')
      if (colon > 0) headers.append(line.slice(0, colon), line.slice(colon + 1).trim())
    }
    // --compressed already decoded the body; do not advertise stale encodings.
    headers.delete('content-encoding'); headers.delete('content-length'); headers.delete('transfer-encoding')
    const body = bytes.subarray(offset)
    if (body.length > MAX_BODY) throw new NetworkPolicyError('curl response too large', NET_ERROR_KINDS.responseTooLarge)
    return new Response([204, 205, 304].includes(status) ? null : body, { status, headers })
  }
}

/** Single GET hop; no automatic redirects, shell or curlrc. */
export function curlPageFetch(url, { route, addresses, headers = {}, signal }) {
  signal?.throwIfAborted()
  const parsed = new URL(url)
  const host = parsed.hostname.replace(/^\[|\]$/g, '')
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new NetworkPolicyError('invalid curl page URL', NET_ERROR_KINDS.blockedHost)
  }
  const config = [`url = ${quoted(parsed.href)}`]
  if (route.route === 'proxy' && route.proxyUrl) {
    config.push(`proxy = ${quoted(route.proxyUrl)}`, 'noproxy = ""')
  } else if (route.route === 'direct') {
    config.push('proxy = ""', 'noproxy = "*"')
    if (addresses?.length) {
      const ips = addresses.map((r) => isIP(r.address) === 6 ? `[${r.address}]` : r.address).join(',')
      config.push(`resolve = ${quoted(`${parsed.hostname}:${parsed.port || (parsed.protocol === 'https:' ? 443 : 80)}:${ips}`)}`)
      if (isIP(host) && !addresses.some((r) => r.address === host)) {
        throw new NetworkPolicyError('literal URL is not in validated snapshot', NET_ERROR_KINDS.blockedAddress)
      }
    }
  } else throw new NetworkPolicyError('curl requires an explicit proxy or direct route', NET_ERROR_KINDS.unsupported)
  for (const [name, value] of Object.entries(headers)) {
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || /[\r\n\0]/.test(value)) {
      throw new NetworkPolicyError('invalid curl request header', NET_ERROR_KINDS.unsupported)
    }
    config.push(`header = ${quoted(`${name}: ${value}`)}`)
  }
  return new Promise((resolve, reject) => {
    let child, failure, size = 0, settled = false
    const chunks = []
    const finish = (err, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      if (err) reject(err); else resolve(value)
    }
    const stop = (err) => { failure ??= err; child?.kill('SIGKILL') }
    const abort = () => stop(new NetworkPolicyError('curl page fetch cancelled', NET_ERROR_KINDS.cancelled))
    const timer = setTimeout(() => stop(new NetworkPolicyError('curl page deadline exceeded', NET_ERROR_KINDS.deadline)), 20_000)
    try {
      child = spawnCurl('curl', ['-q', '--silent', '--show-error', '--compressed', '--include',
        '--suppress-connect-headers', '--proxytunnel', '--globoff', '--proto', '=http,https', '--max-redirs', '0',
        '--max-time', '20', '--connect-timeout', route.route === 'proxy' ? '2' : '10', '--max-filesize', String(MAX_BODY), '--config', '-'],
      { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    } catch (err) {
      finish(new NetworkPolicyError('curl unavailable', NET_ERROR_KINDS.transportUnavailable, { cause: err }))
      return
    }
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
    child.on('error', (err) => finish(new NetworkPolicyError('curl unavailable', NET_ERROR_KINDS.transportUnavailable, { cause: err })))
    child.stdout.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY + MAX_HEADERS) stop(new NetworkPolicyError('curl response too large', NET_ERROR_KINDS.responseTooLarge))
      else chunks.push(chunk)
    })
    child.stderr.resume() // Drain without exposing or retaining sensitive diagnostics.
    child.stdin.on('error', () => {}) // early process exit can close stdin
    child.on('close', (code) => {
      if (failure) return finish(failure)
      if (code !== 0) return finish(curlError(code))
      try { finish(null, responseFrom(Buffer.concat(chunks))) } catch (err) { finish(err) }
    })
    // Config over stdin keeps proxy credentials and target query strings out of argv.
    child.stdin.end(config.join('\n') + '\n')
  })
}
