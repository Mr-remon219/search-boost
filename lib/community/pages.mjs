import { randomUUID } from 'node:crypto'
import { constants, lstatSync, openSync, closeSync, fstatSync, readSync, readdirSync, unlinkSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { searchBoostHome } from '../config-paths.mjs'
import { writeFileAtomicPrivate, withFileLock } from '../private-file.mjs'
import { COMMUNITY_OUTPUT, validateCommunity } from './schemas.mjs'

const ID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/
const CURSOR = /^c1:([a-f0-9-]{36})\.(\d{1,16})$/
const FORMAT = 'search-boost-community-v1'
export const COMMUNITY_PAGE_TTL_MS = 30 * 60_000
export const COMMUNITY_SNAPSHOT_BYTES = 4 * 1024 * 1024
export const COMMUNITY_PAGE_BYTES = 96_000
const MAX_DISK_BYTES = 32 * 1024 * 1024
const home = () => resolve(searchBoostHome())
export const communityResultsDir = () => join(home(), 'state', 'community')
const safeDate = value => typeof value === 'string' && Number.isFinite(Date.parse(value))
function checkDirs() {
  for (const path of [join(home(), 'state'), communityResultsDir()]) {
    let stat
    try { stat = lstatSync(path) } catch (error) { if (error.code === 'ENOENT') continue; throw error }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Community snapshots require regular private directories')
  }
}
function fileFor(id) {
  if (typeof id !== 'string' || !ID.test(id)) throw new Error('Invalid saved community result ID; no search was performed')
  return join(communityResultsDir(), `${id}.json`)
}
function typedResult(result) {
  validateCommunity(COMMUNITY_OUTPUT, result)
  if (result.schema_version !== 1 || result.results !== result.items.length || result.items.length > 30 || result.items.some(item => !item.data || item.data.schema_version !== 1 || item.data.platform !== item.platform || item.data.kind !== item.content_type)) throw new Error('Invalid community snapshot result')
  return result
}
function trimSaved(keep) {
  const files = readdirSync(communityResultsDir()).filter(name => ID.test(name.slice(0, -5)) && name.endsWith('.json')).flatMap(name => {
    const path = join(communityResultsDir(), name), stat = lstatSync(path)
    return stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 ? [{ path, size: stat.size, time: stat.mtimeMs }] : []
  }).sort((a, b) => b.time - a.time || a.path.localeCompare(b.path))
  let bytes = 0, count = 0
  for (const file of [files.find(file => file.path === keep), ...files.filter(file => file.path !== keep)].filter(Boolean)) {
    bytes += file.size; count++
    if (count > 32 || bytes > MAX_DISK_BYTES) unlinkSync(file.path)
  }
}
function saveDisk(id, result, capturedAt) {
  checkDirs()
  const path = fileFor(id)
  const body = JSON.stringify({ format: FORMAT, id, captured_at: capturedAt, result }) + '\n'
  if (Buffer.byteLength(body) > COMMUNITY_SNAPSHOT_BYTES) throw new Error('Community snapshot exceeds the storage byte limit')
  withFileLock(join(communityResultsDir(), 'snapshots'), () => { checkDirs(); writeFileAtomicPrivate(path, body); trimSaved(path) })
  return id
}
function loadDisk(id) {
  const path = fileFor(id)
  let fd
  try {
    checkDirs()
    const stat = lstatSync(path)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > COMMUNITY_SNAPSHOT_BYTES) throw new Error('Invalid file')
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    const opened = fstatSync(fd)
    if (!opened.isFile() || opened.nlink !== 1 || opened.size > COMMUNITY_SNAPSHOT_BYTES || opened.dev !== stat.dev || opened.ino !== stat.ino) throw new Error('Invalid opened file')
    const chunks = []; let bytes = 0
    for (;;) {
      const chunk = Buffer.alloc(Math.min(65536, COMMUNITY_SNAPSHOT_BYTES - bytes + 1)), count = readSync(fd, chunk, 0, chunk.length, null)
      if (!count) break
      bytes += count
      if (bytes > COMMUNITY_SNAPSHOT_BYTES) throw new Error('Invalid size')
      chunks.push(chunk.subarray(0, count))
    }
    const doc = JSON.parse(Buffer.concat(chunks, bytes).toString('utf8'))
    if (doc.format !== FORMAT || doc.id !== id || !safeDate(doc.captured_at) || Object.keys(doc).some(key => !['format', 'id', 'captured_at', 'result'].includes(key))) throw new Error('Invalid format')
    return { result: typedResult(doc.result), capturedAt: doc.captured_at }
  } catch { throw new Error('Saved community snapshot missing, unreadable or invalid; no search was performed') }
  finally { if (fd !== undefined) closeSync(fd) }
}

