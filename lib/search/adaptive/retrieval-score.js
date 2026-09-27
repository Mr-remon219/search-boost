// Reading-value selection for the default retrieval controller.
//
// This module scores fragments as POINTERS A MAIN AGENT WANTS TO READ, never as
// proof that a question is fully answered and never as an answer probability.
// A credible navigation pointer and a partial useful excerpt both qualify as
// "useful"; a fragment only has to be worth opening, not complete.
//
//   r = topic relevance          (does the fragment address the topic at all)
//   v = worth-reading usefulness (credible pointer / partial useful excerpt)
//   d = direction match          (does it help the searcher's stated intent)
//   u = min(r, v) * (1 - lambda + lambda * d)   with lambda = .2 when intent
//                                               exists, otherwise lambda = 0
//   m = per-keyword/per-topic contextual relevance, credited only above .5
//   A = max local eligible u * m                (one keyword's own material)
//   F = sum_f w_f * max_i(u_i * m_if)           fixed topic weights normalized
//   R = topic-weighted geometric extra-group credit, rho = .5
//   S = .25*A + .90*F + .10*R                   advisory index only
//
// Unknown is never zero: a missing mandatory value (r, v or injection) fails
// eligibility closed. A missing direction match only loses the direction bonus
// and stays null in the output — it is never read as a successful match.
// d measures usefulness for the intent, never agreement with a desired
// conclusion, so counterevidence can have a high d.
//
// Duplicate content/source groups add no R credit and repeated rounds add no
// credit either: every number is recomputed from the current unique reviewed set.
// A new topic adds F without any document-position decay; only repeated-topic
// extras diminish, geometrically. Site/content grouping is a conservative
// duplicate discount for R only (it may undercount unrelated shared hosts), and
// never removes a document's F contribution.

export const RETRIEVAL_SCORE_WEIGHTS = Object.freeze({ alpha: 0.25, beta: 0.90, gamma: 0.10, rho: 0.5 })
export const RETRIEVAL_DIRECTION_LAMBDA = 0.2

const finite = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null)
const compare = (a, b) => (String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0)

/** A judgement field as a number, or null when it was not established. */
export function scoreField(judgment, field) {
  return finite(judgment?.[field])
}

/** Semantic keyword match m_ik, or null when the answer did not establish it. */
export function keywordMatchOf(judgment, keyword) {
  const entry = (judgment?.keywords ?? []).find((item) => item && item.keyword === keyword)
  return finite(entry?.match)
}

/** Semantic topic match m_if for a caller-supplied topic, or null. */
export function topicMatchOf(judgment, topicId) {
  const entry = (judgment?.topics ?? []).find((item) => item && item.topicId === topicId)
  return finite(entry?.match)
}

/**
 * u = min(r, v) * (1 - lambda + lambda * d).
 * Without intent the direction term disappears; with intent a missing d gets
 * no bonus instead of a fabricated yes.
 */
export function readingValue(judgment, { intentPresent = false, lambda = RETRIEVAL_DIRECTION_LAMBDA } = {}) {
  const relevance = scoreField(judgment, 'relevance')
  const usefulness = scoreField(judgment, 'reading_value')
  if (relevance === null || usefulness === null) return null
  const direction = scoreField(judgment, 'direction_match')
  const factor = intentPresent ? 1 - lambda + lambda * (direction ?? 0) : 1
  return Math.min(relevance, usefulness) * factor
}

/**
 * Eligibility gate: finite known r > .60, finite known v > .50 and known
 * injection <= .7. Explicit date checks are applied by the caller on top.
 */
export function usefulEligible(judgment, thresholds = {}) {
  const relevance = scoreField(judgment, 'relevance')
  const usefulness = scoreField(judgment, 'reading_value')
  const injection = scoreField(judgment, 'injection')
  return relevance !== null && usefulness !== null && injection !== null
    && relevance > (thresholds.relevance ?? 0.60)
    && usefulness > (thresholds.readingValue ?? 0.50)
    && injection <= (thresholds.injection ?? 0.7)
}

/**
 * One keyword's reading index over the current eligible rows of one target.
 *
 * @param {{
 *   keyword: string,
 *   rows?: Array<{ evidenceId: string, text?: string, judgment: any }>,
 *   topics?: Array<{ id: string, weight?: number, match?: (row: any) => number | null }>,
 *   intentPresent?: boolean,
 *   thresholds?: Record<string, number>,
 *   weights?: typeof RETRIEVAL_SCORE_WEIGHTS,
 *   groups?: Map<any, string|number> | null,
 *   lambda?: number,
 * }} input
 */
