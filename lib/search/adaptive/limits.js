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
  maxQuestions: 6,
  maxQuestionChars: 400,

  // ---- loop shape ----
  maxRounds: 3,
  concurrency: 3,

  // ---- retrieval budgets (reserved before dispatch, retries included) ----
  maxSearchCalls: 12,
  maxFetchCalls: 6,          // network page fetches
  maxFetchReads: 12,         // page reads incl. cache re-reads with a new focus
  maxFetchesPerRound: 2,     // per question
  maxFetchesPerQuestion: 2,
  maxEnginesPerQuestionPerRound: 3,
  maxResultsPerSearch: 6,
  defaultComplexity: 'medium',
  deepenComplexity: 'complex',

  // ---- evidence pool ----
  maxEvidenceItems: 60,          // question × source associations
  maxExcerptChars: 600,          // per reviewed fragment
  maxExcerptsPerEvidence: 4,     // fragments per evidence item
  maxEvidenceTextChars: 1800,    // total reviewed text per evidence item
  minMaterialWords: 5,           // floor that rejects empty/near-empty text, not a quality bar

  // ---- judgement phases ----
  maxJevCalls: 12,               // logical requests (plan/source/coverage batched)
  maxJevHttpAttempts: 20,        // includes bounded retries
  maxJevInputTokens: 60_000,     // server-reported sum
  maxJevRetries: 2,
  jevPerRequestMs: 20_000,
  jevMaxBackoffMs: 4_000,
  maxStateChars: 48_000,         // serialized `state` per request (conservative size cap)
  maxRequestChars: 60_000,       // serialized whole body per request
  maxSourceJudgeCandidatesPerQuestion: 6,
  maxSourceJudgeCandidatesPerRequest: 12,
  maxQualifiedTextCharsPerQuestion: 9_000,
  maxCoverageEvidencePerQuestion: 8,

  // ---- output ----
  maxOutputChars: 60_000,
  maxEvidencePerQuestionInOutput: 6,
  maxWarnings: 20,

  // ---- deadline (host hard timeouts sit above these) ----
  defaultDeadlineMs: 90_000,
  minBudgetMs: 1_500,
}

/** Per-host soft deadlines: inside the host's own tool timeout, not a tool parameter. */
export const ADAPTIVE_HOST_DEADLINES = {
  mcp: 75_000,
  pi: 120_000,
  dsh: 120_000,
}

/**
 * Heuristic routing thresholds (see the module header: initial values only).
 * One per question type — never added together.
 */
export const ADAPTIVE_THRESHOLDS = {
  engineSelect: 0.5,
  actionConfidence: 0.5,
  relevance: 0.45,
  statesEvidence: 0.55,
  injection: 0.7,
  premiseConflict: 0.7,
  coverage: 0.6,
  sourceConflict: 0.6,
  snippetSelfSufficient: 0.6,
}

export function adaptiveLimits(overrides = {}) {
  return { ...ADAPTIVE_LIMITS, ...overrides }
}
