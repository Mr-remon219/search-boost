// Single-target research retrieval: PLAN -> SEARCH -> SCOPE_JUDGE ->
// SOURCE_JUDGE -> current per-keyword admission -> RETRIEVAL_FINAL. Scope and
// quality are separate HTTP phases streamed in bounded batches. Unknown scope
// may receive a bounded new-material page read; rejected rows never get quality
// questions. A final review may return the set or reopen a focused research gap.
//
// All scoring, output and stopping use current qualified material. Direction is
// a hard gate, constraints never average away, and counts are recomputed rather
// than incremented historically. The final judgement is retrieval readiness,
// NOT an answer-completeness or truth claim. The main agent owns the answer.
//
// Budgets are reserved before dispatch, material/metadata changes invalidate
// scope and quality, and missing judgements or failures never imply absence.
// I/O is injected; no recursive Jev calls or imports from the runtime.
//
// Frozen V2 (retrievalMode:false / keywordAccumulation:false) and pre-scope V3
// (scopeFirst:false) remain INTERNAL offline comparisons only. Public schemas
// and the runtime expose one question, intent, keywords and explicit constraints.

import { estimateJevTokens, JEV_ERROR_KINDS, JEV_FATAL_KINDS, JevError } from '../../jev/client.mjs'
import { readChoice, readNoul, routeNoul, selectedChoiceProbability } from '../../jev/questions.js'
import { resultKey } from '../results.js'
import { factUnits, topicUnits } from './facts.js'
import { scoreEvidence, nextPoolLimit, keywordList, contentGroups } from './keyword-progress.js'
import { normalizeAdaptiveInput, canonicalTargets } from './input.js'
import { normalizeLegacyAdaptiveInput } from './legacy-input.js'
import { currentScope, readScope, scopeJudgeRequest, scopeVersion, SCOPE_POLICY_VERSION } from './scope.js'
import { retrievalFinalRequest, finalDecisionEstablished, finalMaterialKey } from './retrieval-final.js'
import { requestFits } from './material.js'
import { queryCandidates, addQueryChoices, researchQueryCandidates, queryPlanRequest } from './planning.js'
import { dateWindow, inspectDates } from './temporal.js'
import { countWords, pool as runPool } from '../text.js'
import { engineBrief, engineCandidates } from './engine-brief.js'
import { createEvidencePool } from './evidence.js'
import { ADAPTIVE_LIMITS, ADAPTIVE_THRESHOLDS, retrievalModeEnabled } from './limits.js'
import { keywordMatchOf, readingValue, retrievalScore, RETRIEVAL_SCORE_WEIGHTS, scoreField, usefulEligible, materialTier } from './retrieval-score.js'
import { coverageRequest, explicitTokens, factBundleRequest, keywordContinuationRequests, planActionRequest, planEngineRequest, sourceJudgeRequests, textStatesToken } from './prompts.js'

export const ADAPTIVE_SCHEMA_VERSION = 2 // frozen fact/coverage output (explicit legacy limits only)
export const ADAPTIVE_RETRIEVAL_SCHEMA_VERSION = 3 // default reading-value output
export const ADAPTIVE_TOOL_NAME = 'adaptive_search'

export const STOP_REASONS = {
  allCovered: 'all_covered',
  noAction: 'no_action',
  budgetRounds: 'budget_rounds',
  budgetCalls: 'budget_calls',
  budgetTokens: 'budget_tokens',
  deadline: 'deadline',
  cancelled: 'cancelled',
  jevUnavailable: 'jev_unavailable',
  invalidInput: 'invalid_input',
  notConfigured: 'not_configured',
  noEngines: 'no_engines',
  // Every keyword is closed (satisfied or exhausted) — never a complete-answer claim.
  keywordQueueEmpty: 'keyword_queue_empty',
}

/** Our own budget stop — never reported as a Jev failure, never marked degraded. */
class BudgetExhausted extends Error {
  constructor(kind) {
    super(`adaptive budget exhausted: ${kind}`)
    this.name = 'BudgetExhausted'
    this.kind = kind
  }
}

/** Whitelisted, code-generated reason categories (no model prose). */
export const REASONS = {
  notSearched: 'not_searched',
  noEngines: 'no_engines',
  noAction: 'no_action',
  coverageBelowThreshold: 'coverage_below_threshold',
  noAnswerCapableEvidence: 'no_answer_capable_evidence',
  dateUnqualified: 'date_unqualified',
  duplicateAction: 'duplicate_action',
  snippetOnly: 'snippet_only',
  judgmentMissing: 'judgment_missing',
  explicitRequirementUnmet: 'explicit_requirement_unmet',
  sourceConflictUnresolved: 'source_conflict_unresolved',
  injectionSuspectedOnly: 'injection_suspected_only',
  enginesFailed: 'engines_failed',
  fetchFailed: 'fetch_failed',
  budgetExhausted: 'budget_exhausted',
  deadline: 'deadline',
  jevUnavailable: 'jev_unavailable',
  cancelled: 'cancelled',
  unassessed: 'unassessed',
  // V3 keyword queue: closed is not proof of absence, and satisfied is not an answer claim.
  keywordContinue: 'keyword_continue',
  keywordSatisfied: 'keyword_satisfied',
  keywordExhausted: 'keyword_exhausted',
  keywordPending: 'keyword_pending',
  keywordDecisionUnqualified: 'keyword_decision_unqualified',
  keywordMaterialChanged: 'keyword_material_changed',
}

const ABORT_MESSAGE = 'adaptive_search cancelled'

/** Validate the tool input. Nothing is truncated and nothing is silently dropped. */
export function validateQuestions(raw, limits = ADAPTIVE_LIMITS) {
  const result = normalizeAdaptiveInput({ questions: raw }, limits)
  return result.error ? { error: result.error } : { questions: result.targets.map((q) => q.text) }
}

/** Compatibility wrapper; production and callers use the same canonicalizer. */
export function canonicalizeQuestions(questions) {
  return canonicalTargets(questions.map((text) => ({ text, context: '', keywords: [], taskId: null, targetId: null })))
}

/**
 * The judgements the coverage filter actually gates on. `premise_conflict` is
 * reported but never a gate: a source that denies the premise is still an answer.
 */
const GATING_JUDGMENT_FIELDS = ['relevant', 'states_evidence', 'injection']

function answerCapableOf(assoc, thresholds) {
  const judgment = assoc.judgment
  const assessed = Boolean(judgment) && assoc.judgmentVersion === assoc.textVersion
  if (!assessed) {
    return { assessed: false, judgmentIncomplete: false, injectionSuspected: false, relevant: false, statesEvidence: false, premiseConflict: false, answerCapable: false, deferLead: true }
  }
  // A missing or invalid field is NOT a no: the item stays incomplete instead of
  // being read as a confident negative — and an incomplete item never enters the
  // success branch. "injection unknown" is not "no injection".
  const judgmentIncomplete = GATING_JUDGMENT_FIELDS.some((field) => judgment[field] === null || judgment[field] === undefined)
  const injectionSuspected = judgment.injection !== null && judgment.injection > thresholds.injection
  const relevant = judgment.relevant !== null && judgment.relevant > thresholds.relevance
  const statesEvidence = judgment.states_evidence !== null && judgment.states_evidence > thresholds.statesEvidence
  const premiseConflict = judgment.premise_conflict !== null && judgment.premise_conflict > thresholds.premiseConflict
  const keywordCapable = judgment.keywords?.some(k => k.relevant > thresholds.relevance && k.states_evidence > thresholds.statesEvidence)
  const answerCapable = (judgment.keywords ? keywordCapable : relevant && statesEvidence) && !injectionSuspected && !judgmentIncomplete
  return {
    assessed: true,
    judgmentIncomplete,
    injectionSuspected,
    relevant,
    statesEvidence,
    premiseConflict,
    answerCapable,
    // A1 defer band (frozen P2 params): judged-but-uncertain material stays a
    // retained lead, never a silent deletion. Unknown ≠ no.
    deferLead: !answerCapable && !injectionSuspected && (judgmentIncomplete
      || (judgment.relevant ?? 0) > (thresholds.deferBand ?? 0.25)
      || (judgment.states_evidence ?? 0) > (thresholds.deferBand ?? 0.25)),
  }
}

/**
 * The adaptive loop. All I/O is injected so the same code runs in three hosts
 * and can be tested hermetically.
 *
 * @param {{ questions: string[] }} input
 * @param {{
 *   jev?: { ask: Function, usage?: Function, describe?: Function } | null,
 *   snapshot?: Function,
 *   runFused?: Function,
 *   runFetchPage?: Function,
 *   signal?: AbortSignal | null,
 *   audit?: { write: Function } | null,
 *   limits?: typeof ADAPTIVE_LIMITS,
 *   thresholds?: typeof ADAPTIVE_THRESHOLDS,
 *   deadlineMs?: number,
 *   now?: () => number,
 *   configuredHint?: string | null,
 * }} deps
 */
