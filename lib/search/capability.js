/** Single live capability contract for routing, caches, MCP and native hosts. */
import { createHash } from 'node:crypto'
import { engineRegistry, ENGINE_ORDER } from './engines.js'
import { readKeysRouting } from '../keys.mjs'
import { getLayer } from '../layer-config.mjs'
import { describeJevForCapability } from '../jev-config.mjs'
import { xAuthAvailableSync } from './x/xsearch.js'
import { authStatus, xAuthCacheToken } from './x/xauth.js'
import { ENGINE_POOLS, legacyPool } from './routing.js'

export function runtimeSnapshot() {
  const routing = readKeysRouting()
  const enabled = routing.summary.hasExplicitRouting || routing.summary.enabled.length < routing.summary.configured.length ? routing.enabledSet : null
  const engines = engineRegistry(routing.keys, enabled)
  const availableEngines = ENGINE_ORDER.filter((name) => engines[name]?.available())
  const layer = getLayer(), official = xAuthAvailableSync()
  const capability = {
    schemaVersion: 1,
    availability: 'Configuration readiness, not a live connectivity or coverage guarantee',
    layer,
    defaultEnginePool: legacyPool(layer),
    defaultRanking: 'balanced',
    defaultComplexity: 'medium',
    availableEngines,
    pools: Object.fromEntries(Object.entries(ENGINE_POOLS).map(([pool, names]) => [pool, names.filter((name) => availableEngines.includes(name))])),
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
    adaptive: describeJevForCapability(),
  }
  // Private cache partition only: never place credential material/fingerprints in capabilities.
  // `adaptive` is Jev configuration, not search routing: it must not change the partition.
  const { adaptive: _adaptive, ...fingerprintCapability } = capability
  const fingerprint = createHash('sha256').update(JSON.stringify([routing.keys, fingerprintCapability, xAuthCacheToken()])).digest('hex')
  return { routing, engines, capability, fingerprint }
}
export const collectRuntimeCapabilities = () => runtimeSnapshot().capability
export function formatRuntimeCapabilities(info = collectRuntimeCapabilities()) {
  const adaptive = info.adaptive ?? {}
  return [
    '<search_capabilities>',
    `Compatibility layer: ${info.layer}; default engine_pool: ${info.defaultEnginePool} (legacy free→free, api→hybrid).`,
    `Available engines: ${info.availableEngines.join(', ') || '(none)'}. Availability is configuration-based; network access may fail.`,
    ...Object.entries(info.pools).map(([pool, names]) => `${pool}: ${names.join(', ') || '(none available)'}`),
    `X official: ${info.x.official.available ? 'available' : 'unavailable'} (${info.x.official.source}); fallback: ${info.x.fallback.available ? 'available, best-effort web/GraphQL/oEmbed' : 'unavailable'}.`,
    'fused_search normally needs no manual engines. engine_pool selects sources; ranking changes final weights only; complexity controls budget/variants/depth. community=false by default; enable only for relevant recent developer/community voices. Missing/disabled engines are not silently replaced.',
    // Only advertised once the user has configured Jev: no probing, no claim.
    ...(adaptive.configured
      ? [`adaptive_search is available (Jev source: ${adaptive.source}${adaptive.gateway === 'custom' ? ', custom gateway' : ''}). For several independent questions with per-question coverage evidence, it selects engines, judges the material and reports which questions are actually supported; question text and the necessary evidence fragments go to ${adaptive.destination}. Use fused_search / fetch_page / x_search when you want to control the query and engines yourself.`]
      : []),
    '</search_capabilities>',
  ].join('\n')
}
