// Candidate snapshot + eligibility gate + ranking for the screening prototype.
// Pure code: no network, no Jev calls inside admitAndRank. The orchestration
// helper (runScreening) packs judgement batches to the existing wire limits and
// dispatches them through an injected judge function, so tests and any future
// runtime share one path; a failed batch keeps everything already decided.
import { resultKey } from '../results.js'
import { screeningScore, validateParams, DEFAULT_SCREENING_PARAMS, SCREENING_POLICY_VERSION } from './scoring.js'
import { validateSourceBiasPolicy, NEUTRAL_SOURCE_BIAS_POLICY, VALUE_LABELS, INFO_OPTIONS, normalizePreferenceMatches } from './policy.js'
import { foldsInto, textShingles, shingleOverlap } from './duplicates.js'
import { buildScreeningRequest, decodeScreening, JUDGEMENT_POLICY_VERSION } from './judgments.js'
import { requestFits } from '../adaptive/material.js'
import { ADAPTIVE_LIMITS } from '../adaptive/limits.js'

/** Wire-size cap for a rescued text. The reader owns MIME/binary/length
 * screening; the controller caps what can enter a judgement request. */
const RESCUE_TEXT_LIMIT = 20000

const hasText = (value) => typeof value === 'string' && value.trim().length > 0
const materialText = (row) => hasText(row.content) ? row.content : (row.snippet ?? '')
const MATERIAL_FIELDS = ['url', 'title', 'domain', 'published', 'content', 'snippet', 'textVersion']
// Choose one complete observation: page content first, then longer text, then
// a stable lexical tie-break over the text and metadata. Never splice a new
// excerpt into another observation's version/date/title.
const materialKey = (row) => JSON.stringify([materialText(row), ...MATERIAL_FIELDS.map((key) => row[key] ?? null)])
function preferMaterial(incoming, prior) {
  const kind = Number(hasText(incoming.content)) - Number(hasText(prior.content))
  if (kind) return kind > 0
  const length = materialText(incoming).length - materialText(prior).length
  return length ? length > 0 : materialKey(incoming) < materialKey(prior)
}
function resultLimit(maxResults) {
  if (!Number.isSafeInteger(maxResults) || maxResults < 1) throw new RangeError('maxResults must be a positive integer')
  return maxResults
}

/** Safety states ordered by restrictiveness. A merged URL reports the WORST
 * state of the rows it merges, so merge order can never upgrade a violation or
 * an unverified text to `clear` (previously `content ||= row.content` delivered
 * a violation body under the first row's clearance). Unknown states are
 * `unavailable`. */
const SAFETY_RANK = Object.freeze({ clear: 0, unavailable: 1, violation: 2 })
const safetyOf = (row) => (typeof row?.safetyState === 'string' && Object.hasOwn(SAFETY_RANK, row.safetyState) ? row.safetyState : 'unavailable')
const worstSafety = (left, right) => (SAFETY_RANK[right] > SAFETY_RANK[left] ? right : left)

/**
 * Snapshot the fused candidate pool: one row per canonical URL, original fused
 * score as B, full provenance preserved. Order is deterministic (score desc,
 * then resultKey) so replays do not depend on engine completion order.
 *
 * `engineWeights` (the resolved route weights) restricts provenance to engines
 * that actually contributed a POSITIVE amount to the fused score. Without it a
 * zero-weight engine that merely returned a rank record would still widen this
 * candidate's source-policy eligibility; the runtime integration must pass it.
 */
