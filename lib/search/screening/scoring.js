// Screening ranking math for the fused+Jev prototype (design contract:
// docs/adaptive-fused-screening-plan.md, "排序数学模型与不变量").
//
// Code computes every number. Jev only ever selects fixed option ids; its
// choice probabilities are never used as scores. The formula is
//   b = B / (B + tau)
//   core = lambda*b + (1-lambda)*u
//   S = D*core + epsilon*p
// so value utility and the preference bonus are NOT multiplied by B. S is a
// bounded ordering policy, not a probability or trust score.
export const SCREENING_POLICY_VERSION = 'fused-screening-mix-v2-prototype'

export const DEFAULT_SCREENING_PARAMS = Object.freeze({
  tau: 1,
  lambda: 0.5,
  utilities: Object.freeze({ 3: 0.25, 4: 0.6, 5: 1 }),
  discountFactors: Object.freeze({ none: 1, mild: 0.9, strong: 0.75, unknown: 1 }),
  preferenceMatchValues: Object.freeze({ match: 1, partial: 0.5, no_match: 0, unknown: 0 }),
  epsilon: 0.1,
  mu: 0,
})

const OPTION_KEYS = Object.freeze({
  utilities: ['3', '4', '5'],
  discountFactors: ['none', 'mild', 'strong', 'unknown'],
  preferenceMatchValues: ['match', 'partial', 'no_match', 'unknown'],
})

function mergeParams(params) {
  const source = params ?? {}
  if (typeof source !== 'object' || Array.isArray(source)) throw new TypeError('Screening params must be an object')
  return {
    ...DEFAULT_SCREENING_PARAMS, ...source,
    utilities: { ...DEFAULT_SCREENING_PARAMS.utilities, ...(source.utilities ?? {}) },
    discountFactors: { ...DEFAULT_SCREENING_PARAMS.discountFactors, ...(source.discountFactors ?? {}) },
    preferenceMatchValues: { ...DEFAULT_SCREENING_PARAMS.preferenceMatchValues, ...(source.preferenceMatchValues ?? {}) },
  }
}

/** Validate a (possibly partial) parameter override against the full merged result. */
export function validateParams(params = {}) {
  const merged = mergeParams(params)
  const { tau, lambda, epsilon, mu } = merged
  if (!Number.isFinite(tau) || tau <= 0) throw new RangeError('tau must be finite and positive')
  if (!Number.isFinite(lambda) || lambda < 0 || lambda > 1) throw new RangeError('lambda must be in [0, 1]')
  if (!Number.isFinite(epsilon) || epsilon < 0) throw new RangeError('epsilon must be finite and nonnegative')
  if (!Number.isFinite(mu) || mu < 0) throw new RangeError('mu must be finite and nonnegative')
  for (const [name, keys] of Object.entries(OPTION_KEYS)) {
    const table = merged[name]
    const actual = Object.keys(table).sort()
    if (actual.join(',') !== [...keys].sort().join(',')) throw new RangeError(`${name} must define exactly: ${keys.join(', ')}`)
    for (const key of keys) if (!Number.isFinite(table[key])) throw new RangeError(`${name}.${key} must be finite`)
  }
  const u = merged.utilities
  if (!(u['3'] >= 0 && u['3'] < u['4'] && u['4'] < u['5'] && u['5'] <= 1)) throw new RangeError('utilities must satisfy 0 <= u(3) < u(4) < u(5) <= 1')
  for (const value of Object.values(merged.discountFactors)) if (value <= 0 || value > 1) throw new RangeError('discount factors must be in (0, 1]')
  const d = merged.discountFactors
  if (d.none !== 1) throw new RangeError('discountFactors.none must be 1: no discount is neutral')
  if (d.unknown !== 1) throw new RangeError('discountFactors.unknown must be 1: unknown provenance stays neutral and disclosed')
  if (!(d.strong <= d.mild && d.mild <= d.none)) throw new RangeError('discount factors must satisfy strong <= mild <= none')
  const p = merged.preferenceMatchValues
  for (const [key, value] of Object.entries(p)) if (value < 0 || value > 1) throw new RangeError('preference match values must be in [0, 1]')
  if (p.no_match !== 0 || p.unknown !== 0) throw new RangeError('no_match and unknown preference matches must map to 0')
  return Object.freeze({
    ...merged,
    utilities: Object.freeze({ ...merged.utilities }),
    discountFactors: Object.freeze({ ...merged.discountFactors }),
    preferenceMatchValues: Object.freeze({ ...merged.preferenceMatchValues }),
  })
}

/** b = B/(B+tau) in [0,1), overflow-safe, order-preserving in B. */
export function normalizeBase(baseScore, tau = DEFAULT_SCREENING_PARAMS.tau) {
  if (!Number.isFinite(baseScore) || baseScore <= 0) throw new RangeError('baseScore must be finite and positive')
  if (!Number.isFinite(tau) || tau <= 0) throw new RangeError('tau must be finite and positive')
  if (baseScore >= tau) return 1 / (1 + tau / baseScore)
  const x = baseScore / tau
  return x / (1 + x)
}

/** Average of the code-defined match values; empty input is exactly 0. */
export function preferenceValue(matches, matchValues = DEFAULT_SCREENING_PARAMS.preferenceMatchValues) {
  if (!Array.isArray(matches)) throw new TypeError('preferenceMatches must be an array')
  if (matches.length === 0) return 0
  let sum = 0
  for (const match of matches) {
    if (!Object.hasOwn(matchValues, match)) throw new RangeError(`Unknown preference match: ${match}`)
    sum += matchValues[match]
  }
  return sum / matches.length
}

/**
 * Final screening score for one ELIGIBLE candidate (the eligibility gate is
 * applied by the caller before scoring). Returns every contribution so the
 * ranking is reconstructable: finalScore = core - sourcePenalty + preferenceBonus.
 */
export function screeningScore({ baseScore, valueLevel, discount, preferenceMatches = [], redundancy = 0 }, params = DEFAULT_SCREENING_PARAMS) {
  const p = validateParams(params)
  if (!Number.isInteger(valueLevel) || valueLevel < 3 || valueLevel > 5) throw new RangeError('valueLevel must be an integer in {3, 4, 5}')
  if (!Object.hasOwn(p.discountFactors, discount)) throw new RangeError(`Unknown discount: ${discount}`)
  if (!Number.isFinite(redundancy) || redundancy < 0 || redundancy > 1) throw new RangeError('redundancy must be in [0, 1]')
  const b = normalizeBase(baseScore, p.tau)
  const u = p.utilities[valueLevel]
  const D = p.discountFactors[discount]
  const matchValue = preferenceValue(preferenceMatches, p.preferenceMatchValues)
  const baseContribution = p.lambda * b
  const valueContribution = (1 - p.lambda) * u
  const coreScore = baseContribution + valueContribution
  const sourcePenalty = (1 - D) * coreScore
  const preferenceBonus = p.epsilon * matchValue
  const finalScore = coreScore - sourcePenalty + preferenceBonus
  return {
    policyVersion: SCREENING_POLICY_VERSION,
    baseNormalized: b, valueUtility: u, sourceDiscountFactor: D,
    baseContribution, valueContribution, coreScore, sourcePenalty,
    preferenceValue: matchValue, preferenceBonus, finalScore,
    selectionScore: finalScore - p.mu * redundancy,
  }
}
