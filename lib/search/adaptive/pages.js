// Process-local pagination of approved results. No extra search or Jev call.
// There is no per-run result-count cap; execution budgets bound collection.
import { randomUUID } from 'node:crypto'
import { resultKey } from '../results.js'

export const ADAPTIVE_PAGE_SCHEMA = {
  cursor: { type: 'string', minLength: 1, maxLength: 100, description: 'Read the next approved-result page from a previous call. Do not supply tasks or questions with a cursor. No search/Jev calls.' },
  page_size: { type: 'integer', minimum: 1, maximum: 50, description: 'Results per page (default 20, max 50); only page size is capped, not total approved results. Pages also have a soft byte budget; a single oversized entry is returned intact with a warning.' },
}

export function approvedResults(evidence) {
  const byUrl = new Map()
  for (const item of evidence) {
    if (item.status !== 'answer_capable' || !item.assessed || !item.reviewedText) continue
    const key = resultKey(item)
    const score = Math.min(item.judgment?.relevance ?? 0, item.judgment?.states_evidence ?? 0)
    const row = { url: item.url, title: item.title, description: item.reviewedText, score }
    const prior = byUrl.get(key)
    if (!prior || score > prior.score || (score === prior.score && row.description.length > prior.description.length)) byUrl.set(key, row)
  }
  return [...byUrl.values()].sort((a, b) => b.score - a.score || a.url.localeCompare(b.url))
    .map(({ score, ...row }) => row)
}

export function createResultPages({ now = Date.now, ttlMs = 30 * 60_000, maxRuns = 32, maxPageBytes = 45_000 } = {}) {
  const records = new Map()
  const prune = () => {
    for (const [id, record] of records) if (record.expires <= now()) records.delete(id)
  }
  const pageSize = (size = 20) => {
    if (!Number.isInteger(size) || size < 1 || size > 50) throw new Error('page_size must be an integer from 1 to 50')
    return size
  }
  function read(cursor, size) {
    size = pageSize(size)
    prune()
    const match = /^([a-f0-9-]{36})\.(\d{1,10})$/.exec(String(cursor))
    if (!match) throw new Error('Invalid adaptive cursor')
    const record = records.get(match[1])
    if (!record) throw new Error('Adaptive results expired or were evicted; cursors are local to this running server. No search was performed.')
    const offset = Number(match[2])
    if (offset > record.results.length) throw new Error('Adaptive cursor offset is out of range')
    const results = []
    let bytes = 0
    for (const row of record.results.slice(offset, offset + size)) {
      const n = Buffer.byteLength(JSON.stringify(row))
      if (results.length && bytes + n > maxPageBytes) break
      results.push({ ...row })
      bytes += n
    }
    const next = offset + results.length
    return { results, totalResults: record.results.length,
      nextCursor: next < record.results.length ? `${match[1]}.${next}` : null,
      expiresAt: new Date(record.expires).toISOString(),
      coverageComplete: record.coverageComplete, stopReason: record.stopReason,
      warnings: [...record.warnings, ...(bytes > maxPageBytes ? ['One result exceeds the page byte budget and was returned intact to preserve its URL and reviewed description.'] : [])],
    }
  }
  return {
    read,
    save(results, metadata, size) {
      pageSize(size)
      prune()
      while (records.size >= maxRuns) records.delete(records.keys().next().value)
      const id = randomUUID()
      records.set(id, { results: structuredClone(results), ...metadata, expires: now() + ttlMs })
      return read(`${id}.0`, size)
    },
  }
}

export const resultPages = createResultPages()

export function validatePageInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Supply tasks, questions, or a cursor')
  if (Object.keys(input).some((k) => !['tasks', 'questions', 'cursor', 'page_size'].includes(k))) throw new Error('Unknown adaptive input field')
  if (input.page_size !== undefined && (!Number.isInteger(input.page_size) || input.page_size < 1 || input.page_size > 50)) throw new Error('page_size must be an integer from 1 to 50')
  if (input.cursor !== undefined && (input.tasks !== undefined || input.questions !== undefined)) throw new Error('A cursor cannot be combined with tasks or questions')
}
