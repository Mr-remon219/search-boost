import { DecisionError, DECISION_CONTRACT_VERSION, frozenCopy, validateDecisionRequest } from './contract.mjs'

/** One frozen adapter/profile per run. Neither registry nor client changes rubrics. */
export class DecisionClient {
  #adapter
  #metadata
  constructor(adapter, metadata) {
    this.#adapter = adapter
    this.#metadata = frozenCopy(metadata)
    this.validateConfig()
  }
  describe() {
    return frozenCopy({ ...this.#metadata, ...this.#adapter.describe() })
  }
  validateConfig() { return this.#adapter.validateConfig() }
  usage() { return this.#adapter.usage() }
  async ask(request) {
    validateDecisionRequest(request, this.#metadata.capabilities)
    request.signal?.throwIfAborted()
    const result = await this.#adapter.evaluate({ ...request, contractVersion: DECISION_CONTRACT_VERSION })
    if (!(result?.entries instanceof Map) || !Array.isArray(result.missingIds) ||
        !Array.isArray(result.invalidIds) || !Array.isArray(result.unknownIds)) {
      throw new DecisionError('malformed_response', { detail: 'invalid_decision_result' })
    }
    // Defense at the adapter boundary: no unoffered or unavailable choice survives.
    for (const [id, answer] of result.entries) {
      const spec = request.questions[id]
      if (!spec || answer?.type !== spec.type ||
          (spec.type === 'choice' && !Object.hasOwn(spec.criteria, answer.choice)) ||
          (spec.type === 'noul' && !(Number.isFinite(answer.value) && answer.value >= 0 && answer.value <= 1)) ||
          result.unavailable?.[id]) {
        throw new DecisionError('malformed_response', { detail: 'invalid_normalized_answer' })
      }
    }
    const identity = {
      provider: this.#metadata.id,
      requestedModel: this.describe().requestedModel,
      resolvedModel: result.model ?? null,
      transport: this.describe().transport,
      adapterVersion: this.#metadata.adapterVersion,
    }
    return { ...result, identity, unavailable: result.unavailable ?? {}, providerDiagnostics: result.providerDiagnostics ?? {} }
  }
}
