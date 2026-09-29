// Fixed option catalogs and the source-bias policy gate for the screening
// prototype (docs/adaptive-fused-screening-plan.md §3). Code owns every option
// id and eligibility rule; Jev only selects among the options a call offers.
import { logicalEngine } from '../scoring.js'

export const RANKING_OPTIONS = Object.freeze(['balanced', 'research', 'fresh'])
export const LANGUAGE_OPTIONS = Object.freeze(['english', 'non_english', 'uncertain'])
export const VALUE_OPTIONS = Object.freeze(['0', '1', '2', '3', '4', '5', 'unestablished'])
export const PUBLISHABLE_VALUE_LEVELS = Object.freeze([3, 4, 5])
export const VALUE_LABELS = Object.freeze({ 3: 'medium', 4: 'medium_high', 5: 'high' })
export const DISCOUNT_OPTIONS = Object.freeze(['none', 'mild', 'strong', 'unknown'])
export const PREFERENCE_MATCH_OPTIONS = Object.freeze(['match', 'partial', 'no_match', 'unknown'])
/** The information-state vocabulary: one definition shared by the question
 * criteria, the decoder's accepted answers and the controller's gate. */
export const INFO_OPTIONS = Object.freeze(['established', 'insufficient_information', 'explicit_conflict', 'unestablished_reason'])

/** D=1 for every option; the prototype ships NO claimed engine-quality mapping. */
export const NEUTRAL_SOURCE_BIAS_POLICY = Object.freeze({
  version: 'neutral-v1',
  nature: 'policy_preference',
  mildEligible: Object.freeze([]),
  strongEligible: Object.freeze([]),
})

/** A modelled policy supplies ALL four criteria, not partial overrides over
 * engine-list defaults. Eligibility still gates the options; if stated
 * conditions overlap, the fixed priority resolves them without inventing a
 * coefficient. Insufficient evidence must never be resolved toward a discount. */
export const DISCOUNT_SELECTION_RULE = 'Consider only the offered options. If applicability is uncertain, select unknown. Otherwise, among established conditions select strong before mild before none. None describes the case where no offered discount condition applies. Never infer source quality from channel membership.'

const optionList = (value, name) => {
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string' || !v.trim())) throw new TypeError(`${name} must be an array of engine names`)
  return [...new Set(value.map((v) => v.trim()))].sort()
}

export function validateSourceBiasPolicy(policy = NEUTRAL_SOURCE_BIAS_POLICY) {
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) throw new TypeError('sourceBiasPolicy must be an object')
  if (typeof policy.version !== 'string' || !policy.version.trim()) throw new TypeError('sourceBiasPolicy.version is required')
  if (!['policy_preference', 'validated_increment'].includes(policy.nature)) throw new TypeError('sourceBiasPolicy.nature must be policy_preference or validated_increment')
  const mildEligible = optionList(policy.mildEligible ?? [], 'mildEligible')
  const strongEligible = optionList(policy.strongEligible ?? [], 'strongEligible')
  for (const engine of strongEligible) if (!mildEligible.includes(engine)) throw new RangeError(`strongEligible engine must also be mildEligible: ${engine}`)
  const suppliedCriteria = policy.criteria ?? {}
  if (typeof suppliedCriteria !== 'object' || Array.isArray(suppliedCriteria)) throw new TypeError('sourceBiasPolicy.criteria must be an object')
  const criteria = {}
  for (const [id, text] of Object.entries(suppliedCriteria)) {
    if (!DISCOUNT_OPTIONS.includes(id)) throw new RangeError(`Unknown sourceBiasPolicy.criteria key: ${id}`)
    if (typeof text !== 'string' || !text.trim()) throw new TypeError(`sourceBiasPolicy.criteria.${id} must be a non-empty string`)
    criteria[id] = text.trim()
  }
  if (Object.keys(criteria).length) {
    const missing = DISCOUNT_OPTIONS.filter((id) => !Object.hasOwn(criteria, id))
    if (missing.length) throw new TypeError(`sourceBiasPolicy.criteria must describe every option; missing: ${missing.join(', ')}`)
  }
  return Object.freeze({
    version: policy.version.trim(), nature: policy.nature,
    mildEligible: Object.freeze(mildEligible), strongEligible: Object.freeze(strongEligible),
    criteria: Object.freeze(criteria),
  })
}

/**
 * Which discount options a call may offer, from the REAL positive-contribution
 * logical engine set E, and whether the level is a code fact or a judgement.
 * An engine outside the eligible sets can only weaken the discount, never
 * trigger it; missing provenance is `unknown` only.
 * @returns {{ options: string[], codeSelected: string|null, basis: 'established'|'missing_provenance', selection: 'code'|'model' }}
 */
export function eligibleDiscountOptions(policy, engines) {
  const p = validateSourceBiasPolicy(policy)
  const E = [...new Set((engines ?? []).map((engine) => logicalEngine(String(engine))))]
  if (!E.length) return { options: ['unknown'], codeSelected: 'unknown', basis: 'missing_provenance', selection: 'code' }
  const options = ['none']
  if (E.every((engine) => p.mildEligible.includes(engine))) options.push('mild')
  if (E.every((engine) => p.strongEligible.includes(engine))) options.push('strong')
  options.push('unknown')
  const policyLevel = options.includes('strong') ? 'strong' : options.includes('mild') ? 'mild' : 'none'
  const modelled = Object.keys(p.criteria).length > 0
  return {
    options,
    codeSelected: modelled ? null : policyLevel,
    basis: 'established',
    selection: modelled ? 'model' : 'code',
  }
}

/** Complete, caller-declared criteria for the offered options. No fallback
 * silently combines a custom rule with incompatible engine-list conditions. */
export function discountCriteria(policy, options) {
  const p = validateSourceBiasPolicy(policy)
  const out = {}
  for (const id of options) {
    const text = p.criteria[id]
    if (!text) throw new RangeError(`No criteria text for discount option: ${id}`)
    out[id] = text
  }
  return out
}

/** Aggregated preference match values; exact duplicate preference texts are collapsed upstream. */
export function normalizePreferenceMatches(matches, expected) {
  if (!Array.isArray(matches)) throw new TypeError('preference matches must be an array')
  if (matches.length !== expected) throw new RangeError(`expected ${expected} preference matches, got ${matches.length}`)
  return matches.map((match) => {
    if (!PREFERENCE_MATCH_OPTIONS.includes(match)) throw new RangeError(`Unknown preference match: ${match}`)
    return match
  })
}