export function buildSnapshot(rows, { engineWeights = null } = {}) {
  if (!Array.isArray(rows)) throw new TypeError('rows must be an array')
  const weighted = engineWeights !== null
  if (weighted && (typeof engineWeights !== 'object' || Array.isArray(engineWeights))) throw new TypeError('engineWeights must be an object of engine -> number')
  const byKey = new Map()
  for (const row of rows) {
    if (!row || typeof row.url !== 'string') continue
    // Contributing engines: observed ranks plus any explicit `engines`, kept only
    // when the resolved route weight is positive. A zero-weight engine never
    // reached the fused score, so it must not widen policy eligibility — nor
    // stay visible in provenance, which would contradict the recorded basis.
    const observed = new Set([...Object.keys(row.engineRanks ?? {}), ...(row.engines ?? [])])
    const contributors = [...observed].filter((engine) => !weighted || (Number.isFinite(engineWeights[engine]) && engineWeights[engine] > 0))
    const key = resultKey(row)
    const incoming = {
      ...row, key,
      engineRanks: Object.fromEntries(Object.entries(row.engineRanks ?? {}).filter(([engine]) => contributors.includes(engine))),
      provenance: [...(row.provenance ?? [])].filter((entry) => !weighted || !entry?.engine || contributors.includes(entry.engine)),
      contributors: new Set(contributors),
      safetyState: safetyOf(row),
    }
    const prior = byKey.get(key)
    if (!prior) {
      byKey.set(key, incoming)
      continue
    }
    for (const [engine, rank] of Object.entries(incoming.engineRanks)) prior.engineRanks[engine] = Math.min(prior.engineRanks[engine] ?? Infinity, rank)
    prior.provenance.push(...incoming.provenance)
    for (const engine of incoming.contributors) prior.contributors.add(engine)
    if (!(Number.isFinite(prior.score) && prior.score > 0)
      || (Number.isFinite(incoming.score) && incoming.score > prior.score)
      || (incoming.score === prior.score && String(incoming.scoreVersion ?? '') < String(prior.scoreVersion ?? ''))) {
      prior.score = incoming.score
      prior.scoreVersion = incoming.scoreVersion ?? null
    }
    if (preferMaterial(incoming, prior)) {
      for (const field of MATERIAL_FIELDS) prior[field] = incoming[field]
    }
    prior.safetyState = worstSafety(prior.safetyState, incoming.safetyState)
  }
  return [...byKey.values()]
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || a.key.localeCompare(b.key))
    .map((row, index) => ({
      evidenceId: `m${index + 1}`,
      assocId: `a${index + 1}`,
      questionId: 'q1',
      key: row.key,
      url: row.url,
      title: row.title ?? row.url,
      domain: row.domain ?? null,
      published: row.published ?? null,
      text: materialText(row).slice(0, 8000),
      basis: hasText(row.content) ? 'page_content' : 'engine_snippet',
      textVersion: row.textVersion ?? null,
      scoreVersion: row.scoreVersion ?? null,
      baseScore: row.score,
      engines: [...(row.contributors ?? new Set(Object.keys(row.engineRanks ?? {})))].sort(),
      engineRanks: row.engineRanks,
      provenance: row.provenance,
      provenanceBasis: weighted ? 'positive_weight_contributors' : 'observed_ranks',
      safetyState: row.safetyState,
    }))
}

// Both independently answered fields must establish compliance. Missing info
// is unavailable; contradictory valid answers are not resolved toward admission.
function scopeReason(judgement) {
  const state = judgement.scope?.state
  const info = judgement.info
  if (state === 'unavailable' || !INFO_OPTIONS.includes(info)) return 'scope_unavailable'
  if (state === 'pass') {
    if (info === 'explicit_conflict') return 'scope_explicit_conflict'
    return info === 'established' ? null : 'scope_inconsistent'
  }
  return info === 'established' ? 'scope_inconsistent' : 'scope_not_established'
}

/** Truncated count of every disposition, so the identity
 * Σ(reasons) + qualityAssessed === collected always holds. */
const REASON_COUNTER = Object.freeze({
  pending: 'pending',
  safety_rejected: 'safetyRejected',
  safety_unavailable: 'safetyUnavailable',
  scope_not_established: 'scopeNotEstablished',
  scope_explicit_conflict: 'scopeExplicitConflict',
  scope_inconsistent: 'scopeInconsistent',
  scope_unavailable: 'scopeUnavailable',
  value_unavailable: 'assessmentUnavailable',
  value_unestablished: 'valueUnestablished',
  value_filtered: 'valueFiltered',
  base_score_missing: 'baseScoreMissing',
  request_too_large: 'requestTooLarge',
  judgement_unavailable: 'judgementUnavailable',
})

/**
 * Eligibility gate then ranking. Constraints are hard: no bonus ever overrides
 * them. Unknowns stay unknown (never a pass, never a low value level).
 *
 * `unassessable` maps evidenceId -> reason for candidates the orchestrator could
 * not judge (oversized request, failed batch); those become disclosed
 * dispositions instead of a vague `pending`.
 *
 * Selection keeps `finalScore` immutable and applies the soft redundancy
 * penalty per round against the items already chosen, like the native list
 * selector. `mu = 0` (default) reduces to ordering by `finalScore`.
 */
