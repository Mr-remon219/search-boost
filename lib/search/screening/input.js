// One host-neutral input contract for the single N_off adaptive flow. Legacy and
// unknown fields are rejected BEFORE any config read, tool gate, budget, Jev
// call or search; nothing is silently stripped.
export const CONSTRAINTS_DESCRIPTION = 'Retired material gate: omit this field; [] is ignored with a warning, and non-empty arrays fail with adaptive_constraints_removed before network calls. Keep conditions in questions/intent; hard domain limits use site:/-site: or fused_search domain filters.'

export const CONSTRAINTS_MIGRATION_MESSAGE = 'adaptive_search removed the per-material constraints hard gate. No search was performed. Keep the full research question and direction in questions/intent; for hard domain limits use the existing site:/-site: operators or fused_search include_domains/exclude_domains. Other conclusions or document properties that must hold are verified by the main Agent after reading; this tool does not guarantee that every material satisfies all research conditions. Review and call again. ' +
  'adaptive_search 已移除逐材料 constraints 硬准入。本次未执行搜索。请把完整研究问题与方向保留在 questions/intent；需要硬域名限制时使用已有 site:/-site: 或 fused_search 的 include_domains/exclude_domains。其他必须满足的结论或文档属性由主 Agent 阅读核验。本工具不保证每条材料满足全部研究条件。请审阅后重新调用。'

export const SAVED_RESULT_ID_PATTERN = '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
const SAVED_RESULT_ID = new RegExp(SAVED_RESULT_ID_PATTERN)

export const ADAPTIVE_INPUT_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    questions: { type: 'array', minItems: 1, maxItems: 1, items: { type: 'string', minLength: 1, maxLength: 400 }, description: 'Exactly one full question for an initial call. English is requested, not validated or translated by the server; the question is searched as written, without intent/preference expansion. Omit for saved-result reads.' },
    intent: { type: 'string', minLength: 1, maxLength: 2000, description: 'Required research direction for an initial call; English is requested but not enforced or translated. Guides screening, never a hard material gate or search suffix. Do not send secrets or private reasoning.' },
    preferences: { type: 'array', maxItems: 8, items: { type: 'string', minLength: 1, maxLength: 300 }, description: 'Optional independent soft preferences; an equal-weight average bonus is applied only after admission. Exact duplicates count once.' },
    community: { type: 'boolean', description: 'Omit for Jev to choose the existing X community branch; true/false overrides explicitly without another question. Unknown/missing strategy choice means off, with disclosure. Does not grant permissions or change engines/domain limits; ordinary fused_search still defaults to false.' },
    constraints: { type: 'array', maxItems: 8, items: { type: 'string', minLength: 1, maxLength: 300 }, description: CONSTRAINTS_DESCRIPTION },
    save_results: { type: 'boolean', description: 'Opt in to a private persistent snapshot of ALL final selected results plus the typed response metadata. Initial question calls only; no credentials or model logs are saved. Returns savedResultId for export/recovery after restart. Default false.' },
    max_results: { type: 'integer', minimum: 1, maximum: 50, description: 'Maximum results selected and saved for this run (default 10, max 50); not the candidate count or the page size.' },
    page_size: { type: 'integer', minimum: 1, maximum: 50, description: 'Results per returned page (default 20, max 50); it never changes ranking, selection, totalResults or targetMet.' },
    cursor: { type: 'string', minLength: 1, maxLength: 100, description: 'Read the next page of this process-local run (s5:) or of a restored historical snapshot (h1:). Accepts page_size only; expired, evicted or out-of-range cursors fail before any search.' },
    saved_result_id: { type: 'string', minLength: 36, maxLength: 36, pattern: SAVED_RESULT_ID_PATTERN, description: 'Read a previously saved snapshot from this SearchBoost home after restart or cache eviction. Accepts page_size only; no Jev, strategy, search, community or value judgement runs.' },
  },
}

export class AdaptiveInputError extends TypeError {
  constructor(code, message) {
    super(`${code}: ${message}`)
    this.name = 'AdaptiveInputError'
    this.code = code
  }
}

const reject = (code, message) => { throw new AdaptiveInputError(code, message) }
const isNonBlank = (value, max) => typeof value === 'string' && value.trim().length > 0 && value.length <= max

