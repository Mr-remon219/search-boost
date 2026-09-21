// adaptive_search loop — PLAN → EXECUTE → SOURCE_JUDGE → code filter →
// COVERAGE_JUDGE → decide, repeated within fixed budgets.
//
// Jev picks engines, judges material and decides per-question coverage; this
// code validates every answer, owns every threshold and every parameter, and
// executes only closed-set actions through injected `runFused` /
// `runFetchPage`. Nothing here calls Jev recursively, and the module never
// imports lib/runtime.mjs (the runtime injects it), so there is no cycle.
//
// Guarantees this file is responsible for:
//   * every input question keeps its position and identity, even when two
//     questions are identical (execution is reused, output positions are not lost)
//   * budgets are reserved before a request is dispatched and never exceeded
//   * the coverage judgement only ever sees the code-qualified evidence set
//   * a missing/invalid Jev answer is never treated as a low score, and never
//     becomes `covered`
//   * earlier verdicts about unchanged evidence survive a later Jev failure;
//     evidence that changed or arrived later stays unassessed

import { estimateJevTokens, JEV_ERROR_KINDS, JEV_FATAL_KINDS, JevError } from '../../jev/client.mjs'
import { readChoice, readNoul, routeNoul } from '../../jev/questions.js'
import { resultKey } from '../results.js'
import { countWords, pool as runPool } from '../text.js'
import { engineBrief, engineCandidates } from './engine-brief.js'
import { createEvidencePool } from './evidence.js'
import { ADAPTIVE_LIMITS, ADAPTIVE_THRESHOLDS } from './limits.js'
import { coverageRequest, explicitTokens, planActionRequest, planEngineRequest, splitSourceJudgeRequests, textStatesToken } from './prompts.js'

export const ADAPTIVE_SCHEMA_VERSION = 1
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
}

const ABORT_MESSAGE = 'adaptive_search cancelled'

/** Validate the tool input. Nothing is truncated and nothing is silently dropped. */
export function validateQuestions(raw, limits = ADAPTIVE_LIMITS) {
  if (raw === undefined || raw === null) return { error: 'questions is required' }
  if (!Array.isArray(raw)) return { error: 'questions must be an array of strings' }
  if (raw.length < limits.minQuestions || raw.length > limits.maxQuestions) {
    return { error: `questions must contain ${limits.minQuestions}..${limits.maxQuestions} items (received ${raw.length})` }
  }
  const questions = []
  for (const [index, value] of raw.entries()) {
    if (typeof value !== 'string') return { error: `questions[${index}] must be a string` }
    const text = value.trim()
    if (!text) return { error: `questions[${index}] is blank` }
    if (text.length > limits.maxQuestionChars) {
      return { error: `questions[${index}] is ${text.length} characters; the limit is ${limits.maxQuestionChars}` }
    }
    questions.push(text)
  }
  return { questions }
}

