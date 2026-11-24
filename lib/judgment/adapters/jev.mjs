import { createDecisionTransport } from '../transport.mjs'
import { normalizeJevBaseUrl, jevProvider, JEV_DEFAULT_MODEL, JEV_VERCEL_MODEL } from '../../jev-config.mjs'
import { DecisionError, isRecord } from '../contract.mjs'

export function validateJevProfile(config) {
  if (!isRecord(config) || config.provider !== 'jev') throw new DecisionError('invalid_config')
  const baseUrl = normalizeJevBaseUrl(config.baseUrl)
  const transport = jevProvider(baseUrl) === 'vercel' ? 'vercel-evaluation' : 'systemone'
  const model = transport === 'vercel-evaluation' ? JEV_VERCEL_MODEL : JEV_DEFAULT_MODEL
  if (config.transport !== undefined && config.transport !== transport) throw new DecisionError('invalid_config', { detail: 'transport_mismatch' })
  if (config.model !== undefined && config.model !== model) throw new DecisionError('invalid_config', { detail: 'unknown_model' })
  if (config.authMode !== undefined && config.authMode !== 'bearer') throw new DecisionError('invalid_config', { detail: 'auth_mode' })
  if (typeof config.apiKey !== 'string' || !config.apiKey.trim()) throw new DecisionError('not_configured')
  if (config.options && (!isRecord(config.options) || Object.keys(config.options).length)) throw new DecisionError('invalid_config', { detail: 'unsupported_options' })
  return { provider: 'jev', baseUrl, transport, model, authMode: 'bearer', apiKey: config.apiKey.trim() }
}

export class JevAdapter {
  #config
  #client
  constructor(config, transport = {}) {
    this.#config = validateJevProfile(config)
    this.#client = createDecisionTransport({ ...transport, ...this.#config })
  }
  validateConfig() { validateJevProfile(this.#config); return true }
  describe() { return { provider: 'jev', requestedModel: this.#config.model, transport: this.#config.transport, configured: true } }
  evaluate(request) { return this.#client.ask(request) }
  usage() { return this.#client.usage() }
}

export const jevRegistration = {
  id: 'jev', label: 'Jev', adapterVersion: 1, kind: 'typed-decision',
  models: [JEV_DEFAULT_MODEL, JEV_VERCEL_MODEL],
  configSchema: { baseUrl: { type: 'url', default: 'https://api.typesafe.ai/v1' }, model: { type: 'select' }, apiKey: { type: 'secret', required: true } },
  capabilities: { questionTypes: ['choice', 'noul'], authentication: 'required-bearer' },
  configurationFor: baseUrl => {
    const url = normalizeJevBaseUrl(baseUrl)
    return jevProvider(url) === 'vercel'
      ? { models: [JEV_VERCEL_MODEL], transport: 'vercel-evaluation', endpoint: 'https://ai-gateway.vercel.sh/v4/ai/evaluation-model' }
      : { models: [JEV_DEFAULT_MODEL], transport: 'systemone', endpoint: `${url}/systemone` }
  },
  validateConfig: validateJevProfile,
  create: (config, transport) => new JevAdapter(config, transport),
}
