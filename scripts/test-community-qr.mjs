#!/usr/bin/env node
import './isolate-tests.mjs'
import assert from 'node:assert/strict'
import { existsSync, lstatSync, mkdirSync, readFileSync, symlinkSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import QRCode from 'qrcode'
import { PNG } from 'pngjs'
import jsQR from 'jsqr'
import { createQrArtifact, inspectQrPng, isOwnedQrPng, qrTerminalRows } from '../lib/community/qr-image.mjs'
import { initializeNativeQrSession, verifyQrLogin } from '../lib/community/qr-login.mjs'
import { qrFileHyperlink, openQrPng } from '../lib/community/qr-terminal.mjs'
import { ConsoleModel, renderConsole, displayWidth, runConsoleTui } from '../lib/console-tui.mjs'

const root = join(process.env.HOME, 'qr-login-fixtures')
let count = 0
const fresh = () => { process.env.SEARCH_BOOST_HOME = join(root, String(++count)) }
const token = 'https://example.test/login?token=private-test-only'
const png = await QRCode.toBuffer(token, { type: 'png', width: 256, margin: 4 })
fresh()
const inspected = inspectQrPng(png)
assert(inspected.matrix)
const rows = qrTerminalRows(inspected.matrix)
assert.equal(rows.length, Math.ceil((inspected.matrix.length + 8) / 2))
assert(rows.slice(0, 2).every(row => /^ +$/.test(row)), 'quiet zone stays intact')
// Render half blocks back into pixels and decode to prove the terminal matrix preserves data.
const image = new PNG({ width: rows[0].length * 6, height: rows.length * 2 * 6 })
for (let y = 0; y < image.height; y++) for (let x = 0; x < image.width; x++) {
  const row = Math.floor(y / 12), column = Math.floor(x / 6), cell = rows[row][column], bottom = Math.floor(y / 6) % 2
  const dark = cell === '█' || cell === (bottom ? '▄' : '▀'), value = dark ? 0 : 255, i = (y * image.width + x) * 4
  image.data.set([value, value, value, 255], i)
}
assert.equal(jsQR(new Uint8ClampedArray(image.data), image.width, image.height).data, token)
assert.equal(qrTerminalRows([[true]]), null)
assert.throws(() => inspectQrPng(Buffer.from('not a PNG')), /invalid/)
const bomb = Buffer.from(png); bomb.writeUInt32BE(50000, 16)
assert.throws(() => inspectQrPng(bomb), /invalid/)
const artifact = createQrArtifact('zhihu'), first = artifact.update(png)
assert.equal(artifact.update(png), null, 'unchanged QR image creates no update')
assert(isOwnedQrPng(first.path))
if (process.platform !== 'win32') assert.equal(lstatSync(first.path).mode & 0o777, 0o600)
assert.match(qrFileHyperlink(first.path), /\x1b\]8;;file:/)
assert.doesNotMatch(qrFileHyperlink('https://evil.test', '\x1b[31mopen\n'), /\x1b/)
let opening
await openQrPng(first.path, { platform: 'darwin', spawnImpl: (command, args, options) => {
  opening = { command, args, options }; const child = new EventEmitter(); child.unref = () => {}; setImmediate(() => child.emit('spawn')); return child
} })
assert.deepEqual(opening.args, [first.path]); assert.equal(opening.command, '/usr/bin/open'); assert.equal(opening.options.shell, false)
await assert.rejects(openQrPng(first.path, { platform: 'linux', env: { WSL_DISTRO_NAME: 'test' } }), /host image viewer/)
artifact.remove(); assert(!existsSync(first.path)); await assert.rejects(openQrPng(first.path), /no longer available/)
// Simulate a crashed login: only UUID PNGs owned by this platform are pruned.
const crashed = createQrArtifact('zhihu'), leftover = crashed.update(png)
const otherPlatform = createQrArtifact('bilibili'), otherQr = otherPlatform.update(png)
const note = join(leftover.path, '..', 'keep.txt')
writeFileSync(note, 'not a QR artifact')
const next = createQrArtifact('zhihu')
assert.equal(existsSync(leftover.path), false, 'a new QR attempt cleans a crashed login PNG')
assert.equal(existsSync(otherQr.path), true, 'other platforms are untouched')
assert.equal(readFileSync(note, 'utf8'), 'not a QR artifact', 'unknown files are not deleted')
next.remove(); crashed.remove(); otherPlatform.remove(); rmSync(note)
console.log('ok: bounded private PNGs, crash recovery, lossless terminal modules, owned-file links and shell-free opening')