export function retrievalScore({ keyword, rows = [], topics = [], intentPresent = false, thresholds = {},
  weights = RETRIEVAL_SCORE_WEIGHTS, groups = null, lambda = RETRIEVAL_DIRECTION_LAMBDA } = {}) {
  const { alpha, beta, gamma, rho } = weights
  if (![alpha, beta, gamma, rho].every(Number.isFinite) || alpha < 0 || beta < 0 || gamma < 0 || rho <= 0 || rho >= 1
    || alpha + gamma >= 1 || alpha + beta <= 1) throw new Error('Invalid retrieval-score weights')
  const matchFloor = thresholds.keywordMatch ?? 0.5
  const scored = []
  for (const row of rows) {
    if (!row?.text || !row.evidenceId) continue
    if (!usefulEligible(row.judgment, thresholds)) continue
    const u = readingValue(row.judgment, { intentPresent, lambda })
    if (u === null) continue
    scored.push({ row, u })
  }
  const local = scored
    .map((item) => ({ ...item, match: keywordMatchOf(item.row.judgment, keyword) }))
    .filter((item) => item.match !== null && item.match > matchFloor)
    .map((item) => ({ ...item, quality: item.u * item.match }))
  // Caller-supplied topics are scored by their own typed match. With no caller
  // topic the keyword itself is the topic, so F reproduces A instead of
  // inventing acceptance facts the caller never supplied.
  const topicList = topics.length
    ? topics.map((topic) => ({ id: topic.id, weight: topic.weight, match: topic.match ?? ((row) => topicMatchOf(row.judgment, topic.id)) }))
    : [{ id: `keyword:${keyword}`, weight: 1, match: (row) => keywordMatchOf(row.judgment, keyword) }]
  const creditable = (value) => (value !== null && value > matchFloor ? value : null)
  const topicTotal = topicList.reduce((sum, topic) => sum + (Number.isFinite(topic.weight) && topic.weight > 0 ? topic.weight : 0), 0)
  let F = 0
  if (topicTotal > 0) {
    for (const topic of topicList) {
      const weight = (Number.isFinite(topic.weight) && topic.weight > 0 ? topic.weight : 0) / topicTotal
      if (!weight) continue
      let best = 0
      for (const { row, u } of scored) {
        const match = creditable(topic.match(row))
        if (match !== null) best = Math.max(best, u * match)
      }
      F += weight * best
    }
  }
  const A = local.length ? Math.max(...local.map((item) => item.quality)) : 0
  // One best row per content/source group: duplicates and repeated rounds add
  // no credit, and only the extra groups (beyond the first, already reflected
  // in A) receive geometric supplementary-value credit.
  const grouped = new Map()
  for (const item of local) {
    const group = groups?.get(item.row) ?? `row:${item.row.evidenceId}`
    const prior = grouped.get(group)
    if (!prior || item.quality > prior.quality || (item.quality === prior.quality && compare(item.row.evidenceId, prior.row.evidenceId) < 0)) grouped.set(group, item)
  }
  // Supplement only repeated coverage of the SAME topic. A first result for a
  // new topic earns its full F contribution, not a decayed repetition bonus.
  let R = 0
  if (topicTotal > 0) for (const topic of topicList) {
    const weight = (Number.isFinite(topic.weight) && topic.weight > 0 ? topic.weight : 0) / topicTotal
    if (!weight) continue
    const repeated = new Map()
    for (const item of local) {
      const match = creditable(topic.match(item.row))
      if (match === null) continue
      const quality = item.u * Math.min(item.match, match)
      const group = groups?.get(item.row) ?? `row:${item.row.evidenceId}`
      repeated.set(group, Math.max(repeated.get(group) ?? 0, quality))
    }
    const qualities = [...repeated.values()].sort((a, b) => b - a)
    R += weight * qualities.slice(1).reduce((sum, quality, i) => sum + (1 - rho) * rho ** i * quality, 0)
  }
  return {
    keyword,
    score: alpha * A + beta * F + gamma * R,
    A, F, R,
    distinct: grouped.size,
    eligible: local.length,
    usefulness: local.length ? Math.max(...local.map((item) => item.u)) : 0,
    match: local.length ? Math.max(...local.map((item) => item.match)) : null,
  }
}
