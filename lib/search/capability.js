import { toolStates } from '../tool-config.mjs'
import { communityCapabilities, communityCacheIdentity } from '../community/config.mjs'
/** Single live capability contract for routing, caches, MCP and native hosts. */
import { SCORE_VERSION, SCORE_CONFIG } from './scoring.js'
import { createHash } from 'node:crypto'
import { engineRegistry, ENGINE_ORDER } from './engines.js'
import { readKeysRouting } from '../keys.mjs'
import { getLayer } from '../layer-config.mjs'
import { describeJudgmentForCapability } from '../judgment/config.mjs'
import { xAuthAvailableSync } from './x/xsearch.js'
import { authStatus, xAuthCacheToken } from './x/xauth.js'
import { ENGINE_POOLS, legacyPool } from './routing.js'

export function runtimeSnapshot() {
  const routing = readKeysRouting()
  const enabled = routing.summary.hasExplicitRouting || routing.summary.enabled < routing.summary.configured ? routing.enabledSet : null
  const engines = engineRegistry(routing.keys, enabled, routing.baseUrls)
  const availableEngines = ENGINE_ORDER.filter((name) => engines[name]?.available())
  const layer = getLayer(), official = xAuthAvailableSync()
  const capability = {
    schemaVersion: 2,
    scoreVersion: SCORE_VERSION, scoring: SCORE_CONFIG,
    availability: 'Configuration readiness, not a live connectivity or coverage guarantee',
    layer,
    defaultEnginePool: legacyPool(layer),
    defaultRanking: 'balanced',
    defaultComplexity: 'medium',
    availableEngines,
    pools: Object.fromEntries(Object.entries(ENGINE_POOLS).map(([pool, names]) => [pool, names.filter((name) => engines[name]?.availableForPool?.(pool) ?? engines[name]?.available())])),
    engines: Object.fromEntries(ENGINE_ORDER.map((name) => [name, {
      available: availableEngines.includes(name),
      ...(availableEngines.includes(name) ? {} : { reason: ENGINE_POOLS.api.includes(name) ? 'Missing key or disabled by engine routing' : 'Locally unavailable' }),
    }])),
    x: {
      official: { available: official, source: authStatus().source },
      fallback: { available: true, webEngines: availableEngines, graphql: 'best-effort user lookup', oembed: 'best-effort public posts; not full thread coverage' },
    },
    // Jev readiness for the optional adaptive_search tool. Credential-free, and
    // excluded from the cache fingerprint below so changing Jev settings never
    // repartitions the core search/page caches.
    adaptive: describeJudgmentForCapability(),
    tools: toolStates(),
  }
  capability.community = communityCapabilities({ x: capability.x, availableEngines })
  // Private cache partition only: never place credential material/fingerprints in capabilities.
  // `adaptive` is Jev configuration, not search routing: it must not change the partition.
  const { adaptive: _adaptive, tools: _tools, ...fingerprintCapability } = capability
  const fingerprint = createHash('sha256').update(JSON.stringify([routing.keys, routing.baseUrls, fingerprintCapability, xAuthCacheToken(), communityCacheIdentity()])).digest('hex')
  return { routing, engines, capability, fingerprint }
}
export const collectRuntimeCapabilities = () => runtimeSnapshot().capability
export function formatRuntimeCapabilities(info = collectRuntimeCapabilities()) {
  const adaptive = info.adaptive ?? {}
  return [
    '<search_capabilities>',
    ...(info.tools ? [`Tool switches (host support varies): ${info.tools.map((row) => `${row.name}=${row.enabled ? 'on' : 'off'}`).join(', ')}. Disabled tool entries must not be called; these are not engine switches.`] : []),
    `Compatibility layer: ${info.layer}; default engine_pool: ${info.defaultEnginePool} (legacy free→free, api→hybrid).`,
    `Available engines: ${info.availableEngines.join(', ') || '(none)'}. Availability is configuration-based; network access may fail.`,
    ...Object.entries(info.pools).map(([pool, names]) => `${pool}: ${names.join(', ') || '(none available)'}`),
    `X official: ${info.x.official.available ? 'available' : 'unavailable'} (${info.x.official.source}); fallback: ${info.x.fallback.available ? 'available, best-effort web/GraphQL/oEmbed' : 'unavailable'}.`,
    ...(info.community ? [`Community platforms: ${info.community.platforms.map(row => `${row.platform}=${!row.supported ? 'not-implemented' : row.ready ? 'configuration-ready' : 'unavailable'}`).join(', ')}. community_search uses configured archive/native/browser/web-index adapters; inspect backend diagnostics. fused/adaptive community arrays select platforms; legacy true means X only. community_backend changes configuration only when requested; check reports readiness, not connectivity.`] : []),
    'These are configuration states, not connectivity checks or permission grants. Use registered tool descriptions/schemas for calls; unavailable or disabled engines are not silently replaced.',
    // Only advertised once the user has configured Jev: no probing, no claim.
    ...(adaptive.configured && (!info.tools || info.tools.find((row) => row.name === 'adaptive_search')?.enabled)
      ? [`adaptive_search is available (${adaptive.provider ?? 'judgment'} source: ${adaptive.source}${adaptive.gateway === 'custom' ? ', custom gateway' : ''}). Questions, intent and necessary evidence fragments are sent to ${adaptive.destination}; do not send secrets. See the registered tool contract for screening and saved-result modes.`]
      : [adaptive.configured
        ? 'adaptive_search is disabled by tool settings; do not call or enable it automatically. Use other enabled tools.'
        : 'adaptive_search is unavailable: a judgment model is not configured. Use enabled fused_search normally; judgment setup is not a prerequisite for research.']),
    '</search_capabilities>',
  ].join('\n')
}
