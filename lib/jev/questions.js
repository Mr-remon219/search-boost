// The two Jev question primitives this feature actually uses: `noul` (a
// probability that the answer is yes, with no separate confidence) and
// `choice` (one option out of a closed set, plus probabilities/confidence).
//
// Reference: https://docs.typesafe.ai/primitives — every answer is constrained
// to the options we supply and every question in one request is independent.
// Score questions are intentionally not wrapped: nothing here needs them.
//
// `instructions` and `criteria` always name the exact `state` path the answer
// is about, so the rule does not live only in a generic rules list or in the
// question id. Code (not the model) then maps answers onto closed sets and
// thresholds.

/** @typedef {{ type: 'noul', instructions: string, criteria?: { true: string, false: string } }} NoulSpec */
/** @typedef {{ type: 'choice', instructions: string, criteria: Record<string, string> }} ChoiceSpec */

/**
 * @param {string} instructions
 * @param {{ true: string, false: string }} criteria
 * @returns {NoulSpec}
 */
export function noul(instructions, criteria) {
  if (!String(instructions ?? '').trim()) throw new Error('noul: instructions are required')
  if (!criteria?.true || !criteria?.false) throw new Error('noul: criteria.true and criteria.false are required')
  return { type: 'noul', instructions: String(instructions), criteria: { true: String(criteria.true), false: String(criteria.false) } }
}

/**
 * @param {string} instructions
 * @param {Record<string, string>} criteria one entry per option
 * @returns {ChoiceSpec}
 */
export function choice(instructions, criteria) {
  if (!String(instructions ?? '').trim()) throw new Error('choice: instructions are required')
  const options = Object.keys(criteria ?? {})
  if (options.length < 2) throw new Error('choice: at least two options are required')
  for (const [key, description] of Object.entries(criteria)) {
    if (!String(key).trim() || !String(description ?? '').trim()) throw new Error('choice: every option needs a key and a description')
  }
  return { type: 'choice', instructions: String(instructions), criteria: Object.fromEntries(Object.entries(criteria).map(([k, v]) => [k, String(v)])) }
}

/**
 * Read a noul answer out of a validated client result.
 * Missing / invalid answers are absence of signal, never a low score.
 * @param {Map<string, { type: string, value?: number, choice?: string, confidence?: number, probabilities?: Record<string, number> }>} entries
 * @param {string} id
 * @returns {{ value: number | null, present: boolean, valid: boolean }}
 */
export function readNoul(entries, id) {
  const entry = entries.get(id)
  if (!entry) return { value: null, present: false, valid: false }
  if (entry.type !== 'noul' || typeof entry.value !== 'number' || !Number.isFinite(entry.value)) {
    return { value: null, present: true, valid: false }
  }
  return { value: entry.value, present: true, valid: true }
}

/**
 * Read a choice answer. The selected option must be one of the offered keys.
 * @param {Map<string, { type: string, value?: number, choice?: string, confidence?: number, probabilities?: Record<string, number> }>} entries
 * @param {string} id
 * @param {string[]} options
 */
export function readChoice(entries, id, options) {
  const entry = entries.get(id)
  if (!entry) return { choice: null, present: false, valid: false, confidence: null, probabilities: {} }
  if (entry.type !== 'choice' || typeof entry.choice !== 'string' || !options.includes(entry.choice)) {
    return { choice: null, present: true, valid: false, confidence: null, probabilities: {} }
  }
  return {
    choice: entry.choice,
    present: true,
    valid: true,
    confidence: typeof entry.confidence === 'number' && Number.isFinite(entry.confidence) ? entry.confidence : null,
    probabilities: entry.probabilities ?? {},
  }
}

/**
 * Route a noul probability at a code threshold: above → 'yes', at-or-below →
 * 'no', absent/invalid → 'missing' (a distinct outcome from a legitimate low
 * score, so a bad response can never be disguised as a valid judgement).
 * @param {Map<string, any>} entries
 * @param {string} id
 * @param {number} threshold
 * @returns {{ state: 'yes'|'no'|'missing', value: number|null }}
 */
export function routeNoul(entries, id, threshold) {
  const { value, valid } = readNoul(entries, id)
  if (!valid || value === null) return { state: 'missing', value: null }
  return { state: value > threshold ? 'yes' : 'no', value }
}

/** Deterministic tie-break / fallback ordering for engine ids. */
export function stableOrder(values) {
  return [...new Set(values)]
}