/** Independent community namespace; page reads never touch acquisition/config. */
export function createCommunityPages({ now = Date.now, ttlMs = COMMUNITY_PAGE_TTL_MS, maxRuns = 32, maxBytes = 16 * 1024 * 1024, pageBytes = COMMUNITY_PAGE_BYTES } = {}) {
  if (!Number.isFinite(ttlMs) || ttlMs <= 0 || !Number.isInteger(maxRuns) || maxRuns < 1 || !Number.isInteger(maxBytes) || maxBytes < 1 || !Number.isInteger(pageBytes) || pageBytes < 1) throw new Error('Invalid community page limits')
  const records = new Map()
  const checkSize = size => { if (!Number.isInteger(size) || size < 1 || size > 50) throw new Error('Community page_size must be 1–50') }
  const prune = () => { for (const [id, record] of records) if (record.expires <= now()) records.delete(id) }
  function put(id, result, capturedAt, { historical = false, savedId = null } = {}) {
    prune()
    const copy = structuredClone(typedResult(result)), bytes = Buffer.byteLength(JSON.stringify(copy))
    if (bytes > COMMUNITY_SNAPSHOT_BYTES || bytes > maxBytes) throw new Error('Community snapshot exceeds the storage byte limit')
    records.delete(id)
    while (records.size >= maxRuns || [...records.values()].reduce((n, record) => n + record.bytes, 0) + bytes > maxBytes) records.delete(records.keys().next().value)
    records.set(id, { home: home(), result: copy, capturedAt, expires: now() + ttlMs, historical, savedId, bytes })
  }
  function read(cursor, pageSize = 5, { signal, reused = true } = {}) {
    signal?.throwIfAborted(); checkSize(pageSize); prune()
    const match = typeof cursor === 'string' && CURSOR.exec(cursor)
    if (!match || !ID.test(match[1])) throw new Error('Invalid community cursor; no search was performed')
    const [, id, offsetText] = match, offset = Number(offsetText), record = records.get(id)
    if (!record || record.home !== home()) throw new Error('Community pages expired, evicted or belong to another home; use saved_result_id to restore; no search was performed')
    if (!Number.isSafeInteger(offset) || offset > record.result.items.length) throw new Error('Community cursor offset out of range; no search was performed')
    const { items: all, ...metadata } = structuredClone(record.result)
    if (reused) {
      metadata.took_ms = 0
      metadata.channels = metadata.channels.map(channel => ({ ...channel, cache_hit: true, ...(channel.in_flight ? { in_flight: false } : {}),
        ...(channel.execution ? { execution: { ...channel.execution, cacheHit: true, inFlight: false, usage: channel.execution.usage ? { ...channel.execution.usage, logicCalls: 0, dispatchedNow: false, officialAttempted: false, fallbackAttempted: false, engineRequests: 0, engineErrors: 0, enhancementAttempts: 0, enhancementErrors: 0, httpAttempts: 0, tokens: 0 } : null } } : {}),
      }))
    }
    const items = [], metaBytes = Buffer.byteLength(JSON.stringify(metadata)) + 1024
    if (metaBytes >= pageBytes) throw new Error('Community page metadata exceeds the return byte limit')
    let bytes = metaBytes
    for (const row of all.slice(offset, offset + pageSize)) {
      const length = Buffer.byteLength(JSON.stringify(row))
      if (items.length && bytes + length > pageBytes) break
      items.push(row); bytes += length
    }
    const next = offset + items.length
    return validateCommunity(COMMUNITY_OUTPUT, { ...metadata, schema_version: 2, results: items.length, items,
      total_results: all.length, page_results: items.length, next_cursor: next < all.length ? `c1:${id}.${next}` : null,
      expires_at: new Date(record.expires).toISOString(), captured_at: record.capturedAt, historical: record.historical, reused,
      ...(record.savedId ? { saved_result_id: record.savedId } : {}),
      warnings: [...metadata.warnings, ...(record.historical ? ['Historical community snapshot: no search, reprocessing or freshness verification was performed.'] : []), ...(bytes > pageBytes ? ['One result exceeds the soft page byte limit and was returned intact.'] : [])],
    })
  }
  return {
    read,
    clear() { records.clear() },
    save(result, { pageSize = 5, persist = false, signal } = {}) {
      signal?.throwIfAborted(); checkSize(pageSize)
      const id = randomUUID(), capturedAt = new Date(now()).toISOString()
      put(id, result, capturedAt)
      try {
        // Validate delivery before writing a durable artifact for an unusable page.
        read(`c1:${id}.0`, pageSize, { signal, reused: false })
        if (persist) { signal?.throwIfAborted(); saveDisk(id, records.get(id).result, capturedAt); records.get(id).savedId = id }
        return read(`c1:${id}.0`, pageSize, { signal, reused: false })
      } catch (error) { records.delete(id); throw error }
    },
    restore(id, pageSize = 5, { signal } = {}) {
      signal?.throwIfAborted(); checkSize(pageSize)
      const loaded = loadDisk(id)
      signal?.throwIfAborted()
      const cursorId = randomUUID()
      put(cursorId, loaded.result, loaded.capturedAt, { historical: true, savedId: id })
      return read(`c1:${cursorId}.0`, pageSize, { signal })
    },
  }
}
export const communityPages = createCommunityPages()
