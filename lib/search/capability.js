import { toolStates } from '../tool-config.mjs'
/** Single live capability contract for routing, caches, MCP and native hosts. */
import { SCORE_VERSION, SCORE_CONFIG } from './scoring.js'
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
    adaptive: describeJevForCapability(),
    tools: toolStates(),
  }
  // Private cache partition only: never place credential material/fingerprints in capabilities.
  // `adaptive` is Jev configuration, not search routing: it must not change the partition.
  const { adaptive: _adaptive, tools: _tools, ...fingerprintCapability } = capability
  const fingerprint = createHash('sha256').update(JSON.stringify([routing.keys, routing.baseUrls, fingerprintCapability, xAuthCacheToken()])).digest('hex')
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
    'fused_search normally needs no manual engines. engine_pool selects sources; ranking changes final weights only; complexity controls budget/variants/depth. community=false by default; enable only for relevant recent developer/community voices. Missing/disabled engines are not silently replaced.',
    // Only advertised once the user has configured Jev: no probing, no claim.
    ...(adaptive.configured && (!info.tools || info.tools.find((row) => row.name === 'adaptive_search')?.enabled)
      ? [`adaptive_search is available (Jev source: ${adaptive.source}${adaptive.gateway === 'custom' ? ', custom gateway' : ''}). For one research question (questions has exactly one item) with a required intent, one pre-search strategy request chooses the fixed balanced/research/fresh ranking and, when community is omitted, whether to add the already-wired community (X) branch; an explicit community true/false overrides that choice and no community question is asked. The single fused call collects a bounded snapshot of at most 32 candidates (web and community rows share it), which is then screened with fixed safety and prototype value levels 0-5 plus real source provenance: only value 3/4/5 is delivered, ranked by the versioned screening formula. max_results caps the selected set; page_size only changes the page. Usage is metered and disclosed but never stops a run: there is no self-set cumulative cost, token, request-count or whole-run time budget. Returns reviewed URLs/extracts with s5: cursor pagination, and saved_result_id restores a private snapshot (v1 data read-only with an h1: cursor). targetMet means quantity only, never verified answer coverage or research completion. There is no per-material constraints gate and no language check: English is a caller instruction in the description, and the original text is searched as written. Question, intent and necessary fragments go to ${adaptive.destination}. Use fused_search / fetch_page / x_search when you want to control the query and engines yourself.`]
      : []),
    '</search_capabilities>',
  ].join('\n')
}
