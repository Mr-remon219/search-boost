// Deterministic retrieval stopping rule, NOT a semantic verdict or probability.
// Equal keyword weights, capped progress, and a per-keyword floor prevent a
// strong point from paying for an empty one. Always recompute from current
// evidence scores; rounds, retries and historical approvals earn no credit.
import { RETRIEVAL_CONVERGENCE_POLICY } from './limits.js'

export function retrievalConvergence(states, policy = RETRIEVAL_CONVERGENCE_POLICY) {
  const { keywordTarget, totalThreshold, keywordFloor } = policy
  if (!Number.isFinite(keywordTarget) || keywordTarget <= 0
    || !Number.isFinite(totalThreshold) || totalThreshold <= 0 || totalThreshold > 100
    || !Number.isFinite(keywordFloor) || keywordFloor <= 0 || keywordFloor > 1
    || totalThreshold < 100 * keywordFloor) throw new RangeError('Invalid retrieval convergence policy')
  const points = states.map(state => {
    const valid = Number.isFinite(state.score) && state.score >= 0 && state.distinct > 0
    const progress = valid ? Math.min(1, state.score / keywordTarget) : 0
    return { keyword: state.keyword, progress, minimumMet: progress >= keywordFloor }
  })
  const score = points.length ? 100 * points.reduce((sum, point) => sum + point.progress, 0) / points.length : 0
  const minimumProgress = points.length ? Math.min(...points.map(point => point.progress)) : 0
  const satisfied = points.length > 0 && score >= totalThreshold && points.every(point => point.minimumMet)
  return {
    method: 'score_threshold_v1', status: satisfied ? 'satisfied' : 'insufficient',
    score, totalThreshold, keywordTarget, keywordFloor, minimumProgress,
    keywordCount: points.length, points,
  }
}
