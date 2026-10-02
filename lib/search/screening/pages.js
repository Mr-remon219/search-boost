// Process-local pagination for the single schema-v5 screening run and for
// read-only historical restores. Cursors and page reads add zero network calls.
//
// One shared 30-minute / 32-run pool holds both namespaces, bound to the record
// type: `s5:<uuid>.<offset>` reads a v5 run, `h1:<uuid>.<offset>` reads a
// restored historical snapshot. A bare v3 `uuid.offset` cursor and the retired
// `s4:` experiment cursors are rejected. Historical restores keep the original
// result set and metadata: no v5 candidate/result cap is re-applied, and only
// the requested page size limits a single page.
import { randomUUID } from 'node:crypto'

export const ADAPTIVE_SCHEMA_VERSION = 5
export const PAGE_TTL_MS = 30 * 60_000
export const MAX_PAGE_RUNS = 32
export const MAX_PAGE_BYTES = 45_000
const METADATA_BUDGET_BYTES = 16_000
export const S5_CURSOR_PATTERN = '^s5:[a-f0-9-]{36}\\.\\d{1,3}$'
export const H1_CURSOR_PATTERN = '^h1:[a-f0-9-]{36}\\.\\d{1,16}$'
const S5_CURSOR = /^s5:([a-f0-9-]{36})\.(\d{1,3})$/
const H1_CURSOR = /^h1:([a-f0-9-]{36})\.(\d{1,16})$/
const NAMESPACES = Object.freeze({ s5: 'schema-v5 run', h1: 'historical restore' })