export async function runAdaptiveLoop(input, deps = {}) {
  const limits = deps.limits ?? ADAPTIVE_LIMITS
  const configuredThresholds = deps.thresholds ?? ADAPTIVE_THRESHOLDS
  const keywordMode = limits.keywordAccumulation === true
  const retrievalMode = retrievalModeEnabled(limits)
  const scopeFirst = retrievalMode && limits.scopeFirst !== false
  const thresholds = scopeFirst ? configuredThresholds : { ...configuredThresholds, relevance: deps.thresholds?.relevance ?? .60, directionMatch: null, directionLambda: deps.thresholds?.directionLambda ?? .2 }
  const now = deps.now ?? (() => Date.now())
  const startedAt = now()
  const deadlineMs = Math.max(limits.minBudgetMs, deps.deadlineMs ?? limits.defaultDeadlineMs)
  const deadlineAt = startedAt + deadlineMs
  const warnings = []
  const warn = (message) => {
    if (!message || warnings.includes(message) || warnings.length >= limits.maxWarnings) return
    warnings.push(message)
  }
  const reportProgress = (message) => {
    try {
      deps.onProgress?.(message)
    } catch { /* progress must never break the loop */ }
  }

  const validated = (scopeFirst ? normalizeAdaptiveInput : normalizeLegacyAdaptiveInput)(input, limits)
  if (validated.error) {
    return earlyResult({
      stopReason: STOP_REASONS.invalidInput,
      stopDetail: validated.error,
      inputQuestions: Array.isArray(input?.questions) ? input.questions : [],
      warnings: [validated.error],
      startedAt,
      now,
      retrievalMode,
    })
  }
  const rawQuestions = validated.targets.map((t) => t.text)

  const jevState = {
    configured: Boolean(deps.jev?.ask),
    used: false,
    degraded: false,
    disabled: false,
    model: null,
    gateway: deps.jev?.describe?.()?.endpointOrigin ?? null,
    customGateway: null,
    calls: 0,
    httpAttempts: 0,
    retries: 0,
    inputTokens: 0,
    outputTokens: 0,
    inputTokensEstimated: 0,
    serverUsageReported: false,
    perPhase: [],
    failures: [],
  }

  if (!deps.jev?.ask) {
    return earlyResult({
      stopReason: STOP_REASONS.notConfigured,
      stopDetail: 'Jev is not configured: no network request was made',
      inputQuestions: rawQuestions,
      warnings: ['Jev is not configured. Configure it with `search-boost config jev` (or the TUI) and use fused_search / fetch_page / x_search directly in the meantime.'],
      startedAt,
      now,
      jevState,
      configuredHint: deps.configuredHint ?? 'search-boost config jev',
      retrievalMode,
    })
  }

  const hostSignal = deps.signal ?? null
  const controller = new AbortController()
  const onHostAbort = () => controller.abort(hostSignal.reason instanceof Error ? hostSignal.reason : new Error(ABORT_MESSAGE))
  if (hostSignal?.aborted) onHostAbort()
  else hostSignal?.addEventListener('abort', onHostAbort, { once: true })
  const timer = setTimeout(() => controller.abort(new Error('adaptive_search deadline exceeded')), deadlineMs)
  timer.unref?.()
  const signal = controller.signal
  const timeLeftMs = () => Math.max(0, deadlineAt - now())
  const isCancelled = () => Boolean(hostSignal?.aborted)
  const isDeadline = () => !isCancelled() && controller.signal.aborted

  const budget = {
    maxRounds: limits.maxRounds,
    maxSearchCalls: limits.maxSearchCalls,
    maxFetchCalls: limits.maxFetchCalls,
    maxFetchReads: limits.maxFetchReads,
    maxJevCalls: limits.maxJevCalls,
    maxJevHttpAttempts: limits.maxJevHttpAttempts,
    maxJevInputTokens: limits.maxJevInputTokens,
  }
  const used = { rounds: 0, searchCalls: 0, fetchCalls: 0, fetchReads: 0, jevCalls: 0, jevInputTokens: 0, jevHttpAttempts: 0, jevRetries: 0, estimatedTokens: 0 }
  const engineStats = {}
  const searchAudit = []
  // Evidence funnel: every stage is counted separately so a loss can be located
  // (engine raw rows → merged candidates → pool associations → reviewed →
  // qualified → coverage input → returned output). Never used for verdicts.
  const funnel = {
    searches: 0,
    cacheHits: 0,
    sawStageCounts: false,
    engineRowsRaw: 0,
    collectedRows: 0,
    uniqueCandidates: 0,
    fusionRows: 0,
    selectedRows: 0,
    fusionTruncatedCalls: 0,
    associationsCreated: 0,
    textlessRows: 0,
    reviewedAssociations: 0,
    staleJudgments: 0,
    deferredJudgmentsTotal: 0,
    coverageInputEvidence: 0,
    returnedEvidence: 0,
  }

  const snapshotCapability = () => {
    try {
      return deps.snapshot ? deps.snapshot() : { capability: {}, engines: {} }
    } catch {
      return { capability: {}, engines: {} }
    }
  }
  const candidateSet = new Set(engineCandidates(snapshotCapability()))
  if (candidateSet.size === 0) {
    clearTimeout(timer)
    hostSignal?.removeEventListener('abort', onHostAbort)
    return earlyResult({
      stopReason: STOP_REASONS.noEngines,
      stopDetail: 'No engine is allowed by the current layer/configuration, so no search was attempted',
      inputQuestions: rawQuestions,
      warnings: ['No available engines for the active layer. Inspect search capabilities and configuration; change keys or the persistent layer only when authorized.'],
      startedAt,
      now,
      jevState,
      limits,
      retrievalMode,
    })
  }

  const canonical = canonicalTargets(validated.targets).map((q) => ({ ...q,
    // In the new controller restrictions are judged semantically first. A bare
    // year/version in a comparison must not become a universal document gate.
    ...(scopeFirst ? { referenceDate: new Date(startedAt).toISOString().slice(0, 10) } : {}),
    timeWindow: scopeFirst ? null : q.timeRange ?? dateWindow(q.acceptance ?? q.text, startedAt),
    // Retrieval mode has no acceptance-fact definitions: caller facts become
    // optional topics and the keyword itself is the retrieval unit.
    factDefinitions: retrievalMode ? [] : factUnits(q).map(f=>({...f,timeWindow:dateWindow(f.question,startedAt)})),
    topics: retrievalMode ? topicUnits(q) : [],
  }))
  if (canonical.some((q) => q.timeWindow && !q.timeRange && /\btoday\b|\byesterday\b|今天|今日|昨天|昨日/i.test(q.text))) warn('Relative dates use the UTC calendar day at call start; unknown event dates cannot qualify as today/yesterday evidence.')
  for (const q of canonical) if (q.timeWindow && !q.timeRange) warn(`${q.id}: inferred ${q.timeWindow.basis} date window ${q.timeWindow.start}..${q.timeWindow.end} (UTC); use task time_range for an explicit window.`)
  if (scopeFirst && canonical.length !== 1) throw new Error('Single-target invariant violated')
  const evidence = createEvidencePool({ limits, questions: canonical })

  /** @type {Map<string, { engines: Set<string>, successful: Set<string>, complexity: string|null, searched: number, depth: number, gapStall: number, lastGap: string|null }>} */
  const progress = new Map(canonical.map((q) => [q.id, { engines: new Set(), successful: new Set(), complexity: null, searched: 0, history: [], depth: 0, gapStall: 0, lastGap: null }]))
  const executed = new Set()
  const phaseCalls = new Set()
  const failedPages = new Set()
  const engineFailures = new Map()
  const finished = new Set()
  const results = new Map(canonical.map((q) => [q.id, {
    status: 'not_searched',
    assessed: false,
    coverage: null,
    reasons: [],
    conflicts: [],
    gap: 'fact',
    verdictTextVersion: null,
    lastJudgedRound: null,
  }]))

  const roundLog = []
  let stopReason = null
  let stopDetail = null
  let fallbackUsed = false
  let sourceJudgeRuns = 0
  let coverageJudgeRuns = 0
  let finalChecks = 0, noProgressRounds = 0, lastProgressSignature = ''
  let roundPoolLimit = limits.maxPoolRowsPerRound ?? 500
  let roundUrls = new Set(), roundQuotas = new Map()
  const reopen = new Set()
  const keywordCache = new Map()
  const factBundles = new Map()
  const retrievalCache = new Map()
  const sourceAssessmentAttempts = new Map()
  const scopeAssessmentAttempts = new Map()
  const queryEngineCache = new Map()
  const engineWeights = new Map()
  let finalReview = { status: 'not_ready', checks: 0, signature: null }
  let judgementBudgetPause = null
  const finalGaps = new Set()

  function materialOf(assoc) {
    const source = evidence.source(assoc.sourceKey)
    return { assocId: assoc.assocKey, evidenceId: assoc.id, questionId: assoc.questionId,
      sourceKey: assoc.sourceKey, sourceId: source?.id, textVersion: assoc.textVersion, collectedRound: assoc.lastTouchedRound ?? assoc.round,
      text: assoc.text, basis: assoc.basis, url: source?.displayUrl ?? source?.url ?? '',
      title: source?.title ?? '', domain: source?.domain, published: source?.published ?? null,
      fusionScore: assoc.fusionScore }
  }
  function scopeOf(assoc) {
    if (!scopeFirst) return { route: 'eligible' }
    const q = canonical.find(q => q.id === assoc.questionId)
    const version = scopeVersion(q, materialOf(assoc), thresholds)
    if (!q.constraints?.length) return { version, route: 'eligible', checks: [], reason: 'no_explicit_constraints' }
    return currentScope(assoc.scope, version)
  }
  function scopeCandidates() {
    return canonical.flatMap(q => evidence.associationsFor(q.id)).filter(a => {
      if (!a.text) return false
      const scope = scopeOf(a)
      if (scope.route !== 'hold') return false
      const attempt = scopeAssessmentAttempts.get(`${a.assocKey}:${scope.version}`)
      return !attempt || (attempt.count < limits.maxSourceAssessmentAttempts && attempt.round !== used.rounds)
    }).map(materialOf)
      .sort((a,b) => (scopeFirst ? (b.collectedRound ?? 0) - (a.collectedRound ?? 0) : 0)
        || (b.fusionScore ?? 0) - (a.fusionScore ?? 0) || a.evidenceId.localeCompare(b.evidenceId))
  }
  const researchSignature = () => JSON.stringify(canonical.flatMap(q => evidence.associationsFor(q.id))
    .map(a => [a.id, scopeOf(a).version, a.judgmentVersion, a.judgment]))

  // Final-review validity tracks admitted witnesses, not unrelated rejected or
  // unknown arrivals. A failed/irrelevant search cannot erase a concrete gap.
  const admittedSignature = () => JSON.stringify(canonical.flatMap(q => retrievalRows(q).filter(isUsefulRow))
    .map(r => [r.evidenceId, r.scope.version, r.judgment.relevance, r.judgment.reading_value,
      r.judgment.direction_match, r.judgment.injection, r.judgment.keywords, r.judgment.kind]))

  // A concrete gap persists until a new whole-question verdict resolves it.
  // Changes to other points are not evidence that this gap has been filled.
  const currentContentSignature = () => JSON.stringify([...new Set(retrievalRows(canonical[0]).filter(isUsefulRow).map(finalMaterialKey))].sort())
  function breadthReady() {
    if (finalReview.checks > 0) return true
    const rows = retrievalRows(canonical[0]).filter(r => r.text)
    const target = Math.min(limits.minInitialReviewMaterials ?? 64, rows.length)
    const reviewed = rows.filter(r => r.scope.route === 'reject' || (r.scope.route === 'eligible' && r.assessed)).length
    return reviewed >= target || (!scopeCandidates().length && !pendingSourceCandidates().length)
  }
  const readyForFinal = () => {
    const states = retrievalStates(canonical[0])
    if (!states.every(s => s.localRows.length > 0) || !breadthReady()) return false
    // A normal not-passed verdict calls for a NEW SEARCH of its named point.
    // A page read or score jitter cannot silently turn that verdict into pass.
    return finalReview.status !== 'continue' || (used.searchCalls > finalReview.searchCalls
      && currentContentSignature() !== finalReview.contentSignature)
  }

  const assessmentKey = (item) => JSON.stringify([item.assocId, item.textVersion, scopeFirst ? scopeOf(evidence.association(item.assocId)).version : evidence.source(evidence.association(item.assocId)?.sourceKey)?.published ?? null])
  const keywordHistoryLog = new Map()
  // V3 keyword queue: one stored decision per (target, keyword index). A
  // decision is valid only while the material it was made about still exists at
  // the same text version, and never overrides the code-side qualification gate.
  const keywordDecisions = new Map()
  let keywordDecisionEpoch = 0
  const decisionKey = (q, index) => `${q.id}\u0000${index}`

  function recordKeywordDecision(q, index, decision) {
    keywordDecisions.set(decisionKey(q, index), decision)
    const history = keywordHistoryLog.get(decisionKey(q, index)) ?? []
    history.push({ round: decision.round ?? used.rounds, status: decision.status, reason: decision.reason ?? null })
    keywordHistoryLog.set(decisionKey(q, index), history)
    keywordDecisionEpoch++
  }

  // ------------------------------------------------- V3 reading-value index

  /** Current judged material for one target, with its date gate resolved. */
  function retrievalRows(q) {
    const rows = []
    for (const assoc of evidence.associationsFor(q.id)) {
      const source = evidence.source(assoc.sourceKey)
      const scope = scopeOf(assoc)
      const fresh = Boolean(assoc.judgment && assoc.judgmentVersion === assoc.textVersion
        && (!scopeFirst || (scope.route === 'eligible' && assoc.qualityScopeVersion === scope.version)))
      const dates = inspectDates({ published: source?.published, text: assoc.text }, q.timeWindow)
      const timeMatch = fresh ? scoreField(assoc.judgment, 'time_match') : null
      const dateEligible = !q.timeWindow || (dates.status === 'eligible' && timeMatch !== null && timeMatch > thresholds.statesEvidence)
      rows.push({
        evidenceId: assoc.id, assocId: assoc.assocKey, textVersion: assoc.textVersion,
        text: assoc.text, url: source?.displayUrl ?? source?.url ?? '', assoc, source,
        judgment: fresh ? assoc.judgment : null, scope,
        assessed: fresh && ['relevance', 'reading_value', 'injection', ...(q.timeWindow ? ['time_match'] : [])].every(field => scoreField(assoc.judgment, field) !== null),
        assessmentIncomplete: scopeFirst ? needsRetrievalReview(assoc) : !fresh,
        dates, dateEligible,
      })
    }
    return rows
  }

  const isUsefulRow = (row) => Boolean(row.text) && row.assessed && row.dateEligible
    && (!scopeFirst || row.scope.route === 'eligible') && usefulEligible(row.judgment, thresholds)

  function needsRetrievalReview(assoc) {
    const q = canonical.find(q => q.id === assoc.questionId)
    const j = assoc.judgment
    if (scopeFirst && (scopeOf(assoc).route !== 'eligible' || assoc.qualityScopeVersion !== scopeOf(assoc).version)) return true
    if (['relevance', 'reading_value', 'injection', ...(q.timeWindow ? ['time_match'] : [])]
      .some(field => scoreField(j, field) === null)) return true
    return usefulEligible(j, thresholds) && ((scopeFirst && scoreField(j, 'direction_match') === null) || keywordList(q).some(keyword => keywordMatchOf(j, keyword) === null))
  }

  function sourceAssessmentRetryable(item) {
    const attempt = sourceAssessmentAttempts.get(assessmentKey(item))
    return !attempt || attempt.count < (limits.maxSourceAssessmentAttempts ?? 2)
  }

  // Incomplete typed answers remain retryable, but never consume every micro-
  // batch on the same fragment: at most one attempt/round and two/text version.
  // Exhausted retries remain visibly unresolved, not confidently rejected.
  function pendingSourceCandidates({ sameRound = false } = {}) {
    const pending = evidence.pendingSourceJudge(retrievalMode ? { needsReview: needsRetrievalReview } : {})
    if (!retrievalMode) return pending
    const selected = pending.filter(item => {
      if (scopeFirst && scopeOf(evidence.association(item.assocId)).route !== 'eligible') return false
      const attempt = sourceAssessmentAttempts.get(assessmentKey(item))
      return sourceAssessmentRetryable(item) && (!attempt || sameRound || attempt.round !== used.rounds)
    })
    if (scopeFirst) selected.sort((a,b) => (evidence.association(b.assocId).lastTouchedRound ?? 0) - (evidence.association(a.assocId).lastTouchedRound ?? 0))
    return selected
  }

  const materialSnapshot = (q) => evidence.associationsFor(q.id).filter(a => a.text)
    .map(a => JSON.stringify([a.assocKey, a.textVersion, evidence.source(a.sourceKey)?.published ?? null]))
    .sort().join('|')

  /**
   * Per-keyword reading index over the current reviewed set of one target.
   * Cached against (material versions, keyword decisions): recomputing the same
   * immutable snapshot never changes a score, so repeated rounds and duplicate
   * rows cannot earn anything.
   */
  function retrievalStates(q) {
    const materialSignature = evidence.associationsFor(q.id).map((assoc) => JSON.stringify([assoc.id, assoc.textVersion, assoc.judgmentVersion, evidence.source(assoc.sourceKey)?.published ?? null])).join('|')
    const signature = `${materialSignature}#${keywordDecisionEpoch}#${scopeFirst ? researchSignature() : ""}`
    const cached = retrievalCache.get(q.id)
    if (cached?.signature === signature) return cached.states
    const rows = retrievalRows(q)
    const useful = rows.filter(isUsefulRow)
    const groups = contentGroups(useful)
    const matchFloor = thresholds.keywordMatch ?? 0.5
    const topics = (q.topics ?? []).map((topic) => ({ id: topic.id, weight: topic.weight }))
    const states = keywordList(q).map((keyword, index) => {
      const scored = retrievalScore({ keyword, rows: useful, topics, intentPresent: scopeFirst || Boolean(q.intent), thresholds, weights: RETRIEVAL_SCORE_WEIGHTS, groups, lambda: thresholds.directionLambda })
      const localRows = useful.filter((row) => {
        const match = keywordMatchOf(row.judgment, keyword)
        return match !== null && match > matchFloor
      })
      return { ...scored, index, questionId: q.id, useful: useful.length, localRows, rows: useful }
    })
    retrievalCache.set(q.id, { signature, states, rows, useful })
    return states
  }

  /**
   * The current status of one keyword. `satisfied` survives only while the exact
   * material it was decided about is still current and still qualified; changed
   * text reverts it to continue. New useful material contradicts `exhausted`.
   */
  function keywordQueueStatus(q, state) {
    if (scopeFirst) {
      const blocked = finalGaps.has(state.index)
      if (state.localRows?.length && !blocked) return { status: 'satisfied', reason: REASONS.keywordSatisfied, round: used.rounds }
      const pending = retrievalRows(q).some(row => row.text && row.scope.route !== 'reject' && row.assessmentIncomplete)
      return { status: pending && !state.localRows?.length ? 'pending' : 'continue',
        reason: blocked ? 'final_review_gap' : pending ? REASONS.keywordPending : REASONS.keywordContinue, round: null }
    }
    const decision = keywordDecisions.get(decisionKey(q, state.index))
    if (!decision) return { status: 'continue', reason: REASONS.keywordContinue, round: null }
    if (decision.status === 'satisfied') {
      const current = new Map((state.localRows ?? []).map((row) => [row.assocId, row]))
      const intact = Boolean(decision.justification?.length) && decision.justification.every((entry) => {
        const row = current.get(entry.assocId)
        return Boolean(row) && row.textVersion === entry.textVersion
      })
      if (!intact) return { status: 'continue', reason: REASONS.keywordMaterialChanged, round: decision.round }
      return { status: 'satisfied', reason: REASONS.keywordSatisfied, round: decision.round }
    }
    if (decision.status === 'exhausted') {
      if (decision.materialSnapshot !== materialSnapshot(q)) return { status: 'continue', reason: REASONS.keywordMaterialChanged, round: decision.round }
      return { status: 'exhausted', reason: REASONS.keywordExhausted, round: decision.round }
    }
    if (decision.status === 'continue') return { status: 'continue', reason: decision.reason ?? REASONS.keywordContinue, round: decision.round }
    return { status: 'pending', reason: REASONS.keywordPending, round: decision.round }
  }

  /** Current status per keyword, in keyword order. */
  function keywordStatuses(q) {
    return retrievalStates(q).map((state) => keywordQueueStatus(q, state).status)
  }

  // A decision that was never obtained stays pending: it is retried (cheaply)
  // before any new search, and it is never read as exhaustion.
  const unresolvedKeywordStatus = (status) => status === 'continue' || status === 'pending'

  /** Keyword-level status, never a complete-answer claim. */
  function retrievalQuestionStatus(q) {
    const statuses = keywordStatuses(q)
    if (statuses.every((status) => status === 'satisfied')) return !scopeFirst || finalAccepted() ? 'satisfied' : 'partial'
    if (statuses.some((status) => status === 'pending')) return 'pending'
    if (statuses.some((status) => status === 'continue')) return 'partial'
    if (statuses.some((status) => status === 'satisfied')) return 'partial'
    return 'exhausted'
  }

  // A target is closed (no more retrieval planned) when no keyword is open — a
  // mixed satisfied+exhausted queue is closed but never sufficient.
  const finalAccepted = () => finalReview.status === 'finish' && finalReview.signature === admittedSignature()
  const queueClosedFor = (q) => scopeFirst ? finalAccepted() : keywordStatuses(q).every((status) => status === 'satisfied' || status === 'exhausted')
  const queueClosed = () => canonical.every(queueClosedFor)
  const retrievalSufficient = () => (!scopeFirst || finalAccepted()) && canonical.every((q) => keywordStatuses(q).every((status) => status === 'satisfied'))

  /**
   * Mirror the keyword queue into `finished` (the loop's execution gate) and the
   * per-target record. Run at the start of every round and after decisions, so
   * a keyword reopened by changed material is searched again.
   */
  function syncRetrievalFinished() {
    for (const q of canonical) {
      const record = results.get(q.id)
      const status = retrievalQuestionStatus(q)
      record.status = status
      record.assessed = status === 'satisfied' || status === 'exhausted'
      const states = retrievalStates(q)
      record.reasons = states.length
        ? [...new Set(states.map((state) => keywordQueueStatus(q, state).reason))]
        : [REASONS.keywordContinue]
      if (scopeFirst && states.every(s => s.localRows.length > 0) && !finalAccepted()) {
        record.reasons = [finalReview.status === 'continue' ? 'final_review_gap' : 'final_review_pending']
      }
      if (queueClosedFor(q)) finished.add(q.id)
      else finished.delete(q.id)
    }
  }

  function retrievalKeywordSummary(q, state) {
    const queue = keywordQueueStatus(q, state)
    const history = keywordHistoryLog.get(decisionKey(q, state.index)) ?? []
    return { keyword: state.keyword, status: queue.status, reason: queue.reason,
      score: state.score, A: state.A, F: state.F, R: state.R, distinct: state.distinct,
      ...(scopeFirst ? { admitted: state.distinct, ready: state.distinct > 0 } : {}),
      ...(history.length ? { history: history.map((entry) => ({ ...entry })) } : {}) }
  }

  function keywordProgress(q) {
    if (retrievalMode) return retrievalStates(q)
    const {classified} = qualifiedFor(q.id)
    const materialSignature=classified.map(x=>`${x.assoc.id}:${x.assoc.textVersion}:${x.assoc.judgmentVersion}`).join('|')
    const bundle = factBundles.get(q.id)
    const currentBundle = bundle?.signature === materialSignature ? bundle.row : null
    const signature = `${materialSignature}:${currentBundle ? 'bundle' : ''}`
    const cached=keywordCache.get(q.id)
    if(cached?.signature===signature)return cached.states.map(k=>({...k,reopened:reopen.has(q.id)}))
    // Acceptance facts belong to the target, not to spelling alternatives.
    // Share their coverage, but require a keyword's own qualified material for A.
    const coverageRows = classified.filter(x => x.answerCapable).map(({assoc}) => {
      const strongest = [...(assoc.judgment?.keywords ?? [])].filter(k=>k.relevant>thresholds.relevance && k.states_evidence>thresholds.statesEvidence).sort((a,b) =>
        Math.min(b.relevant ?? 0,b.states_evidence ?? 0)-Math.min(a.relevant ?? 0,a.states_evidence ?? 0))[0]
      return { evidenceId:assoc.id, text:assoc.text, url:evidence.source(assoc.sourceKey)?.url,
        facts:assoc.judgment?.facts ?? [], judgment:{...strongest,injection:assoc.judgment.injection}, assoc }
    })
    const factualRows = currentBundle ? [...coverageRows,currentBundle] : coverageRows
    const provenanceCache = new WeakMap()
    const states = keywordList(q).map((keyword, index) => {
      const rows = coverageRows.map(row => ({...row,
        judgment:{...row.assoc.judgment.keywords?.[index],injection:row.assoc.judgment.injection}}))
      return {keyword, ...scoreEvidence(rows, {gateRelevant:thresholds.relevance,gateStates:thresholds.statesEvidence,
        factGate:thresholds.factSupport,provenanceGate:thresholds.provenance,
        facts:factUnits(q),coverageRows:factualRows,weights:limits.factScore,provenanceCache}), reopened:reopen.has(q.id)}
    })
    keywordCache.set(q.id,{signature,states})
    return states
  }
  function allKeywordStates() { return canonical.flatMap(q => keywordProgress(q).map(k => ({...k,questionId:q.id}))) }

  function openKeywordsFor(q) {
    if (!retrievalMode) return keywordProgress(q).filter(k => !k.ready || k.reopened)
    return retrievalStates(q).filter((state) => scopeFirst ? ['continue', 'pending'].includes(keywordQueueStatus(q, state).status) : keywordQueueStatus(q, state).status === 'continue')
  }

  /** Keywords that still need retrieval under the active controller. */
  function openKeywordStates() {
    return canonical.flatMap((q) => openKeywordsFor(q).map((state) => ({ ...state, questionId: q.id })))
  }
  function keywordSummary({contributions, witnesses, missingFacts, factProgress, ...summary}, index=0) {
    // Full contribution vectors stay internal; never multiply a 500-row trace by
    // every keyword and every round in the tool response.
    // These facts are shared by target; avoid repeating up to8 long IDs for
    // every spelling alternative in bounded public/diagnostic responses.
    return {...summary,...(index===0 ? {missingFacts,factProgress} : {})}
  }

  function allocateRoundPool(plan) {
    roundUrls = new Set(); roundQuotas = new Map()
    const open = openKeywordStates()
    const total = canonical.reduce((sum, q) => sum + keywordList(q).length, 0)
    const remaining = open.length
    roundPoolLimit = used.rounds === 1 ? limits.maxPoolRowsPerRound : nextPoolLimit(remaining,total,limits)
    // Largest remainder allocation: total dispatched row quotas never exceeds the global budget.
    const searches = plan.filter(s => s.kind === 'search')
    let left=roundPoolLimit
    const weights=searches.map(s=>Math.max(1,open.filter(k=>k.questionId===s.questionId).length))
    const totalWeight=weights.reduce((a,b)=>a+b,0)
    searches.forEach((s,i)=>{ const n=Math.floor(roundPoolLimit*weights[i]/totalWeight);roundQuotas.set(s.questionId,n);left-=n })
    for(let i=0;i<left&&searches.length;i++) { const id=searches[i%searches.length].questionId;roundQuotas.set(id,roundQuotas.get(id)+1) }
  }

  function nextKeywordSearch(q) {
    const remaining = openKeywordsFor(q)
    if (!remaining.length) return null
    let focused
    if (retrievalMode) focused = { ...q, keywords: remaining.map(k => k.keyword) }
    else {
      const missing = new Set(remaining.flatMap(k => k.missingFacts))
      focused = { ...q, keywords: remaining.map(k => k.keyword),
        acceptance: factUnits(q).filter(f => missing.has(f.id)).map(f => f.question).join('; ') || q.acceptance }
    }
    const candidates = (scopeFirst ? researchQueryCandidates(focused, limits.maxQueryChoices) : queryCandidates(focused, results.get(q.id).gap))
      .flatMap(v => [limits.defaultComplexity, limits.deepenComplexity].map(complexity => ({ query: v.query, complexity })))
    const engines = healthyEngines().sort((a,b) => (engineWeights.get(q.id)?.[b] ?? 1) - (engineWeights.get(q.id)?.[a] ?? 1))
    const action = candidates.find(v => engines.some(e => !executed.has(searchSignature(q.id, e, v.query, v.complexity))))
    return action ? { questionId: q.id, kind: 'search', ...action, engines, mode: 'keyword_gap' } : null
  }

  async function directKeywordPlan(roundEntry) {
    if (scopeFirst) {
      // Do not buy new material while a ready/uncertain final decision can be
      // obtained from the set already collected.
      if (readyForFinal()) return []
      // A semantic final gap requires a new search, not a fetch-only substitute.
      if (finalGaps.size) return await researchPlanRound(roundEntry)
      // Before the first final verdict, inspect a bounded, meaningful window of
      // the existing pool instead of accepting the first few good hits.
      if (retrievalStates(canonical[0]).every(s => s.localRows.length > 0)
        && (scopeCandidates().length || pendingSourceCandidates().length)) return []
      const rescue = rescuePlan()
      if (rescue.length) {
        roundEntry.plan = { phase: 'scope_rescue', urls: rescue.flatMap(s => s.action.params.urls.map(u => u.url)) }
        return rescue
      }
      // Open points get their own focused opportunity, even with old backlog.
      // New candidates are prioritised at BOTH scope and quality stages.
      return await researchPlanRound(roundEntry)
    }
    if (pendingSourceCandidates().some(item => !finished.has(item.questionId))) return []
    const plan = canonical.map(nextKeywordSearch).filter(Boolean)
    roundEntry.plan = { phase: 'keyword_gap', selections: plan.map(s => ({ ...s })), remainingKeywords: openKeywordStates().length }
    return plan
  }

  // ------------------------------------------------------------------ budget

  const timeBudgetOk = () => !signal.aborted && timeLeftMs() >= limits.minBudgetMs

  function reserve(kind, count = 1, estimateTokens = 0) {
    if (!timeBudgetOk()) return false
    if (kind === 'search') {
      if (used.searchCalls + count > budget.maxSearchCalls) return false
      used.searchCalls += count
      return true
    }
    if (kind === 'fetch') {
      if (used.fetchCalls + count > budget.maxFetchCalls) return false
      used.fetchCalls += count
      return true
    }
    if (kind === 'fetchRead') {
      if (used.fetchReads + count > budget.maxFetchReads) return false
      used.fetchReads += count
      return true
    }
    if (kind === 'jev') {
      if (used.jevCalls + count > budget.maxJevCalls) return false
      if (used.jevHttpAttempts + (limits.maxJevRetries + 1) > budget.maxJevHttpAttempts) return false
      if (used.jevInputTokens >= budget.maxJevInputTokens) return false
      // The estimate for THIS request is reserved atomically before dispatch: the
      // cap must hold for the request about to be sent, not only for the requests
      // already accounted for. Server-reported usage stays a separate number.
      if (used.estimatedTokens + estimateTokens > budget.maxJevInputTokens) return false
      used.jevCalls += count
      used.estimatedTokens += estimateTokens
      return true
    }    return false
  }

  /**
   * Give a reservation back when the call it paid for turned out not to use it
   * (a cache hit). Only the reservation of that exact call may be refunded —
   * never another call's.
   */
  function refund(kind, count = 1) {
    if (kind === 'fetch') used.fetchCalls = Math.max(0, used.fetchCalls - count)
    else if (kind === 'fetchRead') used.fetchReads = Math.max(0, used.fetchReads - count)
  }

  function abortError() {
    if (isCancelled()) {
      const reason = hostSignal?.reason
      return reason instanceof Error ? reason : new Error(ABORT_MESSAGE)
    }
    return new JevError(isCancelled() ? JEV_ERROR_KINDS.cancelled : JEV_ERROR_KINDS.timeout, { detail: 'deadline' })
  }

  // -------------------------------------------------------------- jev plumbing

  async function jevAsk(phase, request, callKey = phase) {
    if (signal.aborted) throw abortError()
    const phaseKey = `${used.rounds}:${callKey}`
    if (phaseCalls.has(phaseKey)) throw new Error(`duplicate Jev phase: ${phaseKey}`)
    if (!requestFits(request, limits)) throw new BudgetExhausted(STOP_REASONS.budgetTokens)
    const estimate = estimateJevTokens(JSON.stringify(request.state ?? '').length + JSON.stringify(request.questions ?? {}).length)
    // Reserved before dispatch, estimate included: a request whose estimated size
    // does not fit the remaining token budget is never sent (this is our own
    // accounting cap, not a claim about the server's real billing).
    if (!reserve('jev', 1, estimate)) {
      // The time margin can expire between the round guard and reservation.
      // Do not misreport a deadline as exhausted API-call quota.
      if (!timeBudgetOk()) throw new BudgetExhausted(isCancelled() ? STOP_REASONS.cancelled : STOP_REASONS.deadline)
      const tokens = used.jevInputTokens >= budget.maxJevInputTokens || used.estimatedTokens + estimate > budget.maxJevInputTokens
      throw new BudgetExhausted(tokens ? STOP_REASONS.budgetTokens : STOP_REASONS.budgetCalls)
    }
    phaseCalls.add(phaseKey)
    jevState.inputTokensEstimated += estimate
    jevState.calls++
    const started = now()
    try {
      const result = await deps.jev.ask({ ...request, signal, phase })
      jevState.used = true
      const usage = deps.jev.usage?.() ?? {}
      used.jevHttpAttempts = usage.httpAttempts ?? used.jevHttpAttempts
      used.jevRetries = usage.retries ?? used.jevRetries
      used.jevInputTokens = usage.inputTokens ?? used.jevInputTokens
      jevState.httpAttempts = used.jevHttpAttempts
      jevState.retries = used.jevRetries
      jevState.inputTokens = used.jevInputTokens
      jevState.outputTokens = usage.outputTokens ?? jevState.outputTokens
      if (usage.serverUsageCalls) jevState.serverUsageReported = true
      if (result.model) jevState.model = result.model
      jevState.perPhase.push({
        phase,
        round: used.rounds,
        requestChars: result.requestChars ?? null,
        estimatedInputTokens: estimate,
        serverInputTokens: result.usage?.inputTokens ?? null,
        attempts: result.attempts ?? null,
        tookMs: result.tookMs ?? now() - started,
        entries: result.entries?.size ?? 0,
        invalid: result.invalidIds?.length ?? 0,
        missing: result.missingIds?.length ?? 0,
        unknown: result.unknownIds?.length ?? 0,
      })
      for (const id of result.invalidIds ?? []) warn(`jev ${phase}: invalid answer ignored (${id})`)
      if (result.unknownIds?.length) warn(`jev ${phase}: unknown answer id ignored (${result.unknownIds.slice(0, 3).join(', ')})`)
      return result
    } catch (err) {
      const error = err instanceof JevError ? err : new JevError(JEV_ERROR_KINDS.network, { phase, detail: 'unexpected_error' })
      const usage = deps.jev.usage?.() ?? {}
      used.jevHttpAttempts = usage.httpAttempts ?? used.jevHttpAttempts
      used.jevRetries = usage.retries ?? used.jevRetries
      used.jevInputTokens = usage.inputTokens ?? used.jevInputTokens
      jevState.httpAttempts = used.jevHttpAttempts
      jevState.retries = used.jevRetries
      jevState.inputTokens = used.jevInputTokens
      if (error.kind !== JEV_ERROR_KINDS.cancelled) {
        jevState.degraded = true
        jevState.failures.push({ ...error.toJSON(), phase })
        if (JEV_FATAL_KINDS.has(error.kind)) jevState.disabled = true
        warn(`jev ${phase} failed: ${error.kind}${error.detail ? ` (${error.detail})` : ''}`)
      }
      throw error
    }
  }

  // ------------------------------------------------------------ engine choice

  /** Stable code fallback: first candidates in repository order. */
  function defaultEngineSubset(engines, count = 2) {
    return engines.slice(0, Math.min(count, engines.length))
  }

  /**
   * Map Jev's engine answers onto a code-limited set. `allowed` (when given) is
   * the only set an answer can select from: candidates minus the engines this
   * question already used. Nothing here can widen it.
   */
  function selectEnginesFromEntries(entries, offered, threshold, questionId, allowed = null, engineCap = limits.maxEnginesPerQuestionPerRound) {
    const permitted = allowed ? offered.filter((item) => allowed.has(item.engine)) : offered
    const valid = []
    let invalid = 0
    for (const item of permitted) {
      if (item.questionId !== questionId) continue
      const read = readNoul(entries, item.id)
      if (read.valid && read.value !== null) valid.push({ ...item, value: read.value })
      else invalid++
    }
    valid.sort((a, b) => b.value - a.value || a.engineIndex - b.engineIndex)
    const offeredEngines = permitted.filter((item) => item.questionId === questionId).map((item) => item.engine)
    if (!valid.length) {
      const fallback = defaultEngineSubset(offeredEngines, keywordMode ? offeredEngines.length : 2)
      if (scopeFirst) engineWeights.set(questionId, Object.fromEntries(fallback.map(e => [e, 1])))
      return { engines: fallback, mode: 'fallback_default', invalid, valid: 0 }
    }
    const above = valid.filter((item) => item.value > threshold)
    const chosen = above.length ? above : valid.slice(0, 1)
    const engines = []
    for (const item of chosen) {
      if (engines.length >= engineCap) break
      if (allowed && !allowed.has(item.engine)) continue
      engines.push(item.engine)
    }
    if (scopeFirst) {
      // Preserve ALL assessed engine preferences, not just selected engines.
      // Otherwise an engine rejected at .1 regains the implicit weight 1 on a
      // follow-up and outranks the one Jev selected at .9. Missing is neutral.
      const scores = new Map(valid.map(i => [i.engine, i.value]))
      engineWeights.set(questionId, Object.fromEntries(offeredEngines.map(engine => [engine, Math.max(.1, scores.get(engine) ?? .5)])))
    }
    return { engines, mode: above.length ? 'jev_selected' : 'jev_low_scores', invalid, valid: valid.length }
  }

  /** Candidates this question has not used yet: the code definition of "new engines". */
  function allowedNewEngines(questionId) {
    const used = progress.get(questionId)?.engines ?? new Set()
    return new Set(healthyEngines().filter((name) => !used.has(name)))
  }

  function healthyEngines() {
    return [...candidateSet].filter((name) => (engineFailures.get(name) ?? 0) < (limits.engineFailureThreshold ?? 2))
  }

  function feedbackFor(q) {
    const record = results.get(q.id)
    const state = progress.get(q.id)
    return { question_id: q.id, gap: record.gap, reasons: record.reasons,
      history: state.history, engine_failures: Object.fromEntries(engineFailures),
      remaining: { searches: budget.maxSearchCalls - used.searchCalls, fetches: budget.maxFetchCalls - used.fetchCalls },
    }
  }

  function variantsFor(q) {
    return queryCandidates(q, results.get(q.id).gap)
  }

  function chosenQuery(entries, q, variants) {
    const choice = readChoice(entries, `query.${q.id}`, variants.map((v) => v.key))
    const selected = choice.valid && choice.confidence >= thresholds.actionConfidence
      ? variants.find((v) => v.key === choice.choice) : null
    return (selected ?? variants[0])?.query ?? q.text
  }

  // Production planning is sequential: choose a feasible query first, then
  // assess engines FOR THAT EXACT QUERY. This path runs on every actual search,
  // not on review-only rounds; the historical controller stays below.
  async function researchPlanRound(roundEntry) {
    const q = canonical[0]
    if (used.searchCalls >= budget.maxSearchCalls) return []
    const open = openKeywordsFor(q)
    if (!open.length && used.rounds > 1) return []
    const requestedKeyword = finalGaps.size ? keywordList(q)[[...finalGaps][0]] : null
    const focused = { ...q, keywords: requestedKeyword ? [requestedKeyword] : (open.length ? open.map(s => s.keyword) : keywordList(q)) }
    const healthy = healthyEngines()
    const variants = researchQueryCandidates(focused, limits.maxQueryChoices)
      .filter(v => !requestedKeyword || v.keyword === requestedKeyword)
    const feasible = [...new Set([limits.defaultComplexity, limits.deepenComplexity])]
      .flatMap(complexity => variants.map(v => ({ ...v, complexity })))
      .filter(v => healthy.some(engine => !executed.has(searchSignature(q.id, engine, v.query, v.complexity))))
    const bounded = feasible.slice(0, limits.maxQueryChoices ?? 8)
    // Initial search stays inexpensive. After feedback exists, preserve a
    // deepen alternative even if shallow variants fill every option slot.
    // Replace within the same point's lane so point coverage is not erased.
    if (used.searchCalls > 0 && bounded.length && !bounded.some(v => v.complexity === limits.deepenComplexity)) {
      const deeper = feasible.find(v => v.query === bounded.at(-1).query && v.complexity === limits.deepenComplexity)
      if (deeper) bounded[bounded.length - 1] = deeper
    }
    const options = bounded.map((v, i) => ({ ...v, id: `query${i}` }))
    if (!options.length) { roundEntry.plan = { phase: 'no_search_path', selections: [] }; return [] }
    const rows = retrievalRows(q)
    const feedback = {
      requested_keyword: requestedKeyword,
      points: retrievalStates(q).map(s => ({ keyword: s.keyword, admitted: s.distinct, ready: s.distinct > 0, status: keywordQueueStatus(q, s).status })),
      recent_searches: roundLog.flatMap(r => r.search).slice(-4).map(r => ({ query: r.query, complexity: r.complexity, engines: r.engines,
        returned: r.results ?? 0, new_materials: r.created ?? 0, changed_materials: r.changed ?? 0, failed: r.failed === true })),
      sample_admitted_material: rows.filter(isUsefulRow).slice(-4).map(r => ({ url: r.url, text: r.text.slice(0, 400) })),
      constraints_not_passed: rows.filter(r => r.scope.route === 'reject').length,
      pending: rows.filter(r => r.text && r.scope.route !== 'reject' && r.assessmentIncomplete).length,
      remaining: { searches: budget.maxSearchCalls - used.searchCalls, jev: budget.maxJevCalls - used.jevCalls },
    }
    let selected = options[0], queryMode = 'only_option'
    if (options.length > 1) {
      const request = queryPlanRequest(focused, options, feedback)
      const response = await jevAsk('query_plan', request)
      const read = readChoice(response.entries, 'query.next', options.map(o => o.id))
      // A choice among feasible searches is a relative preference, not a
      // correctness assertion. A consistent argmax suffices; confidence is
      // optional and must not silently discard a decisive distribution.
      const probability = read.valid ? selectedChoiceProbability(read, options.map(o => o.id)) : null
      if (probability !== null) { selected = options.find(o => o.id === read.choice); queryMode = 'jev_selected' }
      else { queryMode = 'bounded_fallback'; warn('Query planning returned no valid consistent option distribution; used the first feasible bounded alternative') }
    }
    const available = healthy.filter(engine => !executed.has(searchSignature(q.id, engine, selected.query, selected.complexity)))
    const cacheKey = JSON.stringify([selected.query, selected.complexity])
    let cached = queryEngineCache.get(cacheKey)
    const canReuse = cached && available.every(engine => cached.offered.some(o => o.engine === engine)
      && readNoul(cached.entries, `plan.${q.id}.${engine}`).valid)
    if (!canReuse) {
      const request = planEngineRequest({ questions: [focused], engines: engineBrief(available),
        alreadyRan: { [q.id]: [...progress.get(q.id).engines] }, round: used.rounds, limits })
      request.state.task = 'Assess engines specifically for the selected query; the query decision has already completed.'
      request.state.selected_search = selected
      request.state.feedback = feedback
      for (const spec of Object.values(request.questions)) spec.instructions += ' Evaluate for the EXACT query and complexity in state.selected_search, not merely the broad research topic.'
      const response = await jevAsk('engine_plan', request)
      cached = { entries: response.entries, offered: request.offered }
      queryEngineCache.set(cacheKey, cached)
    }
    const picked = selectEnginesFromEntries(cached.entries, cached.offered, thresholds.engineSelect, q.id, new Set(available), limits.maxEnginesPerQuestionPerRound)
    if (picked.mode !== 'jev_selected') warn(`Engine planning for the selected query used ${picked.mode}; only permitted healthy engines remain eligible`)
    const selection = { questionId: q.id, kind: 'search', query: selected.query, complexity: selected.complexity,
      engines: picked.engines, mode: finalGaps.size ? 'final_gap' : 'research_search' }
    roundEntry.plan = { phase: 'research_plan', queryMode, engineMode: picked.mode, engineCacheHit: Boolean(canReuse),
      requestedKeyword: feedback.requested_keyword, selections: [{ ...selection }] }
    return selection.engines.length ? [selection] : []
  }

  async function planEngineRound(unfinished, roundEntry) {
    const engines = engineBrief(healthyEngines())
    const alreadyRan = Object.fromEntries(canonical.map((q) => [q.id, [...progress.get(q.id).engines]]))
    const variants = Object.fromEntries(canonical.map((q) => [q.id, variantsFor(q)]))
    const build = (questions) => {
      const request = planEngineRequest({ questions, engines, alreadyRan, round: roundEntry.round, limits })
      request.state.feedback = questions.map(feedbackFor)
      addQueryChoices(request, questions, variants)
      return request
    }
    const planningQuestions = []
    for (const q of canonical.filter((q) => unfinished.includes(q.id))) {
      if (requestFits(build([...planningQuestions, q]), limits)) planningQuestions.push(q)
    }
    if (!planningQuestions.length) throw new BudgetExhausted(STOP_REASONS.budgetTokens)
    if (planningQuestions.length < unfinished.length) roundEntry.deferredPlans = unfinished.length - planningQuestions.length
    const request = build(planningQuestions)
    const result = await jevAsk('plan', request)
    const selections = []
    for (const q of canonical) {
      if (!unfinished.includes(q.id)) continue
      const allowed = allowedNewEngines(q.id)
      const offered = request.offered.filter((item) => item.questionId === q.id && allowed.has(item.engine))
      if (!offered.length) continue
      const { engines: chosen, mode, invalid } = selectEnginesFromEntries(result.entries, offered, thresholds.engineSelect, q.id, allowed,
        // First search of a question fans out wide; later searches stay narrow.
        progress.get(q.id)?.searched === 0 ? limits.round1EnginesPerQuestion : limits.maxEnginesPerQuestionPerRound)
      if (mode === 'jev_low_scores') warn(`plan: all ${q.id} engine scores were at or below ${thresholds.engineSelect}; code selected the highest (${chosen.join(', ')})`)
      if (mode === 'fallback_default') warn(`plan: no usable engine answer for ${q.id} (${invalid} missing/invalid); code fallback engines: ${chosen.join(', ') || '(none)'}`)
      const selected = chosen.filter((name) => candidateSet.has(name))
      if (!selected.length) continue
      selections.push({
        questionId: q.id,
        kind: 'search',
        query: chosenQuery(result.entries, q, variants[q.id]),
        engines: selected,
        complexity: limits.defaultComplexity,
        mode,
      })
    }
    roundEntry.plan = { phase: 'plan', selections: selections.map((s) => ({ questionId: s.questionId, engines: s.engines, mode: s.mode })) }
    return selections
  }

  /** Feasible next actions for one unfinished question (code-filtered, closed set). */
  /** Bounded recursion: the initial search is depth 1; every further retrieval
   * step (deepen / gap search / new engine / page read) advances the depth. A
   * gap repeating twice in a row stalls deepening for that question. */
  function markRetrievalStep(questionId) {
    const state = progress.get(questionId)
    if (!state) return
    if (state.depth === 0) {
      state.depth = 1 // initial retrieval level
      return
    }
    state.depth += 1
    const gap = results.get(questionId)?.gap ?? 'fact'
    if (state.lastGap === gap) state.gapStall += 1
    else { state.gapStall = 0; state.lastGap = gap }
  }

  function feasibleActions(questionId) {
    const options = []
    const state = progress.get(questionId)
    const verdict = currentVerdict(questionId)
    // Deepening (recursion) is bounded: tree depth 2, gap stall 2. Review and
    // honest partial remain available regardless — stopping is never silent.
    const deepeningAllowed = state.depth < limits.maxRecursionDepth && state.gapStall < limits.gapStallLimit
    if (evidence.pendingSourceJudge().some((item) => item.questionId === questionId) || (verdict.qualified.length && !verdict.fresh)) {
      options.push({ key: 'review_pending', description: 'Judge already collected material deferred by the previous round request budget, without another search.', params: {} })
    }
    const fetchBudgetLeft = used.fetchCalls < budget.maxFetchCalls && used.fetchReads < budget.maxFetchReads
    const fetchUrls = []
    if (fetchBudgetLeft && deepeningAllowed) {
      const basisRank = { snippet: 1, engine_content: 2, fetched_page: 3 }
      const statusRank = { answer_capable: 0, other: 1, no_text: 2 }
      const ranked = evidence.associationsFor(questionId)
        .filter((assoc) => assoc.basis !== 'fetched_page')
        .map((assoc) => {
          const classified = answerCapableOf(assoc, thresholds)
          const status = !assoc.text ? 'no_text' : classified.answerCapable ? 'answer_capable' : 'other'
          return { assoc, status, classified }
        })
        .filter((item) => item.status === 'no_text' || item.classified.relevant || item.classified.answerCapable || !item.classified.assessed)
        .sort((a, b) => (statusRank[a.status] ?? 9) - (statusRank[b.status] ?? 9)
          || (basisRank[a.assoc.basis] ?? 0) - (basisRank[b.assoc.basis] ?? 0)
          || (b.assoc.fusionScore ?? 0) - (a.assoc.fusionScore ?? 0))
      for (const item of ranked) {
        const source = evidence.source(item.assoc.sourceKey)
        const url = source?.displayUrl ?? source?.url
        if (!url || !source || failedPages.has(item.assoc.sourceKey)) continue
        // Fetch state is per question × source: a page already read for another
        // question does not count as page material for this one.
        if (item.assoc.fetch?.state === 'ok') continue
        const signature = `f|${questionId}|${resultKey({ url })}`
        if (executed.has(signature)) continue
        if (fetchUrls.length >= Math.min(limits.maxFetchesPerQuestion, limits.maxBranchPerNode ?? 3)) break
        fetchUrls.push({ url, evidenceId: item.assoc.id, sourceKey: item.assoc.sourceKey, signature })
      }
      if (fetchUrls.length) {
        const count = Math.min(fetchUrls.length, limits.maxFetchesPerRound, limits.maxBranchPerNode ?? 3)
        options.push({
          key: 'fetch_pages',
          description: `Read the full page text for the top ${count} already-collected URL(s) and re-judge the resulting fragments: ${fetchUrls.slice(0, count).map((item) => item.evidenceId).join(', ')}`,
          params: { urls: fetchUrls.slice(0, count) },
        })
      }
    }
    const successful = [...state.successful].filter((name) => healthyEngines().includes(name))
    const searchBudgetLeft = used.searchCalls < budget.maxSearchCalls
    const previousQuery = state.history.at(-1)?.query ?? variantsFor(canonical.find((q) => q.id === questionId))[0]?.query
    const deepenEngines = successful.filter((engine) => !executed.has(searchSignature(questionId, engine, previousQuery, limits.deepenComplexity)))
    if (searchBudgetLeft && deepenEngines.length && deepeningAllowed) {
      options.push({
        key: 'deepen',
        description: `Re-run engines ${successful.join(', ')} for this question at deeper extraction (complexity=${limits.deepenComplexity}: more query variants and advanced page extraction). Only useful when those engines returned thin fragments.`,
        params: { engines: deepenEngines.slice(0, limits.maxEnginesPerQuestionPerRound), complexity: limits.deepenComplexity, query: previousQuery },
      })
    }
    const newEngines = healthyEngines().filter((name) => !state.engines.has(name))
    if (searchBudgetLeft && newEngines.length && deepeningAllowed) {
      options.push({
        key: 'search_new_engines',
        description: `Search engines not yet used for this question (${newEngines.join(', ')}); the engine subset is chosen by Jev and validated by code.`,
        params: { engines: newEngines },
      })
    }
    const question = canonical.find((q) => q.id === questionId)
    const variants = variantsFor(question).filter((v) => healthyEngines().some((engine) => !executed.has(searchSignature(questionId, engine, v.query, limits.defaultComplexity))))
    if (searchBudgetLeft && variants.length && state.searched > 0 && deepeningAllowed) {
      options.push({ key: 'search_gap', description: 'Search a targeted query for the remaining gap; Jev may reselect any healthy permitted engine.', params: { variants } })
    }
    options.push({
      key: 'finish_partial',
      description: 'Stop retrieving for this question and return the evidence collected so far, marked with an explicit insufficient/unassessed status rather than an answer.',
      params: {},
    })
    return options
  }

  async function planActionRound(unfinished, roundEntry) {
    const actionsByQuestion = []
    const directSelections = []
    for (const q of canonical) {
      if (!unfinished.includes(q.id)) continue
      const options = feasibleActions(q.id)
      if (options.length <= 1) {
        directSelections.push({ questionId: q.id, action: options[0] ?? { key: 'finish_partial', params: {} }, mode: 'single_option' })
        continue
      }
      actionsByQuestion.push({ questionId: q.id, options })
    }
    const selections = [...directSelections]
    let engineChoices = null
    if (actionsByQuestion.length) {
      // Fit whole target plans into one request. Never turn a large plan into
      // a fourth model call. Unsearched targets get first opportunity next round.
      actionsByQuestion.sort((a, b) => progress.get(a.questionId).searched - progress.get(b.questionId).searched)
      const variants = Object.fromEntries(canonical.map((q) => [q.id, actionsByQuestion.find((a) => a.questionId === q.id)?.options.find((o) => o.key === 'search_gap')?.params.variants ?? variantsFor(q)]))
      const build = (actions) => {
        const activeIds = new Set(actions.map((a) => a.questionId))
        const activeQuestions = canonical.filter((q) => activeIds.has(q.id))
        const request = planActionRequest({ questions: activeQuestions, actionsByQuestion: actions, round: roundEntry.round })
        request.state.feedback = activeQuestions.map(feedbackFor)
        addQueryChoices(request, activeQuestions, variants)
        const engineQuestions = actions.filter((entry) => entry.options.some((option) => ['search_new_engines', 'search_gap'].includes(option.key))).map((entry) => entry.questionId)
        let engineRequest = null
        if (engineQuestions.length) {
          engineRequest = planEngineRequest({
            questions: canonical.filter((q) => engineQuestions.includes(q.id)), engines: engineBrief(healthyEngines()),
            alreadyRan: Object.fromEntries(canonical.map((q) => [q.id, [...progress.get(q.id).engines]])),
            round: roundEntry.round, limits, statePath: 'state.engine_state',
          })
          request.state.engine_state = engineRequest.state
          Object.assign(request.questions, engineRequest.questions)
        }
        return { request, engineRequest }
      }
      const fitted = []
      for (const action of actionsByQuestion) if (requestFits(build([...fitted, action]).request, limits)) fitted.push(action)
      if (!fitted.length) throw new BudgetExhausted(STOP_REASONS.budgetTokens)
      if (fitted.length < actionsByQuestion.length) roundEntry.deferredPlans = actionsByQuestion.length - fitted.length
      actionsByQuestion.splice(0, actionsByQuestion.length, ...fitted)
      const built = build(actionsByQuestion)
      const request = built.request
      engineChoices = built.engineRequest
      const result = await jevAsk('plan', request)
      for (const entry of actionsByQuestion) {
        const options = entry.options
        const keys = options.map((option) => option.key)
        const read = readChoice(result.entries, `action.${entry.questionId}`, keys)
        let action = null
        let mode = 'code_default'
        if (read.valid && read.confidence !== null && read.confidence >= thresholds.actionConfidence) {
          action = options.find((option) => option.key === read.choice) ?? null
          mode = 'jev_selected'
        } else if (read.valid) {
          mode = 'low_confidence_default'
          warn(`plan: action confidence ${read.confidence ?? 'n/a'} below ${thresholds.actionConfidence} for ${entry.questionId}; code default order used`)
        } else {
          mode = 'missing_answer_default'
          warn(`plan: no usable action answer for ${entry.questionId}; code default order used`)
        }
        if (!action) {
          // Stable code default order over the feasible closed set.
          for (const key of ['review_pending', 'fetch_pages', 'deepen', 'search_new_engines', 'search_gap', 'finish_partial']) {
            const found = options.find((option) => option.key === key)
            if (found) {
              action = found
              break
            }
          }
        }
        if (['search_new_engines', 'search_gap'].includes(action.key)) {
          // "New" is defined by code, not by the answer: allowed candidates minus
          // the engines this question already used. Construction, answer parsing,
          // default fallback and dispatch all see the same limited set.
          const query = chosenQuery(result.entries, canonical.find((q) => q.id === entry.questionId), variants[entry.questionId])
          const permitted = action.key === 'search_gap' ? healthyEngines() : [...allowedNewEngines(entry.questionId)]
          const allowed = new Set(permitted.filter((engine) => !executed.has(searchSignature(entry.questionId, engine, query, limits.defaultComplexity))))
          const offered = (engineChoices?.offered ?? []).filter((item) => item.questionId === entry.questionId && allowed.has(item.engine))
          const chosen = selectEnginesFromEntries(result.entries, offered, thresholds.engineSelect, entry.questionId, allowed)
          // Same reporting as round 1: a low-score answer and a missing answer are
          // different outcomes, and a code fallback must be visible in warnings.
          if (chosen.mode === 'jev_low_scores') warn(`plan: all ${entry.questionId} engine scores were at or below ${thresholds.engineSelect}; code selected the highest (${chosen.engines.join(', ')})`)
          if (chosen.mode === 'fallback_default') warn(`plan: no usable engine answer for ${entry.questionId} (${chosen.invalid} missing/invalid); code fallback engines: ${chosen.engines.join(', ') || '(none)'}`)
          selections.push({ questionId: entry.questionId, action: { ...action, params: { ...action.params, query, engines: chosen.engines } }, mode, engineMode: chosen.mode })
        } else {
          selections.push({ questionId: entry.questionId, action, mode })
        }
      }
    }
    roundEntry.plan = {
      phase: 'plan',
      actions: selections.map((s) => ({ questionId: s.questionId, action: s.action.key, mode: s.mode, params: s.action.params })),
    }
    return selections
  }

  // ---------------------------------------------------------------- execution

  function recordEngineStats(stats, cacheHit = false) {
    for (const [name, stat] of Object.entries(stats ?? {})) {
      if (!cacheHit) {
        if (stat.successes > 0) engineFailures.set(name, 0)
        else if (stat.errors > 0) {
          engineFailures.set(name, (engineFailures.get(name) ?? 0) + 1)
          if (!healthyEngines().includes(name)) warn(`engine ${name}: temporarily skipped for this call after repeated failures`)
        }
      }
      const prior = engineStats[name] ?? { used: false, errors: 0, attempts: 0, successes: 0 }
      engineStats[name] = {
        used: prior.used || Boolean(stat.used),
        attempts: prior.attempts + (stat.attempts ?? 0),
        successes: prior.successes + (stat.successes ?? 0),
        errors: prior.errors + (stat.errors ?? 0),
        ...(stat.note || prior.note ? { note: stat.note || prior.note } : {}),
      }
    }
  }

  function writeAuditSearch(entry) {
    try {
      deps.audit?.write?.({
        type: 'search',
        ts: new Date().toISOString(),
        query: entry.query,
        queriesUsed: entry.queriesUsed ?? [entry.query],
        engines: entry.engines ?? [],
        engineErrors: entry.engineErrors ?? {},
        results: entry.results ?? 0,
        // A cache hit is not a new paid network request — it is reported as a hit.
        cacheHits: entry.cacheHit ? 1 : 0,
        tier: entry.tier,
        layer: entry.layer,
        tookMs: entry.tookMs ?? 0,
        topUrls: entry.topUrls ?? [],
        tool: ADAPTIVE_TOOL_NAME,
      })
    } catch { /* audit must never break the loop */ }
  }

  const searchSignature = (questionId, engine, query, complexity) => `s|${questionId}|${engine}|${query}|${complexity}`

  async function executeSearch({ questionId, engines, complexity, mode, query }) {
    const question = canonical.find((q) => q.id === questionId)
    query ??= variantsFor(question)[0]?.query ?? question.text
    const live = new Set(engineCandidates(snapshotCapability()))
    // "New engines" is a code-level constraint, not a promise from the answer:
    // an engine this question already used is dropped before dispatch. Other
    // modes (deepen) deliberately re-run engines the question already used.
    const reUsed = mode === 'search_new_engines' ? engines.filter((name) => progress.get(questionId)?.engines.has(name)) : []
    if (reUsed.length) warn(`search ${questionId}: engine(s) ${reUsed.join(', ')} already ran for this question and were not searched again as new`)
    const requested = mode === 'search_new_engines' ? engines.filter((name) => !reUsed.includes(name)) : engines
    // Re-validate right before dispatch: an engine that just became unavailable
    // is dropped with a warning, and the candidate set is never widened.
    const available = requested.filter((name) => live.has(name) && healthyEngines().includes(name))
    const dropped = requested.filter((name) => !available.includes(name))
    if (dropped.length) warn(`search ${questionId}: engine(s) ${dropped.join(', ')} became unavailable or were temporarily suspended and were not called`)
    const repeated = available.filter((name) => executed.has(searchSignature(questionId, name, query, complexity)))
    const selected = available.filter((name) => !repeated.includes(name))
    if (repeated.length) warn(`search ${questionId}: identical query/depth already executed on ${repeated.join(', ')}; duplicate action skipped`)
    if (!selected.length) return { questionId, engines: [], skipped: true, reason: available.length ? REASONS.duplicateAction : REASONS.noEngines }
    const rowQuota = keywordMode ? (roundQuotas.get(questionId) ?? roundPoolLimit) : limits.maxPoolRowsPerSearch
    if (rowQuota <= 0) return {questionId, skipped:true, reason:'round_pool_budget'}
    if (!reserve('search')) return { questionId, engines: selected, skipped: true, reason: REASONS.budgetExhausted }
    for (const engine of selected) executed.add(searchSignature(questionId, engine, query, complexity))
    progress.get(questionId).history.push({ query, engines: selected, complexity, round: used.rounds })
    // Shared metadata lives outside the try: the failure branch must be able to
    // report the same question/engines instead of throwing its own error.
    const meta = { questionId, query, engines: selected, complexity, mode }
    const started = now()
    try {
      const result = await deps.runFused({
        query,
        engineList: selected,
        complexity,
        maxResults: rowQuota ?? limits.maxResultsPerSearch,
        ranking: 'balanced',
        ...(scopeFirst ? { engineWeights: Object.fromEntries(selected.map(e => [e, engineWeights.get(questionId)?.[e] ?? 1])) } : {}),
        candidateSelection: 'per_engine',
        maxResultsCap: keywordMode ? 500 : 20,
        recency: question.timeWindow?.end === new Date(startedAt).toISOString().slice(0, 10) && question.timeWindow.start === question.timeWindow.end ? 'day' : undefined,
        community: false,
        signal,
      })
      let rows = result?.results ?? []
      funnel.collectedRows += rows.length
      if (keywordMode) {
        rows = rows.slice(0,rowQuota).filter(hit => {
          if (!hit.url) return false
          // Same URL may be associated with several targets; it consumes one global slot.
          const key = resultKey(hit)
          if (!key) return false
          if(roundUrls.has(key)) return true
          if(roundUrls.size>=roundPoolLimit) return false
          roundUrls.add(key);return true
        })
      }
      const ingest = {created:[],changed:[],textless:0}
      // Judge each collected source against every target, not just the query that found it.
      for (const target of keywordMode && !scopeFirst ? canonical : [question]) {
        const added=evidence.ingestSearch({questionId:target.id,round:used.rounds,results:rows,query,engines:selected,complexity})
        ingest.created.push(...added.created);ingest.changed.push(...added.changed);ingest.textless+=added.textless
      }
      funnel.searches++
      if (result?.cacheHit) funnel.cacheHits++
      if (result?.funnel) {
        funnel.sawStageCounts = true
        funnel.engineRowsRaw += result.funnel.engineRowsRaw ?? 0
        funnel.uniqueCandidates += result.funnel.uniqueCandidates ?? 0
        funnel.fusionRows += result.funnel.fusionRows ?? 0
        funnel.selectedRows += result.funnel.selectedRows ?? 0
        if (result.funnel.truncated) funnel.fusionTruncatedCalls++
      }
      funnel.associationsCreated += ingest.created.filter((assoc) => assoc.text).length
      funnel.textlessRows += ingest.textless ?? 0
      progress.get(questionId).engines = new Set([...progress.get(questionId).engines, ...selected])
      progress.get(questionId).searched++
      markRetrievalStep(questionId)
      progress.get(questionId).complexity = complexity
      for (const name of selected) {
        const stat = result?.engineStats?.[name]
        if (stat && (retrievalMode ? stat.successes > 0 : !(stat.errors > 0))) progress.get(questionId).successful.add(name)
      }
      recordEngineStats(result?.engineStats, Boolean(result?.cacheHit))
      const cacheHit = Boolean(result?.cacheHit)
      writeAuditSearch({
        query,
        queriesUsed: result?.queriesUsed ?? [query],
        engines: selected,
        engineErrors: Object.fromEntries(Object.entries(result?.engineStats ?? {}).filter(([, s]) => s.errors > 0).map(([name, s]) => [name, s.note ?? 'error'])),
        results: result?.results?.length ?? 0,
        cacheHit,
        tier: result?.tier,
        layer: result?.layer,
        tookMs: result?.tookMs ?? now() - started,
        topUrls: (result?.results ?? []).slice(0, 5).map((hit) => hit.url),
      })
      searchAudit.push({ engineNames: result?.enginesUsed ?? selected, engineCount: Object.keys(result?.engineStats ?? {}).length })
      return {
        ...meta,
        cacheHit,
        results: result?.results?.length ?? 0,
        created: ingest.created.filter((assoc) => assoc.text).length,
        changed: ingest.changed.length,
        textless: ingest.textless,
        errors: countEngineErrors(result?.engineStats),
        warnings: result?.warnings ?? [],
      }
    } catch (err) {
      if (signal.aborted) throw abortError()
      const message = safeMessage(err)
      warn(`search ${questionId} failed (${selected.join(', ')}): ${message}`)
      progress.get(questionId).engines = new Set([...progress.get(questionId).engines, ...selected])
      progress.get(questionId).searched++
      markRetrievalStep(questionId)
      progress.get(questionId).complexity = complexity
      recordEngineStats(Object.fromEntries(selected.map((name) => [name, { used: true, attempts: 1, successes: 0, errors: 1 }])))
      return { ...meta, cacheHit: false, results: 0, created: 0, changed: 0, textless: 0, errors: { [selected[0]]: message }, failed: true }
    }
  }

  /**
   * One page read. Every read reserves its own budget before anything can touch
   * the network, and a cache hit refunds exactly this call's network
   * reservation — never another read's. Without a reservation the read is not
   * attempted at all (the injected fetcher cannot promise a cache-only read).
   */
  async function readPage(url, focus, onDispatch) {
    if (!reserve('fetchRead')) return { skipped: true, reason: REASONS.budgetExhausted }
    if (!reserve('fetch')) {
      refund('fetchRead')
      return { skipped: true, reason: REASONS.budgetExhausted }
    }
    onDispatch?.()
    const page = await deps.runFetchPage(url, focus, signal)
    if (page?.cacheHit) refund('fetch')
    return { page }
  }

  async function executeFetch({ questionId, url, sourceKey }) {
    const signature = `f|${questionId}|${resultKey({ url })}`
    if (executed.has(signature)) return { questionId, url, skipped: true, reason: 'duplicate_action' }
    if (failedPages.has(sourceKey)) return { questionId, url, skipped: true, reason: REASONS.fetchFailed }
    const question = canonical.find((q) => q.id === questionId)
    const started = now()
    try {
      const first = await readPage(url, scopeFirst ? undefined : question.text, () => executed.add(signature))
      if (first.skipped) {
        warn(`fetch ${questionId}: no budget left for a page read of ${url}; nothing was fetched`)
        return { questionId, url, skipped: true, reason: first.reason }
      }
      // Attempted reads are recorded; a read that never started is not.
      executed.add(signature)
      let page = first.page
      if (page?.focusMiss) {
        // A focus miss does not mean the page has no answer: re-read the same
        // page without focus. That re-read reserves its own budget and is
        // skipped when none is left.
        const reread = await readPage(url, undefined)
        if (reread.skipped) warn(`fetch ${questionId}: focus-miss re-read skipped (${reread.reason}) for ${url}`)
        else if (reread.page?.content) page = { ...reread.page, focusMiss: true }
      }
      const ingest = evidence.ingestFetch({ questionId, sourceKey, page, round: used.rounds, focusMiss: Boolean(page?.focusMiss),
        researchPoints: scopeFirst ? [...finalGaps.keys()].map(index => keywordList(question)[index]) : [] })
      markRetrievalStep(questionId)
      if (!ingest.changed) warn(`fetch ${questionId}: ${ingest.reason} for ${url}`)
      return {
        questionId,
        url,
        via: page?.via ?? null,
        words: page?.word_count ?? 0,
        focusMiss: Boolean(page?.focusMiss),
        changed: ingest.changed,
        reason: ingest.reason,
        tookMs: now() - started,
      }
    } catch (err) {
      if (signal.aborted) throw abortError()
      const message = safeMessage(err)
      failedPages.add(sourceKey)
      const assoc = evidence.associationsFor(questionId).find((item) => item.sourceKey === sourceKey)
      if (assoc) assoc.fetch = { state: 'failed', via: null, words: 0, atRound: used.rounds }
      warn(`fetch ${questionId} failed for ${url}: ${message}`)
      return { questionId, url, failed: true, error: message, tookMs: now() - started }
    }
  }

  // --------------------------------------------------------------- judgements

  function selectPendingCandidates(pending, batchIndex=0) {
    const groups = canonical.map((q) => pending.filter((c) => c.questionId === q.id).slice(0, limits.maxSourceJudgeCandidatesPerQuestion))
    const out = []
    const rotation = (used.rounds - 1 + batchIndex) % Math.max(1, groups.length)
    for (let i = 0; i < limits.maxSourceJudgeCandidatesPerQuestion; i++) {
      for (let j = 0; j < groups.length; j++) {
        const item = groups[(j + rotation) % groups.length][i]
        if (item) out.push(item)
      }
    }
    return out
  }

  function finalHeadroom(request, downstream = 0) {
    if (!keywordMode) return true
    // The frozen fact mode reserves its final checks; the default retrieval mode
    // reserves one bounded continuation decision per still-open target.
    if (!retrievalMode && finalChecks>=limits.maxFinalChecks) return true
    // One bounded reserved request per unfinished target is conservative even if
    // batching later combines them. Never increase any configured hard cap.
    const targets=scopeFirst ? (finalAccepted() ? 0 : 1) : retrievalMode
      ? canonical.filter((q)=>openKeywordsFor(q).length).length
      : canonical.filter(q=>!finished.has(q.id)).length
    const retries=limits.maxJevRetries+1
    const estimate=estimateJevTokens(JSON.stringify(request.state).length+JSON.stringify(request.questions).length)
    const reserved = targets + downstream
    const finalTokens=reserved*estimateJevTokens(limits.maxRequestChars)
    const callsFit = used.jevCalls+1+reserved<=budget.maxJevCalls
      && used.jevHttpAttempts+retries*(1+reserved)<=budget.maxJevHttpAttempts
    const tokensFit = Math.max(used.estimatedTokens,used.jevInputTokens)+estimate+finalTokens<=budget.maxJevInputTokens
    if (scopeFirst && (!callsFit || !tokensFit)) judgementBudgetPause = callsFit ? STOP_REASONS.budgetTokens : STOP_REASONS.budgetCalls
    return callsFit && tokensFit
  }

  // Independent retrieval recovery: textless candidates or thin borderline
  // non-pass snippets can get one page read. Never promote without reassessment.
  function rescuePlan() {
    if (!scopeFirst || typeof deps.runFetchPage !== 'function' || used.fetchCalls >= budget.maxFetchCalls || used.fetchReads >= budget.maxFetchReads) return []
    const q = canonical[0]
    const fetched = evidence.associationsFor(q.id).filter(a => executed.has(`f|${q.id}|${resultKey({ url: materialOf(a).url })}`)).length
    const cap = Math.min(limits.maxScopeRescuesPerRound ?? 4, limits.maxFetchesPerQuestion - fetched, budget.maxFetchCalls - used.fetchCalls)
    if (cap <= 0) return []
    const rows = evidence.associationsFor(q.id).filter(a => {
      const scope = scopeOf(a), material = materialOf(a)
      if (a.basis === 'fetched_page' || failedPages.has(a.sourceKey)
        || executed.has(`f|${q.id}|${resultKey({ url: material.url })}`)) return false
      return !a.text || (scope.route === 'reject' && a.basis === 'snippet'
        && countWords(a.text) < 80 && (scope.checks[0]?.probability ?? 0) >= .5)
        || (scope.route === 'eligible' && [...finalGaps.keys()].some(index => (keywordMatchOf(a.judgment, keywordList(q)[index]) ?? 0) > thresholds.keywordMatch) && usefulEligible(a.judgment, thresholds))
    }).sort((a,b) => (scopeOf(b).checks?.filter(c => c.state === 'pass').length ?? 0)
      - (scopeOf(a).checks?.filter(c => c.state === 'pass').length ?? 0)
      || (b.fusionScore ?? 0) - (a.fusionScore ?? 0))
    const urls = rows.slice(0, cap).map(a => ({ url: materialOf(a).url, sourceKey: a.sourceKey, evidenceId: a.id }))
    return urls.length ? [{ questionId: q.id, action: { key: 'fetch_pages', params: { urls } } }] : []
  }

  async function scopeJudgeRound(roundEntry) {
    const prior = roundEntry.judgment?.scopeJudge ?? { judged: 0, microBatches: 0 }
    if (prior.microBatches >= limits.maxSourceJudgeMicroBatches || !timeBudgetOk()) return false
    const request = scopeJudgeRequest(canonical[0], scopeCandidates(), limits, thresholds)
    if (!request) return false
    // Preserve BOTH the downstream quality request and the final review. Do not
    // burn the whole token budget proving scope for hundreds of unread rows.
    if (!finalHeadroom(request, 1)) { warn('Scope draining paused to preserve quality/final-review headroom; unchecked materials stay pending'); return false }
    let result
    const callsBefore = used.jevCalls
    try { result = await jevAsk('scope_judge', request, `scope_judge#${prior.microBatches}`) }
    catch (err) {
      if (used.jevCalls > callsBefore) for (const mapping of request.mapping) {
        const assoc = evidence.association(mapping.assocId)
        if (assoc && scopeOf(assoc).version === mapping.scopeVersion) assoc.scope = readScope(new Map(), mapping, thresholds)
      }
      handleJevFailure(err, 'scope_judge', roundEntry); return false
    }
    let judged = 0
    for (const mapping of request.mapping) {
      const assoc = evidence.association(mapping.assocId)
      if (!assoc || scopeOf(assoc).version !== mapping.scopeVersion) continue
      const attemptKey = `${assoc.assocKey}:${mapping.scopeVersion}`
      const priorAttempt = scopeAssessmentAttempts.get(attemptKey)
      scopeAssessmentAttempts.set(attemptKey, { count: (priorAttempt?.count ?? 0) + 1, round: used.rounds })
      assoc.scope = readScope(result.entries, mapping, thresholds)
      if (assoc.qualityScopeVersion !== mapping.scopeVersion) { assoc.judgment = null; assoc.judgmentVersion = null }
      judged++
    }
    retrievalCache.clear()
    roundEntry.judgment = { ...(roundEntry.judgment ?? {}), scopeJudge: {
      judged: prior.judged + judged, microBatches: prior.microBatches + 1, pending: scopeCandidates().length } }
    return judged > 0
  }

  async function scopeAndQualityRound(roundEntry) {
    // Bound this round's assessment effort as well as the whole run. Otherwise
    // a broad pool for point A can consume the budget before searching point B.
    if (readyForFinal()) return
    const cap = Math.min(limits.maxSourceJudgeMicroBatches, limits.maxScopeQualityBatchesPerRound ?? 2)
    for (let batch = 0; batch < cap; batch++) {
      const pending = pendingSourceCandidates()
      const freshScope = scopeCandidates().some(item => item.collectedRound === used.rounds)
      if (pending.length && !freshScope) await sourceJudgeRound(roundEntry)
      else if (scopeCandidates().length) {
        if (!await scopeJudgeRound(roundEntry) || stopReason) break
        await sourceJudgeRound(roundEntry)
      } else if (pending.length) await sourceJudgeRound(roundEntry)
      else break
      if (stopReason || judgementBudgetPause || readyForFinal()) break
    }
  }

  async function singleTargetFinalRound(roundEntry) {
    const q = canonical[0]
    const states = retrievalStates(q)
    const signature = admittedSignature()
    // Per-keyword admission is computed from current qualified groups, not a
    // model promise or a monotonic historical counter.
    roundEntry.keywordDecisions = states.map(s => ({ keyword: s.keyword, admitted: s.distinct, ready: s.localRows.length > 0 }))
    if (!states.length || !readyForFinal()) { syncRetrievalFinished(); return { judged: 0, skipped: true } }
    if (finalAccepted()) return { judged: 0, skipped: true }
    if (finalReview.checks >= (limits.maxRetrievalFinalChecks ?? 3)) {
      stopReason = STOP_REASONS.noAction; stopDetail = 'bounded final-review attempts exhausted; material returned without a sufficient verdict'
      return { judged: 0, skipped: true }
    }
    const pending = retrievalRows(q).filter(r => r.text && r.scope.route !== 'reject' && r.assessmentIncomplete).length
    const rows = retrievalRows(q).filter(isUsefulRow)
    const candidate = retrievalFinalRequest(q, states, rows, pending)
    const request = requestFits(candidate, limits) ? candidate : null
    if (!request) {
      warn('All admitted material cannot fit one whole-question final request; no sampled or batch-vote verdict was substituted')
      stopReason = STOP_REASONS.budgetTokens
      stopDetail = 'full admitted set exceeds the bounded final request; all results are retained, but final review is incomplete'
      return { judged: 0, skipped: true }
    }
    let result
    const callsBefore = used.jevCalls
    try { result = await jevAsk('retrieval_final', request) }
    catch (err) { handleJevFailure(err, 'retrieval_final', roundEntry); return { judged: 0, skipped: true } }
    finally {
      if (used.jevCalls > callsBefore) finalReview = { status: 'pending', checks: finalReview.checks + 1, signature,
        contentSignature: currentContentSignature(), searchCalls: used.searchCalls, inputMaterials: rows.length, allMaterialsIncluded: true }
    }
    const read = readChoice(result.entries, 'final.next', Object.keys(request.questions['final.next'].criteria))
    if (signature !== admittedSignature()) { finalReview.status = 'stale'; return { judged: 0, skipped: true } }
    if (finalDecisionEstablished(read, Object.keys(request.questions['final.next'].criteria), thresholds)) {
      if (read.choice === 'finish') { finalReview.status = 'finish'; finalGaps.clear() }
      else {
        const index = Number(read.choice.slice('keyword'.length))
        finalReview.status = 'continue'
        finalGaps.clear(); finalGaps.add(index)
      }
    } else warn('Missing or uncertain whole-question final judgement; no sufficient verdict was inferred')
    syncRetrievalFinished()
    roundEntry.judgment = { ...(roundEntry.judgment ?? {}), retrievalFinal: { status: finalReview.status, checks: finalReview.checks } }
    return { judged: 1, skipped: false }
  }

  async function sourceJudgeRound(roundEntry) {
    // Pending material is drained in bounded micro-batches instead of one
    // small slice per round: each batch is one judge request, fair-rotated
    // across questions. The loop stops on empty pending, exhausted batches,
    // lost time budget, or a Jev failure — never silently dropping the rest.
    const prior = roundEntry.judgment?.sourceJudge ?? { candidates: 0, judged: 0, microBatches: 0 }
    let judged = 0
    let scheduled = 0
    let batches = 0
    let stopped = false
    while (batches + prior.microBatches < limits.maxSourceJudgeMicroBatches && !stopped) {
      const pending = pendingSourceCandidates().filter((item) => !finished.has(item.questionId))
      if (!pending.length) break
      const selected = selectPendingCandidates(pending,batches)
      const requests = sourceJudgeRequests({ questions: canonical, candidates: selected, limits })
      if (!requests.length || !requests[0].mapping.length) break
      for (const request of requests) {
        if (!timeBudgetOk()) { stopped = true; break }
        // Default mode reserves budget for the keyword continuation decisions;
        // that reservation is never spent on draining unrelated material.
        if (keywordMode && !finalHeadroom(request) && (retrievalMode || allKeywordStates().every(k=>k.ready))) {
          warn('Source draining paused to preserve continuation-decision headroom; remaining associations stay pending')
          stopped=true;break
        }
        scheduled += request.mapping.length
        let result
        const callsBefore = used.jevCalls
        const attemptKeys = retrievalMode ? request.mapping.map(assessmentKey) : []
        try {
          result = await jevAsk('source_judge', request, `source_judge#${prior.microBatches + batches}`)
        } catch (err) {
          handleJevFailure(err, 'source_judge', roundEntry)
          stopped = true
          break
        } finally {
          if (used.jevCalls > callsBefore) for (const key of attemptKeys) {
            const prior = sourceAssessmentAttempts.get(key)
            sourceAssessmentAttempts.set(key, { count: (prior?.count ?? 0) + 1, round: used.rounds })
          }
        }
        const judgments = []
        for (const item of request.mapping) {
          const kindRead = retrievalMode && item.ids.kind
            ? readChoice(result.entries, item.ids.kind, ['direct', 'lead', 'counterevidence', 'context', 'unknown'])
            : null
          const scores = retrievalMode ? {
            relevance: readNoul(result.entries, item.ids.relevance).value,
            reading_value: readNoul(result.entries, item.ids.reading_value).value,
            // A missing direction answer loses the intent bonus and stays null;
            // it is never read as a successful match.
            direction_match: item.ids.direction_match ? readNoul(result.entries, item.ids.direction_match).value : null,
            injection: readNoul(result.entries, item.ids.injection).value,
            ...(item.ids.time_match ? { time_match: readNoul(result.entries, item.ids.time_match).value } : {}),
            kind: kindRead?.valid && (kindRead.confidence === null || kindRead.confidence >= thresholds.actionConfidence) ? kindRead.choice : 'unknown',
            keywords: (item.keywords ?? []).map((k) => ({ keyword: k.keyword, match: readNoul(result.entries, k.ids.match).value })),
            topics: (item.topics ?? []).map((t) => ({ topicId: t.topicId, match: readNoul(result.entries, t.ids.match).value })),
          } : {
            relevant: routeNoul(result.entries, item.ids.relevant, thresholds.relevance).value,
            states_evidence: routeNoul(result.entries, item.ids.states_evidence, thresholds.statesEvidence).value,
            premise_conflict: routeNoul(result.entries, item.ids.premise_conflict, thresholds.premiseConflict).value,
            injection: routeNoul(result.entries, item.ids.injection, thresholds.injection).value,
            ...(item.ids.time_match ? { time_match: readNoul(result.entries, item.ids.time_match).value } : {}),
            ...(keywordMode ? {keywords:(item.keywords??[]).map(k=>({keyword:k.keyword,...Object.fromEntries(Object.entries(k.ids).map(([field,id])=>[field,readNoul(result.entries,id).value]))}))} : {}),
            ...(keywordMode ? {facts:(item.facts??[]).map(f=>{
              const stance=readChoice(result.entries,f.ids.stance,['support','refute','unknown'])
              const candidate=request.candidates.find(c=>c.evidenceId===item.evidenceId)
              const dateEligible=!f.timeWindow || inspectDates(candidate,f.timeWindow).status==='eligible'
              return {factId:f.factId,support:dateEligible ? readNoul(result.entries,f.ids.support).value : null,
                stance:stance.valid && stance.confidence>=thresholds.actionConfidence ? stance.choice : 'unknown',
                independent:readNoul(result.entries,f.ids.independent).value}
            })} : {}),
          }
          if (scopeFirst) {
            const assoc = evidence.association(item.assocId)
            const candidate = request.candidates.find(c => c.assocId === item.assocId)
            const judgedVersion = scopeVersion(canonical[0], candidate, thresholds)
            if (scopeOf(assoc).route !== 'eligible' || scopeOf(assoc).version !== judgedVersion) continue
            assoc.qualityScopeVersion = judgedVersion
          }
          judgments.push({ assocId: item.assocId, textVersion: item.textVersion, scores, round: used.rounds })
        }
        const applied = evidence.applySourceJudgments(judgments)
        if (retrievalMode) retrievalCache.clear() // same text can gain previously missing typed answers
        judged += applied.applied
        funnel.reviewedAssociations += applied.applied
        funnel.staleJudgments += applied.stale
        if (applied.stale) warn(`source judge: ${applied.stale} judgement(s) discarded because the reviewed text changed`)
      }
      batches++
      if (scopeFirst) break // one bounded quality batch per research scheduling step
    }
    const remaining = evidence.pendingSourceJudge(retrievalMode ? { needsReview: needsRetrievalReview } : {}).filter((item) => !finished.has(item.questionId)
      && (!scopeFirst || scopeOf(evidence.association(item.assocId)).route === 'eligible')).length
    if (remaining > 0) {
      roundEntry.deferredSourceJudgments = remaining
      funnel.deferredJudgmentsTotal += remaining
    }
    if (batches > 0) sourceJudgeRuns += batches
    roundEntry.judgment = { ...(roundEntry.judgment ?? {}), sourceJudge: { candidates: prior.candidates + scheduled, judged: prior.judged + judged, microBatches: prior.microBatches + batches } }
    return { judged, skipped: batches === 0 }
  }

  /**
   * One bounded typed continuation decision per open keyword.
   *
   * Code decides which keywords exist and which are still open (Jev is never
   * asked whether a list is empty), and code re-checks a `satisfied` answer
   * against current qualified useful material before accepting it. A missing,
   * invalid or failed answer leaves the keyword pending — never exhausted, and
   * never a silent stop.
   */
  async function keywordJudgeRound(roundEntry) {
    if (!retrievalMode) return { judged: 0, skipped: true }
    if (scopeFirst) return await singleTargetFinalRound(roundEntry)
    const note = (questionId, keyword, status, reason) => {
      roundEntry.keywordDecisions = [...(roundEntry.keywordDecisions ?? []), { questionId, keyword, status, reason }]
    }
    const entries = []
    for (const q of canonical) {
      const open = retrievalStates(q)
        .filter((state) => unresolvedKeywordStatus(keywordQueueStatus(q, state).status))
        .map((state) => ({ index: state.index, keyword: state.keyword, eligible: state.eligible, distinct: state.distinct,
          score: state.score, A: state.A, F: state.F, R: state.R,
          material: [...state.localRows].sort((a, b) =>
            readingValue(b.judgment, { intentPresent: scopeFirst || Boolean(q.intent), lambda: thresholds.directionLambda }) * keywordMatchOf(b.judgment, state.keyword)
            - readingValue(a.judgment, { intentPresent: scopeFirst || Boolean(q.intent), lambda: thresholds.directionLambda }) * keywordMatchOf(a.judgment, state.keyword))
            .slice(0, 3).map(row => ({ url: row.url, text: row.text, kind: row.judgment?.kind ?? 'unknown' })),
          pending: retrievalRows(q).filter(row => row.text && !row.assessed).length,
          successfulEngines: progress.get(q.id).successful.size,
          searched: progress.get(q.id).searched }))
      if (open.length) entries.push({ question: q, keywords: open })
    }
    if (!entries.length) return { judged: 0, skipped: true }
    const { requests, unfittable } = keywordContinuationRequests({ questions: canonical, entries, limits })
    for (const item of unfittable) {
      const q = canonical.find((entry) => entry.id === item.questionId)
      recordKeywordDecision(q, item.index, { status: 'pending', reason: REASONS.keywordPending, round: used.rounds })
      note(q.id, item.keyword, 'pending', REASONS.keywordPending)
      warn(`${q.id}: the continuation decision for ${JSON.stringify(item.keyword)} does not fit the request budget; it stays pending`)
    }
    const markPending = (mapping) => {
      for (const item of mapping) {
        const q = canonical.find((entry) => entry.id === item.questionId)
        recordKeywordDecision(q, item.index, { status: 'pending', reason: REASONS.keywordPending, round: used.rounds })
        note(q.id, item.keyword, 'pending', REASONS.keywordPending)
      }
    }
    let judged = 0, batches = 0
    for (const [requestIndex, request] of requests.entries()) {
      const remainingMapping = () => requests.slice(requestIndex).flatMap(entry => entry.mapping)
      if (!timeBudgetOk()) { markPending(remainingMapping()); break }
      let result
      try {
        result = await jevAsk('keyword_judge', request, `keyword_judge#${batches}`)
      } catch (err) {
        markPending(remainingMapping())
        handleJevFailure(err, 'keyword_judge', roundEntry)
        break
      }
      for (const item of request.mapping) {
        const q = canonical.find((entry) => entry.id === item.questionId)
        const state = retrievalStates(q).find((entry) => entry.index === item.index)
        if (!state) continue
        const read = readChoice(result.entries, item.ids.status, ['continue', 'satisfied', 'exhausted'])
        if (!read.valid || read.confidence === null || read.confidence < thresholds.actionConfidence) {
          recordKeywordDecision(q, item.index, { status: 'pending', reason: REASONS.keywordPending, round: used.rounds })
          note(q.id, item.keyword, 'pending', REASONS.keywordPending)
          continue
        }
        const localRows = state.localRows ?? []
        if (read.choice === 'satisfied' && !localRows.length) {
          // A typed answer alone can never satisfy a keyword: at least one
          // CURRENT code-qualified useful result must match it.
          warn(`${q.id}: keyword ${JSON.stringify(item.keyword)} was answered satisfied without a current qualified useful result; the keyword stays open`)
          recordKeywordDecision(q, item.index, { status: 'continue', reason: REASONS.keywordDecisionUnqualified, round: used.rounds })
          note(q.id, item.keyword, 'continue', REASONS.keywordDecisionUnqualified)
          continue
        }
        const missingMatches = read.choice === 'exhausted'
          ? retrievalRows(q).filter(row => isUsefulRow(row) && keywordMatchOf(row.judgment, item.keyword) === null)
          : []
        if (read.choice === 'exhausted' && (!progress.get(q.id).successful.size
          || retrievalRows(q).some(row => row.text && !row.assessed)
          || missingMatches.some(sourceAssessmentRetryable))) {
          recordKeywordDecision(q, item.index, { status: 'continue', reason: REASONS.keywordContinue, round: used.rounds })
          note(q.id, item.keyword, 'continue', REASONS.keywordContinue)
          warn(`${q.id}: exhaustion rejected while engines have not succeeded or collected material remains pending`)
          continue
        }
        if (missingMatches.length) {
          // A valid exhaustion decision may close a search after optional match
          // retries run out. Mandatory relevance/safety judgments still gate it;
          // unresolved matches remain disclosed and never imply satisfaction.
          warn(`${q.id}: keyword-match assessment retries exhausted for ${JSON.stringify(item.keyword)}; accepting the explicit exhausted decision with unresolved matches (not proof of absence)`)
        }
        const decision = read.choice === 'satisfied'
          ? { status: 'satisfied', reason: REASONS.keywordSatisfied, round: used.rounds, justification: localRows.map((row) => ({ assocId: row.assocId, textVersion: row.textVersion })) }
          : { status: read.choice, reason: read.choice === 'exhausted' ? REASONS.keywordExhausted : REASONS.keywordContinue,
              round: used.rounds, materialSnapshot: materialSnapshot(q) }
        recordKeywordDecision(q, item.index, decision)
        note(q.id, item.keyword, decision.status, decision.reason)
        judged++
      }
      batches++
    }
    syncRetrievalFinished()
    roundEntry.judgment = { ...(roundEntry.judgment ?? {}), keywordJudge: { asked: entries.reduce((sum, entry) => sum + entry.keywords.length, 0), judged, microBatches: batches } }
    return { judged, skipped: judged === 0 }
  }

  async function factBundleRound(roundEntry) {
    if (!keywordMode || evidence.pendingSourceJudge().length) return
    let checked = 0, attempted = 0
    const offset=(used.rounds-1)%canonical.length
    const ordered=[...canonical.slice(offset),...canonical.slice(0,offset)]
    for (const q of ordered) {
      if (attempted>=limits.maxFactBundleCallsPerRound) break
      if (finished.has(q.id) || !timeBudgetOk()) continue
      const states = keywordProgress(q)
      if (states.every(k => k.ready) || !states.some(k => k.missingFacts.length)) continue
      const {qualified, classified} = qualifiedFor(q.id)
      const signature = classified.map(x=>`${x.assoc.id}:${x.assoc.textVersion}:${x.assoc.judgmentVersion}`).join('|')
      if (factBundles.get(q.id)?.signature === signature) continue
      // Exact clones supply no complementary context. Do not use containment:
      // a mostly duplicated paragraph may contain the missing condition.
      const texts = new Set()
      const unique = qualified.filter(item => {
        const key = item.text.replace(/\s+/gu,' ').trim()
        if (texts.has(key)) return false
        texts.add(key); return true
      })
      let kept = enforceTextBudget(unique, limits.maxQualifiedTextCharsPerQuestion)
      let request = factBundleRequest(q, kept)
      while (kept.length > 1 && !requestFits(request, limits)) {
        kept = kept.slice(0,-1); request = factBundleRequest(q, kept)
      }
      if (kept.length < 2 || !requestFits(request,limits)) continue
      let result
      if (!finalHeadroom(request)) { warn('Optional fact-bundle assessment deferred to preserve final-check headroom'); break }
      attempted++
      try { result = await jevAsk('fact_bundle',request,`fact_bundle#${q.id}`) }
      catch (err) {
        if (err instanceof BudgetExhausted || signal.aborted || JEV_FATAL_KINDS.has(err.kind)
          || err.kind===JEV_ERROR_KINDS.cancelled || err.kind===JEV_ERROR_KINDS.rateLimited) {
          handleJevFailure(err,'fact_bundle',roundEntry);break
        }
        // A transient enrichment failure cannot manufacture F or end otherwise
        // useful retrieval. Do not retry the same snapshot on the next round.
        factBundles.set(q.id,{signature,row:null})
        warn(`${q.id}: optional fact-bundle assessment failed (${err.kind??'network'}); facts remain unresolved`)
        continue
      }
      const facts = request.mapping.map(f => {
        const stance=readChoice(result.entries,f.ids.stance,['support','refute','unknown'])
        const dateEligible=!f.timeWindow || kept.some(item=>inspectDates(item,f.timeWindow).status==='eligible')
        return {factId:f.factId,support:dateEligible ? readNoul(result.entries,f.ids.support).value : null,
          stance:stance.valid && stance.confidence>=thresholds.actionConfidence ? stance.choice : 'unknown', independent:0}
      })
      const admitted = kept.map(item => classified.find(x=>x.assoc.id===item.evidenceId).assoc.judgment)
      const strongest=admitted.map(j=>j.keywords.filter(k=>k.relevant>thresholds.relevance && k.states_evidence>thresholds.statesEvidence)
        .sort((a,b)=>Math.min(b.relevant,b.states_evidence)-Math.min(a.relevant,a.states_evidence))[0])
      // Admission is inherited only from already-qualified material. This row
      // can affect F, never A or independent-source R.
      const row = {bundle:true,evidenceId:`bundle:${q.id}`,witnesses:kept.map(item=>item.evidenceId),
        text:kept.map(item=>item.text).join('\n'),facts,
        judgment:{relevant:Math.min(...strongest.map(k=>k.relevant)),states_evidence:Math.min(...strongest.map(k=>k.states_evidence)),injection:Math.max(...admitted.map(j=>j.injection))}}
      factBundles.set(q.id,{signature,row})
      keywordCache.delete(q.id)
      checked++
    }
    roundEntry.judgment = {...roundEntry.judgment, factBundle:{checked,attempted}}
  }

  /** The verdict that is valid for the CURRENT text versions, never a stale one. */
  function currentVerdict(questionId) {
    const record = results.get(questionId)
    const { classified, qualified } = qualifiedFor(questionId)
    const signature = evidence.versionSignature(questionId, qualified.map((item) => item.assocId))
    const fresh = Boolean(record.coverage && record.coverage.versionSignature === signature)
    return { record, classified, qualified, signature, fresh }
  }

  /**
   * End one question honestly. A covered verdict only survives when it is still
   * about the exact same evidence versions; changed evidence is unassessed.
   */
  function finalizeQuestion(questionId, fallbackReason) {
    const { record, classified, qualified, fresh } = currentVerdict(questionId)
    const entry = progress.get(questionId)
    if (fresh && record.status === 'covered') {
      finished.add(questionId)
      return
    }
    if (record.status === 'covered') {
      // The evidence set moved after the verdict: do not carry it over.
      record.status = 'unassessed'
      record.assessed = false
      if (!record.reasons.includes(REASONS.unassessed)) record.reasons = [...record.reasons, REASONS.unassessed]
    }
    if (!record.reasons.length) record.reasons = [fallbackReason]
    const hasAnyText = classified.some((item) => item.assoc.text)
    if (record.assessed && fresh) {
      record.status = 'insufficient'
    } else if (hasAnyText) {
      const anyJudged = classified.some((item) => item.assessed)
      const anyIncomplete = classified.some((item) => item.assessed && item.judgmentIncomplete)
      if (qualified.length) {
        // Qualified material exists but no coverage verdict is valid for it.
        record.status = 'unassessed'
        if (!record.reasons.includes(REASONS.unassessed) && !record.reasons.includes(REASONS.jevUnavailable)) record.reasons = [...record.reasons, REASONS.unassessed]
      } else if (anyIncomplete) {
        record.status = 'unassessed'
        if (!record.reasons.includes(REASONS.judgmentMissing)) record.reasons = [...record.reasons, REASONS.judgmentMissing]
      } else if (anyJudged) {
        // The material was judged and did not qualify: an honest negative, not an
        // unfinished judgement.
        record.status = 'insufficient'
        const gateReason = classified.some((item) => item.assoc.text && !item.dateEligible && !item.injectionSuspected)
          ? REASONS.dateUnqualified
          : classified.filter((item) => item.assoc.text).every((item) => item.injectionSuspected)
            ? REASONS.injectionSuspectedOnly : REASONS.noAnswerCapableEvidence
        if (!record.reasons.includes(gateReason)) record.reasons = [...record.reasons, gateReason]
      } else {
        record.status = record.status === 'failed' ? 'failed' : 'unassessed'
        if (!record.reasons.includes(REASONS.unassessed) && !record.reasons.includes(REASONS.jevUnavailable)) record.reasons = [...record.reasons, REASONS.unassessed]
      }
    } else if (entry.searched === 0) {
      record.status = 'not_searched'
      const searchBlocked = used.searchCalls >= budget.maxSearchCalls
      record.reasons = [...new Set([
        ...(searchBlocked ? [REASONS.budgetExhausted] : []),
        REASONS.notSearched,
        ...record.reasons.filter((reason) => reason !== fallbackReason),
      ])]
    } else if (entry.successful.size === 0) {
      record.status = 'failed'
      if (!record.reasons.includes(REASONS.enginesFailed)) record.reasons = [...record.reasons, REASONS.enginesFailed]
    } else {
      // Searched successfully but nothing usable came back — that is an answer to
      // report honestly, not an unassessed judgement.
      record.status = 'insufficient'
      if (!record.reasons.includes(REASONS.noAnswerCapableEvidence)) record.reasons = [...record.reasons, REASONS.noAnswerCapableEvidence]
    }
    if (qualified.length && record.status === 'insufficient' && record.reasons.length === 1 && record.reasons[0] === fallbackReason) {
      record.reasons = [...record.reasons, REASONS.noAnswerCapableEvidence]
    }
    finished.add(questionId)
  }

  /** Code filter: the exact qualified set the coverage judgement is allowed to see. */
  function qualifiedFor(questionId) {
    const list = evidence.associationsFor(questionId)
    const classified = list.map((assoc) => ({ assoc, ...answerCapableOf(assoc, thresholds) }))
    const q = canonical.find((q) => q.id === questionId)
    for (const item of classified) {
      const source = evidence.source(item.assoc.sourceKey)
      item.dates = inspectDates({ published: source?.published, text: item.assoc.text }, q.timeWindow)
      item.dateEligible = !q.timeWindow || (item.dates.status === 'eligible' && item.assoc.judgment?.time_match > thresholds.statesEvidence)
      item.answerCapable = item.answerCapable && item.dateEligible
    }
    const answerCapable = classified.filter((item) => item.answerCapable)
    const qualified = answerCapable.map((item) => {
      const source = evidence.source(item.assoc.sourceKey)
      return {
        assocId: item.assoc.assocKey,
        evidenceId: item.assoc.id,
        textVersion: item.assoc.textVersion,
        url: source?.displayUrl ?? source?.url ?? '',
        title: source?.title ?? '',
        domain: source?.domain ?? '',
        published: source?.published ?? null,
        sourceId: source?.id,
        quality: item.assoc.judgment?.keywords
          ? Math.max(0,...item.assoc.judgment.keywords.filter(k=>k.relevant>thresholds.relevance && k.states_evidence>thresholds.statesEvidence).map(k=>Math.min(k.relevant,k.states_evidence)))
          : Math.min(item.assoc.judgment?.relevant ?? 0, item.assoc.judgment?.states_evidence ?? 0),
        basis: item.assoc.basis,
        text: item.assoc.text,
        words: countWords(item.assoc.text),
      }
    })
    qualified.sort((a, b) => b.quality - a.quality || a.evidenceId.localeCompare(b.evidenceId))
    return { classified, qualified }
  }

  function enforceTextBudget(qualified, maxChars) {
    const kept = []
    let usedChars = 0
    // Never discard a superset with new facts merely for text containment.
    const distinct=qualified.map(item=>({item}))
    for (const {item} of distinct.slice(0, limits.maxCoverageEvidencePerQuestion)) {
      if (kept.length > 0 && usedChars + item.text.length > maxChars) break
      kept.push(item)
      usedChars += item.text.length
    }
    return kept
  }

  function missingExplicitTokens(questionText, qualified) {
    const tokens = explicitTokens(questionText)
    if (!tokens.length) return []
    const haystack = qualified.map((item) => item.text).join('\n')
    return tokens.filter((token) => !textStatesToken(haystack, token))
  }

  async function coverageJudgeRound(roundEntry) {
    if(keywordMode) {
      if(!allKeywordStates().every(k=>k.ready) || finalChecks>=limits.maxFinalChecks) return {skipped:true,judged:0}
    }
    const entries = []
    for (const q of canonical) {
      const record = results.get(q.id)
      const { qualified } = qualifiedFor(q.id)
      const signature = evidence.versionSignature(q.id, qualified.map((item) => item.assocId))
      const prior = record.coverage
      const unchanged = prior && prior.versionSignature === signature
      if (unchanged) continue
      if (!qualified.length) {
        record.coverage = null
        if (q.timeWindow && evidence.associationsFor(q.id).some((a) => a.text)) {
          record.gap = 'date'
          record.reasons = [REASONS.dateUnqualified]
        }
        continue
      }
      const witnessIds = keywordMode ? [...new Set(keywordProgress(q).flatMap(k => k.witnesses))] : []
      const orderedQualified=[...qualified].sort((a,b)=>{
        const ai=witnessIds.indexOf(a.evidenceId),bi=witnessIds.indexOf(b.evidenceId)
        return (ai<0?Infinity:ai)-(bi<0?Infinity:bi)
      })
      const budgeted = enforceTextBudget(orderedQualified, limits.maxQualifiedTextCharsPerQuestion)
      if (keywordMode && witnessIds.some(id => !budgeted.some(item => item.evidenceId === id))) {
        warn(`${q.id}: final evidence budget cannot include all fact/contradiction witnesses; not declared covered`)
        record.gap='fact'
        roundEntry.deferredCoverageJudgments=(roundEntry.deferredCoverageJudgments??0)+1
        continue
      }
      const hasStrongBasis = budgeted.some((item) => item.basis === 'fetched_page' || item.basis === 'engine_content')
      entries.push({ question: q, qualified: budgeted, signature, snippetSelfSufficiency: !hasStrongBasis })
    }
    if (!entries.length) return { skipped: true, judged: 0 }
    if(keywordMode) finalChecks++
    const ordered = [...entries.slice((used.rounds - 1) % entries.length), ...entries.slice(0, (used.rounds - 1) % entries.length)]
    const chunks = []
    let current = []
    for (const entry of ordered) {
      if (requestFits(coverageRequest({ questions: [...current, entry], limits, keywordMode }), limits)) current.push(entry)
      else if(keywordMode) {
        if(current.length)chunks.push(current)
        current=requestFits(coverageRequest({questions:[entry],limits,keywordMode}),limits)?[entry]:[]
      }
    }
    if(current.length)chunks.push(current)
    const included=chunks.reduce((n,c)=>n+c.length,0)
    if (included < entries.length) roundEntry.deferredCoverageJudgments = entries.length - included
    for (const [chunkIndex, chunk] of chunks.entries()) {
      if (!timeBudgetOk()) break
      const request = coverageRequest({ questions: chunk, limits, keywordMode })
      funnel.coverageInputEvidence += chunk.reduce((sum, entry) => sum + entry.qualified.length, 0)
      let result
      try {
        result = await jevAsk('coverage_judge', request, `coverage_judge#${chunkIndex}`)
      } catch (err) {
        handleJevFailure(err, 'coverage_judge', roundEntry)
        break
      }
      for (const item of request.mapping) {
        const record = results.get(item.questionId)
        const q = canonical.find((entry) => entry.id === item.questionId)
        const { qualified } = qualifiedFor(item.questionId)
        const index = chunk.findIndex((entry) => entry.question.id === item.questionId)
        const chunkEntry = chunk[index]
        const signature = evidence.versionSignature(item.questionId, qualified.map((entry) => entry.assocId))
        const coverageRead = readNoul(result.entries, item.ids.coverage)
        const gapRead = readChoice(result.entries, item.ids.gap, ['fact', 'official', 'date', 'region', 'independent', 'none'])
        if (gapRead.valid && gapRead.confidence >= thresholds.actionConfidence && gapRead.choice !== 'none') record.gap = gapRead.choice
        const conflictRead = item.ids.source_conflict ? readNoul(result.entries, item.ids.source_conflict) : { value: null, valid: false }
        const snippetRead = item.ids.snippet_self_sufficient ? readNoul(result.entries, item.ids.snippet_self_sufficient) : { value: null, valid: false }
        // A requested answer that never arrived is unknown, not a no: "not judged
        // for conflict" is not "no conflict", and an unjudged snippet is not a
        // self-sufficient one. Checks that were never requested never block.
        const conflictRequested = Boolean(item.ids.source_conflict)
        const conflictKnown = conflictRead.valid && conflictRead.value !== null
        const snippetRequested = Boolean(item.ids.snippet_self_sufficient)
        const snippetKnown = snippetRead.valid && snippetRead.value !== null
        const hasStrongBasis = chunkEntry.qualified.some((entry) => entry.basis !== 'snippet')
        const missingTokens = missingExplicitTokens([q.text,...factUnits(q).map(f=>f.question)].join("\n"), chunkEntry.qualified)
        if (keywordMode) for (const fact of factUnits(q)) {
          if (fact.timeWindow && !chunkEntry.qualified.some(item=>inspectDates(item,fact.timeWindow).status==='eligible')) missingTokens.push(`fact:${fact.id}:date`)
        }
        const conflicts = []
        if (conflictKnown && conflictRead.value > thresholds.sourceConflict) {
          conflicts.push({ kind: 'source_conflict_unresolved', probability: conflictRead.value, threshold: thresholds.sourceConflict, round: used.rounds })
        }
        const reasons = []
        let covered = false
        if (!coverageRead.valid || coverageRead.value === null) {
          reasons.push(REASONS.judgmentMissing)
        } else if (coverageRead.value <= thresholds.coverage) {
          reasons.push(REASONS.coverageBelowThreshold)
        } else if (keywordMode && (!gapRead.valid || gapRead.confidence < thresholds.actionConfidence)) {
          reasons.push(REASONS.judgmentMissing)
        } else if (keywordMode && gapRead.choice !== 'none') {
          reasons.push(REASONS.explicitRequirementUnmet)
        } else if (!qualified.length) {
          reasons.push(REASONS.noAnswerCapableEvidence)
        } else if (!hasStrongBasis && snippetRequested && !snippetKnown) {
          reasons.push(REASONS.judgmentMissing)
        } else if (!hasStrongBasis && !(snippetKnown && snippetRead.value > thresholds.snippetSelfSufficient)) {
          reasons.push(REASONS.snippetOnly)
        } else if (missingTokens.length) {
          reasons.push(REASONS.explicitRequirementUnmet)
        } else if (conflicts.length) {
          reasons.push(REASONS.sourceConflictUnresolved)
        } else if (conflictRequested && !conflictKnown) {
          reasons.push(REASONS.judgmentMissing)
        } else {
          covered = true
        }
        record.coverage = {
          probability: coverageRead.valid ? coverageRead.value : null,
          threshold: thresholds.coverage,
          basis: chunkEntry.qualified[0]?.basis ?? null,
          textBasis: bestBasis(chunkEntry.qualified),
          snippetOnly: !hasStrongBasis,
          snippetSelfSufficient: snippetRead.valid ? snippetRead.value : null,
          versionSignature: signature,
          judgedAtRound: used.rounds,
          missingExplicitRequirements: missingTokens,
          evidenceIds: chunkEntry.qualified.map((entry) => entry.evidenceId),
        }
        record.verdictTextVersion = signature
        record.lastJudgedRound = used.rounds
        record.conflicts = conflicts
        // `assessed` means the model completed every judgement this question
        // asked for. A requested answer that never arrived leaves the verdict
        // incomplete instead of silently complete.
        record.assessed = coverageRead.valid && coverageRead.value !== null
          && (!conflictRequested || conflictKnown)
          && (!snippetRequested || snippetKnown)
          && (!keywordMode || (gapRead.valid && gapRead.confidence >= thresholds.actionConfidence))
        record.status = covered ? 'covered' : 'insufficient'
        record.reasons = covered ? [] : reasons
        if (covered) { finished.add(item.questionId); reopen.delete(item.questionId) }
        else if(keywordMode) { reopen.add(item.questionId); if(gapRead.choice==='none')record.gap='fact' }
        evidence.setCoverage(item.questionId, { assocKeys: qualified.map((entry) => entry.assocId), versionSignature: signature, round: used.rounds })
      }
    }
    coverageJudgeRuns++
    roundEntry.judgment = { ...(roundEntry.judgment ?? {}), coverageJudge: { questions: entries.length } }
    return { judged: entries.length, skipped: false }
  }

  function bestBasis(qualified) {
    const order = ['fetched_page', 'engine_content', 'snippet']
    for (const basis of order) if (qualified.some((item) => item.basis === basis)) return basis
    return null
  }

  // ------------------------------------------------------------ failure paths

  function handleJevFailure(err, phase, roundEntry) {
    if (err instanceof BudgetExhausted) {
      stopReason = err.kind
      stopDetail = err.kind === STOP_REASONS.deadline ? 'deadline or minimum remaining work margin reached (Jev was not called again)'
        : err.kind === STOP_REASONS.cancelled ? ABORT_MESSAGE
          : `adaptive_search own ${err.kind.replace('budget_', '')} budget reached (Jev was not called again)`
      if (roundEntry) roundEntry.jevFailure = { phase, kind: err.kind }
      annotateUnassessed()
      return
    }
    const error = err instanceof JevError ? err : new JevError(JEV_ERROR_KINDS.network, { phase, detail: 'unexpected_error' })
    stopReason = stopReason ?? STOP_REASONS.jevUnavailable
    stopDetail = `Jev ${phase} failed: ${error.kind}${error.detail ? ` (${error.detail})` : ''}`
    if (roundEntry) roundEntry.jevFailure = { phase, kind: error.kind, status: error.status ?? null }
    if (error.kind === JEV_ERROR_KINDS.cancelled) {
      stopReason = STOP_REASONS.cancelled
      stopDetail = ABORT_MESSAGE
    } else if (error.kind === JEV_ERROR_KINDS.timeout && signal.aborted) {
      stopReason = STOP_REASONS.deadline
      stopDetail = 'deadline reached'
    }
    // Verdicts already made about unchanged evidence stay valid; everything
    // that arrived or changed later stays unassessed.
    annotateUnassessed()
  }

  /**
   * Annotate unfinished questions after a Jev failure. Verdicts about unchanged
   * evidence are kept; everything else becomes explicitly unassessed. Questions
   * are not closed here, because the fallback search round may still run.
   */
  function annotateUnassessed() {
    // Default retrieval mode keeps its per-keyword statuses: decisions are bound
    // to the reviewed material, so a Jev failure never rewrites them into a
    // verdict. Unclosed keywords stay continue/pending and are reported as such.
    if (retrievalMode) {
      syncRetrievalFinished()
      return
    }
    for (const q of canonical) {
      if (finished.has(q.id)) continue
      const record = results.get(q.id)
      const { qualified } = qualifiedFor(q.id)
      const signature = evidence.versionSignature(q.id, qualified.map((item) => item.assocId))
      const priorValid = record.coverage && record.coverage.versionSignature === signature && record.assessed
      if (priorValid && record.status === 'covered') {
        finished.add(q.id)
        continue
      }
      record.status = priorValid ? record.status : (progress.get(q.id).searched > 0 || qualified.length ? 'unassessed' : record.status)
      if (record.status === 'unassessed' && !record.reasons.includes(REASONS.jevUnavailable)) record.reasons = [...record.reasons, REASONS.jevUnavailable]
      record.assessed = Boolean(priorValid)
    }
  }

  /** Close every remaining question (after the fallback round decided the outcome). */
  function closeUnfinished() {
    annotateUnassessed()
    for (const q of canonical) finished.add(q.id)
  }

  /**
   * Run planned work with bounded concurrency. Nothing is dispatched once the
   * deadline passed or the call was cancelled, and one task's unexpected error
   * is contained: it is reported through `onError` instead of unwinding the
   * round, which would lose the other questions' results and skip assembly.
   */
  async function runContained(items, run, onError) {
    const tasks = items.map((item) => async () => {
      if (!timeBudgetOk()) return
      try {
        await run(item)
      } catch (err) {
        if (signal.aborted) return
        onError?.(item, err)
      }
    })
    await runPool(tasks, Math.min(limits.concurrency, tasks.length), (task) => task())
  }

  async function fallbackSearchRound(reason) {
    fallbackUsed = true
    stopDetail = `${stopDetail ?? reason}; a restricted plain-search fallback ran once (results stay unassessed)`
    await runContained(canonical, async (q) => {
      const engines = defaultEngineSubset([...candidateSet], scopeFirst ? Math.min(3, candidateSet.size) : keywordMode ? candidateSet.size : Math.min(3, candidateSet.size))
      const outcome = await executeSearch({
        questionId: q.id,
        engines,
        complexity: limits.defaultComplexity,
        mode: 'fallback_search',
      })
      // Retrieval mode keeps its keyword statuses; the pool is still reported.
      if (retrievalMode) return
      const record = results.get(q.id)
      const { qualified } = qualifiedFor(q.id)
      if (outcome?.created > 0 || qualified.length) record.status = 'unassessed'
      if (outcome?.failed && !progress.get(q.id).searched) record.status = 'failed'
    }, (q, err) => {
      warn(`fallback search for ${q.id} failed unexpectedly: ${safeMessage(err)}`)
    })
    closeUnfinished()
    for (const q of canonical) {
      const record = results.get(q.id)
      if (record.status === 'not_searched' && !progress.get(q.id).searched) record.reasons = [...record.reasons, REASONS.budgetExhausted]
    }
  }

  // ------------------------------------------------------------------- rounds

  try {
    while (true) {
      if (isCancelled()) {
        stopReason = STOP_REASONS.cancelled
        stopDetail = ABORT_MESSAGE
        break
      }
      if (isDeadline()) {
        stopReason = STOP_REASONS.deadline
        stopDetail = 'deadline reached'
        break
      }
      for (const q of canonical) if (results.get(q.id).status === 'covered' && !currentVerdict(q.id).fresh) finished.delete(q.id)
      // Keyword decisions are valid only for the exact material they were made
      // about: recompute the queue before planning, so changed text reopens it.
      if (retrievalMode) syncRetrievalFinished()
      const unfinished = canonical.filter((q) => !finished.has(q.id)).map((q) => q.id)
      if (!unfinished.length) {
        stopReason = stopReason ?? (retrievalMode
          ? STOP_REASONS.keywordQueueEmpty
          : canonical.every((q) => results.get(q.id).status === 'covered') ? STOP_REASONS.allCovered : STOP_REASONS.noAction)
        break
      }
      if (scopeFirst && finalReview.checks >= (limits.maxRetrievalFinalChecks ?? 3)) {
        stopReason = STOP_REASONS.noAction
        stopDetail = 'bounded final-review attempts exhausted; no further retrieval can be accepted in this run'
        break
      }
      if (used.rounds >= budget.maxRounds) {
        stopReason = STOP_REASONS.budgetRounds
        stopDetail = `round limit ${budget.maxRounds} reached`
        break
      }
      if (!timeBudgetOk()) {
        stopReason = STOP_REASONS.deadline
        stopDetail = 'deadline reached'
        break
      }
      used.rounds++
      judgementBudgetPause = null
      const roundEntry = { round: used.rounds, plan: null, search: [], fetch: [], judgment: null, failures: [] }
      roundLog.push(roundEntry)
      reportProgress(`round ${used.rounds}/${budget.maxRounds}: planning`)

      // ---- PLAN ----
      let plan
      try {
        plan = used.rounds === 1 ? (scopeFirst ? await researchPlanRound(roundEntry) : await planEngineRound(unfinished, roundEntry)) : keywordMode ? await directKeywordPlan(roundEntry) : await planActionRound(unfinished, roundEntry)
        if(keywordMode) { allocateRoundPool(plan); roundEntry.poolLimit=roundPoolLimit; roundEntry.rowQuotas=Object.fromEntries(roundQuotas) }
      } catch (err) {
        handleJevFailure(err, 'plan', roundEntry)
        if (!(err instanceof BudgetExhausted) && used.searchCalls === 0 && !fallbackUsed && timeBudgetOk() && !isCancelled() && !isDeadline()) {
          await fallbackSearchRound('Jev failed before any search')
        }
        break
      }

      // ---- EXECUTE ----
      // One planned selection. Errors stay inside their own task so a failure on
      // one question cannot lose another question's results or skip assembly.
      const runSelection = async (selection) => {
        if (selection.kind === 'search') {
          const outcome = await executeSearch(selection)
          if (outcome) roundEntry.search.push(outcome)
          return
        }
        const action = selection.action
        if (action.key === 'finish_partial') {
          finalizeQuestion(selection.questionId, REASONS.noAction)
          roundEntry.plan.actions = roundEntry.plan.actions.map((entry) => (entry.questionId === selection.questionId ? { ...entry, finished: true } : entry))
          return
        }
        if (['search_new_engines', 'search_gap'].includes(action.key)) {
          const outcome = await executeSearch({
            questionId: selection.questionId,
            engines: action.params.engines ?? [],
            complexity: limits.defaultComplexity,
            mode: action.key,
            query: action.params.query,
          })
          if (outcome) roundEntry.search.push(outcome)
          return
        }
        if (action.key === 'review_pending') return
        if (action.key === 'deepen') {
          const outcome = await executeSearch({
            questionId: selection.questionId,
            engines: action.params.engines ?? [],
            complexity: action.params.complexity ?? limits.deepenComplexity,
            mode: 'deepen',
            query: action.params.query,
          })
          if (outcome) roundEntry.search.push(outcome)
          return
        }
        if (action.key === 'fetch_pages') {
          for (const item of action.params.urls ?? []) {
            if (!timeBudgetOk()) break
            const outcome = await executeFetch({ questionId: selection.questionId, url: item.url, sourceKey: item.sourceKey })
            if (outcome) roundEntry.fetch.push(outcome)
          }
        }
      }

      plan.sort((a, b) => evidence.associationsFor(a.questionId).filter((x) => x.fetch?.state === 'ok').length - evidence.associationsFor(b.questionId).filter((x) => x.fetch?.state === 'ok').length)
      await runContained(plan, runSelection, (selection, err) => {
        const message = safeMessage(err)
        warn(`action for ${selection.questionId} failed unexpectedly: ${message}`)
        roundEntry.failures.push({ questionId: selection.questionId, action: selection.action?.key ?? selection.kind, message })
      })
      reportProgress(`round ${used.rounds}/${budget.maxRounds}: executed ${roundEntry.search.length} search(es) and ${roundEntry.fetch.length} fetch(es)`)
      if (signal.aborted && isCancelled()) {
        stopReason = STOP_REASONS.cancelled
        stopDetail = ABORT_MESSAGE
        break
      }
      if (signal.aborted && isDeadline()) {
        stopReason = STOP_REASONS.deadline
        stopDetail = 'deadline reached'
        break
      }

      // Separate scope -> quality HTTP phases, streaming admitted batches so
      // pool pressure cannot consume the whole budget before any useful output.
      if (scopeFirst) await scopeAndQualityRound(roundEntry)
      else await sourceJudgeRound(roundEntry)
      if (stopReason) break

      // ---- KEYWORD_JUDGE (default) or the frozen fact/coverage checks ----
      if (retrievalMode) {
        await keywordJudgeRound(roundEntry)
        if (stopReason) break
        if (scopeFirst && judgementBudgetPause && !finalAccepted()) {
          stopReason = judgementBudgetPause
          stopDetail = 'insufficient remaining judgement budget after reserving downstream quality/final review; unchecked material remains pending'
          break
        }
      } else {
        await factBundleRound(roundEntry)
        await coverageJudgeRound(roundEntry)
        if (stopReason) break
      }
      for (const q of canonical) if (results.get(q.id).status === 'covered' && !currentVerdict(q.id).fresh) finished.delete(q.id)
      if (retrievalMode) {
        const closed = canonical.filter(queueClosedFor).length
        reportProgress(`round ${used.rounds}/${budget.maxRounds}: ${closed}/${canonical.length} target(s) with a closed keyword queue`)
      } else {
        const stillCovered = canonical.filter((q) => results.get(q.id).status === 'covered').length
        reportProgress(`round ${used.rounds}/${budget.maxRounds}: ${stillCovered}/${canonical.length} covered`)
      }

      if(keywordMode) {
        roundEntry.keywordProgress=retrievalMode
          ? canonical.flatMap((q)=>retrievalStates(q).map((state)=>({...retrievalKeywordSummary(q,state),questionId:q.id})))
          : allKeywordStates().map(keywordSummary)
        roundEntry.admittedUniqueUrls=roundUrls.size
        const signature=canonical.map(q=>evidence.versionSignature(q.id,evidence.associationsFor(q.id).filter(a=>a.judgmentVersion===a.textVersion).map(a=>a.assocKey))).join('|')
        noProgressRounds=signature===lastProgressSignature?noProgressRounds+1:0;lastProgressSignature=signature
        if (retrievalMode) {
          // Every keyword is closed (satisfied or exhausted) -> stop. A mixed
          // list may stop here, but retrievalSufficient stays false.
          if (queueClosed()) { stopReason=STOP_REASONS.keywordQueueEmpty;stopDetail='every keyword is closed (satisfied or exhausted); closed is not proof of absence and not a complete answer';break }
          const retryable = pendingSourceCandidates({ sameRound: true }).some(item => !finished.has(item.questionId)) || (scopeFirst && (scopeCandidates().length > 0 || rescuePlan().length > 0))
          const nextSearch = canonical.some(q => nextKeywordSearch(q))
          if (!retryable && nextSearch && used.searchCalls >= budget.maxSearchCalls) {
            stopReason = STOP_REASONS.budgetCalls; stopDetail = 'search call budget exhausted; open keywords remain unresolved'; break
          }
          if (noProgressRounds >= limits.maxNoProgressRounds && !retryable && !nextSearch) {
            stopReason = STOP_REASONS.noAction; stopDetail = 'no new reviewed material, no retryable assessment and no untried query remains; open keywords are unresolved'; break
          }
          continue
        }
        if(canonical.every(q=>results.get(q.id).status==='covered'&&currentVerdict(q.id).fresh)) {stopReason=STOP_REASONS.allCovered;break}
        if(finalChecks>=limits.maxFinalChecks) {stopReason=STOP_REASONS.noAction;stopDetail='final material-gap checks exhausted; remaining targets are not complete';break}
        if(noProgressRounds>=limits.maxNoProgressRounds && !evidence.pendingSourceJudge().some(item => !finished.has(item.questionId))) {stopReason=STOP_REASONS.noAction;stopDetail='no new reviewed material; keyword scores never increase just for another round';break}
        continue
      }

      // ---- DECIDE ----
      const stillUnfinished = canonical.filter((q) => !finished.has(q.id))
      let progressed = false
      for (const q of stillUnfinished) {
        const options = feasibleActions(q.id)
        const actionable = options.filter((option) => option.key !== 'finish_partial')
        if (actionable.length) {
          progressed = true
          continue
        }
        const { record, fresh } = currentVerdict(q.id)
        if (!record.reasons.length) record.reasons = [record.assessed && fresh ? REASONS.noAnswerCapableEvidence : REASONS.noAction]
        finalizeQuestion(q.id, REASONS.noAction)
      }
      if (finished.size === canonical.length) {
        stopReason = canonical.every((q) => results.get(q.id).status === 'covered') ? STOP_REASONS.allCovered : STOP_REASONS.noAction
        break
      }
      if (!progressed) {
        stopReason = STOP_REASONS.noAction
        stopDetail = 'no actionable next step remains for the unfinished questions'
        break
      }
    }
  } finally {
    clearTimeout(timer)
    hostSignal?.removeEventListener('abort', onHostAbort)
  }

  if (retrievalMode) syncRetrievalFinished()
  else for (const q of canonical) if (!finished.has(q.id)) finalizeQuestion(q.id, REASONS.noAction)
  if (!stopReason) {
    stopReason = retrievalMode
      ? (queueClosed() ? STOP_REASONS.keywordQueueEmpty : STOP_REASONS.noAction)
      : (canonical.every((q) => results.get(q.id).status === 'covered') ? STOP_REASONS.allCovered : STOP_REASONS.noAction)
  }
  if (retrievalMode && stopReason === STOP_REASONS.keywordQueueEmpty && !stopDetail) {
    stopDetail = 'every keyword is closed (satisfied or exhausted); closed is not proof of absence and not a complete answer'
  }

  // ------------------------------------------------------------------ assembly

  function buildEvidenceView(classified, coverageIds) {
    const items = []
    for (const item of classified) {
      const assoc = item.assoc
      const source = evidence.source(assoc.sourceKey)
      const judgment = assoc.judgment && assoc.judgmentVersion === assoc.textVersion ? assoc.judgment : null
      let status = 'unassessed'
      if (!assoc.text) status = 'no_text'
      else if (!judgment) status = 'unassessed'
      else if (item.injectionSuspected) status = 'excluded_injection'
      else if (!item.dateEligible) status = REASONS.dateUnqualified
      else if (item.answerCapable) status = 'answer_capable'
      else if (item.judgmentIncomplete) status = 'deferred_lead'
      else if (item.relevant) status = 'mention_only'
      else if (item.deferLead) status = 'deferred_lead'
      else status = 'off_topic'
      items.push({
        evidenceId: assoc.id,
        url: source?.displayUrl ?? source?.url ?? '',
        title: source?.title ?? '',
        domain: source?.domain ?? '',
        published: source?.published ?? null,
        dates: item.dates,
        provenance: assoc.provenance ?? [],
        textBasis: assoc.basis,
        reviewedText: assoc.text,
        textVersion: assoc.textVersion,
        engines: [...assoc.engines],
        fusionScore: assoc.fusionScore,
        status,
        assessed: item.assessed,
        judgment: judgment ? {
          relevance: judgment.relevant ?? null,
          states_evidence: judgment.states_evidence ?? null,
          premise_conflict: judgment.premise_conflict ?? null,
          injection: judgment.injection ?? null,
          ...(judgment.keywords ? {keywords:judgment.keywords, facts:judgment.facts??[]} : {}),
        } : null,
        premiseConflict: item.premiseConflict,
        injectionSuspected: item.injectionSuspected,
        judgmentIncomplete: Boolean(item.judgmentIncomplete),
        usedForCoverage: coverageIds.has(assoc.id),
        firstRound: assoc.round,
        changeCount: assoc.changeCount,
        fetch: assoc.fetch ? { state: assoc.fetch.state, via: assoc.fetch.via ?? null, words: assoc.fetch.words ?? 0 } : null,
      })
    }
    const rank = { answer_capable: 0, mention_only: 1, deferred_lead: 2, unassessed: 2, off_topic: 3, excluded_injection: 4, no_text: 5 }
    items.sort((a, b) => (rank[a.status] ?? 9) - (rank[b.status] ?? 9) || (b.fusionScore ?? 0) - (a.fusionScore ?? 0) || a.evidenceId.localeCompare(b.evidenceId))
    return items
  }

  function enforceOutputSize(result) {
    if (JSON.stringify(result).length <= limits.maxOutputChars) return result
    let truncated = false
    for (const q of result.questions) {
      for (const item of q.evidence) {
        if (typeof item.reviewedText === 'string' && item.reviewedText.length > 240) {
          item.reviewedText = item.reviewedText.slice(0, 240)
          item.textTruncated = true
          truncated = true
        }
      }
    }
    if (JSON.stringify(result).length <= limits.maxOutputChars) {
      result.outputTruncated = truncated
      result.warnings.push('reviewed fragments were shortened to stay inside the response size cap')
      return result
    }
    for (const q of result.questions) {
      if (q.evidence.length > 3) {
        q.evidence = q.evidence.slice(0, 3)
        q.evidenceTruncated = true
        truncated = true
      }
    }
    result.outputTruncated = truncated
    result.warnings.push('evidence lists were trimmed to stay inside the response size cap')
    if (JSON.stringify(result).length > limits.maxOutputChars) {
      result.roundLog = result.roundLog.map(r => ({round:r.round, poolLimit:r.poolLimit,
        admittedUniqueUrls:r.admittedUniqueUrls, searches:r.search.length, fetches:r.fetch.length,
        judgment:r.judgment, detailsOmitted:true}))
      result.outputTruncated = true
      // This is only the diagnostic view: onComplete already retained the full
      // approved pool for pagination. Preserve evidenceCount/omission flags.
      while (JSON.stringify(result).length > limits.maxOutputChars && result.questions.some(q => q.evidence.length)) {
        const largest = [...result.questions].sort((a,b) => b.evidence.length-a.evidence.length)[0]
        largest.evidence.pop()
        largest.evidenceTruncated = true
      }
    }
    if (JSON.stringify(result).length > limits.maxOutputChars) {
      // Optional fact IDs/metadata can fill the diagnostic cap even after all
      // evidence previews are removed. Preserve decisions/scores, not duplicate
      // copies of the caller's long question in both questions and uncovered.
      for (const q of [...result.questions,...result.uncovered]) if (q.question?.length>160) {
        q.question=q.question.slice(0,160);q.questionTruncated=true
      }
      result.outputTruncated=true
    }
    if (JSON.stringify(result).length > limits.maxOutputChars) {
      result.jev.perPhase=[];result.jev.phaseDetailsOmitted=true
      result.warnings=result.warnings.slice(0,8)
      result.warnings.push('Some diagnostic details omitted for size; scores, status, pending counts and paginated approved results are preserved')
    }
    return result
  }

  /**
   * Default-mode evidence view. A useful result is material worth reading — a
   * credible pointer or a partial useful excerpt both qualify. `assessed` is
   * true for exactly the eligible set, and `reviewedText` is the same reviewed
   * extract the judgement was made about (never a rewrite or a summary).
   */
  function retrievalEvidenceView(q) {
    const items = []
    for (const row of retrievalRows(q)) {
      const assoc = row.assoc
      const source = row.source
      const injection = scoreField(row.judgment, 'injection')
      const injectionSuspected = injection !== null && injection > thresholds.injection
      const useful = isUsefulRow(row)
      let status = 'unassessed'
      if (!assoc.text) status = 'no_text'
      else if (scopeFirst && row.scope.route === 'reject') status = 'constraints_not_passed'
      else if (scopeFirst && row.scope.route !== 'eligible') status = row.scope.reason === 'invalid_or_missing_judgement' ? 'assessment_unavailable' : 'unassessed'
      else if (!row.assessed) status = scopeFirst && sourceAssessmentAttempts.has(assessmentKey(row)) ? 'assessment_unavailable' : 'unassessed'
      else if (injection === null) status = 'unassessed' // an unknown mandatory gate fails closed
      else if (injectionSuspected) status = 'excluded_injection'
      else if (!row.dateEligible) status = REASONS.dateUnqualified
      else if (useful) status = 'useful_result'
      else status = scopeFirst ? 'quality_not_passed' : 'off_topic'
      items.push({
        evidenceId: assoc.id,
        url: source?.displayUrl ?? source?.url ?? '',
        title: source?.title ?? '',
        domain: source?.domain ?? '',
        published: source?.published ?? null,
        dates: row.dates,
        provenance: assoc.provenance ?? [],
        textBasis: assoc.basis,
        reviewedText: assoc.text,
        textVersion: assoc.textVersion,
        engines: [...assoc.engines],
        fusionScore: assoc.fusionScore,
        status,
        assessed: Boolean(row.assessed),
        valueScore: useful ? readingValue(row.judgment, { intentPresent: scopeFirst || Boolean(q.intent), lambda: thresholds.directionLambda }) : null,
        kind: row.judgment?.kind ?? 'unknown',
        ...(scopeFirst && useful ? { tier: materialTier(row.judgment, thresholds) } : {}),
        judgment: row.judgment ? {
          relevance: scoreField(row.judgment, 'relevance'),
          reading_value: scoreField(row.judgment, 'reading_value'),
          direction_match: scoreField(row.judgment, 'direction_match'),
          injection,
          kind: row.judgment.kind ?? 'unknown',
          keywords: (row.judgment.keywords ?? []).map((k) => ({ keyword: k.keyword, match: scoreField(k, 'match') })),
          topics: (row.judgment.topics ?? []).map((t) => ({ topicId: t.topicId, match: scoreField(t, 'match') })),
        } : null,
        ...(scopeFirst ? { scope: { route: row.scope.route, checks: row.scope.checks }, admissionPolicy: SCOPE_POLICY_VERSION, admitted: useful } : {}),
        judgmentIncomplete: scopeFirst ? row.assessmentIncomplete : Boolean(row.assessed && !usefulEligible(row.judgment, thresholds)),
        firstRound: assoc.round,
        changeCount: assoc.changeCount,
        fetch: assoc.fetch ? { state: assoc.fetch.state, via: assoc.fetch.via ?? null, words: assoc.fetch.words ?? 0 } : null,
      })
    }
    const rank = { useful_result: 0, off_topic: 2, unassessed: 2, date_unqualified: 3, excluded_injection: 4, no_text: 5 }
    items.sort((a, b) => (rank[a.status] ?? 9) - (rank[b.status] ?? 9)
      || (scopeFirst ? Number(b.tier === 'focus') - Number(a.tier === 'focus') : 0)
      || (b.valueScore ?? -1) - (a.valueScore ?? -1)
      || (b.fusionScore ?? 0) - (a.fusionScore ?? 0)
      || a.evidenceId.localeCompare(b.evidenceId))
    return items
  }

  /**
   * Reading-value result. The index is advisory: `retrievalSufficient` is true
   * only when every keyword of every target was closed as satisfied, and even
   * then it is not an answer-completeness or absence claim.
   */
  function assembleRetrievalResult(final) {
    const questionsOut = []
    const uncovered = []
    let usefulCount = 0
    const completeEvidence = []
    const byBasis = { fetched_page: 0, engine_content: 0, snippet: 0 }
    for (const q of canonical) {
      const record = results.get(q.id)
      const status = retrievalQuestionStatus(q)
      record.status = status
      record.assessed = status === 'satisfied' || status === 'exhausted'
      const states = retrievalStates(q)
      const progressEntries = states.map((state) => retrievalKeywordSummary(q, state))
      const allEvidence = retrievalEvidenceView(q)
      usefulCount += allEvidence.filter((item) => item.status === 'useful_result').length
      for (const item of allEvidence) if (item.textBasis) byBasis[item.textBasis] = (byBasis[item.textBasis] ?? 0) + 1
      const outputItems = (scopeFirst ? allEvidence.filter(item => item.status === 'useful_result') : allEvidence).slice(0, limits.maxEvidencePerQuestionInOutput)
      funnel.returnedEvidence += outputItems.length
      const openKeywords = progressEntries.filter((entry) => entry.status === 'continue').length
      const pendingKeywords = progressEntries.filter((entry) => entry.status === 'pending').length
      const reasons = scopeFirst
        ? [...new Set([...record.reasons, ...progressEntries.filter(entry => entry.status !== 'satisfied').map(entry => entry.reason)])].filter(reason => reason !== REASONS.keywordSatisfied)
        : [...new Set([...progressEntries.map((entry) => entry.reason), ...record.reasons])]
      const sufficient = status === 'satisfied'
      const first = validated.targets[q.inputIndexes[0]]
      completeEvidence.push(...allEvidence.map((item) => ({ ...item, questionId: q.id, canonicalId: q.id, taskId: first.taskId, targetId: first.targetId,
        targets: q.inputIndexes.map(index => ({ canonicalId: q.id, taskId: validated.targets[index].taskId, targetId: validated.targets[index].targetId ?? `q${index + 1}` })) })))
      for (const inputIndex of q.inputIndexes) {
        questionsOut[inputIndex] = {
          id: `q${inputIndex + 1}`,
          canonicalId: q.id,
          question: validated.targets[inputIndex].text,
          taskId: validated.targets[inputIndex].taskId,
          targetId: validated.targets[inputIndex].targetId,
          keywords: validated.targets[inputIndex].keywords,
          ...(first.intent ? { intent: first.intent } : {}),
          ...(scopeFirst ? { constraints: first.constraints ?? [] } : {}),
          status,
          assessed: record.assessed,
          retrievalSufficient: sufficient,
          keywordProgress: progressEntries.map((entry) => ({ ...entry })),
          openKeywords,
          pendingKeywords,
          usefulResults: allEvidence.filter((item) => item.status === 'useful_result').length,
          evidence: outputItems.map((item) => ({ ...item })),
          evidenceCount: allEvidence.length,
          deferredLeads: allEvidence.filter((item) => item.status === 'unassessed' && item.reviewedText).length,
          evidenceTruncated: allEvidence.length > outputItems.length,
          conflictCount: 0,
          uncoveredReason: sufficient ? null : (reasons[0] ?? null),
          uncoveredReasons: reasons,
          conflicts: [],
          searchedEngines: [...progress.get(q.id).engines],
        }
        if (!sufficient) uncovered.push({
          id: `q${inputIndex + 1}`,
          canonicalId: q.id,
          question: validated.targets[inputIndex].text,
          status,
          reasons,
          usefulResults: allEvidence.filter((item) => item.status === 'useful_result').length,
          openKeywords,
          pendingKeywords,
        })
      }
    }
    const engineRequests = Object.values(engineStats).reduce((sum, stat) => sum + (stat.attempts ?? 0), 0)
    const result = {
      schemaVersion: ADAPTIVE_RETRIEVAL_SCHEMA_VERSION,
      tool: ADAPTIVE_TOOL_NAME,
      // True only with current point contributions AND a fresh full-set verdict. Never an
      // answer-completeness claim, and never a missing-facts gate.
      retrievalSufficient: retrievalSufficient(),
      ...(scopeFirst ? { finalReview: { status: finalAccepted() ? 'finish' : finalReview.status === 'finish' ? 'stale' : finalReview.status, checks: finalReview.checks,
        verdict: finalAccepted() ? 'pass' : finalReview.status === 'continue' ? 'not_passed' : null,
        researchKeyword: finalReview.status === 'continue' ? keywordList(canonical[0])[[...finalGaps.keys()][0]] ?? null : null,
        inputMaterials: finalReview.inputMaterials ?? 0, allMaterialsIncluded: finalReview.allMaterialsIncluded === true },
        reviewSummary: { collectedRows: funnel.collectedRows, collected: completeEvidence.length, withText: completeEvidence.filter(i => i.reviewedText).length,
          scopeAssessed: completeEvidence.filter(i => i.scope?.checks?.length && ['pass', 'not_passed'].includes(i.scope.checks[0].state)).length,
          scopeSkipped: completeEvidence.filter(i => i.scope?.route === 'eligible' && !i.scope.checks.length).length,
          constraintsNotPassed: completeEvidence.filter(i => i.status === 'constraints_not_passed').length,
          qualityAssessed: completeEvidence.filter(i => i.assessed).length,
          qualityNotPassed: completeEvidence.filter(i => ['quality_not_passed', 'excluded_injection', 'date_unqualified'].includes(i.status)).length,
          admitted: usefulCount, focus: completeEvidence.filter(i => i.tier === 'focus').length,
          supporting: completeEvidence.filter(i => i.tier === 'supporting').length,
          assessmentUnavailable: completeEvidence.filter(i => i.status === 'assessment_unavailable').length,
          unreviewed: completeEvidence.filter(i => ['unassessed', 'no_text'].includes(i.status)).length,
          awaitingAdmission: completeEvidence.filter(i => ['unassessed', 'assessment_unavailable', 'no_text'].includes(i.status)).length },
        scopeSummary: { eligible: completeEvidence.filter(i => i.scope?.route === 'eligible').length,
          rejected: completeEvidence.filter(i => i.scope?.route === 'reject').length,
          unknown: completeEvidence.filter(i => i.scope?.route === 'hold').length } } : {}),
      questions: questionsOut,
      uncovered,
      rounds: used.rounds,
      stopReason: final.stopReason,
      stopDetail: final.stopDetail ?? null,
      evidence: {
        total: evidence.size(),
        sources: evidence.sourceCount(),
        withText: evidence.stats().withText,
        // `answerCapable` is kept for compatibility and counts useful results.
        answerCapable: usefulCount,
        useful: usefulCount,
        dropped: evidence.droppedAssociations(),
        byBasis,
      },
      funnel: {
        engine_returned_rows: funnel.sawStageCounts ? funnel.engineRowsRaw : null,
        unique_urls: evidence.sourceCount(),
        reviewed_associations: funnel.reviewedAssociations,
        qualified_associations: usefulCount,
        returned_evidence: funnel.returnedEvidence,
        pending_associations: scopeFirst ? completeEvidence.filter(i => i.reviewedText && i.scope?.route !== 'reject' && i.judgmentIncomplete).length : evidence.pendingSourceJudge({ needsReview: needsRetrievalReview }).length,
        fetched_pages: used.fetchCalls,
        unique_candidates_after_merge: funnel.sawStageCounts ? funnel.uniqueCandidates : null,
        fusion_rows: funnel.sawStageCounts ? funnel.fusionRows : null,
        fusion_selected_rows: funnel.sawStageCounts ? funnel.selectedRows : null,
        fusion_truncated_calls: funnel.fusionTruncatedCalls,
        search_calls: used.searchCalls,
        search_cache_hits: funnel.cacheHits,
        associations_created: funnel.associationsCreated,
        textless_rows: funnel.textlessRows,
        stale_judgments_discarded: funnel.staleJudgments,
        deferred_judgments_total: funnel.deferredJudgmentsTotal,
        coverage_input_evidence: 0,
        dropped_associations: evidence.droppedAssociations(),
      },
      usage: {
        tookMs: now() - startedAt,
        rounds: used.rounds,
        searchCalls: used.searchCalls,
        fetchCalls: used.fetchCalls,
        fetchReads: used.fetchReads,
        engineStats,
        engineRequests,
        engineFanout: searchAudit.map((entry) => ({ engines: entry.engineNames, enginesCalled: entry.engineCount })),
        jevCalls: used.jevCalls,
        jevHttpAttempts: used.jevHttpAttempts,
        jevRetries: used.jevRetries,
        jevInputTokens: jevState.inputTokens,
        jevOutputTokens: jevState.outputTokens,
        jevInputTokensEstimated: used.estimatedTokens,
        tokenAccounting: {
          note: 'Token counts are conservative estimates from serialized request size (chars/2); server usage is reported separately when returned.',
          estimated: true,
          serverReported: jevState.serverUsageReported,
        },
      },
      roundLog,
      jev: jevSummary(jevState),
      limits: {
        rounds: budget.maxRounds,
        searchCalls: budget.maxSearchCalls,
        fetchCalls: budget.maxFetchCalls,
        fetchReads: budget.maxFetchReads,
        jevCalls: budget.maxJevCalls,
        thresholds: { ...thresholds },
        note: 'Budgets and thresholds are code constants; they are not tool parameters.',
      },
      warnings: [...warnings, ...evidence.warningsList()],
      ...(fallbackUsed ? { fallback: { ran: true, reason: 'jev failed before any search; one restricted plain-search round ran and its material stays unassessed' } } : {}),
    }
    deps.onComplete?.({ result, evidence: completeEvidence })
    return enforceOutputSize(result)
  }

  function assembleResult(final) {
    if (retrievalMode) return assembleRetrievalResult(final)
    const questionsOut = []
    const uncovered = []
    let answerCapableCount = 0
    const completeEvidence = []
    const byBasis = { fetched_page: 0, engine_content: 0, snippet: 0 }
    for (const q of canonical) {
      const record = results.get(q.id)
      const { classified, qualified, fresh } = currentVerdict(q.id)
      const coverageIds = new Set(fresh && record.coverage ? record.coverage.evidenceIds ?? [] : [])
      const allEvidence = buildEvidenceView(classified, coverageIds)
      completeEvidence.push(...allEvidence.map((item) => ({ ...item, questionId: q.id })))
      answerCapableCount += classified.filter((item) => item.answerCapable).length
      for (const item of allEvidence) if (item.textBasis) byBasis[item.textBasis] = (byBasis[item.textBasis] ?? 0) + 1
      const outputItems = [...allEvidence].sort((a,b)=>Number(coverageIds.has(b.evidenceId))-Number(coverageIds.has(a.evidenceId))).slice(0, limits.maxEvidencePerQuestionInOutput)
      funnel.returnedEvidence += outputItems.length
      const coverage = fresh && record.coverage
        ? {
          probability: record.coverage.probability,
          threshold: record.coverage.threshold,
          basis: record.coverage.basis,
          textBasis: record.coverage.textBasis,
          snippetOnly: Boolean(record.coverage.snippetOnly),
          snippetSelfSufficient: record.coverage.snippetSelfSufficient ?? null,
          judgedAtRound: record.coverage.judgedAtRound,
          evidenceVersionSignature: record.coverage.versionSignature,
          missingExplicitRequirements: record.coverage.missingExplicitRequirements ?? [],
          evidenceIds: record.coverage.evidenceIds ?? [],
        }
        : null
      const status = fresh && record.status === 'covered' ? 'covered' : (record.status === 'covered' ? 'unassessed' : record.status)
      const reasons = status === 'covered' ? [] : (record.reasons.length ? record.reasons : [REASONS.noAction])
      for (const inputIndex of q.inputIndexes) {
        questionsOut[inputIndex] = {
          id: `q${inputIndex + 1}`,
          canonicalId: q.id,
          question: q.text,
          taskId: validated.targets[inputIndex].taskId,
          targetId: validated.targets[inputIndex].targetId,
          keywords: validated.targets[inputIndex].keywords,
          ...(keywordMode ? {keywordProgress:keywordProgress(q).map(keywordSummary),finalChecks} : {}),
          gap: record.gap,
          status,
          assessed: Boolean(fresh && record.assessed),
          coverage,
          evidence: outputItems.map((item) => ({ ...item })),
          evidenceCount: allEvidence.length,
          deferredLeads: allEvidence.filter((item) => item.status === 'deferred_lead'
            || (item.status === 'unassessed' && item.reviewedText)).length,
          evidenceTruncated: allEvidence.length > outputItems.length,
          conflictCount: record.conflicts.length,
          uncoveredReason: status === 'covered' ? null : (reasons[0] ?? null),
          uncoveredReasons: [...reasons],
          conflicts: record.conflicts.map((conflict) => ({ ...conflict })),
          searchedEngines: [...progress.get(q.id).engines],
        }
        if (status !== 'covered') {
          uncovered.push({
            id: `q${inputIndex + 1}`,
            canonicalId: q.id,
            question: q.text,
            status,
            reasons: [...reasons],
            qualifiedEvidence: qualified.length,
            pendingLeads: allEvidence.filter((item) => item.status === 'deferred_lead'
              || (item.status === 'unassessed' && item.reviewedText)).length,
            conflicts: record.conflicts.length,
          })
        }
      }
    }
    const engineRequests = Object.values(engineStats).reduce((sum, stat) => sum + (stat.attempts ?? 0), 0)
    const funnelOut = {
      // Names match bench/run.schema.json; null means "not measurable here".
      engine_returned_rows: funnel.sawStageCounts ? funnel.engineRowsRaw : null,
      unique_urls: evidence.sourceCount(),
      reviewed_associations: funnel.reviewedAssociations,
      qualified_associations: answerCapableCount,
      returned_evidence: funnel.returnedEvidence,
      pending_associations: evidence.pendingSourceJudge().length,
      fetched_pages: used.fetchCalls,
      // Extra stages for loss localisation.
      unique_candidates_after_merge: funnel.sawStageCounts ? funnel.uniqueCandidates : null,
      fusion_rows: funnel.sawStageCounts ? funnel.fusionRows : null,
      fusion_selected_rows: funnel.sawStageCounts ? funnel.selectedRows : null,
      fusion_truncated_calls: funnel.fusionTruncatedCalls,
      search_calls: used.searchCalls,
      search_cache_hits: funnel.cacheHits,
      associations_created: funnel.associationsCreated,
      textless_rows: funnel.textlessRows,
      stale_judgments_discarded: funnel.staleJudgments,
      deferred_judgments_total: funnel.deferredJudgmentsTotal,
      coverage_input_evidence: funnel.coverageInputEvidence,
      dropped_associations: evidence.droppedAssociations(),
    }
    const result = {
      schemaVersion: ADAPTIVE_SCHEMA_VERSION,
      tool: ADAPTIVE_TOOL_NAME,
      questions: questionsOut,
      uncovered,
      rounds: used.rounds,
      stopReason: final.stopReason,
      stopDetail: final.stopDetail ?? null,
      evidence: {
        total: evidence.size(),
        sources: evidence.sourceCount(),
        withText: evidence.stats().withText,
        answerCapable: answerCapableCount,
        dropped: evidence.droppedAssociations(),
        byBasis,
      },
      funnel: funnelOut,
      usage: {
        tookMs: now() - startedAt,
        rounds: used.rounds,
        searchCalls: used.searchCalls,
        fetchCalls: used.fetchCalls,
        fetchReads: used.fetchReads,
        engineStats,
        engineRequests,
        engineFanout: searchAudit.map((entry) => ({ engines: entry.engineNames, enginesCalled: entry.engineCount })),
        jevCalls: used.jevCalls,
        jevHttpAttempts: used.jevHttpAttempts,
        jevRetries: used.jevRetries,
        jevInputTokens: jevState.inputTokens,
        jevOutputTokens: jevState.outputTokens,
        jevInputTokensEstimated: used.estimatedTokens,
        tokenAccounting: {
          note: 'Token counts are conservative estimates from serialized request size (chars/2); server usage is reported separately when returned.',
          estimated: true,
          serverReported: jevState.serverUsageReported,
        },
      },
      roundLog,
      jev: jevSummary(jevState),
      limits: {
        rounds: budget.maxRounds,
        searchCalls: budget.maxSearchCalls,
        fetchCalls: budget.maxFetchCalls,
        fetchReads: budget.maxFetchReads,
        jevCalls: budget.maxJevCalls,
        evidenceItems: Number.isFinite(limits.maxEvidenceItems) ? limits.maxEvidenceItems : null,
        thresholds: { ...thresholds },
        note: 'Budgets and thresholds are code constants; they are not tool parameters.',
      },
      warnings: [...warnings, ...evidence.warningsList()],
      ...(fallbackUsed ? { fallback: { ran: true, reason: 'jev failed before any search; one restricted plain-search round ran and its material stays unassessed' } } : {}),
    }
    deps.onComplete?.({ result, evidence: completeEvidence })
    return enforceOutputSize(result)
  }

  return assembleResult({ stopReason, stopDetail })
}

