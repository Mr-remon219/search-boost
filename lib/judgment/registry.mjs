import { DecisionClient } from './client.mjs'
import { DecisionError, frozenCopy, isRecord, normalizeDecisionBaseUrl } from './contract.mjs'
import { jevRegistration } from './adapters/jev.mjs'
import { layaRegistration } from './adapters/laya.mjs'

export class DecisionRegistry {
  #adapters = new Map()
  register(adapter) {
    if (!isRecord(adapter) || !/^[a-z][a-z0-9-]{0,31}$/.test(adapter.id) ||
        adapter.kind !== 'typed-decision' || !Number.isSafeInteger(adapter.adapterVersion) ||
        adapter.adapterVersion < 1 || typeof adapter.label !== 'string' ||
        !Array.isArray(adapter.models) || !adapter.models.length ||
        !isRecord(adapter.configSchema) || !isRecord(adapter.capabilities) ||
        !Array.isArray(adapter.capabilities.questionTypes) ||
        typeof adapter.create !== 'function' || typeof adapter.validateConfig !== 'function') {
      throw new DecisionError('invalid_registration')
    }
    if (this.#adapters.has(adapter.id)) throw new DecisionError('duplicate_provider')
    const { create, validateConfig, configurationFor, ...metadata } = adapter
    this.#adapters.set(adapter.id, { metadata: frozenCopy(metadata), create, validateConfig, configurationFor })
    return this
  }
  get(id) {
    const adapter = this.#adapters.get(id)
    if (!adapter) throw new DecisionError('unknown_provider')
    return adapter.metadata
  }
  list() { return [...this.#adapters.values()].map(adapter => adapter.metadata) }
  configurationFor(provider, baseUrl) {
    const metadata = this.get(provider)
    const url = normalizeDecisionBaseUrl(baseUrl)
    const specific = this.#adapters.get(provider).configurationFor
    return frozenCopy(specific ? specific(url) : { models: metadata.models, transport: 'systemone', endpoint: `${url}/systemone` })
  }
  validateConfig(config) {
    this.get(config?.provider)
    if (Object.keys(config).some(key => !['provider', 'baseUrl', 'model', 'transport', 'authMode', 'apiKey', 'options'].includes(key))) {
      throw new DecisionError('invalid_config', { detail: 'unknown_profile_field' })
    }
    return this.#adapters.get(config.provider).validateConfig(config)
  }
  createClient(config, transport = {}) {
    const normalized = this.validateConfig(config)
    const adapter = this.#adapters.get(config.provider)
    return new DecisionClient(adapter.create(frozenCopy(normalized), transport), adapter.metadata)
  }
}

// Explicit registrations only: config cannot import arbitrary code or packages.
export const decisionRegistry = new DecisionRegistry().register(jevRegistration).register(layaRegistration)
export const createDecisionClient = (config, transport = {}) => decisionRegistry.createClient(config, transport)
