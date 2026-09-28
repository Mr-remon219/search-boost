// Public adaptive contract: one research question, its intent, search points and
// explicit document restrictions. No target cross-product or hidden task lists.
import { ADAPTIVE_LIMITS } from './limits.js'
import { ADAPTIVE_PAGE_SCHEMA } from './pages.js'

export const CONSTRAINTS_DESCRIPTION = 'Explicit, checkable hard conditions that EVERY admitted material must meet, such as applicable version (e.g. Node.js 22), event/publication date range, platform, region, or ONLY official sources. Write complete conditions, not isolated words. Do not put research direction, keywords, soft preferences or desired conclusions here; use intent/keywords/the question instead. Place every mandatory document condition here; the question is interpretation context, not a hidden restriction list. Omit or use [] when there are no explicit restrictions. Preserve alternatives within one condition; separate conditions are ANDed.'
export const ADAPTIVE_INPUT_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    ...ADAPTIVE_PAGE_SCHEMA,
    questions: { type: 'array', minItems: 1, maxItems: 1, items: { type: 'string', minLength: 1, maxLength: 400 }, description: 'Exactly ONE coherent research question. A comparison may contain multiple related aspects. Use either questions or cursor; independent questions require separate calls.' },
    intent: { type: 'string', minLength: 1, maxLength: 2000, description: 'Research purpose and direction: what material the agent wants to read and why. Direction prioritises focused materials without excluding useful supporting context; relevant counterevidence still qualifies. Soft preferences are not hard restrictions. Not appended to search queries. No secrets/private reasoning. Omit to use the question as the purpose.' },
    keywords: { type: 'array', minItems: 1, maxItems: 8, items: { type: 'string', minLength: 1, maxLength: 100 }, description: 'Search points, each judged semantically together with the full question. Matches attribute contributions to these points; useful supporting material can be retained without matching a listed point. Omit to use the question as one point.' },
    constraints: { type: 'array', maxItems: 8, items: { type: 'string', minLength: 1, maxLength: 300 }, description: CONSTRAINTS_DESCRIPTION },
  },
}

export function normalizeAdaptiveInput(input, limits = ADAPTIVE_LIMITS) {
  const fail = error => ({ error })
  if (!input || typeof input !== 'object' || Array.isArray(input)) return fail('Supply exactly one question in questions')
  if (Object.keys(input).some(key => !['questions', 'intent', 'keywords', 'constraints'].includes(key))) return fail('Unknown adaptive input field; tasks/targets are no longer supported')
  if (!Array.isArray(input.questions) || input.questions.length !== 1) return fail('questions must contain exactly one coherent research question')
  const text = (value, max) => typeof value === 'string' && value.trim().length > 0 && value.trim().length <= max
  if (!text(input.questions[0], limits.maxQuestionChars ?? 400)) return fail('The question must be nonblank and at most 400 characters')
  if (input.intent !== undefined && !text(input.intent, limits.maxIntentChars ?? 2000)) return fail('intent must be nonblank and at most 2000 characters')
  if (input.keywords !== undefined && (!Array.isArray(input.keywords) || input.keywords.length < 1 || input.keywords.length > 8 || input.keywords.some(k => !text(k, 100)))) return fail('keywords must be a flat array of 1–8 nonblank search points, at most 100 characters each')
  if (input.constraints !== undefined && (!Array.isArray(input.constraints) || input.constraints.length > 8 || input.constraints.some(c => !text(c, 300)))) return fail('constraints must contain 0–8 explicit nonblank conditions, at most 300 characters each')
  const intent = input.intent?.trim() ?? null
  return { mode: 'single', intent, targets: [{ text: input.questions[0].trim(), context: '', intent,
    keywords: [...new Set(input.keywords?.map(k => k.trim()) ?? [])],
    constraints: [...new Set(input.constraints?.map(c => c.trim()) ?? [])], taskId: null, targetId: null }] }
}

export function canonicalTargets(targets) {
  const byKey = new Map(), out = []
  targets.forEach((target, index) => {
    const key = JSON.stringify([target.text, target.keywords, target.timeRange, target.facts, target.intent ?? null, target.constraints ?? []])
    let entry = byKey.get(key)
    if (!entry) { entry = { ...target, id: `q${out.length + 1}`, inputIndexes: [] }; byKey.set(key, entry); out.push(entry) }
    entry.inputIndexes.push(index)
  })
  return out
}
