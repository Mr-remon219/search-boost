import { ENGINE_ORDER, engineRegistry } from '../../search/engines.js'
import { readKeys } from '../../keys.mjs'
import { getLayer } from '../../layer-config.mjs'
import { authStatus } from '../../search/xauth.js'
import { xAuthAvailableSync } from '../../search/xsearch.js'

const FREE_ENGINES = ['bing', 'ddg', 'yahoo', 'exa-free']
const KEYED_ENGINES = ['tavily', 'brave', 'exa']

function agyOnPath() {
  const registry = engineRegistry(readKeys())
  return registry.antigravity?.available?.() ?? false
}

/** @param {import('../types.mjs').DoctorContext} _ctx */
export function checkFreeEnginePool(_ctx) {
  const registry = engineRegistry(readKeys())
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
  const layer = getLayer()
  const registry = engineRegistry(readKeys())
  const available = KEYED_ENGINES.filter((name) => registry[name]?.available?.())
  if (layer === 'free') {
    return {
      id: 'api_keyed_pool',
      category: 'engines',
      status: 'pass',
      message: 'free layer (keyed pool optional)',
      details: { layer, available },
    }
  }
  if (available.length === 0) {
    return {
      id: 'api_keyed_pool',
      category: 'engines',
      status: 'warn',
      message: 'api layer but no tavily/brave/exa keys available',
      fix_hint: 'search-boost config keys --set tavily=...',
      details: { layer, available },
    }
  }
  return {
    id: 'api_keyed_pool',
    category: 'engines',
    status: 'pass',
    message: available.join(', '),
    details: { layer, available },
  }
}

/** @param {import('../types.mjs').DoctorContext} _ctx */
export function checkAgyCliOptional(_ctx) {
  const layer = getLayer()
  if (layer === 'free' || agyOnPath()) {
    return {
      id: 'agy_cli_optional',
      category: 'engines',
      status: 'pass',
      message: layer === 'free' ? 'free layer (agy optional)' : 'agy CLI on PATH',
      details: { layer, agy: agyOnPath() },
    }
  }
  return {
    id: 'agy_cli_optional',
    category: 'engines',
    status: 'warn',
    message: 'api layer but agy CLI not on PATH',
    fix_hint: 'Install agy or ignore if not using Antigravity tier',
    details: { layer, agy: false },
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
  const registry = engineRegistry(readKeys())
  return Object.fromEntries(
    ENGINE_ORDER.map((name) => [name, registry[name]?.available?.() ?? false]),
  )
}
