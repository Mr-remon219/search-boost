// Stable acceptance units, never discovered from how many URLs were retrieved.
// Explicit caller-supplied facts are preferred. Automatic splitting only follows
// unambiguous question/list separators; unsplit prose stays one compound unit.
export const MAX_FACTS = 8

export function factUnits(question) {
  if (question.factDefinitions) return question.factDefinitions
  if (question.facts?.length) return question.facts.map(f => ({ ...f, weight: 1 / question.facts.length }))
  const text = String(question.acceptance ?? question.text ?? '').trim()
  const parts = [...new Set(text.split(/[;；\n]+|(?<=[?？])\s+/u)
    .map(s => s.trim()).filter(Boolean))]
  // Do not drop requirements when an automatic split exceeds the bounded schema.
  const units = parts.length && parts.length <= MAX_FACTS ? parts : [text]
  return units.filter(Boolean).map((question, i) => ({ id: `f${i + 1}`, question, weight: 1 / units.length }))
}

/**
 * Retrieval-mode topics: ONLY caller-supplied facts, never an automatic split
 * of the question into generated acceptance facts. Topics are optional search
 * hints that can earn coverage credit; they are never required to be answered.
 */
export function topicUnits(question) {
  const facts = question?.facts?.filter((fact) => fact && typeof fact.id === 'string' && fact.id) ?? []
  if (!facts.length) return []
  return facts.map((fact) => ({ id: fact.id, question: fact.question, weight: 1 / facts.length }))
}

export const FACT_INPUT_SCHEMA = {
  type: 'array', minItems: 1, maxItems: MAX_FACTS,
  description: 'Legacy field: optional fixed search topics [{id, question}], not discovered claims or mandatory answer facts. Unique IDs per target. New-topic coverage affects the advisory index, not completion.',
  items: { type: 'object', additionalProperties: false, required: ['id', 'question'], properties: {
    id: { type: 'string', minLength: 1, maxLength: 64, pattern: '^[A-Za-z0-9_-]+$' },
    question: { type: 'string', minLength: 1, maxLength: 400 },
  } },
}

export function validFacts(facts) {
  return Array.isArray(facts) && facts.length > 0 && facts.length <= MAX_FACTS
    && facts.every(f => f && typeof f === 'object' && !Array.isArray(f)
      && Object.keys(f).every(k => ['id', 'question'].includes(k))
      && typeof f.id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(f.id)
      && typeof f.question === 'string' && f.question.trim().length > 0 && f.question.trim().length <= 400)
    && new Set(facts.map(f => f.id)).size === facts.length
}