/** Canonical question records: identical texts share one execution, not one output slot. */
export function canonicalizeQuestions(questions) {
  const byText = new Map()
  const canonical = []
  questions.forEach((text, index) => {
    let entry = byText.get(text)
    if (!entry) {
      entry = { id: `q${canonical.length + 1}`, text, inputIndexes: [] }
      canonical.push(entry)
      byText.set(text, entry)
    }
    entry.inputIndexes.push(index)
  })
  return canonical
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
    return { assessed: false, judgmentIncomplete: false, injectionSuspected: false, relevant: false, statesEvidence: false, premiseConflict: false, answerCapable: false }
  }
  // A missing or invalid field is NOT a no: the item stays incomplete instead of
  // being read as a confident negative — and an incomplete item never enters the
  // success branch. "injection unknown" is not "no injection".
  const judgmentIncomplete = GATING_JUDGMENT_FIELDS.some((field) => judgment[field] === null || judgment[field] === undefined)
  const injectionSuspected = judgment.injection !== null && judgment.injection > thresholds.injection
  const relevant = judgment.relevant !== null && judgment.relevant > thresholds.relevance
  const statesEvidence = judgment.states_evidence !== null && judgment.states_evidence > thresholds.statesEvidence
  const premiseConflict = judgment.premise_conflict !== null && judgment.premise_conflict > thresholds.premiseConflict
  return {
    assessed: true,
    judgmentIncomplete,
    injectionSuspected,
    relevant,
    statesEvidence,
    premiseConflict,
    answerCapable: relevant && statesEvidence && !injectionSuspected && !judgmentIncomplete,
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
  const thresholds = deps.thresholds ?? ADAPTIVE_THRESHOLDS
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

  const validated = validateQuestions(input?.questions, limits)
  if (validated.error) {
    return earlyResult({
      stopReason: STOP_REASONS.invalidInput,
      stopDetail: validated.error,
      inputQuestions: Array.isArray(input?.questions) ? input.questions : [],
      warnings: [validated.error],
      startedAt,
      now,
    })
  }
  const rawQuestions = validated.questions

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
    })
  }

  const canonical = canonicalizeQuestions(rawQuestions)
  const evidence = createEvidencePool({ limits, questions: canonical })

  /** @type {Map<string, { engines: Set<string>, successful: Set<string>, complexity: string|null, searched: number }>} */
  const progress = new Map(canonical.map((q) => [q.id, { engines: new Set(), successful: new Set(), complexity: null, searched: 0 }]))
  const executed = new Set()
  const finished = new Set()
  const results = new Map(canonical.map((q) => [q.id, {
    status: 'not_searched',
    assessed: false,
    coverage: null,
    reasons: [],
    conflicts: [],
    verdictTextVersion: null,
    lastJudgedRound: null,
  }]))

  const roundLog = []
  let stopReason = null
  let stopDetail = null
  let fallbackUsed = false
  let sourceJudgeRuns = 0
  let coverageJudgeRuns = 0

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

  async function jevAsk(phase, request) {
    if (signal.aborted) throw abortError()
    const estimate = estimateJevTokens(JSON.stringify(request.state ?? '').length + JSON.stringify(request.questions ?? {}).length)
    // Reserved before dispatch, estimate included: a request whose estimated size
    // does not fit the remaining token budget is never sent (this is our own
    // accounting cap, not a claim about the server's real billing).
    if (!reserve('jev', 1, estimate)) {
      const tokens = used.jevInputTokens >= budget.maxJevInputTokens || used.estimatedTokens + estimate > budget.maxJevInputTokens
      throw new BudgetExhausted(tokens ? STOP_REASONS.budgetTokens : STOP_REASONS.budgetCalls)
    }
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
  function selectEnginesFromEntries(entries, offered, threshold, questionId, allowed = null) {
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
      const fallback = defaultEngineSubset(offeredEngines)
      return { engines: fallback, mode: 'fallback_default', invalid, valid: 0 }
    }
    const above = valid.filter((item) => item.value > threshold)
    const chosen = above.length ? above : valid.slice(0, 1)
    const engines = []
    for (const item of chosen) {
      if (engines.length >= limits.maxEnginesPerQuestionPerRound) break
      if (allowed && !allowed.has(item.engine)) continue
      engines.push(item.engine)
    }
    return { engines, mode: above.length ? 'jev_selected' : 'jev_low_scores', invalid, valid: valid.length }
  }

  /** Candidates this question has not used yet: the code definition of "new engines". */
  function allowedNewEngines(questionId) {
    const used = progress.get(questionId)?.engines ?? new Set()
    return new Set([...candidateSet].filter((name) => !used.has(name)))
  }

  async function planEngineRound(unfinished, roundEntry) {
    const engines = engineBrief([...candidateSet])
    const alreadyRan = Object.fromEntries(canonical.map((q) => [q.id, [...progress.get(q.id).engines]]))
    const request = planEngineRequest({ questions: canonical.filter((q) => unfinished.includes(q.id)), engines, alreadyRan, round: roundEntry.round, limits })
    const result = await jevAsk('plan', request)
    const selections = []
    const firstRound = used.rounds === 1
    for (const q of canonical) {
      if (!unfinished.includes(q.id)) continue
      const allowed = allowedNewEngines(q.id)
      const offered = request.offered.filter((item) => item.questionId === q.id && allowed.has(item.engine))
      if (!offered.length) continue
      const { engines: chosen, mode, invalid } = selectEnginesFromEntries(result.entries, offered, thresholds.engineSelect, q.id, allowed)
      if (mode === 'jev_low_scores') warn(`plan: all ${q.id} engine scores were at or below ${thresholds.engineSelect}; code selected the highest (${chosen.join(', ')})`)
      if (mode === 'fallback_default') warn(`plan: no usable engine answer for ${q.id} (${invalid} missing/invalid); code fallback engines: ${chosen.join(', ') || '(none)'}`)
      const selected = chosen.filter((name) => candidateSet.has(name))
      if (!selected.length) continue
      selections.push({
        questionId: q.id,
        kind: 'search',
        engines: selected,
        complexity: firstRound ? limits.defaultComplexity : limits.defaultComplexity,
        mode,
      })
    }
    roundEntry.plan = { phase: 'plan', selections: selections.map((s) => ({ questionId: s.questionId, engines: s.engines, mode: s.mode })) }
    return selections
  }

  /** Feasible next actions for one unfinished question (code-filtered, closed set). */
  function feasibleActions(questionId) {
    const options = []
    const state = progress.get(questionId)
    const fetchBudgetLeft = used.fetchCalls < budget.maxFetchCalls && used.fetchReads < budget.maxFetchReads
    const fetchUrls = []
    if (fetchBudgetLeft) {
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
        if (!url || !source) continue
        // Fetch state is per question × source: a page already read for another
        // question does not count as page material for this one.
        if (item.assoc.fetch?.state === 'ok') continue
        const signature = `f|${questionId}|${resultKey({ url })}`
        if (executed.has(signature)) continue
        if (fetchUrls.length >= limits.maxFetchesPerQuestion) break
        fetchUrls.push({ url, evidenceId: item.assoc.id, sourceKey: item.assoc.sourceKey, signature })
      }
      if (fetchUrls.length) {
        const count = Math.min(fetchUrls.length, limits.maxFetchesPerRound)
        options.push({
          key: 'fetch_pages',
          description: `Read the full page text for the top ${count} already-collected URL(s) and re-judge the resulting fragments: ${fetchUrls.slice(0, count).map((item) => item.url).join(' , ')}`,
          params: { urls: fetchUrls.slice(0, count) },
        })
      }
    }
    const successful = [...state.successful].filter((name) => candidateSet.has(name))
    const searchBudgetLeft = used.searchCalls < budget.maxSearchCalls
    if (searchBudgetLeft && state.complexity !== limits.deepenComplexity && successful.length) {
      options.push({
        key: 'deepen',
        description: `Re-run engines ${successful.join(', ')} for this question at deeper extraction (complexity=${limits.deepenComplexity}: more query variants and advanced page extraction). Only useful when those engines returned thin fragments.`,
        params: { engines: successful.slice(0, limits.maxEnginesPerQuestionPerRound), complexity: limits.deepenComplexity },
      })
    }
    const newEngines = [...candidateSet].filter((name) => !state.engines.has(name))
    if (searchBudgetLeft && newEngines.length) {
      options.push({
        key: 'search_new_engines',
        description: `Search engines not yet used for this question (${newEngines.join(', ')}); the engine subset is chosen by Jev and validated by code.`,
        params: { engines: newEngines },
      })
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
      const request = planActionRequest({ questions: canonical, actionsByQuestion, round: roundEntry.round })
      // Engine detail is only needed for questions where searching new engines is feasible.
      const engineQuestions = actionsByQuestion
        .filter((entry) => entry.options.some((option) => option.key === 'search_new_engines'))
        .map((entry) => entry.questionId)
      if (engineQuestions.length) {
        const engines = engineBrief([...candidateSet])
        const alreadyRan = Object.fromEntries(canonical.map((q) => [q.id, [...progress.get(q.id).engines]]))
        const engineRequest = planEngineRequest({
          questions: canonical.filter((q) => engineQuestions.includes(q.id)),
          engines,
          alreadyRan,
          round: roundEntry.round,
          limits,
          // This sub-request is merged into the action request below, so every
          // path it names must resolve inside that sub-state — the action
          // request's own `state.questions` is a different (complete) list.
          statePath: 'state.engine_state',
        })
        request.state.engine_state = engineRequest.state
        Object.assign(request.questions, engineRequest.questions)
        engineChoices = engineRequest
      }
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
          for (const key of ['fetch_pages', 'deepen', 'search_new_engines', 'finish_partial']) {
            const found = options.find((option) => option.key === key)
            if (found) {
              action = found
              break
            }
          }
        }
        if (action.key === 'search_new_engines') {
          // "New" is defined by code, not by the answer: allowed candidates minus
          // the engines this question already used. Construction, answer parsing,
          // default fallback and dispatch all see the same limited set.
          const allowed = allowedNewEngines(entry.questionId)
          const offered = (engineChoices?.offered ?? []).filter((item) => item.questionId === entry.questionId && allowed.has(item.engine))
          const chosen = selectEnginesFromEntries(result.entries, offered, thresholds.engineSelect, entry.questionId, allowed)
          // Same reporting as round 1: a low-score answer and a missing answer are
          // different outcomes, and a code fallback must be visible in warnings.
          if (chosen.mode === 'jev_low_scores') warn(`plan: all ${entry.questionId} engine scores were at or below ${thresholds.engineSelect}; code selected the highest (${chosen.engines.join(', ')})`)
          if (chosen.mode === 'fallback_default') warn(`plan: no usable engine answer for ${entry.questionId} (${chosen.invalid} missing/invalid); code fallback engines: ${chosen.engines.join(', ') || '(none)'}`)
          selections.push({ questionId: entry.questionId, action: { ...action, params: { ...action.params, engines: chosen.engines } }, mode, engineMode: chosen.mode })
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

  function recordEngineStats(stats) {
    for (const [name, stat] of Object.entries(stats ?? {})) {
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

  async function executeSearch({ questionId, engines, complexity, mode }) {
    const live = new Set(engineCandidates(snapshotCapability()))
    // "New engines" is a code-level constraint, not a promise from the answer:
    // an engine this question already used is dropped before dispatch. Other
    // modes (deepen) deliberately re-run engines the question already used.
    const reUsed = mode === 'search_new_engines' ? engines.filter((name) => progress.get(questionId)?.engines.has(name)) : []
    if (reUsed.length) warn(`search ${questionId}: engine(s) ${reUsed.join(', ')} already ran for this question and were not searched again as new`)
    const requested = mode === 'search_new_engines' ? engines.filter((name) => !reUsed.includes(name)) : engines
    // Re-validate right before dispatch: an engine that just became unavailable
    // is dropped with a warning, and the candidate set is never widened.
    const selected = requested.filter((name) => live.has(name) && candidateSet.has(name))
    const dropped = requested.filter((name) => !selected.includes(name))
    if (dropped.length) warn(`search ${questionId}: engine(s) ${dropped.join(', ')} became unavailable and were not called`)
    if (!selected.length) return { questionId, engines: [], skipped: true, reason: REASONS.noEngines }
    const signature = `s|${questionId}|${[...selected].sort().join('+')}|${complexity}`
    if (executed.has(signature)) return { questionId, engines: selected, skipped: true, reason: 'duplicate_action' }
    if (!reserve('search')) return { questionId, engines: selected, skipped: true, reason: REASONS.budgetExhausted }
    executed.add(signature)
    const question = canonical.find((q) => q.id === questionId)
    // Shared metadata lives outside the try: the failure branch must be able to
    // report the same question/engines instead of throwing its own error.
    const meta = { questionId, engines: selected, complexity, mode }
    const started = now()
    try {
      const result = await deps.runFused({
        query: question.text,
        engineList: selected,
        complexity,
        maxResults: limits.maxResultsPerSearch,
        ranking: 'balanced',
        community: false,
        signal,
      })
      const ingest = evidence.ingestSearch({ questionId, round: used.rounds, results: result?.results ?? [] })
      progress.get(questionId).engines = new Set([...progress.get(questionId).engines, ...selected])
      progress.get(questionId).searched++
      progress.get(questionId).complexity = complexity
      for (const name of selected) {
        const stat = result?.engineStats?.[name]
        if (stat && !(stat.errors > 0)) progress.get(questionId).successful.add(name)
      }
      recordEngineStats(result?.engineStats)
      const cacheHit = Boolean(result?.cacheHit)
      writeAuditSearch({
        query: question.text,
        queriesUsed: result?.queriesUsed ?? [question.text],
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
      progress.get(questionId).complexity = complexity
      return { ...meta, cacheHit: false, results: 0, created: 0, changed: 0, textless: 0, errors: { [selected[0]]: message }, failed: true }
    }
  }

  /**
   * One page read. Every read reserves its own budget before anything can touch
   * the network, and a cache hit refunds exactly this call's network
   * reservation — never another read's. Without a reservation the read is not
   * attempted at all (the injected fetcher cannot promise a cache-only read).
   */
  async function readPage(url, focus) {
    if (!reserve('fetchRead')) return { skipped: true, reason: REASONS.budgetExhausted }
    if (!reserve('fetch')) {
      refund('fetchRead')
      return { skipped: true, reason: REASONS.budgetExhausted }
    }
    const page = await deps.runFetchPage(url, focus, signal)
    if (page?.cacheHit) refund('fetch')
    return { page }
  }

  async function executeFetch({ questionId, url, sourceKey }) {
    const signature = `f|${questionId}|${resultKey({ url })}`
    if (executed.has(signature)) return { questionId, url, skipped: true, reason: 'duplicate_action' }
    const question = canonical.find((q) => q.id === questionId)
    const started = now()
    try {
      const first = await readPage(url, question.text)
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
      const ingest = evidence.ingestFetch({ questionId, sourceKey, page, round: used.rounds, focusMiss: Boolean(page?.focusMiss) })
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
      warn(`fetch ${questionId} failed for ${url}: ${message}`)
      return { questionId, url, failed: true, error: message, tookMs: now() - started }
    }
  }

  // --------------------------------------------------------------- judgements

  function selectPendingCandidates(pending) {
    const counts = new Map()
    const out = []
    // Round-robin across questions so one question cannot consume the batch.
    for (const item of pending) {
      const count = counts.get(item.questionId) ?? 0
      if (count >= limits.maxSourceJudgeCandidatesPerQuestion) continue
      counts.set(item.questionId, count + 1)
      out.push(item)
    }
    return out
  }

  async function sourceJudgeRound(roundEntry) {
    const pending = evidence.pendingSourceJudge()
    if (!pending.length) return { judged: 0, skipped: true }
    const selected = selectPendingCandidates(pending)
    const requests = splitSourceJudgeRequests({ questions: canonical, candidates: selected, limits })
    let judged = 0
    for (const request of requests) {
      if (!timeBudgetOk()) break
      let result
      try {
        result = await jevAsk('source_judge', request)
      } catch (err) {
        handleJevFailure(err, 'source_judge', roundEntry)
        break
      }
      const judgments = []
      for (const item of request.mapping) {
        const scores = {
          relevant: routeNoul(result.entries, item.ids.relevant, thresholds.relevance).value,
          states_evidence: routeNoul(result.entries, item.ids.states_evidence, thresholds.statesEvidence).value,
          premise_conflict: routeNoul(result.entries, item.ids.premise_conflict, thresholds.premiseConflict).value,
          injection: routeNoul(result.entries, item.ids.injection, thresholds.injection).value,
        }
        judgments.push({ assocId: item.assocId, textVersion: item.textVersion, scores, round: used.rounds })
      }
      const applied = evidence.applySourceJudgments(judgments)
      judged += applied.applied
      if (applied.stale) warn(`source judge: ${applied.stale} judgement(s) discarded because the reviewed text changed`)
    }
    sourceJudgeRuns++
    roundEntry.judgment = { ...(roundEntry.judgment ?? {}), sourceJudge: { candidates: selected.length, judged } }
    return { judged }
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
        if (!record.reasons.includes(REASONS.noAnswerCapableEvidence)) record.reasons = [...record.reasons, REASONS.noAnswerCapableEvidence]
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
        basis: item.assoc.basis,
        text: item.assoc.text,
        words: countWords(item.assoc.text),
      }
    })
    return { classified, qualified }
  }

  function enforceTextBudget(qualified, maxChars) {
    const kept = []
    let usedChars = 0
    for (const item of qualified.slice(0, limits.maxCoverageEvidencePerQuestion)) {
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
        continue
      }
      const budgeted = enforceTextBudget(qualified, limits.maxQualifiedTextCharsPerQuestion)
      const hasStrongBasis = budgeted.some((item) => item.basis === 'fetched_page' || item.basis === 'engine_content')
      entries.push({ question: q, qualified: budgeted, signature, snippetSelfSufficiency: !hasStrongBasis })
    }
    if (!entries.length) return { skipped: true, judged: 0 }
    // Split only by serialized size; each request stays self-contained.
    const chunks = []
    let current = []
    for (const entry of entries) {
      const trial = [...current, entry]
      if (current.length && JSON.stringify(trial).length > limits.maxStateChars) {
        chunks.push(current)
        current = [entry]
      } else {
        current = trial
      }
    }
    if (current.length) chunks.push(current)
    for (const chunk of chunks) {
      if (!timeBudgetOk()) break
      const request = coverageRequest({ questions: chunk, limits })
      let result
      try {
        result = await jevAsk('coverage_judge', request)
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
        const missingTokens = missingExplicitTokens(q.text, chunkEntry.qualified)
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
        record.status = covered ? 'covered' : 'insufficient'
        record.reasons = covered ? [] : reasons
        if (covered) finished.add(item.questionId)
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
      stopDetail = `adaptive_search own ${err.kind.replace('budget_', '')} budget reached (Jev was not called again)`
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
      const engines = defaultEngineSubset([...candidateSet].filter((name) => candidateSet.has(name)), Math.min(3, candidateSet.size))
      const outcome = await executeSearch({
        questionId: q.id,
        engines,
        complexity: limits.defaultComplexity,
        mode: 'fallback_search',
      })
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
      const unfinished = canonical.filter((q) => !finished.has(q.id)).map((q) => q.id)
      if (!unfinished.length) {
        stopReason = stopReason ?? (canonical.every((q) => results.get(q.id).status === 'covered') ? STOP_REASONS.allCovered : STOP_REASONS.noAction)
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
      const roundEntry = { round: used.rounds, plan: null, search: [], fetch: [], judgment: null, failures: [] }
      roundLog.push(roundEntry)
      reportProgress(`round ${used.rounds}/${budget.maxRounds}: planning`)

      // ---- PLAN ----
      let plan
      try {
        plan = used.rounds === 1 ? await planEngineRound(unfinished, roundEntry) : await planActionRound(unfinished, roundEntry)
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
        if (action.key === 'search_new_engines') {
          const outcome = await executeSearch({
            questionId: selection.questionId,
            engines: action.params.engines ?? [],
            complexity: limits.defaultComplexity,
            mode: 'search_new_engines',
          })
          if (outcome) roundEntry.search.push(outcome)
          return
        }
        if (action.key === 'deepen') {
          const outcome = await executeSearch({
            questionId: selection.questionId,
            engines: action.params.engines ?? [],
            complexity: action.params.complexity ?? limits.deepenComplexity,
            mode: 'deepen',
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

      // ---- SOURCE_JUDGE ----
      await sourceJudgeRound(roundEntry)
      if (stopReason) break

      // ---- COVERAGE_JUDGE (only the qualified set) ----
      await coverageJudgeRound(roundEntry)
      if (stopReason) break
      const stillCovered = canonical.filter((q) => results.get(q.id).status === 'covered').length
      reportProgress(`round ${used.rounds}/${budget.maxRounds}: ${stillCovered}/${canonical.length} covered`)

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

  for (const q of canonical) if (!finished.has(q.id)) finalizeQuestion(q.id, REASONS.noAction)
  if (!stopReason) {
    stopReason = canonical.every((q) => results.get(q.id).status === 'covered') ? STOP_REASONS.allCovered : STOP_REASONS.noAction
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
      else if (item.answerCapable) status = 'answer_capable'
      else if (item.judgmentIncomplete) status = 'unassessed'
      else if (item.relevant) status = 'mention_only'
      else status = 'off_topic'
      items.push({
        evidenceId: assoc.id,
        url: source?.displayUrl ?? source?.url ?? '',
        title: source?.title ?? '',
        domain: source?.domain ?? '',
        published: source?.published ?? null,
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
    const rank = { answer_capable: 0, mention_only: 1, unassessed: 2, off_topic: 3, excluded_injection: 4, no_text: 5 }
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
    return result
  }

  function assembleResult(final) {
    const questionsOut = []
    const uncovered = []
    let answerCapableCount = 0
    const byBasis = { fetched_page: 0, engine_content: 0, snippet: 0 }
    for (const q of canonical) {
      const record = results.get(q.id)
      const { classified, qualified, fresh } = currentVerdict(q.id)
      const coverageIds = new Set(fresh && record.coverage ? record.coverage.evidenceIds ?? [] : [])
      const allEvidence = buildEvidenceView(classified, coverageIds)
      answerCapableCount += classified.filter((item) => item.answerCapable).length
      for (const item of allEvidence) if (item.textBasis) byBasis[item.textBasis] = (byBasis[item.textBasis] ?? 0) + 1
      const outputItems = allEvidence.slice(0, limits.maxEvidencePerQuestionInOutput)
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
          status,
          assessed: Boolean(fresh && record.assessed),
          coverage,
          evidence: outputItems.map((item) => ({ ...item })),
          evidenceCount: allEvidence.length,
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
            conflicts: record.conflicts.length,
          })
        }
      }
    }
    const engineRequests = Object.values(engineStats).reduce((sum, stat) => sum + (stat.attempts ?? 0), 0)
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
        evidenceItems: limits.maxEvidenceItems,
        thresholds: { ...thresholds },
        note: 'Budgets and thresholds are code constants; they are not tool parameters.',
      },
      warnings: [...warnings, ...evidence.warningsList()],
      ...(fallbackUsed ? { fallback: { ran: true, reason: 'jev failed before any search; one restricted plain-search round ran and its material stays unassessed' } } : {}),
    }
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

function earlyResult({ stopReason, stopDetail, inputQuestions, warnings, startedAt, now, jevState = null, limits = ADAPTIVE_LIMITS, configuredHint = null }) {
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
    schemaVersion: ADAPTIVE_SCHEMA_VERSION,
    tool: ADAPTIVE_TOOL_NAME,
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
