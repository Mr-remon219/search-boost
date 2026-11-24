import { createDecisionTransport, validateJevAnswers } from '../transport.mjs'
import { DecisionError, frozenCopy, isRecord, normalizeDecisionBaseUrl } from '../contract.mjs'

export const LAYA_MODELS = Object.freeze(['english', 'multilingual', 'typed-decisions'])
const nonnegative = value => Number.isSafeInteger(value) && value >= 0
const unit = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1

export function validateLayaProfile(config) {
  if (!isRecord(config) || config.provider !== 'laya' || !LAYA_MODELS.includes(config.model)) {
    throw new DecisionError('invalid_config', { detail: 'unknown_model' })
  }
  const baseUrl = normalizeDecisionBaseUrl(config.baseUrl)
  if (config.transport !== undefined && config.transport !== 'systemone') throw new DecisionError('invalid_config', { detail: 'transport_mismatch' })
  const apiKey = typeof config.apiKey === 'string' ? config.apiKey.trim() : ''
  const authMode = config.authMode
  if (!['none', 'bearer'].includes(authMode) || (authMode === 'none' && apiKey) || (authMode === 'bearer' && !apiKey)) {
    throw new DecisionError('invalid_config', { detail: 'auth_mode' })
  }
  const options = config.options ?? {}
  if (!isRecord(options) || Object.keys(options).some(key => !['max_len', 'head_max_len'].includes(key))) {
    throw new DecisionError('invalid_config', { detail: 'unsupported_options' })
  }
  for (const value of Object.values(options)) {
    if (value !== null && (!Number.isSafeInteger(value) || value < 1)) throw new DecisionError('invalid_config', { detail: 'token_budget' })
  }
  return { provider: 'laya', transport: 'systemone', baseUrl, model: config.model, authMode, apiKey: apiKey || null, options: { ...options } }
}

