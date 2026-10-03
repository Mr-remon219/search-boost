// One capacity contract for the shared fused snapshot and adaptive's declared
// review set. This is a finite candidate pool, not a cumulative request quota.
export const DEFAULT_SNAPSHOT_CANDIDATE_LIMIT = 32
export const MAX_SNAPSHOT_CANDIDATE_LIMIT = 500
const DEFAULT_RESULT_TARGET = 10

export function validateSnapshotCandidateLimit(limit) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_SNAPSHOT_CANDIDATE_LIMIT) {
    throw new RangeError(`snapshot candidate limit must be an integer from 1 to ${MAX_SNAPSHOT_CANDIDATE_LIMIT}`)
  }
  return limit
}

/** Preserve the original 32-for-10 headroom, scale it for larger legal targets.
 * Capacity is chosen BEFORE the one search; no second search or quantity-based
 * early stop is introduced, and actual supply/qualification may still fall short. */
export function adaptiveCandidateLimit(resultTarget) {
  if (!Number.isSafeInteger(resultTarget) || resultTarget < 1 || resultTarget > 50) {
    throw new RangeError('adaptive result target must be an integer from 1 to 50')
  }
  return Math.max(DEFAULT_SNAPSHOT_CANDIDATE_LIMIT,
    Math.ceil(resultTarget * DEFAULT_SNAPSHOT_CANDIDATE_LIMIT / DEFAULT_RESULT_TARGET))
}