function loginFixture({ verifiedAfter = 2, controller, failure, captureImage = png } = {}) {
  let clock = 0, verifies = 0, saved = 0, closed = 0, options, emitted
  const page = { close: async () => { closed++ } }
  return { options: () => options, saved: () => saved, closed: () => closed, emitted: () => emitted,
    run: () => initializeNativeQrSession('zhihu', {
      signal: controller?.signal, timeoutMs: 10000, pollMs: 1000, verifyIntervalMs: 1000, clock: () => clock,
      wait: async () => { clock += 1000 },
      session: async (_platform, work, opts) => { options = opts; return work({ newPage: async () => page }) },
      prepare: async () => {}, verify: async () => ++verifies >= verifiedAfter,
      capture: async () => { if (failure === 'capture') throw new Error('private cookie raw error'); return captureImage },
      persist: (_platform, state) => { assert.equal(state.authenticated, true); saved++ },
      onQr: qr => { emitted = qr; assert(existsSync(qr.path)); assert(!JSON.stringify(qr).includes('private-test-only')); controller?.abort() },
    }),
  }
}
fresh()
const success = loginFixture({ verifiedAfter: 4 }); assert.equal(await success.run(), true)
assert.equal(success.options().headless, true); assert.equal(success.options().login, true)
assert.equal(success.saved(), 1); assert.equal(success.closed(), 1); assert(!existsSync(success.emitted().path))
const reused = loginFixture({ verifiedAfter: 1 }); assert.equal(await reused.run(), true); assert.equal(reused.emitted(), undefined)
const controller = new AbortController(), cancelled = loginFixture({ verifiedAfter: 100, controller })
await assert.rejects(cancelled.run(), { name: 'AbortError' }); assert.equal(cancelled.saved(), 0); assert(!existsSync(cancelled.emitted().path))
const timeout = loginFixture({ verifiedAfter: Infinity }); await assert.rejects(timeout.run(), { kind: 'qr_login_timeout' }); assert.equal(timeout.saved(), 0)
assert(!existsSync(timeout.emitted().path))
const broken = loginFixture({ failure: 'capture', verifiedAfter: Infinity })
await assert.rejects(broken.run(), error => error.kind === 'qr_login_failed' && !error.message.includes('private cookie'))
assert.equal(broken.saved(), 0)
console.log('ok: headless QR login auto-verifies identity; cancel, timeout and failures never save a session')

const fakeJsonContext = doc => ({ newPage: async () => ({ goto: async () => ({ status: () => 200 }), locator: () => ({ innerText: async () => JSON.stringify(doc) }), close: async () => {} }) })
assert.equal(await verifyQrLogin('bilibili', fakeJsonContext({ code: 0, data: { isLogin: true, mid: 123 } })), true)
assert.equal(await verifyQrLogin('bilibili', fakeJsonContext({ code: 0, data: { isLogin: false, mid: 123 } })), false)
assert.equal(await verifyQrLogin('zhihu', fakeJsonContext({ id: 'valid-user-id', name: 'fixture', is_active: true })), true)
assert.equal(await verifyQrLogin('zhihu', fakeJsonContext({ id: 'valid-user-id', error: { code: 401 } })), false)
assert.equal(await verifyQrLogin('xiaohongshu', null, { evaluate: async () => ({ id: 'valid-id', guest: true, accountLink: true }) }), false)
assert.equal(await verifyQrLogin('xiaohongshu', null, { evaluate: async () => ({ id: 'valid-id', guest: false, accountLink: true }) }), true)
console.log('ok: cookie presence, guest identity and scans-in-progress cannot substitute for account verification')

