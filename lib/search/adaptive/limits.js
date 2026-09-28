// Adaptive-search budgets and thresholds — the single place to tune this
// feature. None of these are tool parameters: the model cannot raise a budget,
// widen the engine set, or lower a threshold.
//
// Thresholds are INITIAL HEURISTIC values, not calibrated accuracies. A Jev
// probability is a model judgement (how likely the answer is yes), never a
// measured correctness rate, and confidence is not source truthfulness. Scores
// from different question types are never summed.

export const ADAPTIVE_LIMITS = {
  // ---- input contract ----
  minQuestions: 1,
  maxQuestions: 1,
  maxTargets: 1,
  maxQuestionChars: 400,
  maxIntentChars: 2000,      // root intent: concise search preferences, not secrets
  maxTargetIntentChars: 1000, // per-target intent, combined with the root intent
  maxKeywordChars: 100,

  // ---- loop shape ----
  // EXPERIMENTAL ceilings: deliberately generous while the feature is being
  // tuned, so a long multi-question run is not cut short. They are still hard
  // code caps (never tool parameters) and will be recalibrated with the Phase 4
  // eval numbers; raising them never widens the engine set or lowers a threshold.
  maxRounds: 6,
  keywordAccumulation: true, // V2: evidence-index controller; false only for legacy comparisons
  // V3 default: reading-value selection with a per-keyword continuation queue.
  // false is an explicit internal switch for frozen offline comparisons only;
  // it is never a tool parameter and never widens budgets or the engine set.
  retrievalMode: true,
  scopeFirst: true, // false only for frozen internal V3 comparisons, never a tool input
  maxScopeRescuesPerRound: 4,
  maxScopeQualityBatchesPerRound: 2, // yield to focused retrieval rather than drain a broad pool
  maxRetrievalFinalChecks: 3,
  minInitialReviewMaterials: 64, // review opportunities, not a required result count
  maxQueryChoices: 8, // bounded typed planning alternatives per actual search
  maxPoolRowsPerRound: 500,
  minPoolRowsPerRound: 24,
  recoveryConstant: 1.25,
  // Algebraically bounded starting weights, NOT experimentally calibrated accuracy.
  factScore: { alpha: 0.25, beta: 0.90, gamma: 0.10, rho: 0.5 },
  maxFinalChecks: 2,
  maxFactBundleCallsPerRound: 4,
  maxNoProgressRounds: 2,
  concurrency: 3,

  // ---- retrieval budgets (reserved before dispatch, retries included) ----
  maxSearchCalls: 30,
  maxFetchCalls: 15,         // network page fetches
  maxFetchReads: 30,         // page reads incl. cache re-reads with a new focus
  maxFetchesPerRound: 3,     // per question and step: bounded branch factor
  maxFetchesPerQuestion: 6,
  maxRecursionDepth: 2,      // initial retrieval = depth 1; deepening stops at 2
  maxBranchPerNode: 3,       // new pages/queries pursued per deepening node
  gapStallLimit: 2,          // same gap twice in a row -> stop deepening this question
  maxEnginesPerQuestionPerRound: Infinity, // configuration/health still constrain engines
  round1EnginesPerQuestion: Infinity,
  maxResultsPerSearch: 6,
  maxPoolRowsPerSearch: 500,     // allocated from the global per-round quota
  defaultComplexity: 'medium',
  deepenComplexity: 'complex',

  // ---- evidence pool ----
  maxEvidenceItems: Infinity,         // question × source associations
  maxExcerptChars: 600,          // per reviewed fragment (unchanged: not a masking knob)
  maxExcerptsPerEvidence: 4,     // fragments per evidence item
  maxEvidenceTextChars: 1800,    // total reviewed text per evidence item
  minMaterialWords: 5,           // floor that rejects empty/near-empty text, not a quality bar

  // ---- judgement phases ----
  maxJevCalls: 72,               // logical requests (plan/source/coverage batched)
  maxJevHttpAttempts: 80,        // includes bounded retries
  maxJevInputTokens: 1_200_000,    // estimated input cap; server usage is reported separately
  maxJevRetries: 2,
  jevPerRequestMs: 20_000,
  jevMaxBackoffMs: 4_000,
  maxStateChars: 48_000,         // serialized `state` per request (conservative size cap)
  maxRequestChars: 60_000,       // serialized whole body per request
  maxSourceJudgeCandidatesPerQuestion: 32,
  maxSourceJudgeCandidatesPerRequest: 32,
  maxSourceAssessmentAttempts: 2, // incomplete typed answers: at most two assessments per text version, one per round
  maxSourceJudgeMicroBatches: 64,  // actual batch size also bounded by serialized request bytes
  maxQualifiedTextCharsPerQuestion: 18_000,
  maxCoverageEvidencePerQuestion: 24,

  // ---- output ----
  maxOutputChars: 60_000,
  engineFailureThreshold: 2,
  maxEvidencePerQuestionInOutput: 6,
  maxWarnings: 40,

  // ---- deadline (host hard timeouts sit above these) ----
  defaultDeadlineMs: 150_000,
  minBudgetMs: 1_500,
}

/** Per-host soft deadlines: inside the host's own tool timeout, not a tool parameter. */
export const ADAPTIVE_HOST_DEADLINES = {
  mcp: 120_000,   // MCP adapter aborts the tool at 150s
  pi: 150_000,
  dsh: 150_000,   // DSH tool timeout is 180s
}

/**
 * Heuristic routing thresholds (see the module header: initial values only).
 * One per question type — never added together.
 */
export const ADAPTIVE_THRESHOLDS = {
  engineSelect: 0.5,
  actionConfidence: 0.5,
  finalProbability: 0.85, // selected-option probability, independent of optional confidence
  // V2 pilot: slightly stricter than A1; uncertain material stays a lead.
  // Keyword readiness is a separate index, never a probability of completeness.
  relevance: 0.50,
  statesEvidence: 0.60,
  // V3: v must be > readingValue, r > relevance, injection known and <= injection,
  // and a keyword/topic match is only credited above keywordMatch.
  readingValue: 0.50,
  keywordMatch: 0.5,
  directionLambda: 0.35, // u=min(r,v)*(.65+.35*d): focus boosts rank, not admission
  directionMatch: null, // direction is not a document admission veto
  focusDirection: 0.65, // focus/supporting presentation tier only
  scopeAllow: 0.85, // uncalibrated first-stage Choice acceptance
  deferBand: 0.25,
  injection: 0.7,
  premiseConflict: 0.7,
  coverage: 0.85, // preserve the pre-experiment final gate; not calibrated accuracy
  factSupport: 0.60,
  provenance: 0.85,
  sourceConflict: 0.6,
  snippetSelfSufficient: 0.6,
}

export function adaptiveLimits(overrides = {}) {
  return { ...ADAPTIVE_LIMITS, ...overrides }
}

/**
 * The single definition of the retrieval-mode switch. It is derived from code
 * limits only (never a tool parameter): keyword accumulation must be on and the
 * retrieval controller must not have been explicitly disabled for a frozen
 * offline comparison.
 */
export function retrievalModeEnabled(limits) {
  const active = limits ?? ADAPTIVE_LIMITS
  return active.keywordAccumulation === true && active.retrievalMode !== false
}
