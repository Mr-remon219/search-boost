import { ENGINE_ORDER, engineRegistry } from '../../search/engines.js'
import { ENGINE_POOLS } from '../../search/routing.js'
import { readKeysRouting } from '../../keys.mjs'
import { authStatus } from '../../search/x/xauth.js'
import { xAuthAvailableSync } from '../../search/x/xsearch.js'

const FREE_ENGINES = ENGINE_POOLS.free
const KEYED_ENGINES = ENGINE_POOLS.api

function keyedRegistry() {
  const routing = readKeysRouting()
  const enabledSet = routing.summary.hasExplicitRouting || routing.summary.enabled < routing.summary.configured
    ? routing.enabledSet
    : null
  return { routing, registry: engineRegistry(routing.keys, enabledSet, routing.baseUrls) }
}

/** @param {import('../types.mjs').DoctorContext} _ctx */
export function checkFreeEnginePool(_ctx) {
  const { registry } = keyedRegistry()
  const available = FREE_ENGINES.filter((name) => registry[name]?.available?.())
  if (available.length === 0) {
    return {
      id: 'free_engine_pool',
      category: 'engines',
      status: 'fail',
      message: 'No free-tier engines available',
      fix_hint: 'Report a bug — free engines should always be available',
      details: { engines: FREE_ENGINES },
    }
  }
  return {
    id: 'free_engine_pool',
    category: 'engines',
    status: 'pass',
    message: available.join(', '),
    details: { available },
  }
}

/** @param {import('../types.mjs').DoctorContext} _ctx */
export function checkApiKeyedPool(_ctx) {
  const { routing, registry } = keyedRegistry()
  const available = KEYED_ENGINES.filter((name) => registry[name]?.availableForPool?.('api') ?? registry[name]?.available?.())
  return {
    id: 'api_keyed_pool', category: 'engines', status: 'pass',
    message: available.length ? `${available.join(', ')} — automatic API selection; one engine is enough` : 'Automatic keyless search (no enabled API key; APIs optional)',
    details: { layer: available.length ? 'api' : 'free', available, enabledNames: routing.summary.enabledNames },
  }
}

/** @param {import('../types.mjs').DoctorContext} _ctx */
export function checkXSearchMode(_ctx) {
  const official = xAuthAvailableSync()
  const xSource = authStatus()
  if (official) {
    return {
      id: 'x_search_mode',
      category: 'engines',
      status: 'pass',
      message: 'official X auth available',
      details: { mode: 'official', source: xSource.source },
    }
  }
  if (xSource.source === 'grok-pending') {
    return {
      id: 'x_search_mode',
      category: 'engines',
      status: 'warn',
      message: 'grok login found but not imported — hosted community X disabled',
      fix_hint: 'search-boost config x --import-grok',
      details: { mode: 'fallback', source: xSource.source },
    }
  }
  return {
    id: 'x_search_mode',
    category: 'engines',
    status: 'pass',
    message: `fallback mode (${xSource.source})`,
    details: { mode: 'fallback', source: xSource.source },
  }
}

/** Static engine availability for report enrichment. */
export function staticEngineMap() {
  const { registry } = keyedRegistry()
  return Object.fromEntries(
    ENGINE_ORDER.map((name) => [name, registry[name]?.available?.() ?? false]),
  )
}