export function admitAndRank({ candidates, judgements, preferences = [], constraints = [], params = DEFAULT_SCREENING_PARAMS, policy = NEUTRAL_SOURCE_BIAS_POLICY, maxResults = 8, mu, dedupe = false, unassessable = {} } = {}) {
  if (!Array.isArray(candidates)) throw new TypeError('candidates must be an array')
  const p = validateParams(mu === undefined ? params : { ...params, mu })
  const limit = resultLimit(maxResults)
  const unassessableReasons = unassessable instanceof Map ? unassessable : new Map(Object.entries(unassessable ?? {}))
  const sourcePolicy = validateSourceBiasPolicy(policy)
  const preferenceTexts = [...new Set((preferences ?? []).map((text) => String(text).trim()).filter(Boolean))]
  const expectedMatches = preferenceTexts.length
  const diagnostics = {
    collected: candidates.length, pending: 0, safetyRejected: 0, safetyUnavailable: 0,
    scopePassed: 0, scopeNotEstablished: 0, scopeUnavailable: 0, scopeExplicitConflict: 0, scopeInconsistent: 0,
    qualityAssessed: 0, valueFiltered: 0, valueUnestablished: 0, assessmentUnavailable: 0,
    baseScoreMissing: 0, requestTooLarge: 0, judgementUnavailable: 0,
    selected: 0, valueCounts: { 3: 0, 4: 0, 5: 0 },
    rescueAttempted: 0, rescueRecovered: 0, duplicatesFolded: 0,
  }
  const admitted = []
  const decisions = []
  for (const candidate of candidates) {
    const judgement = judgements?.get(candidate.evidenceId)
    let reason = null
    let scopeEstablished = false
    // Disposition order: terminal code facts first (they hold even with no Jev
    // judgement), then "not yet processed", then judgement-dependent gates.
    if (candidate.safetyState === 'violation') reason = 'safety_rejected'
    else if (!(Number.isFinite(candidate.baseScore) && candidate.baseScore > 0)) reason = 'base_score_missing'
    else if (!judgement && unassessableReasons.has(candidate.evidenceId)) reason = unassessableReasons.get(candidate.evidenceId)
    else if (!judgement) reason = 'pending'
    else if (candidate.safetyState !== 'clear') reason = 'safety_unavailable'
    else if (constraints.length) {
      reason = scopeReason(judgement)
      scopeEstablished = reason === null
    }
    if (!reason) {
      if (judgement.value.state === 'unavailable') reason = 'value_unavailable'
      else if (judgement.value.state === 'unestablished') reason = 'value_unestablished'
      else if (judgement.value.level < 3) reason = 'value_filtered'
    }
    if (scopeEstablished) diagnostics.scopePassed++
    if (reason) {
      decisions.push({ evidenceId: candidate.evidenceId, url: candidate.url, admitted: false, reason, info: judgement?.info ?? null })
      const counter = REASON_COUNTER[reason]
      if (counter) diagnostics[counter]++
      else diagnostics.baseScoreMissing++
      continue
    }
    diagnostics.qualityAssessed++
    const discount = judgement.discount.option ?? 'unknown'
    let matches
    try {
      matches = normalizePreferenceMatches(judgement.preferences.length ? judgement.preferences : [], expectedMatches)
    } catch {
      matches = Array.from({ length: expectedMatches }, () => 'unknown')
    }
    const score = screeningScore({
      baseScore: candidate.baseScore, valueLevel: judgement.value.level,
      discount, preferenceMatches: matches, redundancy: 0,
    }, p)
    admitted.push({ candidate, judgement, matches, discount, score })
  }
  admitted.sort((a, b) => b.score.finalScore - a.score.finalScore
    || b.candidate.baseScore - a.candidate.baseScore
    || a.candidate.key.localeCompare(b.candidate.key))
  // Near-duplicate folding is EXPERIMENTAL and OFF by default: the heuristic is
  // validated only in-sample against the frozen ablation fixture and can merge
  // independent pages that share a slug and title. Callers opt in explicitly.
  let pool = admitted
  if (dedupe) {
    const kept = []
    for (const item of admitted) {
      const representative = kept.find((k) => foldsInto(item.candidate, k.candidate) || foldsInto(k.candidate, item.candidate))
      if (representative) {
        diagnostics.duplicatesFolded++
        decisions.push({ evidenceId: item.candidate.evidenceId, url: item.candidate.url, admitted: true, selected: false, reason: 'near_duplicate', duplicateOf: representative.candidate.evidenceId })
      } else kept.push(item)
    }
    pool = kept
  }
  // Soft redundancy is a selection-time penalty: only already-selected rows
  // affect the next pick, and `finalScore` is never rewritten. With mu = 0 the
  // greedy loop below reproduces plain final-score order.
  let selected
  if (p.mu > 0) {
    const remaining = [...pool]
    const shingles = new Map(pool.map((item) => [item.candidate.evidenceId, textShingles(item.candidate)]))
    selected = []
    while (remaining.length && selected.length < limit) {
      let bestIndex = 0, bestScore = -Infinity, bestRedundancy = 0
      for (const [index, item] of remaining.entries()) {
        let redundancy = 0
        for (const chosen of selected) {
          const value = shingleOverlap(shingles.get(item.candidate.evidenceId), shingles.get(chosen.candidate.evidenceId))
          if (value > redundancy) redundancy = value
        }
        const selectionScore = item.score.finalScore - p.mu * redundancy
        if (selectionScore > bestScore) { bestIndex = index; bestScore = selectionScore; bestRedundancy = redundancy }
      }
      const [chosen] = remaining.splice(bestIndex, 1)
      selected.push({ ...chosen, redundancy: bestRedundancy, selectionScore: bestScore })
    }
  } else {
    selected = pool.slice(0, limit).map((item) => ({ ...item, redundancy: 0, selectionScore: item.score.finalScore }))
  }
  const results = selected.map(({ candidate, judgement, matches, discount, score, redundancy, selectionScore }, index) => ({
    id: `r${index + 1}`,
    evidenceId: candidate.evidenceId,
    url: candidate.url,
    title: candidate.title,
    description: candidate.text,
    basis: candidate.basis ?? null,
    published: candidate.published ?? null,
    textVersion: candidate.textVersion ?? null,
    scoreVersion: candidate.scoreVersion ?? null,
    safetyState: candidate.safetyState ?? null,
    engineRanks: candidate.engineRanks ?? null,
    valueLevel: judgement.value.level,
    valueLabel: VALUE_LABELS[judgement.value.level],
    fusionScore: candidate.baseScore,
    baseNormalized: score.baseNormalized,
    valueUtility: score.valueUtility,
    baseContribution: score.baseContribution,
    valueContribution: score.valueContribution,
    sourceDiscount: discount,
    sourceDiscountFactor: score.sourceDiscountFactor,
    sourcePenalty: score.sourcePenalty,
    sourceDiscountSelectedBy: judgement.discount.selectedBy ?? null,
    preferenceMatches: matches,
    preferenceBonus: score.preferenceBonus,
    finalScore: score.finalScore,
    redundancy,
    selectionScore,
    engines: candidate.engines ?? [],
    // Decoded confidence values, recorded for audit only: they never enter the
    // value level, the score, an admission gate or a rescue trigger.
    signals: {
      valueConfidence: judgement.valueConfidence ?? null,
      infoConfidence: judgement.infoConfidence ?? null,
      discountConfidence: judgement.discountConfidence ?? null,
    },
  }))
  diagnostics.selected = results.length
  for (const result of results) diagnostics.valueCounts[result.valueLevel]++
  const valueGroups = { 3: [], 4: [], 5: [] }
  for (const result of results) valueGroups[result.valueLevel].push(result.id)
  // The pure ranking helper reports only what it knows: it is incomplete while a
  // candidate still has no judgement, and it is also incomplete when a candidate
  // WAS dispatched but no usable assessment came back (an empty or invalid answer
  // map is a real client outcome, not proof that the pool held nothing else).
  const pending = diagnostics.pending
  const unassessed = diagnostics.requestTooLarge + diagnostics.judgementUnavailable
    + diagnostics.assessmentUnavailable + diagnostics.scopeUnavailable
  const incomplete = pending > 0 || unassessed > 0
  return {
    policyVersion: SCREENING_POLICY_VERSION,
    judgementPolicyVersion: JUDGEMENT_POLICY_VERSION,
    sourceBiasPolicyVersion: sourcePolicy.version,
    params: { tau: p.tau, lambda: p.lambda, utilities: p.utilities, discountFactors: p.discountFactors, preferenceMatchValues: p.preferenceMatchValues, epsilon: p.epsilon, mu: p.mu },
    results,
    valueGroups,
    decisions,
    selection: {
      requested: limit,
      returned: results.length,
      targetMet: results.length >= limit,
      stopReason: results.length >= limit ? 'target_met'
        : pending > 0 ? 'pending_candidates'
          : unassessed > 0 ? 'unassessable_material'
            : 'candidate_pool_exhausted',
      incomplete,
    },
    diagnostics,
  }
}

