// Sole adaptive execution path (N_off): one bounded fused candidate snapshot,
// one fixed-option Jev strategy request, one screening pass. Transport, routing,
// fusion and X execution stay in the shared core; this module owns the input
// contract, the community decision, the budget and the response contract.
import { createHash } from 'node:crypto'
import { normalizeAdaptiveInput } from './input.js'
import { resultPages, ADAPTIVE_SCHEMA_VERSION } from './pages.js'
import { buildSnapshot, runScreening, admitAndRank, ADMISSION_POLICY_VERSION } from './controller.js'
import { buildStrategyRequest, decodeStrategy, STRATEGY_POLICY_VERSION } from './judgments.js'
import { createScreeningBudget, SCREENING_BUDGET_VERSION } from './limits.js'
import { isPlausibleText } from '../pdf.js'
import { assertStaticHttpUrl } from '../ssrf.js'
import { requestFits } from './material.js'
import { allAttemptedEnginesFailed } from '../engine-status.js'
import { validateParams } from './scoring.js'
import { validateSourceBiasPolicy } from './policy.js'
import { adaptiveCandidateLimit } from '../snapshot-capacity.js'

export const ADAPTIVE_OUTPUT_SCHEMA_VERSION = ADAPTIVE_SCHEMA_VERSION
export const SAVED_FORMAT_V1 = 'search-boost-research-v1'
export const SAVED_FORMAT_V2 = 'search-boost-research-v2'
export const SAVED_FORMAT_V3 = 'search-boost-research-v3'

export const RANKING_PRESETS = Object.freeze({
  balanced: 'General evidence balance; existing balanced engine weights. Does not change pool, calls, depth or date filters.',
  research: 'Prefer research-oriented retrieval weighting (existing research preset); no new engines or query variants.',
  fresh: 'Prefer freshness-oriented retrieval weighting (existing fresh preset); does not impose any date filter or expand the query.',
})

/** Fixed execution outcomes for the community branch, as reported by the shared
 * fused core. `not_run` means the branch never reached execution. */
export const COMMUNITY_OUTCOMES = Object.freeze([
  'not_requested', 'domain_excluded', 'unavailable', 'blocked', 'succeeded', 'empty', 'failed', 'partial', 'not_run',
])
const COMMUNITY_FAILURE_OUTCOMES = Object.freeze(['unavailable', 'blocked', 'failed', 'partial'])
const COMMUNITY_STATUS_REASON = /^[a-z0-9_]{1,64}$/
const COMMUNITY_FAILURE_REASONS = /^[a-z0-9_]{1,64}$/
const COMMUNITY_USAGE_FLAGS = new Set(['officialAttempted', 'fallbackAttempted', 'dispatchedNow', 'inFlight'])

/**
 * Bind the EXACT bounded text and its provenance to a version hash and mark the
 * material `pending`. Structural validity is never `clear`: pending material
 * must still receive the fixed safety judgement. An already explicit
 * `violation` is preserved, never washed away by preparation or URL merging.
 */
export function prepareMaterial(candidate) {
  const text = candidate?.text
  let valid = typeof text === 'string' && text.trim().length > 0 && isPlausibleText(text)
  try { assertStaticHttpUrl(candidate?.url) } catch { valid = false }
  const textVersion = createHash('sha256').update(JSON.stringify([
    text ?? null, candidate?.basis ?? null, candidate?.url ?? null, candidate?.title ?? null,
    candidate?.published ?? null, candidate?.domain ?? null, candidate?.engines ?? [], candidate?.engineRanks ?? {},
  ])).digest('hex')
  return { ...candidate, textVersion, safetyState: candidate?.safetyState === 'violation' ? 'violation' : valid ? 'pending' : 'unavailable' }
}

function assertToolGate(toolState) {
  if (typeof toolState !== 'function') return
  const state = toolState()
  if (!state || typeof state !== 'object' || Array.isArray(state)) return
  const requested = state.requested !== false
  const enabled = typeof state.enabled === 'boolean' ? state.enabled : requested
  if (!requested || !enabled) {
    throw new Error(`adaptive_search: ${typeof state.reason === 'string' && state.reason ? state.reason : 'Disabled by user'}`)
  }
}

function pickContributionWeights(fused) {
  const source = fused?.contributionWeights
  if (!source || typeof source !== 'object' || Array.isArray(source)) return null
  const weights = {}
  for (const [engine, weight] of Object.entries(source)) if (engine && Number.isFinite(weight)) weights[engine] = weight
  return Object.keys(weights).length ? weights : null
}

