// Frozen V2/V3 input for explicit internal offline comparisons only. Never a host schema.
// Targets define search directions, not answer-completeness acceptance gates.
import { ADAPTIVE_LIMITS } from './limits.js'
import { strictDay } from './temporal.js'
import { validFacts } from './facts.js'

const ROOT_FIELDS = ['questions', 'tasks', 'intent', 'keywords']

/**
 * Question-mode keyword lists. A flat list is unambiguous only for exactly one
 * question; otherwise one list per question must be aligned by position.
 */
function questionKeywords(value, count, limits) {
  const maxChars = limits.maxKeywordChars ?? 100
  const list = (entries) => Array.isArray(entries) && entries.length >= 1 && entries.length <= 4
    && entries.every((keyword) => typeof keyword === 'string' && keyword.trim().length > 0 && keyword.trim().length <= maxChars)
  if (value === undefined) return { lists: null }
  if (!Array.isArray(value) || value.length === 0) return { error: 'keywords must be a non-empty array of 1-4 strings, or one such list per question' }
  if (value.every((entry) => typeof entry === 'string')) {
    if (count !== 1) return { error: 'A flat keywords list is only valid when exactly one question is supplied; supply one list per question instead' }
    if (!list(value)) return { error: `keywords must contain 1-4 nonblank strings of at most ${maxChars} characters` }
    return { lists: [[...new Set(value.map((keyword) => keyword.trim()))]] }
  }
  if (value.every((entry) => Array.isArray(entry))) {
    if (value.length !== count) return { error: `keywords must contain exactly ${count} lists aligned with the questions` }
    if (!value.every(list)) return { error: `Every keywords list must contain 1-4 nonblank strings of at most ${maxChars} characters` }
    return { lists: value.map((entries) => [...new Set(entries.map((keyword) => keyword.trim()))]) }
  }
  return { error: 'keywords must be all strings (single question) or all arrays aligned with the questions' }
}

export function normalizeLegacyAdaptiveInput(input, limits = ADAPTIVE_LIMITS) {
  limits = { ...limits, maxQuestions: 6, maxTargets: 12 }
  const fail = (error) => ({ error })
  if (!input || typeof input !== 'object' || Array.isArray(input)) return fail('Supply questions or tasks')
  if (Object.keys(input).some((key) => !ROOT_FIELDS.includes(key))) return fail('Unknown adaptive input field')
  if ((input.questions !== undefined) === (input.tasks !== undefined)) return fail('Supply exactly one of questions or tasks')
  const text = (value, max) => typeof value === 'string' && value.trim().length > 0 && value.trim().length <= max
  const maxIntentChars = limits.maxIntentChars ?? 2000
  const maxTargetIntentChars = limits.maxTargetIntentChars ?? 1000
  if (input.intent !== undefined && !text(input.intent, maxIntentChars)) return fail(`intent must be a nonblank string of at most ${maxIntentChars} characters`)
  const rootIntent = input.intent === undefined ? null : input.intent.trim()
  const combineIntent = (targetIntent) => [rootIntent, targetIntent].filter(Boolean).join('\n') || null
  if (input.questions !== undefined) {
    if (!Array.isArray(input.questions) || input.questions.length < 1 || input.questions.length > limits.maxQuestions) return fail(`questions must contain 1..${limits.maxQuestions} items`)
    if (input.questions.some((q) => !text(q, limits.maxQuestionChars))) return fail('Every question must be a nonblank string of at most 400 characters')
    const parsed = questionKeywords(input.keywords, input.questions.length, limits)
    if (parsed.error) return fail(parsed.error)
    return { mode: 'questions', intent: rootIntent, targets: input.questions.map((q, index) => ({ text: q.trim(), context: '', keywords: parsed.lists?.[index] ?? [], intent: combineIntent(null), targetId: null, taskId: null })) }
  }
  if (input.keywords !== undefined) return fail('keywords are only valid with questions, never with tasks')
  if (!Array.isArray(input.tasks) || input.tasks.length < 1 || input.tasks.length > limits.maxQuestions) return fail('tasks must contain 1..6 items')
  const targets = []
  for (const [ti, task] of input.tasks.entries()) {
    if (!task || typeof task !== 'object' || Object.keys(task).some((k) => !['context', 'targets', 'time_range'].includes(k)) || !text(task.context, 400) || !Array.isArray(task.targets) || task.targets.length < 1 || task.targets.length > 4) return fail(`Invalid task ${ti + 1}`)
    const range = task.time_range
    if (range !== undefined && (!range || typeof range !== 'object' || Object.keys(range).some((k) => !['start', 'end', 'basis'].includes(k)) || !/^\d{4}-\d{2}-\d{2}$/.test(range.start) || !/^\d{4}-\d{2}-\d{2}$/.test(range.end) || !strictDay(range.start) || !strictDay(range.end) || range.start > range.end || !['published', 'event'].includes(range.basis))) return fail(`Invalid time_range in task ${ti + 1}`)
    const ids = new Set()
    for (const target of task.targets) {
      if (!target || typeof target !== 'object' || Object.keys(target).some((k) => !['id', 'keywords', 'question', 'intent', 'facts'].includes(k)) || !text(target.id, 64) || !/^[A-Za-z0-9_-]+$/.test(target.id) || ids.has(target.id) || !text(target.question, 400) || !Array.isArray(target.keywords) || target.keywords.length < 1 || target.keywords.length > 4 || target.keywords.some((k) => !text(k, limits.maxKeywordChars ?? 100))) return fail(`Invalid or duplicate target in task ${ti + 1}`)
      if (target.intent !== undefined && !text(target.intent, maxTargetIntentChars)) return fail(`Invalid intent in target ${target.id}`)
      if (target.facts !== undefined && !validFacts(target.facts)) return fail(`Invalid facts in target ${target.id}`)
      ids.add(target.id)
      targets.push({ text: `${task.context.trim()}\n${target.question.trim()}`, context: task.context.trim(), acceptance: target.question.trim(), ...(target.facts ? { facts: target.facts.map(f => ({ id: f.id, question: f.question.trim() })) } : {}), keywords: [...new Set(target.keywords.map((k) => k.trim()))], intent: combineIntent(target.intent?.trim() ?? null), taskId: `t${ti + 1}`, targetId: target.id, timeRange: range ? { ...range, timeZone: 'UTC' } : null })
    }
  }
  if (targets.length > (limits.maxTargets ?? 12)) return fail('At most 12 targets are allowed across all tasks')
  return { mode: 'tasks', intent: rootIntent, targets }
}

export function canonicalTargets(targets) {
  const byKey = new Map()
  const out = []
  targets.forEach((target, index) => {
    // Different retrieval hints (or intents) do not silently share an execution.
    const key = JSON.stringify([target.text, target.keywords, target.timeRange, target.facts, target.intent ?? null])
    let entry = byKey.get(key)
    if (!entry) {
      entry = { ...target, id: `q${out.length + 1}`, inputIndexes: [] }
      byKey.set(key, entry)
      out.push(entry)
    }
    entry.inputIndexes.push(index)
  })
  return out
}