// ------------------------------------------------------------------ assembly

function safeMessage(err) {
  const raw = err instanceof Error ? err.message : String(err)
  return String(raw).replace(/\s+/g, ' ').slice(0, 160)
}

function countEngineErrors(stats) {
  const out = {}
  for (const [name, stat] of Object.entries(stats ?? {})) if (stat?.errors) out[name] = stat.note ?? 'error'
  return out
}

function earlyResult({ stopReason, stopDetail, inputQuestions, warnings, startedAt, now, jevState = null, limits = ADAPTIVE_LIMITS, configuredHint = null, retrievalMode = false }) {
  const questions = (Array.isArray(inputQuestions) ? inputQuestions : []).map((value, index) => ({
    id: `q${index + 1}`,
    canonicalId: null,
    question: typeof value === 'string' ? value : String(value ?? ''),
    status: 'not_searched',
    assessed: false,
    coverage: null,
    evidence: [],
    evidenceCount: 0,
    evidenceTruncated: false,
    conflictCount: 0,
    uncoveredReason: REASONS.notSearched,
    uncoveredReasons: [REASONS.notSearched],
    conflicts: [],
    searchedEngines: [],
  }))
  return {
    schemaVersion: retrievalMode ? ADAPTIVE_RETRIEVAL_SCHEMA_VERSION : ADAPTIVE_SCHEMA_VERSION,
    tool: ADAPTIVE_TOOL_NAME,
    // Early errors in the default mode are honest: nothing was searched.
    ...(retrievalMode ? { retrievalSufficient: false } : {}),
    questions,
    uncovered: questions.map((q) => ({
      id: q.id,
      canonicalId: q.canonicalId,
      question: q.question,
      status: q.status,
      reasons: q.uncoveredReasons,
      qualifiedEvidence: 0,
      conflicts: 0,
    })),
    rounds: 0,
    stopReason,
    stopDetail,
    usage: emptyUsage(now() - startedAt),
    jev: jevSummary(jevState),
    warnings,
    evidence: { total: 0, sources: 0, withText: 0, answerCapable: 0, dropped: 0, byBasis: { fetched_page: 0, engine_content: 0, snippet: 0 } },
    roundLog: [],
    limits: { rounds: limits.maxRounds, searchCalls: limits.maxSearchCalls, fetchCalls: limits.maxFetchCalls, evidenceItems: limits.maxEvidenceItems },
    ...(configuredHint ? { configurationHint: configuredHint } : {}),
  }
}