/**
 * Size-bounded packing: `batchSize` is an upper bound and the serialized wire
 * envelope is the real limit (lib/search/adaptive/material.js `requestFits`,
 * whose thresholds come from lib/search/adaptive/limits.js). Every candidate
 * keeps its complete question set; a candidate that cannot fit even alone is
 * reported through `onOversized` instead of raising or vanishing.
 */
function packBatches(candidates, build, limits, batchSize, onOversized) {
  const batches = []
  let members = []
  let request = null
  const flush = () => {
    if (members.length) batches.push({ members, request })
    members = []
    request = null
  }
  for (const candidate of candidates) {
    if (members.length >= batchSize) flush()
    const attemptMembers = members.length ? [...members, candidate] : [candidate]
    const attempt = build(attemptMembers)
    if (requestFits(attempt, limits)) {
      members = attemptMembers
      request = attempt
      continue
    }
    if (!members.length) {
      onOversized(candidate.evidenceId)
      continue
    }
    flush()
    const single = build([candidate])
    if (requestFits(single, limits)) {
      members = [candidate]
      request = single
    } else onOversized(candidate.evidenceId)
  }
  flush()
  return batches
}

/** A rescue target must be blocked by MISSING information while still being
 * deliverable in principle: same URL, once, and only for a candidate that is
 * not already decided unsafe, scoreless or explicitly conflicting.
 * `valueUnknown` additionally allows a scope-established candidate whose value
 * is still unestablished (documented as an explicit, opt-in extension). */
