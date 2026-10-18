import { createHash, randomUUID } from 'node:crypto'
import { existsSync, lstatSync, readdirSync, rmSync, rmdirSync } from 'node:fs'
import { join, resolve, relative, basename } from 'node:path'
import { createRequire } from 'node:module'
import { NATIVE_PLATFORMS } from './native-setup.mjs'
import { searchBoostHome } from '../config-paths.mjs'
import { ensurePrivateDir, writeFileAtomicPrivate } from '../private-file.mjs'

const require = createRequire(import.meta.url)
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
const qrError = () => Object.assign(new Error('Login QR image unavailable or invalid'), { kind: 'qr_unavailable' })
const fileName = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.png$/
const qrHome = platform => {
  if (!NATIVE_PLATFORMS.includes(platform)) throw qrError()
  return join(searchBoostHome(), 'state', 'community', 'qr', platform)
}
function ownedQrDirectory(platform, create = false) {
  const home = qrHome(platform)
  let current = searchBoostHome()
  for (const part of [null, 'state', 'community', 'qr', platform]) {
    if (part) current = join(current, part)
    let stat
    try { stat = lstatSync(current) } catch (error) { if (error.code !== 'ENOENT') throw qrError() }
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw qrError()
    if (create) ensurePrivateDir(current)
  }
  return home
}

/** Decode only bounded PNGs. QR payload bytes stay in memory, never in UI/logs. */
export function inspectQrPng(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 33 || buffer.length > 2_000_000 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)
    || buffer.toString('ascii', 12, 16) !== 'IHDR') throw qrError()
  const width = buffer.readUInt32BE(16), height = buffer.readUInt32BE(20)
  if (width < 20 || height < 20 || width > 1024 || height > 1024) throw qrError()
  // Keep non-QR CLI/migration startup independent of image packages.
  let PNG, jsQR, QRCode
  try { ({ PNG } = require('pngjs')); jsQR = require('jsqr'); QRCode = require('qrcode') } catch { throw qrError() }
  let png
  try { png = PNG.sync.read(buffer) } catch { throw qrError() }
  const decoded = jsQR(new Uint8ClampedArray(png.data), png.width, png.height, { inversionAttempts: 'attemptBoth' })
  let matrix = null
  if (decoded?.binaryData?.length && decoded.binaryData.length <= 4096) {
    // Preserve binary QR data rather than exposing/reinterpreting a signed login URL.
    try {
      const code = QRCode.create([{ data: Buffer.from(decoded.binaryData), mode: 'byte' }], { errorCorrectionLevel: 'M' })
      matrix = Array.from({ length: code.modules.size }, (_, y) => Array.from({ length: code.modules.size }, (_, x) => Boolean(code.modules.get(y, x))))
    } catch { /* The original PNG remains usable when inline re-encoding is unsupported. */ }
  }
  return { matrix, digest: createHash('sha256').update(buffer).digest('hex') }
}

export function isOwnedQrPng(path) {
  if (typeof path !== 'string' || !fileName.test(basename(path))) return false
  try {
    for (const platform of NATIVE_PLATFORMS) {
      const home = ownedQrDirectory(platform)
      if (relative(resolve(home), resolve(path)) !== basename(path)) continue
      const stat = lstatSync(path)
      return stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1
    }
  } catch { /* An unsafe/unreadable directory is never an image-opening target. */ }
  return false
}

/** A transient, private, per-attempt PNG; removed after success/cancel/failure.
 * Call only while holding the platform session lock: previous attempt PNGs can
 * then only be crash leftovers, never another active login's image.
 */
export function createQrArtifact(platform) {
  const home = ownedQrDirectory(platform, true), path = join(home, `${randomUUID()}.png`)
  for (const name of readdirSync(home)) {
    if (!fileName.test(name)) continue
    const stale = join(home, name)
    if (isOwnedQrPng(stale)) rmSync(stale, { force: true })
  }
  let digest
  return {
    path,
    update(buffer) {
      const inspected = inspectQrPng(buffer)
      if (inspected.digest === digest) return null
      ownedQrDirectory(platform)
      if (existsSync(path) && !isOwnedQrPng(path)) throw qrError()
      writeFileAtomicPrivate(path, buffer)
      digest = inspected.digest
      return { path, matrix: inspected.matrix }
    },
    remove() {
      try { ownedQrDirectory(platform) } catch { return } // Never clean through a changed/foreign ancestor.
      if (isOwnedQrPng(path)) rmSync(path)
      try { rmdirSync(home) } catch (error) { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error }
    },
  }
}

/** Full quiet zone, no scaling/cropping; each cell holds two vertical modules. */
export function qrTerminalRows(matrix) {
  if (!Array.isArray(matrix) || matrix.length < 21 || matrix.length > 177 || matrix.some(row => !Array.isArray(row) || row.length !== matrix.length || row.some(cell => typeof cell !== 'boolean'))) return null
  const size = matrix.length + 8
  const dark = (x, y) => x >= 4 && y >= 4 && x < size - 4 && y < size - 4 && matrix[y - 4][x - 4]
  return Array.from({ length: Math.ceil(size / 2) }, (_, row) => Array.from({ length: size }, (_, x) => {
    const upper = dark(x, row * 2), lower = dark(x, row * 2 + 1)
    return upper ? lower ? '█' : '▀' : lower ? '▄' : ' '
  }).join(''))
}