function emptyUsage(tookMs) {
  return {
    tookMs,
    rounds: 0,
    searchCalls: 0,
    fetchCalls: 0,
    fetchReads: 0,
    engineStats: {},
    engineRequests: 0,
    jevCalls: 0,
    jevHttpAttempts: 0,
    jevRetries: 0,
    jevInputTokens: 0,
    jevOutputTokens: 0,
    jevInputTokensEstimated: 0,
    tokenAccounting: {
      note: 'Token counts are estimates from a conservative serialized-size heuristic (chars/2); server usage is reported separately when the service returns it.',
      estimated: true,
      serverReported: false,
    },
  }
}

function jevSummary(jevState) {
  const state = jevState ?? {}
  return {
    configured: Boolean(state.configured),
    used: Boolean(state.used),
    degraded: Boolean(state.degraded),
    disabled: Boolean(state.disabled),
    model: state.model ?? null,
    gatewayOrigin: state.gateway ?? null,
    calls: state.calls ?? 0,
    httpAttempts: state.httpAttempts ?? 0,
    retries: state.retries ?? 0,
    inputTokens: state.inputTokens ?? 0,
    outputTokens: state.outputTokens ?? 0,
    inputTokensEstimated: state.inputTokensEstimated ?? 0,
    serverUsageReported: Boolean(state.serverUsageReported),
    perPhase: state.perPhase ?? [],
    failures: state.failures ?? [],
  }
}

export { ABORT_MESSAGE }
