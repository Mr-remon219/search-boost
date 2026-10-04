import { JevError } from './transport.mjs'

export const DECISION_CONTRACT_VERSION = 1
export const DECISION_PHASES = Object.freeze(['strategy', 'screening'])

export class DecisionError extends JevError {
  constructor(kind, opts = {}) {
    super(kind, opts)
    this.name = 'DecisionError'
    this.message = `judgment ${kind}${opts.status ? ` (http ${opts.status})` : ''}${/^[a-z_]{1,64}$/.test(opts.detail ?? '') ? `: ${opts.detail}` : ''}`
  }
}

export const isRecord = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
export function frozenCopy(value) {
  const copy = structuredClone(value)
  const freeze = object => {
    if (object && typeof object === 'object') {
      for (const child of Object.values(object)) freeze(child)
      Object.freeze(object)
    }
    return object
  }
  return freeze(copy)
}

/** API-prefix URL; never accepts embedded credentials or query/fragment routing. */
export function normalizeDecisionBaseUrl(value) {
  let url
  try { url = new URL(String(value ?? '').trim()) } catch { throw new DecisionError('invalid_config', { detail: 'invalid_base_url' }) }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new DecisionError('invalid_config', { detail: 'invalid_base_url' })
  }
  return url.href.replace(/\/+$/, '')
}

export function validateDecisionRequest(request, capabilities) {
  if (!isRecord(request) || !DECISION_PHASES.includes(request.phase) ||
      !isRecord(request.questions) || !Object.keys(request.questions).length ||
      (request.contractVersion !== undefined && request.contractVersion !== DECISION_CONTRACT_VERSION)) {
    throw new DecisionError('invalid_request', { detail: 'invalid_decision_request' })
  }
  for (const question of Object.values(request.questions)) {
    if (!isRecord(question) || !capabilities.questionTypes.includes(question.type) ||
        typeof question.instructions !== 'string' || !question.instructions.trim() ||
        !isRecord(question.criteria) || !Object.keys(question.criteria).length) {
      throw new DecisionError('invalid_request', { detail: 'invalid_question' })
    }
  }
}
