const ID = /^[a-z][a-z0-9-]{0,47}$/
export const COMMUNITY_PLATFORMS = Object.freeze(['reddit', 'x', 'bilibili', 'zhihu', 'xiaohongshu'])

/** Explicit implementation registration; configuration never imports code. */
export class CommunityRegistry {
  #providers = new Map()
  register(provider) {
    if (!provider || !ID.test(provider.id) || !COMMUNITY_PLATFORMS.includes(provider.platform)
      || typeof provider.label !== 'string' || !Number.isSafeInteger(provider.version) || provider.version < 1
      || !Array.isArray(provider.operations) || !provider.operations.length
      || provider.operations.some(operation => !['keyword', 'semantic', 'user', 'thread'].includes(operation))
      || new Set(provider.operations).size !== provider.operations.length
      || (provider.configFields !== undefined && (!Array.isArray(provider.configFields) || provider.configFields.some(field => typeof field !== 'string' || !/^[a-z][a-z_]*$/.test(field))))
      || !['native', 'archive', 'mixed', 'web-index'].includes(provider.retrievalMode)
      || typeof provider.validateConfig !== 'function' || typeof provider.describeAvailability !== 'function'
      || typeof provider.search !== 'function') throw new Error('Invalid community provider registration')
    if (this.#providers.has(provider.id)) throw new Error('Duplicate community provider')
    this.#providers.set(provider.id, Object.freeze({ ...provider, operations: Object.freeze([...provider.operations]), configFields: Object.freeze([...(provider.configFields ?? [])]) }))
    return this
  }
  get(id) {
    const provider = this.#providers.get(id)
    if (!provider) throw new Error('Unknown community provider')
    return provider
  }
  list() {
    return [...this.#providers.values()].map(({ id, platform, label, version, operations, retrievalMode, configFields = [] }) =>
      ({ id, platform, label, version, operations: [...operations], retrieval_mode: retrievalMode, config_fields: [...configFields] }))
  }
}

export function validateInstance(value, registry) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !['id', 'provider', 'enabled', 'config'].includes(key))
    || !ID.test(value.id) || typeof value.provider !== 'string' || typeof value.enabled !== 'boolean') {
    throw new Error('Invalid community backend instance')
  }
  const provider = registry.get(value.provider)
  const config = provider.validateConfig(value.config ?? {})
  return { id: value.id, provider: provider.id, enabled: value.enabled, config }
}
