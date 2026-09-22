// Host-neutral adaptive input contract. Targets are acceptance questions, not
// individual synonym tokens. Legacy questions remain independent targets.
import { ADAPTIVE_LIMITS } from './limits.js'
import { ADAPTIVE_PAGE_SCHEMA } from './pages.js'
import { strictDay } from './temporal.js'

export const ADAPTIVE_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    ...ADAPTIVE_PAGE_SCHEMA,
    questions: { type: 'array', minItems: 1, maxItems: 6, items: { type: 'string', minLength: 1, maxLength: 400 }, description: 'Legacy independent questions. Supply either questions or tasks, never both.' },
    tasks: {
      type: 'array', minItems: 1, maxItems: 6,
      description: 'Task context plus keyword-guided acceptance targets. At most 12 targets total.',
      items: {
        type: 'object', additionalProperties: false, required: ['context', 'targets'],
        properties: {
          context: { type: 'string', minLength: 1, maxLength: 400 },
          time_range: { type: 'object', additionalProperties: false, required: ['start', 'end', 'basis'], description: 'Optional inclusive calendar-date constraint. Never infer event time from publication time.', properties: { start: { type: 'string' }, end: { type: 'string' }, basis: { type: 'string', enum: ['published', 'event'] } } },
          targets: { type: 'array', minItems: 1, maxItems: 4, items: {
            type: 'object', additionalProperties: false, required: ['id', 'keywords', 'question'],
            properties: {
              id: { type: 'string', minLength: 1, maxLength: 64, pattern: '^[A-Za-z0-9_-]+$' },
              keywords: { type: 'array', minItems: 1, maxItems: 4, items: { type: 'string', minLength: 1, maxLength: 100 } },
              question: { type: 'string', minLength: 1, maxLength: 400 },
            },
          } },
        },
      },
    },
  },
  additionalProperties: false,
}

export function normalizeAdaptiveInput(input, limits = ADAPTIVE_LIMITS) {
  const fail = (error) => ({ error })
  if (!input || typeof input !== 'object' || Array.isArray(input)) return fail('Supply questions or tasks')
  if (Object.keys(input).some((key) => !['questions', 'tasks'].includes(key))) return fail('Unknown adaptive input field')
  if ((input.questions !== undefined) === (input.tasks !== undefined)) return fail('Supply exactly one of questions or tasks')
  const text = (value, max) => typeof value === 'string' && value.trim().length > 0 && value.trim().length <= max
  if (input.questions !== undefined) {
    if (!Array.isArray(input.questions) || input.questions.length < 1 || input.questions.length > limits.maxQuestions) return fail(`questions must contain 1..${limits.maxQuestions} items`)
    if (input.questions.some((q) => !text(q, limits.maxQuestionChars))) return fail('Every question must be a nonblank string of at most 400 characters')
    return { mode: 'questions', targets: input.questions.map((q) => ({ text: q.trim(), context: '', keywords: [], targetId: null, taskId: null })) }
  }
  if (!Array.isArray(input.tasks) || input.tasks.length < 1 || input.tasks.length > limits.maxQuestions) return fail('tasks must contain 1..6 items')
  const targets = []
  for (const [ti, task] of input.tasks.entries()) {
    if (!task || typeof task !== 'object' || Object.keys(task).some((k) => !['context', 'targets', 'time_range'].includes(k)) || !text(task.context, 400) || !Array.isArray(task.targets) || task.targets.length < 1 || task.targets.length > 4) return fail(`Invalid task ${ti + 1}`)
    const range = task.time_range
    if (range !== undefined && (!range || typeof range !== 'object' || Object.keys(range).some((k) => !['start', 'end', 'basis'].includes(k)) || !/^\d{4}-\d{2}-\d{2}$/.test(range.start) || !/^\d{4}-\d{2}-\d{2}$/.test(range.end) || !strictDay(range.start) || !strictDay(range.end) || range.start > range.end || !['published', 'event'].includes(range.basis))) return fail(`Invalid time_range in task ${ti + 1}`)
    const ids = new Set()
    for (const target of task.targets) {
      if (!target || typeof target !== 'object' || Object.keys(target).some((k) => !['id', 'keywords', 'question'].includes(k)) || !text(target.id, 64) || !/^[A-Za-z0-9_-]+$/.test(target.id) || ids.has(target.id) || !text(target.question, 400) || !Array.isArray(target.keywords) || target.keywords.length < 1 || target.keywords.length > 4 || target.keywords.some((k) => !text(k, 100))) return fail(`Invalid or duplicate target in task ${ti + 1}`)
      ids.add(target.id)
      targets.push({ text: `${task.context.trim()}\n${target.question.trim()}`, context: task.context.trim(), acceptance: target.question.trim(), keywords: [...new Set(target.keywords.map((k) => k.trim()))], taskId: `t${ti + 1}`, targetId: target.id, timeRange: range ? { ...range, timeZone: 'UTC' } : null })
    }
  }
  if (targets.length > (limits.maxTargets ?? 12)) return fail('At most 12 targets are allowed across all tasks')
  return { mode: 'tasks', targets }
}

export function canonicalTargets(targets) {
  const byKey = new Map()
  const out = []
  targets.forEach((target, index) => {
    // Different retrieval hints do not silently share an execution.
    const key = JSON.stringify([target.text, target.keywords, target.timeRange])
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
