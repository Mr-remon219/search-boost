// Process-local pagination of approved results. No extra search or Jev call.
// There is no per-run result-count cap; execution budgets bound collection.
import { randomUUID } from 'node:crypto'
import { resultKey } from '../results.js'

export const ADAPTIVE_PAGE_SCHEMA = {
  save_results: { type: 'boolean', description: 'Opt in to a private persistent snapshot of all approved materials and the request summary. Initial question calls only. No credentials or internal model logs are saved. Returns savedResultId for export/recovery after restart; false by default.' },
  saved_result_id: { type: 'string', minLength: 36, maxLength: 36, pattern: '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$', description: 'Read a previously saved research snapshot from this SearchBoost home after restart/eviction. Supply this OR a cursor OR one question, not combinations. No new search/Jev calls; returns a new process-local page cursor.' },
  cursor: { type: 'string', minLength: 1, maxLength: 100, description: 'Read the next approved-result page from a previous call. Do not supply questions, intent, keywords or constraints with a cursor. No search/Jev calls.' },
  page_size: { type: 'integer', minimum: 1, maximum: 50, description: 'Results per page (default 20, max 50); only page size is capped, not total approved results. Pages also have a soft byte budget; a single oversized entry is returned intact with a warning.' },
}

export function approvedResults(evidence) {
  const byUrl = new Map()
  const matches = new Map()
  for (const item of evidence) {
    if (['scope-first-v1', 'explicit-constraints-v2'].includes(item.admissionPolicy) && (item.admitted !== true || item.scope?.route !== 'eligible')) continue
    if (!['answer_capable', 'useful_result'].includes(item.status) || !item.assessed || !item.reviewedText) continue
    const key = resultKey(item)
    const score = item.status === 'useful_result' ? item.valueScore ?? 0 : Math.min(item.judgment?.relevance ?? 0, item.judgment?.states_evidence ?? 0)
    const row = { url: item.url, title: item.title, description: item.reviewedText, score, ...(item.tier ? { tier: item.tier } : {}), ...(item.status === 'useful_result' ? { valueScore: score, directionMatch: item.judgment?.direction_match ?? null, kind: item.kind ?? 'unknown' } : {}) }
    if (item.status === 'useful_result') {
      const targetMatches = matches.get(key) ?? new Map()
      for (const target of item.targets ?? [item]) {
        const identity = JSON.stringify([target.taskId ?? null, target.targetId ?? null, target.canonicalId ?? null])
        const match = { taskId: target.taskId ?? null, targetId: target.targetId ?? target.canonicalId ?? null,
          canonicalId: target.canonicalId ?? null, valueScore: score,
          directionMatch: item.judgment?.direction_match ?? null, kind: item.kind ?? 'unknown' }
        if (!targetMatches.has(identity) || targetMatches.get(identity).valueScore < score) targetMatches.set(identity, match)
      }
      matches.set(key, targetMatches)
    }
    const prior = byUrl.get(key)
    if (!prior || score > prior.score || (score === prior.score && row.description.length > prior.description.length)) byUrl.set(key, row)
  }
  return [...byUrl.values()].sort((a, b) => Number(b.tier === 'focus') - Number(a.tier === 'focus') || b.score - a.score || a.url.localeCompare(b.url))
    .map(({ score, ...row }) => ({ ...row, ...(matches.has(resultKey(row)) ? { matches: [...matches.get(resultKey(row)).values()] } : {}) }))
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
    if (typeof cursor !== 'string' || cursor.length > 100) throw new Error('Invalid adaptive cursor')
    const match = /^([a-f0-9-]{36})\.(\d{1,10})$/.exec(cursor)
    if (!match) throw new Error('Invalid adaptive cursor')
    const record = records.get(match[1])
    if (!record) throw new Error('Adaptive results expired or were evicted; cursors are local to this running server. No search was performed.')
    const offset = Number(match[2])
    if (offset > record.results.length) throw new Error('Adaptive cursor offset is out of range')
    const results = []
    const metadataBytes=Buffer.byteLength(JSON.stringify({keywordProgress:record.keywordProgress,
      inputSummary:record.inputSummary,savedResultId:record.savedResultId,pendingAssessments:record.pendingAssessments,coverageComplete:record.coverageComplete, schemaVersion:record.schemaVersion,retrievalSufficient:record.retrievalSufficient,
      stopReason:record.stopReason,warnings:record.warnings,scopeSummary:record.scopeSummary,finalReview:record.finalReview,convergence:record.convergence,reviewSummary:record.reviewSummary}))+256
    const rowBudget=Math.max(0,maxPageBytes-metadataBytes)
    let bytes = 0
    for (const row of record.results.slice(offset, offset + size)) {
      const n = Buffer.byteLength(JSON.stringify(row))
      if (results.length && bytes + n > rowBudget) break
      results.push(structuredClone(row))
      bytes += n
    }
    const next = offset + results.length
    return { results, totalResults: record.results.length,
      nextCursor: next < record.results.length ? `${match[1]}.${next}` : null,
      expiresAt: new Date(record.expires).toISOString(),
      coverageComplete: record.coverageComplete, stopReason: record.stopReason,
      ...(record.inputSummary ? { inputSummary: structuredClone(record.inputSummary) } : {}),
      ...(record.savedResultId ? { savedResultId: record.savedResultId } : {}),
      ...(record.scopeSummary ? { scopeSummary: structuredClone(record.scopeSummary) } : {}),
      ...(record.convergence ? { convergence: structuredClone(record.convergence) } : {}),
      ...(record.finalReview ? { finalReview: structuredClone(record.finalReview) } : {}),
      ...(record.reviewSummary ? { reviewSummary: structuredClone(record.reviewSummary) } : {}),
      ...(record.schemaVersion === 3 ? { schemaVersion: 3, retrievalSufficient: record.retrievalSufficient === true } : {}),
      ...(record.keywordProgress ? {keywordProgress:structuredClone(record.keywordProgress), pendingAssessments:record.pendingAssessments??0} : {}),
      warnings: [...record.warnings, ...(bytes > rowBudget ? ['One result exceeds the page byte budget after reserving metadata and was returned intact to preserve its URL and reviewed description.'] : [])],
    }
  }
  return {
    read,
    clear() { records.clear() },
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
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Supply exactly one question or a cursor')
  if (Object.keys(input).some((k) => !['questions', 'intent', 'keywords', 'constraints', 'cursor', 'page_size', 'save_results', 'saved_result_id'].includes(k))) throw new Error('Unknown adaptive input field')
  if (input.page_size !== undefined && (!Number.isInteger(input.page_size) || input.page_size < 1 || input.page_size > 50)) throw new Error('page_size must be an integer from 1 to 50')
  if (input.cursor !== undefined && (typeof input.cursor !== 'string' || input.cursor.length < 1 || input.cursor.length > 100)) throw new Error('Invalid adaptive cursor')
  if (input.save_results !== undefined && typeof input.save_results !== 'boolean') throw new Error('save_results must be a boolean')
  if (input.saved_result_id !== undefined && (typeof input.saved_result_id !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(input.saved_result_id))) throw new Error('Invalid saved research result ID')
  if (input.cursor !== undefined || input.saved_result_id !== undefined) {
    if ((input.cursor !== undefined && input.saved_result_id !== undefined) || ['questions', 'intent', 'keywords', 'constraints', 'save_results'].some(k => input[k] !== undefined)) throw new Error('A cursor or saved_result_id cannot be combined with a new question or save_results; supply only cursor OR saved_result_id (optional page_size)')
  }
}