function boundedCommunityUsage(usage) {
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return {}
  const out = {}
  for (const [key, value] of Object.entries(usage).slice(0, 16)) {
    if (!/^[A-Za-z0-9_]{1,32}$/.test(key)) continue
    if (value === null) out[key] = null
    else if (Number.isSafeInteger(value) && value >= 0) out[key] = value
    else if (COMMUNITY_USAGE_FLAGS.has(key) && typeof value === 'boolean') out[key] = value
  }
  return out
}

function boundedWarnings(warnings) {
  return [...new Set(warnings.map((warning) => String(warning).slice(0, 300)))].slice(0, 24)
}

/** Restore a verified snapshot without any strategy, Jev, search, community,
 * fetch, value or language step. The response keeps the original data: a v2 file
 * returns the v5 record with an s5 page, a v1 file returns the frozen original
 * record with a marked h1 page. Nothing is re-scored or re-ranked. */
function restoreSavedResult(savedResultId, pageSize, deps) {
  if (typeof deps.loadResults !== 'function') {
    throw new Error('adaptive_search: saved research results are not available on this host; no search was performed')
  }
  const record = deps.loadResults(savedResultId)
  if (!record || typeof record !== 'object' || Array.isArray(record) || !Array.isArray(record.results)) {
    throw new Error('adaptive_search: saved research results are unreadable or invalid; no search was performed')
  }
  const metadata = record.metadata && typeof record.metadata === 'object' && !Array.isArray(record.metadata) ? record.metadata : {}
  if ([SAVED_FORMAT_V2, SAVED_FORMAT_V3].includes(record.format)) {
    const version = record.schemaVersion ?? metadata.schemaVersion
    if (version !== (record.format === SAVED_FORMAT_V2 ? 5 : ADAPTIVE_SCHEMA_VERSION)) {
      throw new Error('adaptive_search: saved research format and schema version do not match; no search was performed')
    }
    return resultPages.save(record.results, { ...metadata, schemaVersion: version, savedResultId }, pageSize)
  }
  if (record.format === SAVED_FORMAT_V1) {
    // Missing version stays missing: a historical file is never guessed as v3 or v5.
    const original = record.schemaVersion ?? metadata.schemaVersion
    return resultPages.saveHistorical({
      results: record.results,
      metadata,
      originalFormat: record.format,
      originalSchemaVersion: typeof original === 'number' && Number.isFinite(original) ? original : null,
      savedAt: typeof record.savedAt === 'string' ? record.savedAt : null,
    }, pageSize)
  }
  throw new Error('adaptive_search: unsupported saved research format; no search was performed')
}

/**
 * Run one adaptive_search call.
 *
 * `deps` is the host-neutral injection contract:
 *   readConfig() -> { apiKey, baseUrl, model? }
 *   createClient(config) -> Jev client ({ ask({state,questions,phase,signal}) })
 *   snapshot() -> runtime capability snapshot
 *   route(state, ranking) -> { engineNames: string[], warnings?: string[] }
 *   search(args, state) -> shared fused result (snapshot selection)
 *   toolState() -> { requested, enabled?, reason? }
 *   loadResults(id) / saveResults(results, metadata) -> private persistence
 * Only toolState/loadResults/saveResults are optional; a missing persistence
 * function is reported as a bounded save failure, never as a silent success.
 *
 * `opts.signal` is the only cancellation source. There is no internal total
 * deadline and `opts.deadlineMs` is deliberately ignored: self-imposed
 * cumulative cost/token/request/time quotas are not allowed to stop this flow
 * (2026-10-02 budget supplement). Real single-request timeouts, retries,
 * authentication/rate-limit failures, safety refusals and cancellation remain.
 */