function rescueEligible(candidate, judgement, hasConstraints, valueUnknown) {
  if (!judgement) return false
  if (candidate.safetyState !== 'clear' || !(Number.isFinite(candidate.baseScore) && candidate.baseScore > 0)) return false
  if (hasConstraints && judgement.scope.state === 'not_passed' && judgement.info === 'insufficient_information') return 'scope_information'
  if (valueUnknown && judgement.info !== 'explicit_conflict' && (!hasConstraints || scopeReason(judgement) === null) && judgement.value.state === 'unestablished') return 'value_unestablished'
  return false
}

/**
 * Bounded batch orchestration over an injected `judge(request)`. Optional
 * `rescueRead(candidate)` re-reads the SAME candidate once, never a new URL; the
 * rescued text is a new text version that must carry its own `safetyState`.
 *
 * Failure, cancellation and deadline behaviour: a failed judge batch or read
 * never discards the judgements already collected, the run record says what
 * stopped the work, and an already-aborted signal performs no work at all.
 */
export async function runScreening({
  candidates, question, intent, constraints = [], preferences = [], policy = NEUTRAL_SOURCE_BIAS_POLICY,
  params = DEFAULT_SCREENING_PARAMS, maxResults = 8, batchSize = 8, judge, rescue, rescueRead, dedupe = false,
  signal, deadlineMs, limits,
} = {}) {
  if (!Array.isArray(candidates)) throw new TypeError('candidates must be an array')
  if (typeof judge !== 'function') throw new TypeError('judge must be a function')
  const text = typeof question === 'string' ? question : question?.text
  const nestedIntent = typeof question === 'object' && question !== null ? question.intent : undefined
  if (intent !== undefined && nestedIntent !== undefined && intent !== nestedIntent) throw new TypeError('Conflicting intent inputs')
  const resolvedIntent = intent ?? nestedIntent
  if (typeof text !== 'string' || !text.trim()) throw new TypeError('question text is required')
  if (typeof resolvedIntent !== 'string' || !resolvedIntent.trim()) throw new TypeError('intent is required')
  // Reject invalid caller configuration before any potentially paid operation.
  const checkedParams = validateParams(params)
  const checkedMaxResults = resultLimit(maxResults)
  const sourcePolicy = validateSourceBiasPolicy(policy)
  const preferenceTexts = [...new Set((preferences ?? []).map((text) => String(text).trim()).filter(Boolean))]
  const sizeLimits = {
    maxStateChars: Number.isFinite(limits?.maxStateChars) ? limits.maxStateChars : ADAPTIVE_LIMITS.maxStateChars,
    maxRequestChars: Number.isFinite(limits?.maxRequestChars) ? limits.maxRequestChars : ADAPTIVE_LIMITS.maxRequestChars,
  }
  const startedAt = Date.now()
  const deadlineAt = Number.isFinite(deadlineMs) && deadlineMs > 0 ? startedAt + deadlineMs : null
  const haltReason = () => signal?.aborted ? 'cancelled' : deadlineAt !== null && Date.now() >= deadlineAt ? 'deadline' : null
  const judgements = new Map()
  const original = new Map()
  const unassessable = new Map()
  const effective = new Map()
  const judgeFailedIds = []
  const counters = { judgeCalls: 0, judgeFailures: 0, rescueAttempted: 0, rescueReadFailed: 0, rescueTooLarge: 0, rescueJudgeFailed: 0, rescueScopeRecovered: 0, rescueValueRecovered: 0, rescuedIds: new Set(), rescuePlan: [] }
  let halted = haltReason()
  const build = (members) => buildScreeningRequest({ text, intent: resolvedIntent }, members, {
    constraints, preferences: preferenceTexts, policy: sourcePolicy,
  })
  const dispatch = async (members, request) => {
    counters.judgeCalls++
    const decoded = decodeScreening(await judge(request), request.mapping)
    for (const [evidenceId, judgement] of decoded) {
      // Keep the pre-reread judgement so recovery counters compare like with like.
      if (judgements.has(evidenceId) && !original.has(evidenceId)) original.set(evidenceId, judgements.get(evidenceId))
      judgements.set(evidenceId, judgement)
    }
  }
  // Terminal code facts never reach the judge: a safety-blocked, safety-unverified
  // or scoreless candidate cannot become deliverable in this run, so its material
  // would only enlarge the request and its questions could never change the outcome.
  // Skipped candidates still receive their real disposition through the gate below.
  const judgeable = []
  for (const candidate of candidates) {
    if (!candidate || !Number.isFinite(candidate.baseScore) || candidate.baseScore <= 0) continue
    if (candidate.safetyState === 'violation') continue
    if (candidate.safetyState !== 'clear') {
      unassessable.set(candidate.evidenceId, 'safety_unavailable')
      continue
    }
    judgeable.push(candidate)
  }
  const batches = packBatches(judgeable, build, sizeLimits, Math.max(1, Math.trunc(batchSize) || 8),
    (evidenceId) => unassessable.set(evidenceId, 'request_too_large'))
  for (const batch of batches) {
    if (halted) break
    const stop = haltReason()
    if (stop) { halted = stop; break }
    try {
      await dispatch(batch.members, batch.request)
    } catch {
      counters.judgeFailures++
      for (const member of batch.members) {
        judgeFailedIds.push(member.evidenceId)
        unassessable.set(member.evidenceId, 'judgement_unavailable')
      }
      halted = haltReason() ?? 'judge_failure'
      break
    } finally {
      halted ??= haltReason()
    }
  }
  const rescueBudget = rescue?.maxReads ?? 0
  if (rescueBudget > 0 && !halted && typeof rescueRead === 'function') {
    const hasConstraints = constraints.length > 0
    const eligible = judgeable
      .map((candidate) => ({ candidate, blockedBy: rescueEligible(candidate, judgements.get(candidate.evidenceId), hasConstraints, rescue?.valueUnknown === true) }))
      .filter((entry) => entry.blockedBy)
      // Read priority proxy: the fused base score says which material is most
      // likely to change delivery; ties prefer a condition blocked only by
      // missing information, then stay deterministic by id.
      .sort((a, b) => b.candidate.baseScore - a.candidate.baseScore
        || (a.blockedBy === 'scope_information' ? 0 : 1) - (b.blockedBy === 'scope_information' ? 0 : 1)
        || a.candidate.evidenceId.localeCompare(b.candidate.evidenceId))
      .slice(0, rescueBudget)
    counters.rescuePlan = eligible.map((entry) => entry.candidate.evidenceId)
    for (const { candidate } of eligible) {
      const stop = haltReason()
      if (stop) { halted = stop; break }
      counters.rescueAttempted++
      counters.rescuedIds.add(candidate.evidenceId)
      let read = null
      try {
        read = await rescueRead(candidate)
      } catch {
        read = null
      }
      // Check even when the reader threw or returned empty/oversized material:
      // the last operation has no next loop iteration to disclose its stop.
      halted ??= haltReason()
      if (halted) break
      if (typeof read?.text !== 'string' || !read.text.trim()) {
        counters.rescueReadFailed++
        continue
      }
      const reread = {
        ...candidate,
        text: String(read.text).slice(0, RESCUE_TEXT_LIMIT),
        basis: read.basis ?? 'rescued_content',
        textVersion: read.textVersion ?? null,
        safetyState: read.safetyState ?? 'unavailable',
      }
      // The rescue dispatch goes through the same envelope check as a batch: an
      // oversized reread is never sent, and the candidate keeps the text and
      // judgement it already had instead of shipping one with the other.
      const rereadRequest = build([reread])
      if (!requestFits(rereadRequest, sizeLimits)) {
        counters.rescueTooLarge++
        continue
      }
      const afterRead = haltReason()
      if (afterRead) { halted = afterRead; break }
      effective.set(candidate.evidenceId, reread)
      try {
        await dispatch([reread], rereadRequest)
      } catch {
        counters.judgeFailures++
        counters.rescueJudgeFailed++
        judgeFailedIds.push(candidate.evidenceId)
        // The pre-read judgement stays valid for the pre-read text: drop the
        // reread so the delivered text and its judgement stay the same version.
        effective.delete(candidate.evidenceId)
        halted = haltReason() ?? 'judge_failure'
        break
      } finally {
        halted ??= haltReason()
      }
      const after = judgements.get(candidate.evidenceId)
      const before = original.get(candidate.evidenceId)
      if (after && before && hasConstraints && scopeReason(before) !== null && scopeReason(after) === null) counters.rescueScopeRecovered++
      if (after && before && before.value.state !== 'level' && after.value.state === 'level') counters.rescueValueRecovered++
    }
  }
  const artifact = admitAndRank({
    candidates: candidates.map((candidate) => effective.get(candidate?.evidenceId) ?? candidate),
    judgements, preferences: preferenceTexts, constraints, params: checkedParams, policy: sourcePolicy, maxResults: checkedMaxResults, dedupe, unassessable,
  })
  artifact.diagnostics.rescueAttempted = counters.rescueAttempted
  artifact.diagnostics.rescueReadFailed = counters.rescueReadFailed
  artifact.diagnostics.rescueTooLarge = counters.rescueTooLarge
  artifact.diagnostics.rescueJudgeFailed = counters.rescueJudgeFailed
  artifact.diagnostics.rescueScopeRecovered = counters.rescueScopeRecovered
  artifact.diagnostics.rescueValueRecovered = counters.rescueValueRecovered
  // Recovery is restored eligibility, before maxResults/deduplication selection.
  const rejected = new Set(artifact.decisions.filter((d) => d.admitted === false).map((d) => d.evidenceId))
  artifact.diagnostics.rescueRecovered = [...effective.keys()].filter((id) => !rejected.has(id)).length
  artifact.diagnostics.judgeCalls = counters.judgeCalls
  halted ??= haltReason()
  artifact.run = {
    halted,
    judgeFailures: counters.judgeFailures,
    judgeFailedIds,
    unassessable: [...unassessable].map(([evidenceId, reason]) => ({ evidenceId, reason })),
    rescuePlan: counters.rescuePlan,
    batches: batches.length,
    limits: sizeLimits,
  }
  if (halted) {
    artifact.selection.incomplete = true
    if (!artifact.selection.targetMet) artifact.selection.stopReason = halted
  }
  return artifact
}