export function createResultPages({ now = Date.now, ttlMs = PAGE_TTL_MS, maxRuns = MAX_PAGE_RUNS, maxPageBytes = MAX_PAGE_BYTES } = {}) {
  if (!Number.isInteger(maxRuns) || maxRuns < 1 || !Number.isFinite(ttlMs) || ttlMs <= 0 || !Number.isFinite(maxPageBytes) || maxPageBytes < 1) {
    throw new TypeError('Invalid page storage limits')
  }
  const records = new Map()
  const prune = () => { for (const [id, record] of records) if (record.expires <= now()) records.delete(id) }
  const checkSize = (size = 20) => {
    if (!Number.isInteger(size) || size < 1 || size > 50) throw new TypeError('page_size must be an integer from 1 to 50')
    return size
  }
  const pushWarning = (metadata, text) => { if (Array.isArray(metadata.warnings)) metadata.warnings.push(text) }
  // Bound the per-page metadata independently so it cannot displace every
  // result. Counters, usage and the measured status survive; only the bounded
  // per-candidate decision list and warning wording may be trimmed, and every
  // trim is disclosed.
  function boundedMetadata(metadata, { historical, warnings }) {
    const bounded = structuredClone(metadata)
    const size = () => Buffer.byteLength(JSON.stringify(bounded))
    if (size() > METADATA_BUDGET_BYTES && !historical && bounded.run && Array.isArray(bounded.run.decisions)) {
      // Keep required schema fields and the real global count. Only the
      // detailed list is elided; the typed truncation flag discloses that.
      bounded.run.decisions = []
      bounded.run.decisionsTruncated = true
      warnings.push('Per-candidate decision details were trimmed to preserve every reviewed result; counts and usage are retained.')
    }
    if (size() > METADATA_BUDGET_BYTES && !historical && Array.isArray(bounded.warnings)) {
      const omitted = Math.max(0, bounded.warnings.length - 4)
      bounded.warnings = [...bounded.warnings.slice(0, 4).map((text) => String(text).slice(0, 160)), `${omitted} warning details omitted to preserve every reviewed result.`]
    }
    if (size() > METADATA_BUDGET_BYTES && !historical) throw new TypeError('Screening metadata exceeds the page storage budget')
    if (size() > METADATA_BUDGET_BYTES) warnings.push('Historical snapshot metadata exceeds the soft page budget and is returned unchanged to keep the original record intact.')
    return bounded
  }
  function store(namespace, results, metadata, size, warnings) {
    checkSize(size)
    prune()
    while (records.size >= maxRuns) records.delete(records.keys().next().value)
    const id = randomUUID()
    records.set(id, { namespace, results: structuredClone(results), metadata, expires: now() + ttlMs })
    return read(`${namespace}:${id}.0`, size)
  }
  function read(cursor, size) {
    size = checkSize(size)
    prune()
    if (typeof cursor !== 'string' || cursor.length > 100) {
      throw new TypeError('Invalid adaptive cursor. Pages are process-local; no search was performed.')
    }
    const s5 = S5_CURSOR.exec(cursor)
    const h1 = s5 ? null : H1_CURSOR.exec(cursor)
    if (!s5 && !h1) {
      throw new TypeError('Invalid or incompatible adaptive cursor: only this process\'s schema-v5 (s5:) and historical (h1:) page cursors are readable. Legacy v3 cursors and the removed s4: cursors are not. No search was performed.')
    }
    const namespace = s5 ? 's5' : 'h1'
    const [, id, offsetText] = s5 ?? h1
    const record = records.get(id)
    if (!record) throw new Error('Screening results expired or were evicted; page cursors are process-local and a saved_result_id is required to restore a snapshot. No search was performed.')
    if (record.namespace !== namespace) throw new TypeError(`Cursor namespace ${namespace} does not match its ${NAMESPACES[record.namespace] ?? 'unknown'} record. No search was performed.`)
    const offset = Number(offsetText)
    if (!Number.isSafeInteger(offset) || offset > record.results.length) throw new TypeError('Screening cursor offset is out of range')
    const warnings = []
    const metadata = boundedMetadata(record.metadata, { historical: namespace === 'h1', warnings })
    const rowBudget = Math.max(1, maxPageBytes - Buffer.byteLength(JSON.stringify(metadata)) - 512)
    const results = []
    let bytes = 0
    // Slice by offset and requested size only: the stored set is never re-capped.
    for (const row of record.results.slice(offset, offset + size)) {
      const length = Buffer.byteLength(JSON.stringify(row))
      if (results.length && bytes + length > rowBudget) break
      results.push(structuredClone(row))
      bytes += length
    }
    const next = offset + results.length
    return {
      ...metadata,
      results,
      totalResults: record.results.length,
      pageResults: results.length,
      nextCursor: next < record.results.length ? `${namespace}:${id}.${next}` : null,
      expiresAt: new Date(record.expires).toISOString(),
      warnings: [
        ...(metadata.warnings ?? []),
        ...warnings,
        ...(bytes > rowBudget ? ['One result exceeds the soft page byte budget after reserving metadata and was returned intact to preserve its URL and reviewed description.'] : []),
      ],
    }
  }
  return {
    read,
    clear() { records.clear() },
    /** New schema-v5 run: complete selected results + typed run metadata. */
    save(results, metadata, size) {
      if (!metadata || metadata.schemaVersion !== ADAPTIVE_SCHEMA_VERSION) throw new TypeError('Schema-v5 run metadata is required to save a page')
      return store('s5', results, structuredClone(metadata), size, [])
    },
    /**
     * Historical snapshot restored read-only from a verified file. `restoration`
     * is generated here from the verified format, never read out of the file.
     * The original result set and metadata are preserved; no v5 field is invented.
     */
    saveHistorical({ results, metadata, originalFormat, originalSchemaVersion = null, savedAt = null }, size) {
      if (typeof originalFormat !== 'string' || !originalFormat.trim()) throw new TypeError('A verified historical format is required to restore a snapshot')
      if (originalSchemaVersion !== null && (typeof originalSchemaVersion !== 'number' || !Number.isFinite(originalSchemaVersion))) throw new TypeError('originalSchemaVersion must be a finite number or null')
      const record = { ...(metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? structuredClone(metadata) : {}) }
      delete record.restoration
      delete record.totalResults
      delete record.pageResults
      delete record.nextCursor
      delete record.expiresAt
      delete record.results
      record.restoration = { historical: true, originalFormat, originalSchemaVersion }
      if (typeof savedAt === 'string' && savedAt) record.savedAt = savedAt
      if (originalSchemaVersion === null) delete record.schemaVersion
      else record.schemaVersion = originalSchemaVersion
      const warnings = [...(Array.isArray(record.warnings) ? record.warnings : []), 'Historical snapshot restored read-only: it was not re-searched, re-screened, re-verified or refreshed, and its original scores, sources and stop reason are shown unchanged.']
      record.warnings = warnings
      return store('h1', results, record, size, [])
    },
  }
}

export const resultPages = createResultPages()