fresh()
const visible = createQrArtifact('bilibili'), qr = visible.update(png)
const model = new ConsoleModel({ language: 'en' }); model.navigate(4)
model.openModal({ kind: 'qr', title: 'App QR login', qr, status: 'Waiting for confirmation', communityLogin: true })
const big = renderConsole(model, { columns: 150, rows: 60, color: true })
assert.match(big, /\x1b\[30;47m/); assert.match(big, /\x1b\]8;;file:/); assert(big.includes('▀') || big.includes('▄'))
assert(!big.includes('private-test-only'))
for (const columns of [54, 80, 112, 150]) for (const height of [16, 30, 60]) for (const color of [true, false]) {
  const frame = renderConsole(model, { columns, rows: height, color })
  assert(frame.split('\n').every(line => displayWidth(line) <= columns - 1))
  assert(frame.split('\n').length <= height - 1)
  if (!color) assert.doesNotMatch(frame, /\x1b/)
}
assert.match(renderConsole(model, { columns: 80, rows: 24, color: false }), /PNG/)
let opened = 0
model.services.openQrPng = async path => { assert.equal(path, qr.path); opened++ }
model.handleKey('', { name: 'o' }); await new Promise(resolve => setImmediate(resolve)); assert.equal(opened, 1)
model.handleKey('', { name: 'return' }); await new Promise(resolve => setImmediate(resolve)); assert.equal(opened, 2)
const hit = model.qrLinkRegions[0]
model.handleMouse(`\x1b[<16;${hit.left};${hit.row}M`); await new Promise(resolve => setImmediate(resolve)); assert.equal(opened, 3)
for (const button of [0, 48, 80]) model.handleMouse(`\x1b[<${button};${hit.left};${hit.row}M`)
model.handleMouse(`\x1b[<16;1;1M`); await new Promise(resolve => setImmediate(resolve)); assert.equal(opened, 3)
const input = new PassThrough(), output = new PassThrough(); input.isTTY = true; output.isTTY = true
input.setRawMode = value => { input.isRaw = value }; output.columns = 150; output.rows = 60
let terminalOutput = ''; output.on('data', chunk => { terminalOutput += chunk.toString() })
const running = runConsoleTui([], { input, output, model })
await new Promise(resolve => setImmediate(resolve))
const actualHit = model.qrLinkRegions[0]
input.write(`\x1b[<16;${actualHit.left};`); input.write(`${actualHit.row}M`)
await new Promise(resolve => setImmediate(resolve)); assert.equal(opened, 4, 'fragmented SGR Ctrl+left click opens the PNG in the actual input path')
input.write('q'); await running
assert.match(terminalOutput, /\x1b\[\?1000h/); assert.match(terminalOutput, /\x1b\[\?1000l/)
assert.match(terminalOutput, /\x1b\[\?1006l/); assert.equal(input.listenerCount('keypress'), 0)
visible.remove()
console.log('ok: inline console QR is high-contrast and never cropped; narrow/no-color uses clickable PNG fallback')

fresh()
const real = join(process.env.HOME, 'foreign-qr-directory'); mkdirSync(real, { recursive: true })
mkdirSync(join(process.env.SEARCH_BOOST_HOME, 'state', 'community'), { recursive: true })
symlinkSync(real, join(process.env.SEARCH_BOOST_HOME, 'state', 'community', 'qr'), process.platform === 'win32' ? 'junction' : 'dir')
assert.throws(() => createQrArtifact('zhihu'), /invalid/); assert(existsSync(real))
rmSync(join(process.env.SEARCH_BOOST_HOME, 'state', 'community', 'qr'))
console.log('ok: QR files cannot be created or opened through a symlinked foreign directory')
