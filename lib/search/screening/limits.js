// Capacity/protocol limits for ONE adaptive_search call plus PURE usage metering.
//
// Per the 2026-10-02 budget supplement, this flow imposes NO self-imposed
// cumulative cap on cost, tokens, request counts or total run duration: usage is
// observed and reported only, and it never blocks a dispatch, a batch or the
// delivery of already valid results. Real single-request timeouts, capacity
// batch splitting, limited retries, authentication/rate-limit failures, SSRF and
// content safety, and explicit cancellation are unchanged and still enforced.
import { DEFAULT_SNAPSHOT_CANDIDATE_LIMIT, validateSnapshotCandidateLimit } from '../snapshot-capacity.js'

export const SCREENING_METERING_VERSION = 'screening-metering-v3-no-cumulative-cap'
/** Name kept for the run record/log field; it now identifies the metering module. */
export const SCREENING_BUDGET_VERSION = SCREENING_METERING_VERSION
export const SCREENING_LIMITS = Object.freeze({
  // Flow shape (the one fused call, the declared 32-candidate snapshot and the
  // batch size are output/process design, not a cumulative resource quota).
  candidateLimit: DEFAULT_SNAPSHOT_CANDIDATE_LIMIT, batchSize: 4, rescueReads: 0,
  // Real single-request protection and capacity.
  maxJevRetries: 1, maxJevResponseBytes: 24_000,
  maxInitialTextChars: 8_000,
  jevPerRequestMs: 20_000, jevMaxBackoffMs: 4_000,
  maxStateChars: 48_000, maxRequestChars: 60_000,
})
const NONZERO_LIMITS = Object.freeze([
  'candidateLimit', 'batchSize', 'jevPerRequestMs', 'maxStateChars', 'maxRequestChars', 'maxJevResponseBytes', 'maxInitialTextChars',
])

/**
 * Usage meter for one run. `search`/`logical`/`attempt` only count what
 * happened: they never throw and never refuse a later request. The client's
 * `beforeAttempt(chars)` hook calls `attempt` before every HTTP attempt
 * (including retries) purely to meter and to check cancellation.
 */
export function createScreeningBudget(limits = SCREENING_LIMITS) {
  for (const key of Object.keys(limits)) if (!Object.hasOwn(SCREENING_LIMITS, key)) throw new TypeError(`Unknown screening limit: ${key}`)
  const cap = { ...SCREENING_LIMITS, ...limits }
  for (const [key, value] of Object.entries(cap)) {
    if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`Invalid screening limit: ${key}`)
    if (NONZERO_LIMITS.includes(key) && value === 0) throw new TypeError(`Invalid screening limit: ${key}`)
  }
  validateSnapshotCandidateLimit(cap.candidateLimit)
  // No automatic rescue read exists in this flow, so a non-zero value could only
  // silently re-open a retired capability. Refuse it instead of ignoring it.
  if (cap.rescueReads !== 0) throw new TypeError('Invalid screening limit: rescueReads must be 0 (no automatic page read in the N_off flow)')
  let attemptsThisCall = 0
  const usage = {
    fusedCalls: 0, engineRequests: null, engineHttpRequests: null,
    jevCalls: 0, jevHttpAttempts: 0, jevRetries: 0,
    jevInputTokensEstimated: 0, jevTokensEstimatedReserved: 0, jevUsageUnknownAttempts: 0,
    jevInputTokens: null, jevOutputTokens: null, serverUsageCalls: 0, unknownUsageCalls: 0,
    // fetch_page/rescue compatibility counters: this layer never reads pages, so
    // they are a real zero, not an unknown. They never deny the X fallback's own
    // provider requests, which are disclosed through the community metadata.
    fetchReads: 0, fetchCalls: 0, fetchCacheReads: 0, fetchHttpRequests: 0,
  }
  return {
    limits: cap, usage,
    search() { usage.fusedCalls++ },
    logical() { usage.jevCalls++; attemptsThisCall = 0 },
    // Metering only: called by the client immediately BEFORE every HTTP attempt.
    attempt(chars) {
      const tokens = Math.ceil(Math.max(0, Number(chars) || 0) / 2)
      usage.jevHttpAttempts++
      usage.jevUsageUnknownAttempts++
      usage.jevInputTokensEstimated += tokens
      usage.jevTokensEstimatedReserved += tokens + Math.ceil(cap.maxJevResponseBytes / 2)
      if (attemptsThisCall++ > 0) usage.jevRetries++
    },
    reported(result) {
      const u = result?.usage
      if (u?.inputTokens != null || u?.outputTokens != null) usage.serverUsageCalls++
      if (u?.inputTokens != null && u?.outputTokens != null) usage.jevUsageUnknownAttempts = Math.max(0, usage.jevUsageUnknownAttempts - 1)
      if (u?.inputTokens != null) usage.jevInputTokens = (usage.jevInputTokens ?? 0) + u.inputTokens
      if (u?.outputTokens != null) usage.jevOutputTokens = (usage.jevOutputTokens ?? 0) + u.outputTokens
      if (u?.inputTokens == null || u?.outputTokens == null) usage.unknownUsageCalls++
    },
  }
}
