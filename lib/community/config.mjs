import { join } from 'node:path'
import { searchBoostHome } from '../config-paths.mjs'
import { readJsonStore, withFileLock, writeFileAtomicPrivate } from '../private-file.mjs'
import { CommunityRegistry, COMMUNITY_PLATFORMS, validateInstance } from './registry.mjs'
import { existingXProvider } from './providers/x.mjs'
import { redditArcticProvider } from './providers/reddit.mjs'
import { webIndexProvider } from './providers/web.mjs'
import { browserProvider } from './providers/browser.mjs'
import { bilibiliPublicProvider } from './providers/bilibili.mjs'
import { createHash } from 'node:crypto'

export const communityRegistry = new CommunityRegistry().register(existingXProvider).register(redditArcticProvider).register(bilibiliPublicProvider)
for (const platform of ['reddit', 'bilibili', 'zhihu', 'xiaohongshu']) communityRegistry.register(webIndexProvider(platform))
for (const platform of ['bilibili', 'zhihu', 'xiaohongshu']) communityRegistry.register(browserProvider(platform))
export const communityConfigPath = () => join(searchBoostHome(), 'config', 'community.json')
const defaults = () => [{ id: 'x-default', provider: 'existing-x', enabled: true, config: {} },
  { id: 'reddit-default', provider: 'reddit-arctic', enabled: true, config: {} },
  ...['bilibili', 'zhihu', 'xiaohongshu'].map(platform => ({ id: `${platform}-default`, provider: `${platform}-web`, enabled: true, config: {} }))]

export function readCommunityConfig(registry = communityRegistry) {
  const { doc, error } = readJsonStore(communityConfigPath())
  if (error) throw error
  if (doc && (doc.schema_version !== 1 || !Array.isArray(doc.backends)
    || Object.keys(doc).some(key => !['schema_version', 'backends'].includes(key)))) throw new Error('Invalid community configuration')
  const backends = (doc?.backends ?? []).map(value => validateInstance(value, registry))
  if (new Set(backends.map(value => value.id)).size !== backends.length) throw new Error('Duplicate community backend id')
  if (defaults().some(expected => backends.some(value => value.id === expected.id && value.provider !== expected.provider))) throw new Error('Built-in backend providers cannot be replaced')
  // Existing v1 stores migrate in memory only. Built-in ids are reserved; explicit
  // enabled=false survives reload. No capability read creates a configuration file.
  const missing = defaults().filter(value => !backends.some(row => row.id === value.id))
  return { schema_version: 1, backends: [...backends, ...missing] }
}

export function communityCapabilities(context = {}, registry = communityRegistry) {
  try {
    const config = readCommunityConfig(registry)
    const backends = config.backends.map(instance => {
      const provider = registry.get(instance.provider)
      const availability = provider.describeAvailability(context, instance.config)
      return { id: instance.id, provider: provider.id, platform: provider.platform, enabled: instance.enabled,
        configured: true, ready: instance.enabled && availability.ready,
        reason: instance.enabled ? availability.reason : 'Disabled by user',
        operations: [...provider.operations], retrieval_mode: provider.retrievalMode }
    })
    return { schema_version: 1, availability: 'Configuration readiness, not live connectivity or coverage',
      providers: registry.list(), backends,
      platforms: COMMUNITY_PLATFORMS.map(platform => ({ platform,
        supported: registry.list().some(provider => provider.platform === platform),
        ready: backends.some(backend => backend.platform === platform && backend.ready),
        reason: registry.list().some(provider => provider.platform === platform) ? 'Inspect backend readiness' : 'Not implemented' })),
    }
  } catch {
    // A broken community store must not break unrelated web tools or expose its contents.
    return { schema_version: 1, availability: 'Unavailable: community configuration needs repair',
      providers: registry.list(), backends: [],
      platforms: COMMUNITY_PLATFORMS.map(platform => ({ platform, supported: registry.list().some(provider => provider.platform === platform), ready: false, reason: 'Configuration unreadable or invalid' })),
      error: 'Community configuration unreadable or invalid' }
  }
}

export function manageCommunityBackend(args, context = {}, registry = communityRegistry) {
  const { action } = args
  const allowed = action === 'list' ? ['action'] : action === 'check' || action === 'remove' ? ['action', 'id'] : ['action', 'id', 'provider', 'enabled', 'config']
  if (Object.keys(args).some(key => !allowed.includes(key))) throw new Error('Fields do not apply to this backend action')
  if (action !== 'list' && !args.id) throw new Error('Backend id required')
  if (action === 'list' || action === 'check') {
    // Explicit read validates rather than disguising corruption as an empty list.
    const config = readCommunityConfig(registry)
    if (action === 'check' && !config.backends.some(backend => backend.id === args.id)) throw new Error('Unknown backend instance')
    const status = communityCapabilities(context, registry)
    return { action, changed: false, providers: status.providers,
      backends: status.backends.filter(backend => action === 'list' || backend.id === args.id) }
  }
  if (!['register', 'update', 'remove'].includes(action)) throw new Error('Unknown backend action')
  return withFileLock(communityConfigPath(), () => {
    const doc = readCommunityConfig(registry)
    const index = doc.backends.findIndex(backend => backend.id === args.id)
    if (action === 'register') {
      if (index >= 0) throw new Error('Backend instance already exists')
      if (!args.provider) throw new Error('Provider required for register')
      doc.backends.unshift(validateInstance({ id: args.id, provider: args.provider, enabled: args.enabled ?? true, config: args.config ?? {} }, registry))
    } else {
      if (index < 0) throw new Error('Unknown backend instance')
      if (action === 'remove') {
        if (defaults().some(row => row.id === args.id)) throw new Error('Cannot remove a built-in instance; update enabled=false instead')
        doc.backends.splice(index, 1)
      } else {
        if (args.provider && args.provider !== doc.backends[index].provider) throw new Error('Update cannot change provider; register another instance')
        doc.backends[index] = validateInstance({ ...doc.backends[index],
          ...(args.enabled !== undefined ? { enabled: args.enabled } : {}),
          ...(args.config !== undefined ? { config: args.config } : {}) }, registry)
      }
    }
    writeFileAtomicPrivate(communityConfigPath(), `${JSON.stringify(doc, null, 2)}\n`)
    const status = communityCapabilities(context, registry)
    return { action, changed: true, providers: status.providers, backends: status.backends }
  })
}

/** Private cache partition; never expose configuration or credential hashes in resources. */
export function communityCacheIdentity() {
  try {
    const config = readCommunityConfig()
    return createHash('sha256').update(JSON.stringify(config.backends.map(b => [b.id, b.provider, b.enabled, b.config, b.config.token_env ? process.env[b.config.token_env] ?? '' : '']))).digest('hex')
  } catch { return 'invalid-community-store' }
}