export async function runAdaptiveScreening(input, opts = {}, deps = {}) {
  // 1. Structure and legacy migration first: zero network, zero config, zero Jev.
  const normalized = normalizeAdaptiveInput(input)
  // 2. Public entry gate (explicit OFF or the Jev configuration lock) applies to
  //    new calls AND to cursor/saved_result_id reads.
  assertToolGate(deps.toolState)
  opts.signal?.throwIfAborted()
  // 3. Read-only branches end here: no budget, strategy, search or Jev client.
  if (normalized.mode === 'cursor') return resultPages.read(normalized.cursor, normalized.pageSize)
  if (normalized.mode === 'saved') return restoreSavedResult(normalized.savedResultId, normalized.pageSize, deps)

  const warnings = [...normalized.warnings]
  const params = validateParams(opts.params)
  const policy = validateSourceBiasPolicy(opts.policy)
  // Pure meter: no cumulative cost/token/request/time quota can stop this run.
  const budget = createScreeningBudget({ candidateLimit: adaptiveCandidateLimit(normalized.maxResults), ...opts.limits })
  const limits = budget.limits
  // Only the caller's external signal can cancel; there is no internal total
  // deadline and `opts.deadlineMs` is intentionally not read (host whole-call
  // timeouts must be removed, not re-implemented here).
  const signal = opts.signal ?? null
  const checkCancel = () => signal?.throwIfAborted()
  let configIdentity = null
  let client = null, strategy = null, fused = null, artifact = null, failure = null, searched = false
  const community = {
    input: normalized.communityExplicit ? normalized.community : 'auto',
    source: normalized.communityExplicit ? 'explicit' : 'judge',
    state: normalized.communityExplicit ? 'explicit' : 'unavailable',
    choice: null,
    requested: normalized.communityExplicit ? normalized.community : null,
    reason: null,
    warning: null,
  }
  const stopped = (error) => signal?.aborted === true ? 'cancelled'
    : typeof error?.kind === 'string' && error.kind ? error.kind : 'service_unavailable'
  const judge = async (request, phase) => {
    checkCancel()
    if (!requestFits(request, limits)) throw Object.assign(new Error('Request size limit'), { kind: 'request_too_large' })
    budget.logical()
    const attemptsBefore = budget.usage.jevHttpAttempts
    try {
      const response = await client.ask({ state: request.state, questions: request.questions, phase, signal })
      budget.reported(response)
      if (response?.invalidIds?.length || response?.missingIds?.length || response?.shapeError) {
        warnings.push(`${phase}: missing or invalid fixed answers; unavailable judgements stay excluded`)
      }
      const reasons = [...new Set(Object.values(response?.unavailable ?? {}))].filter(reason => /^[a-z_]{1,64}$/.test(reason))
      if (reasons.length) warnings.push(`${phase}: judgment unavailable (${reasons.join(', ')})`)
      return response?.entries ?? new Map()
    } catch (error) {
      if (budget.usage.jevHttpAttempts > attemptsBefore) budget.usage.unknownUsageCalls++
      failure = stopped(error)
      throw error
    }
  }
  try {
    const cfg = deps.readConfig()
    configIdentity = cfg
    if (cfg?.provider === 'laya' && cfg.capacityStatus && cfg.capacityStatus !== 'loaded') {
      warnings.push(`Laya offline head-capacity evidence ${cfg.capacityStatus}; unverified questions remain unavailable`)
    }
    if (!cfg || cfg.ready === false || (!cfg.provider && !cfg.apiKey)) failure = 'not_configured'
    else {
      const state = deps.snapshot()
      const route = deps.route(state, 'balanced')
      if (!route || !Array.isArray(route.engineNames) || route.engineNames.length === 0) failure = 'no_engines'
      else {
        client = deps.createClient({
          baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, model: cfg.model ?? undefined,
          provider: cfg.provider, transport: cfg.transport, authMode: cfg.authMode, options: cfg.options, capacityManifest: cfg.capacityManifest, signal,
          maxRetries: limits.maxJevRetries, perRequestMs: limits.jevPerRequestMs, maxBackoffMs: limits.jevMaxBackoffMs,
          maxRequestChars: limits.maxRequestChars, maxResponseBytes: limits.maxJevResponseBytes,
          beforeAttempt: (chars) => { checkCancel(); budget.attempt(chars) },
        })
        opts.onProgress?.('selecting the fixed ranking and community strategy')
        const includeCommunity = !normalized.communityExplicit
        strategy = decodeStrategy(await judge(
          buildStrategyRequest({ text: normalized.question }, normalized.intent, normalized.preferences, { presets: RANKING_PRESETS, includeCommunity }),
          'strategy',
        ), { includeCommunity })
        if (strategy.ranking.state === 'fallback') warnings.push('Invalid or missing ranking choice: declared balanced fallback, not model approval')
        if (includeCommunity) {
          community.state = strategy.community.state
          community.choice = strategy.community.choice
          if (strategy.community.state === 'selected') {
            community.requested = strategy.community.choice === 'enable'
            if (strategy.community.choice === 'unknown') {
              community.warning = 'strategy: community choice unknown; defaulted to no community branch, which is not evidence that community discussion is absent'
            }
          } else {
            community.requested = false
            community.reason = 'community_answer_unavailable'
            community.warning = 'strategy: community answer missing or invalid; defaulted to no community branch instead of reporting a model disable choice'
          }
        }
        checkCancel()
        budget.search()
        opts.onProgress?.('collecting the bounded fused candidate snapshot')
        fused = await deps.search({
          query: normalized.question, ranking: strategy.ranking.ranking, complexity: 'medium',
          maxResults: limits.candidateLimit, maxResultsCap: limits.candidateLimit,
          candidateSelection: 'snapshot', snapshotCandidateLimit: limits.candidateLimit,
          community: community.requested === true, signal,
        }, state)
        searched = true
        if (!fused || !Array.isArray(fused.results)) throw Object.assign(new Error('Shared fused search returned no candidate pool'), { kind: 'service_unavailable' })
        // Observations, not requests this run made: a cache hit dispatched nothing.
        budget.usage.engineRequests = fused.cacheHit ? 0 : Object.values(fused.engineStats ?? {}).reduce((total, stat) => total + (stat?.attempts ?? 0), 0)
        budget.usage.engineHttpRequests = fused.cacheHit ? 0 : null
        warnings.push(...(Array.isArray(fused.warnings) ? fused.warnings : []))
        // A transport outage is not a successfully exhausted candidate pool.
        // Keep the fused observations above, but do not screen an unavailable
        // snapshot. Successful zero hits and partial successes remain normal.
        if (fused.results.length === 0 && allAttemptedEnginesFailed(fused.engineStats)) {
          throw Object.assign(new Error('No engine request succeeded'), { kind: 'all_engines_failed' })
        }
        const weights = pickContributionWeights(fused)
        if (!weights) warnings.push('Snapshot contribution weights unavailable from the shared core; positive source contributions are unknown, not inferred from observed engine ranks')
        const candidates = buildSnapshot(fused.results, { engineWeights: weights ?? {}, maxTextChars: limits.maxInitialTextChars }).map(prepareMaterial)
        opts.onProgress?.(`screening ${candidates.length} declared candidates`)
        artifact = await runScreening({
          candidates, question: normalized.question, intent: normalized.intent, preferences: normalized.preferences,
          maxResults: normalized.maxResults, batchSize: limits.batchSize, params, policy, signal,
          limits, judge: (request) => judge(request, 'screening'),
        })
        const fusionRows = Number.isSafeInteger(fused.funnel?.fusionRows) ? fused.funnel.fusionRows : candidates.length
        artifact.diagnostics.snapshotCandidates = candidates.length
        artifact.diagnostics.outsideReview = Math.max(0, fusionRows - candidates.length)
        artifact.diagnostics.unreviewed = artifact.diagnostics.pending + artifact.diagnostics.outsideReview
        if (artifact.diagnostics.outsideReview) {
          warnings.push(`${artifact.diagnostics.outsideReview} fused candidates are outside the declared review cap; only reviewed-set priority is claimed`)
        }
      }
    }
  } catch (error) {
    failure ??= stopped(error)
  }
  if (!artifact) artifact = admitAndRank({ candidates: [], judgements: new Map(), maxResults: normalized.maxResults, params, policy })
  // Only an explicit external cancellation or a real failure stops the run:
  // there is no internal total deadline and no cumulative budget stop.
  const halt = signal?.aborted === true ? 'cancelled' : failure ?? artifact.run?.halted ?? null
  if (halt) {
    artifact.selection.incomplete = true
    artifact.selection.stopReason = halt
    warnings.push(`Screening stopped: ${halt}; only valid reviewed materials are returned`)
  }
  artifact.diagnostics.snapshotCandidates ??= 0
  artifact.diagnostics.outsideReview ??= 0
  artifact.diagnostics.unreviewed ??= 0
  if (!halt && !artifact.selection.targetMet && !artifact.selection.incomplete && artifact.diagnostics.outsideReview > 0) {
    artifact.selection.stopReason = 'review_cap_reached'
  }
  // Community execution status comes from the shared core's structured metadata,
  // never from warnings, `communityUsed` or a provider note.
  const execution = fused && typeof fused.communityExecution === 'object' && !Array.isArray(fused.communityExecution) ? fused.communityExecution : null
  let outcome = community.requested === null ? 'not_run' : community.requested ? 'not_run' : 'not_requested'
  let effective = community.requested === true
  let cacheHit = false
  let usage = {}
  if (execution) {
    if (typeof execution.effective === 'boolean') effective = execution.effective
    if (COMMUNITY_OUTCOMES.includes(execution.outcome)) outcome = execution.outcome
    if (typeof execution.cacheHit === 'boolean') cacheHit = execution.cacheHit
    if (typeof execution.reason === 'string' && COMMUNITY_STATUS_REASON.test(execution.reason)) community.reason = execution.reason
    usage = boundedCommunityUsage(execution.usage)
    if (typeof execution.inFlight === 'boolean' && execution.usage) usage.inFlight = execution.inFlight
  } else if (community.requested === true && searched) {
    community.reason = 'community_status_unavailable'
    community.warning ??= 'community execution status unavailable from the shared core; this run does not claim community success'
  } else if (community.requested === null) {
    community.choice = 'unavailable'
    community.reason ??= failure && COMMUNITY_FAILURE_REASONS.test(failure) ? failure : 'strategy_unavailable'
  }
  if (community.warning) warnings.push(community.warning)
  const communityStatus = {
    input: community.input, source: community.source, choice: community.choice,
    requested: community.requested, effective, outcome, cacheHit,
    reason: community.reason ?? null, usage,
  }
  if (COMMUNITY_FAILURE_OUTCOMES.includes(communityStatus.outcome)) {
    const detail = communityStatus.reason ? ` (${communityStatus.reason})` : ''
    warnings.push(`The community branch did not complete${detail}; valid web results are still screened and returned`)
    if (!halt) {
      artifact.selection.incomplete = true
      // Preserve an existing specific review/service reason. A quantity-success
      // reason alone cannot hide the incomplete community channel.
      if (!artifact.selection.stopReason || artifact.selection.stopReason === 'target_met') {
        artifact.selection.stopReason = 'community_incomplete'
      }
    }
  } else if (communityStatus.outcome === 'domain_excluded') {
    warnings.push('The community branch was skipped because the query domain filters exclude X; the limits were not relaxed')
  } else if (communityStatus.outcome === 'empty') {
    warnings.push('The community branch completed with no posts; this is not evidence that community discussion does not exist')
  }
  if (!artifact.results.length && !halt) {
    warnings.push('No material passed screening for this declared snapshot; an empty result set is not proof that relevant evidence does not exist')
  }
  if (normalized.maxResults > limits.candidateLimit) {
    warnings.push(`Requested ${normalized.maxResults} results exceeds the declared review cap ${limits.candidateLimit}; targetMet is not promised`)
  }
  const clientUsage = typeof client?.usage === 'function' ? client.usage() : null
  const clientDescription = client?.describe?.() ?? {}
  // Legacy client injection can still describe a native transport provider.
  // Map ONLY those known aliases; a missing identity stays unknown.
  const declaredProvider = configIdentity?.provider ?? clientDescription.provider
  const identityProvider = ['jev', 'laya'].includes(declaredProvider) ? declaredProvider
    : ['typesafe', 'vercel'].includes(declaredProvider) ? 'jev' : null
  const identityTransport = configIdentity?.transport ?? clientDescription.transport ??
    (declaredProvider === 'vercel' ? 'vercel-evaluation' : declaredProvider === 'typesafe' ? 'systemone' : null)
  const { results, decisions, ...artifactMeta } = artifact
  const metadata = { ...artifactMeta }
  metadata.diagnostics = Object.fromEntries(Object.entries(metadata.diagnostics ?? {}).filter(([, value]) => typeof value === 'number'))
  metadata.schemaVersion = ADAPTIVE_SCHEMA_VERSION
  metadata.strategyPolicyVersion = STRATEGY_POLICY_VERSION
  metadata.admissionPolicyVersion = ADMISSION_POLICY_VERSION
  metadata.stopReason = artifact.selection.stopReason
  metadata.usage = budget.usage
  metadata.inputSummary = {
    question: normalized.question, intent: normalized.intent, preferences: normalized.preferences,
    community: normalized.communityExplicit ? normalized.community : 'auto', maxResults: normalized.maxResults,
  }
  metadata.run = {
    halted: halt,
    budgetVersion: SCREENING_BUDGET_VERSION,
    limits,
    strategy: {
      ranking: strategy ? { state: strategy.ranking.state, ranking: strategy.ranking.ranking } : { state: 'unavailable', ranking: null },
      community: { state: community.state, choice: community.choice },
    },
    ranking: strategy?.ranking?.ranking ?? null,
    enginePool: typeof fused?.enginePool === 'string' ? fused.enginePool : null,
    cacheHit: fused?.cacheHit === true,
    queriesUsed: (Array.isArray(fused?.queriesUsed) ? fused.queriesUsed : []).filter((query) => typeof query === 'string').slice(0, 8).map((query) => query.slice(0, 200)),
    effectiveWeights: Object.fromEntries(Object.entries(fused?.effectiveWeights ?? {}).filter(([engine, weight]) => engine && Number.isFinite(weight)).slice(0, 24)),
    engineStats: fused ? Object.fromEntries(Object.entries(fused.engineStats ?? {}).slice(0, 8).map(([name, stat]) => [name, {
      used: Boolean(stat?.used), attempts: stat?.attempts ?? 0, successes: stat?.successes ?? 0, errors: stat?.errors ?? 0,
    }])) : {},
    community: communityStatus,
    reviewRule: 'review_declared_snapshot_until_real_failure_or_cancel; no_quantity_early_stop; no_cumulative_budget_stop',
    targetExceedsReviewCap: normalized.maxResults > limits.candidateLimit,
    diversity: 'mu=0; URL deduplication only; near-duplicate folding disabled',
    decisions: decisions.slice(0, 32).map(({ evidenceId, admitted, reason }) => ({ evidenceId, admitted, reason })),
    decisionCount: decisions.length,
    decisionsTruncated: decisions.length > 32,
    batches: artifact.run?.batches ?? 0,
    judgeFailures: artifact.run?.judgeFailures ?? 0,
    judgeFailedIds: (artifact.run?.judgeFailedIds ?? []).slice(0, 32),
    // Historical jev* counters/model are compatibility aliases. Identity is
    // authoritative here, never inferred from an alias or a warning.
    jevModel: typeof clientUsage?.model === 'string' ? clientUsage.model : null,
    judgment: {
      provider: identityProvider,
      transport: identityTransport,
      requestedModel: configIdentity?.model ?? clientDescription.requestedModel ?? clientDescription.model ?? null,
      resolvedModel: clientUsage?.resolvedModel ?? null,
      adapterVersion: clientDescription.adapterVersion ?? null,
    },
    host: typeof opts.host === 'string' && opts.host ? opts.host : 'mcp',
    snapshotCandidates: artifact.diagnostics.snapshotCandidates,
    outsideReview: artifact.diagnostics.outsideReview,
    unreviewed: artifact.diagnostics.unreviewed,
  }
  if (halt && !results.length) metadata.error = halt
  // The stored snapshot carries the run's warnings: freeze them before the write
  // so a saved v3 record validates against the shared v6 metadata contract.
  metadata.warnings = boundedWarnings(warnings)
  // Save the complete selected set BEFORE any page-level trimming, and only when
  // the caller explicitly asked for it and the run was not cancelled.
  if (normalized.saveResults) {
    if (signal?.aborted === true) {
      warnings.push('Research results were NOT saved because this call was cancelled; the returned pages remain available')
    } else {
      if (!results.length) warnings.push('The saved snapshot is empty: no material passed screening. Inspect stopReason; a saved ID is not evidence of a successful search.')
      try {
        if (typeof deps.saveResults !== 'function') throw new Error('persistence_unavailable')
        const savedId = deps.saveResults(results, structuredClone(metadata))
        if (typeof savedId !== 'string' || !savedId) throw new Error('persistence_invalid_id')
        metadata.savedResultId = savedId
      } catch {
        warnings.push('Research results were NOT saved (private store unavailable or snapshot too large); the returned pages remain available and no automatic repeat search will occur')
      }
    }
  }
  metadata.warnings = boundedWarnings(warnings)
  // Audit records only finite code identifiers, counts and the bounded community
  // status; never full text, secrets or model reasoning.
  opts.audit?.write?.({
    type: 'screening',
    schemaVersion: ADAPTIVE_SCHEMA_VERSION,
    policyVersion: metadata.policyVersion,
    judgementPolicyVersion: metadata.judgementPolicyVersion,
    strategyPolicyVersion: metadata.strategyPolicyVersion,
    admissionPolicyVersion: metadata.admissionPolicyVersion,
    budgetVersion: SCREENING_BUDGET_VERSION,
    community: communityStatus,
    snapshotCandidates: metadata.run.snapshotCandidates,
    outsideReview: metadata.run.outsideReview,
    unreviewed: metadata.run.unreviewed,
    diagnostics: metadata.diagnostics,
    selected: results.length,
    stopReason: metadata.stopReason,
    cacheHit: metadata.run.cacheHit,
    usage: budget.usage,
  })
  return resultPages.save(results, metadata, normalized.pageSize)
}
