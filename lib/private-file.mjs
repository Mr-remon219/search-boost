// Private, atomic file writes for credentials this tool owns.
//
// What this module guarantees on POSIX:
//   * a directory we own is 0700, so only the user can traverse it;
//   * the temporary file is created with O_EXCL under a random name and mode
//     0600 — a pre-existing file or symlink at that path makes the write fail
//     instead of being followed;
//   * the replacement is a rename, so readers see either the old or the new
//     file, never a partial one;
//   * an existing file is never *widened*: `writeFileSync(path, data, {mode})`
//     does not tighten an existing file, which is why the replacement is built
//     from a fresh 0600 temp file instead of writing in place;
//   * a failed write cleans up its own temp file and leaves the old file alone.
//
// Windows has no POSIX mode bits; ACL inheritance applies instead. Nothing here
// claims that 0600 equals a private ACL on Windows, and the platform check only
// skips mode calls that would be meaningless there.
//
// Read-modify-write cycles (keys.json and friends) take an exclusive lock file
// so two writers cannot silently lose each other's update: the second writer
// gets an explicit conflict error instead.

import { chmodSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { basename, dirname, join } from 'node:path'

export const PRIVATE_DIR_MODE = 0o700
export const PRIVATE_FILE_MODE = 0o600
/** A lock file older than this is treated as abandoned by a crashed writer. */
export const LOCK_STALE_MS = 30_000

const isWindows = () => process.platform === 'win32'

/** Error for a conflicting concurrent writer, an unreadable store or a corrupt one. */
export class PrivateFileError extends Error {
  constructor(message, code = 'private_file_error') {
    super(message)
    this.name = 'PrivateFileError'
    this.code = code
  }
}

/**
 * Create a directory this tool owns and keep it private.
 * `tighten` must only be true for directories we own: a directory the user
 * pointed us at (an env override into a shared location) keeps its own mode —
 * the credential file itself is still written 0600.
 * @param {string} dir
 * @param {{ tighten?: boolean }} [options]
 */
export function ensurePrivateDir(dir, options = {}) {
  const tighten = options.tighten !== false
  mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR_MODE })
  if (isWindows() || !tighten) return dir
  try {
    if ((statSync(dir).mode & 0o077) !== 0) chmodSync(dir, PRIVATE_DIR_MODE)
  } catch { /* best effort: a filesystem without POSIX modes */ }
  return dir
}

/**
 * Refuse to write through a symlink: rename() would replace the link itself and
 * silently detach whatever the user pointed at.
 * @param {string} file
 */
export function assertNotSymlink(file) {
  let stat
  try {
    stat = lstatSync(file)
  } catch (err) {
    if (err?.code === 'ENOENT') return
    throw err
  }
  if (stat.isSymbolicLink()) {
    throw new PrivateFileError(`${file} is a symlink; refusing to replace it (write to the real file instead)`, 'symlink_target')
  }
}

/**
 * Atomically replace `file` with `data` through a fresh private temp file.
 * Cleans up its own temp file on failure and leaves the previous file intact.
 * @param {string} file
 * @param {string} data
 * @param {{ mode?: number, tightenDir?: boolean }} [options]
 */
export function writeFileAtomicPrivate(file, data, options = {}) {
  const mode = options.mode ?? PRIVATE_FILE_MODE
  const dir = dirname(file)
  ensurePrivateDir(dir, { tighten: options.tightenDir !== false })
  assertNotSymlink(file)
  const tmp = join(dir, `.${basename(file)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`)
  let fd
  try {
    // 'wx' = O_CREAT | O_EXCL | O_WRONLY: an existing file or symlink at this
    // path (a leftover or an attacker's link) makes the write fail.
    fd = openSync(tmp, 'wx', mode)
    writeSync(fd, data)
    try { fsyncSync(fd) } catch { /* fsync is not available everywhere */ }
    closeSync(fd)
    fd = undefined
    renameSync(tmp, file)
  } catch (err) {
    if (fd !== undefined) { try { closeSync(fd) } catch { /* already closed */ } }
    try { rmSync(tmp, { force: true }) } catch { /* best effort cleanup */ }
    throw err
  }
  return file
}

/**
 * Exclusive lock around a read-modify-write cycle. A second writer gets an
 * explicit conflict error instead of silently overwriting the first one's data.
 * @template T
 * @param {string} file
 * @param {() => T} fn
 * @param {{ staleMs?: number, tightenDir?: boolean }} [options]
 * @returns {T}
 */
export function withFileLock(file, fn, options = {}) {
  const staleMs = options.staleMs ?? LOCK_STALE_MS
  const lock = `${file}.lock`
  ensurePrivateDir(dirname(lock), { tighten: options.tightenDir !== false })
  const take = () => {
    try {
      const fd = openSync(lock, 'wx', PRIVATE_FILE_MODE)
      writeSync(fd, `${process.pid}\n${new Date().toISOString()}\n`)
      closeSync(fd)
      return true
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err
      return false
    }
  }
  if (!take()) {
    let stale = false
    try {
      stale = Date.now() - statSync(lock).mtimeMs > staleMs
    } catch { /* the lock disappeared between the two calls */ }
    if (stale) {
      try { rmSync(lock, { force: true }) } catch { /* someone else cleaned it */ }
    }
    if (!take()) {
      throw new PrivateFileError(
        `another writer is updating ${file} (lock: ${lock}); retry after it finishes`,
        'write_conflict',
      )
    }
  }
  try {
    return fn()
  } finally {
    try { rmSync(lock, { force: true }) } catch { /* best effort */ }
  }
}

/**
 * Read + parse a JSON store, distinguishing "missing" from "unreadable/corrupt".
 * A corrupt main config surfaces as an error: it is never treated as an empty
 * object (which would let a write overwrite the user's file) and never silently
 * falls back to an older copy.
 * @param {string} file
 * @returns {{ exists: boolean, doc: any | null, error: Error | null }}
 */
export function readJsonStore(file) {
  if (!existsSync(file)) return { exists: false, doc: null, error: null }
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch (err) {
    const denied = err?.code === 'EACCES' || err?.code === 'EPERM'
    return {
      exists: true,
      doc: null,
      error: new PrivateFileError(
        `cannot read ${file}: ${denied ? 'permission denied' : (err?.code ?? 'read error')}`,
        denied ? 'store_unreadable' : 'store_read_failed',
      ),
    }
  }
  if (!text.trim()) return { exists: true, doc: {}, error: null }
  try {
    const doc = JSON.parse(text)
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
      return { exists: true, doc: null, error: new PrivateFileError(`${file} must contain a JSON object`, 'store_corrupt') }
    }
    return { exists: true, doc, error: null }
  } catch {
    return { exists: true, doc: null, error: new PrivateFileError(`${file} is not valid JSON; fix or remove it before continuing`, 'store_corrupt') }
  }
}