/** Self-hosted protocol adapter. Incomplete inputs never become valid decisions. */
export class LayaAdapter {
  #config
  #client
  #verifyHead
  constructor(config, transport = {}) {
    this.#config = frozenCopy(validateLayaProfile(config))
    // Trusted code injection for offline, pinned tokenizer fixtures. Never an
    // executable config field, HTTP preflight, character heuristic or model probe.
    this.#verifyHead = transport.verifyHead ?? (() => false)
    this.#client = createDecisionTransport({ ...transport, ...this.#config }, {
      authentication: 'optional-bearer', transport: 'systemone', ErrorType: DecisionError, normalizeBaseUrl: normalizeDecisionBaseUrl,
      buildRequest: request => this.buildRequest(request),
      normalizeResponse: (raw, request) => this.normalizeResponse(raw, request),
    })
  }
  validateConfig() { validateLayaProfile(this.#config); return true }
  describe() {
    return { provider: 'laya', requestedModel: this.#config.model, transport: 'systemone', configured: true }
  }
  usage() { return this.#client.usage() }
  buildRequest(request) {
    return { state: request.state, questions: request.questions, model: this.#config.model,
      ...Object.fromEntries(Object.entries(this.#config.options).filter(([, value]) => value !== null)) }
  }
  evaluate(request) { return this.#client.ask(request) }
  normalizeResponse(raw, request) {
    const questions = request.questions
    // Entropy and max(p) are diagnostics, not Jev-compatible scoring signals.
    const clean = isRecord(raw.answers) ? Object.fromEntries(Object.entries(raw.answers).map(([id, answer]) => [
      id, isRecord(answer) ? { type: answer.type, choice: answer.choice, noul: answer.noul } : answer,
    ])) : raw.answers
    const result = validateJevAnswers(clean, questions)
    const unavailable = {}
    const diagnostics = { routing: null, truncation: null, options: {}, answers: {} }
    const routing = raw.routing
    const usage = raw.usage
    let commonReason = null
    const resolvedModel = isRecord(routing) && LAYA_MODELS.includes(routing.model) ? routing.model : null
    if (!resolvedModel || typeof routing.repo !== 'string' || !/^[A-Za-z0-9_.:/@-]{1,200}$/.test(routing.repo) ||
        (this.#config.apiKey && routing.repo.includes(this.#config.apiKey))) commonReason = 'routing_unavailable'
    else {
      diagnostics.routing = { model: resolvedModel, repo: routing.repo }
      if (resolvedModel !== this.#config.model) commonReason = 'model_mismatch'
    }
    const ids = Object.keys(questions)
    const truncatedIds = usage?.truncated_questions
    if (!isRecord(usage) || typeof usage.truncated !== 'boolean' || !nonnegative(usage.state_tokens_dropped) ||
        !nonnegative(usage.state_tokens) || !Array.isArray(truncatedIds) ||
        truncatedIds.some(id => typeof id !== 'string' || !Object.hasOwn(questions, id)) ||
        new Set(truncatedIds).size !== truncatedIds.length ||
        usage.truncated !== (usage.state_tokens_dropped > 0) ||
        usage.truncated !== (truncatedIds.length > 0) ||
        usage.state_tokens_dropped > usage.state_tokens) {
      commonReason ??= 'diagnostics_unavailable'
    } else diagnostics.truncation = {
      truncated: usage.truncated, stateTokens: usage.state_tokens,
      stateTokensDropped: usage.state_tokens_dropped, questionIds: [...truncatedIds],
    }
    if (usage?.options !== undefined && !isRecord(usage.options)) commonReason ??= 'diagnostics_unavailable'
    for (const id of ids) {
      let reason = commonReason
      if (!reason && truncatedIds.includes(id)) reason = 'state_truncated'
      const options = usage?.options?.[id]
      if (options !== undefined) {
        const expectedTotal = questions[id].type === 'noul' ? 2 : Object.keys(questions[id].criteria).length
        if (!isRecord(options) || !nonnegative(options.total) || !nonnegative(options.distinct) ||
            options.total !== expectedTotal || options.distinct > options.total) reason ??= 'diagnostics_unavailable'
        else {
          diagnostics.options[id] = { total: options.total, distinct: options.distinct }
          if (options.distinct < options.total) reason ??= 'options_collapsed'
        }
      }
      const answer = raw.answers?.[id]
      if (isRecord(answer)) {
        const status = answer.abstention
        const low = answer.low_confidence
        diagnostics.answers[id] = {
          confidence: unit(answer.confidence) ? answer.confidence : null,
          answerConfidence: unit(answer.answer_confidence) ? answer.answer_confidence : null,
          abstention: ['passed', 'abstained', 'unevaluated'].includes(status) ? status : null,
          lowConfidence: typeof low === 'boolean' ? low : null,
        }
        if (status !== undefined && !['passed', 'abstained', 'unevaluated'].includes(status)) reason ??= 'diagnostics_unavailable'
        if (low !== undefined && typeof low !== 'boolean') reason ??= 'diagnostics_unavailable'
        if (low === true || status === 'abstained') reason ??= 'abstained'
        if (status === 'unevaluated') reason ??= 'abstention_unevaluated'
      }
      if (!reason) {
        let verified = false
        try { verified = this.#verifyHead({ questionId: id, question: frozenCopy(questions[id]), profile: frozenCopy({ model: this.#config.model, options: this.#config.options }), routing: frozenCopy(diagnostics.routing) }) === true } catch { /* missing/failed fixture is not proof */ }
        if (!verified) reason = 'head_capacity_unverified'
      }
      if (reason) {
        unavailable[id] = reason
        result.entries.delete(id)
      }
    }
    return { ...result, resolvedModel, unavailable, providerDiagnostics: diagnostics }
  }
}

export const layaRegistration = {
  id: 'laya', label: 'Laya (self-hosted)', adapterVersion: 1, kind: 'typed-decision',
  models: [...LAYA_MODELS],
  configSchema: {
    baseUrl: { type: 'url', default: 'http://localhost:8000/v1' }, model: { type: 'select', required: true },
    authMode: { type: 'select', values: ['none', 'bearer'], required: true }, apiKey: { type: 'secret', required: false },
    options: { type: 'object', fields: ['max_len', 'head_max_len'] },
  },
  capabilities: { questionTypes: ['choice', 'noul'], authentication: 'optional-bearer' },
  validateConfig: validateLayaProfile,
  create: (config, transport) => new LayaAdapter(config, transport),
}
