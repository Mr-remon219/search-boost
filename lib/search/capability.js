/** Single live capability contract for routing, caches, MCP and native hosts. */
import { createHash } from 'node:crypto'
import { engineRegistry, ENGINE_ORDER } from './engines.js'
import { readKeysRouting } from '../keys.mjs'
import { getLayer } from '../layer-config.mjs'
import { xAuthAvailableSync } from './xsearch.js'
import { authStatus, xAuthCacheToken } from './xauth.js'
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
  }
  // Private cache partition only: never place credential material/fingerprints in capabilities.
  const fingerprint = createHash('sha256').update(JSON.stringify([routing.keys, capability, xAuthCacheToken()])).digest('hex')
  return { routing, engines, capability, fingerprint }
}
export const collectRuntimeCapabilities = () => runtimeSnapshot().capability
export function formatRuntimeCapabilities(info = collectRuntimeCapabilities()) {
  return [
    '<search_capabilities>',
    `Compatibility layer: ${info.layer}; default engine_pool: ${info.defaultEnginePool} (legacy free→free, api→hybrid).`,
    `Available engines: ${info.availableEngines.join(', ') || '(none)'}. Availability is configuration-based; network access may fail.`,
    ...Object.entries(info.pools).map(([pool, names]) => `${pool}: ${names.join(', ') || '(none available)'}`),
    `X official: ${info.x.official.available ? 'available' : 'unavailable'} (${info.x.official.source}); fallback: ${info.x.fallback.available ? 'available, best-effort web/GraphQL/oEmbed' : 'unavailable'}.`,
    'fused_search normally needs no manual engines. engine_pool selects sources; ranking changes final weights only; complexity controls budget/variants/depth. community=false by default; enable only for relevant recent developer/community voices. Missing/disabled engines are not silently replaced.',
    '</search_capabilities>',
  ].join('\n')
}
