import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { stripVTControlCharacters } from 'node:util'
import { isOwnedQrPng } from './qr-image.mjs'

const safeText = value => stripVTControlCharacters(String(value)).replace(/[\x00-\x1f\x7f-\x9f]/g, ' ')
export function qrLinkHint({ platform = process.platform } = {}) {
  return platform === 'darwin' ? 'Ctrl+click in console / Cmd+click terminal link · O: open PNG' : platform === 'win32' ? 'Ctrl+click (Windows Terminal) · O: open PNG' : 'Open the PNG path · O: open image where supported'
}

/** OSC 8 only for a verified, local, SearchBoost-owned login PNG. Raw URLs from
 * platform/config text never enter this escape sequence; visible text stays plain.
 */
export function qrFileHyperlink(path, label = path, { enabled = true } = {}) {
  const text = safeText(label)
  if (!enabled || !isOwnedQrPng(path)) return text
  const uri = pathToFileURL(path).href
  if (uri.length > 2000) return text
  return `\x1b]8;;${uri}\x1b\\${text}\x1b]8;;\x1b\\`
}

/** Explicit user action, not automatic. No shell, platform token or remote URL. */
export async function openQrPng(path, { platform = process.platform, env = process.env, spawnImpl = spawn } = {}) {
  if (!isOwnedQrPng(path)) throw new Error('Login PNG is no longer available')
  if (platform === 'linux' && (env.WSL_DISTRO_NAME || env.WSL_INTEROP)) throw new Error('Open the PNG path using your host image viewer')
  const command = platform === 'win32' ? 'explorer.exe' : platform === 'darwin' ? '/usr/bin/open' : 'xdg-open'
  await new Promise((resolve, reject) => {
    let done = false
    const finish = error => { if (done) return; done = true; clearTimeout(timer); error ? reject(new Error('Could not open the login PNG; use its path')) : resolve() }
    let child, timer
    try {
      child = spawnImpl(command, [path], { shell: false, windowsHide: true, stdio: 'ignore' })
      timer = setTimeout(() => finish(new Error('timeout')), 5000)
      child.once('error', finish)
      child.once('spawn', () => finish())
      child.unref?.()
    } catch { finish(new Error('spawn failed')) }
  })
}