/**
 * Normalize one public call. Returns a discriminated mode:
 *  - { mode: 'new', question, intent, preferences, community, communityExplicit, saveResults, maxResults, pageSize, warnings }
 *  - { mode: 'cursor', cursor, pageSize, warnings }
 *  - { mode: 'saved', savedResultId, pageSize, warnings }
 * `community` is `undefined` when the caller omitted it: omission and an
 * explicit false must stay distinguishable all the way to the strategy request.
 */
export function normalizeAdaptiveInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    reject('invalid_input', 'Supply exactly one question with a required intent, or a cursor or saved_result_id')
  }
  const known = new Set(Object.keys(ADAPTIVE_INPUT_SCHEMA.properties))
  for (const key of Object.keys(input)) {
    if (!known.has(key)) {
      reject('unsupported_field', `Unsupported adaptive input field: ${key}; legacy fields (keywords, tasks, targets, facts, time_range, ...) are not accepted and are never silently stripped`)
    }
  }
  for (const key of ['page_size', 'max_results']) {
    if (input[key] !== undefined && (!Number.isInteger(input[key]) || input[key] < 1 || input[key] > 50)) {
      reject('invalid_input', `${key} must be an integer from 1 to 50`)
    }
  }
  const pageSize = input.page_size ?? 20
  const hasCursor = input.cursor !== undefined
  const hasSaved = input.saved_result_id !== undefined
  if (hasCursor || hasSaved) {
    if (hasCursor && hasSaved) reject('invalid_input', 'A cursor and a saved_result_id cannot be combined; supply only one of them (optional page_size)')
    const extra = Object.keys(input).filter((key) => !['cursor', 'saved_result_id', 'page_size'].includes(key))
    if (extra.length) reject('invalid_input', `Reading saved results accepts page_size only; remove: ${extra.join(', ')} (no search, strategy, save or new-research field is allowed)`)
    if (hasCursor) {
      if (typeof input.cursor !== 'string' || input.cursor.length < 1 || input.cursor.length > 100) reject('invalid_input', 'Invalid adaptive cursor')
      return { mode: 'cursor', cursor: input.cursor, pageSize, warnings: [] }
    }
    if (typeof input.saved_result_id !== 'string' || !SAVED_RESULT_ID.test(input.saved_result_id)) reject('invalid_input', 'Invalid saved research result ID')
    return { mode: 'saved', savedResultId: input.saved_result_id, pageSize, warnings: [] }
  }
  const warnings = []
  if (!Array.isArray(input.questions) || input.questions.length !== 1 || !isNonBlank(input.questions[0], 400)) {
    reject('invalid_input', 'questions must contain exactly one nonblank question (max 400 characters)')
  }
  if (!isNonBlank(input.intent, 2000)) {
    reject('invalid_input', 'intent is required: a nonblank research direction (max 2000 characters); the question no longer fills it in automatically')
  }
  if (input.preferences !== undefined && (!Array.isArray(input.preferences) || input.preferences.length > 8 || input.preferences.some((value) => !isNonBlank(value, 300)))) {
    reject('invalid_input', 'preferences must contain 0-8 nonblank clauses (max 300 characters each)')
  }
  if (input.community !== undefined && typeof input.community !== 'boolean') {
    reject('invalid_input', 'community must be a strict boolean (true/false) or omitted for automatic selection; strings such as auto, null, numbers and platform arrays are not accepted')
  }
  if (input.save_results !== undefined && typeof input.save_results !== 'boolean') {
    reject('invalid_input', 'save_results must be a strict boolean')
  }
  if (input.constraints !== undefined) {
    if (!Array.isArray(input.constraints) || input.constraints.length > 8 || input.constraints.some((value) => !isNonBlank(value, 300))) {
      reject('invalid_input', 'constraints must contain 0-8 nonblank clauses (max 300 characters each) or be omitted; an invalid shape is never repaired or reinterpreted')
    }
    if (input.constraints.length > 0) reject('adaptive_constraints_removed', CONSTRAINTS_MIGRATION_MESSAGE)
    warnings.push('deprecated_constraints_empty: constraints is a retired migration field; the empty array is accepted and ignored')
  }
  return {
    mode: 'new',
    question: input.questions[0].trim(),
    intent: input.intent.trim(),
    preferences: [...new Set(input.preferences?.map((preference) => preference.trim()) ?? [])],
    community: input.community,
    communityExplicit: input.community !== undefined,
    saveResults: input.save_results ?? false,
    maxResults: input.max_results ?? 10,
    pageSize,
    warnings,
  }
}
