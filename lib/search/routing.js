/** Pool selection and final-scoring weights are independent of search budget. */
export const ENGINE_POOLS = {
  free: ['bing', 'ddg', 'yahoo', 'exa-free'],
  api: ['tavily', 'brave', 'exa'],
}
ENGINE_POOLS.hybrid = [...ENGINE_POOLS.free, ...ENGINE_POOLS.api]
export const RANKINGS = ['balanced', 'research', 'fresh']
const weights = (names, values) => Object.fromEntries(names.map((name, i) => [name, values[i]]))
export const RANKING_WEIGHTS = {
  free: {
    balanced: weights(ENGINE_POOLS.free, [1, 1.05, 1, 1.10]),
    research: weights(ENGINE_POOLS.free, [0.95, 0.90, 0.85, 1.30]),
    fresh: weights(ENGINE_POOLS.free, [1.15, 0.95, 0.90, 1]),
  },
  api: {
    balanced: weights(ENGINE_POOLS.api, [1.20, 1.10, 1.20]),
    research: weights(ENGINE_POOLS.api, [1.35, 1, 1.45]),
    fresh: weights(ENGINE_POOLS.api, [1.30, 1.40, 1.25]),
  },
  hybrid: {
    balanced: weights(ENGINE_POOLS.hybrid, [1, 1.05, 1, 1.10, 1.20, 1.10, 1.20]),
    research: weights(ENGINE_POOLS.hybrid, [0.90, 0.85, 0.80, 1.20, 1.35, 1, 1.45]),
    fresh: weights(ENGINE_POOLS.hybrid, [1.05, 0.90, 0.85, 1, 1.30, 1.40, 1.25]),
  },
}
export const legacyPool = (layer) => layer === 'free' ? 'free' : 'hybrid'
export function resolveSearchRoute({ enginePool, layer = 'free', engineList, ranking = 'balanced', engineWeights = {}, engines }) {
  const pool = enginePool ?? legacyPool(layer)
  if (!Object.hasOwn(ENGINE_POOLS, pool)) throw new Error('engine_pool must be free, api or hybrid')
  if (!RANKINGS.includes(ranking)) throw new Error('ranking must be balanced, research or fresh')
  if (!engineWeights || typeof engineWeights !== 'object' || Array.isArray(engineWeights)) throw new Error('engine_weights must be an object')
  for (const [name, weight] of Object.entries(engineWeights)) {
    if (!ENGINE_POOLS.hybrid.includes(name) || typeof weight !== 'number' || !Number.isFinite(weight) || weight < 0) throw new Error(`Invalid engine_weights entry: ${name}`)
  }
  if (engineList != null && (!Array.isArray(engineList) || !engineList.length)) throw new Error('engines must be a non-empty array')
  const requested = [...new Set(engineList ?? ENGINE_POOLS[pool])]
  if (requested.some((name) => !ENGINE_POOLS.hybrid.includes(name))) throw new Error('Unknown search engine')
  const names = requested.filter((name) => engines[name]?.available())
  const warnings = requested.filter((name) => !names.includes(name)).map((name) => `${name} unavailable (missing credentials, disabled, or locally unavailable); not called`)
  if (!names.length) warnings.push(`No available engines in requested ${pool} pool; no implicit fallback`)
  // An explicit engines override can cross pool boundaries. Missing preset
  // entries use that engine's native free/api preset, not a routing change.
  const effectiveWeights = Object.fromEntries(names.map((name) => [name, engineWeights[name]
    ?? RANKING_WEIGHTS[pool][ranking][name]
    ?? RANKING_WEIGHTS[ENGINE_POOLS.api.includes(name) ? 'api' : 'free'][ranking][name]]))
  return { enginePool: pool, ranking, enginesRequested: requested, engineNames: names, effectiveWeights, warnings }
}

export const FUSED_DESCRIPTION = 'Main Web Search entry point for public evidence, APIs, versions and comparisons. Normally omit engines: engine_pool chooses which sources to search; ranking changes only final engine scoring weights; complexity controls budget, query variants and depth. Optional engine_weights override scoring, never engine selection. Enable community only when recent developer/community voices on X are relevant (default false); use x_search directly for X-only account/thread searches. Returns ranked evidence plus enginesUsed, effectiveWeights, communityUsed and warnings. Current availability is reported by runtime capabilities, not guaranteed by a preset. Use fetch_page when snippets are insufficient.'
export const FUSED_ROUTING_PROPERTIES = {
  engine_pool: { type: 'string', enum: ['free', 'api', 'hybrid'], description: 'Which pool to search. Omitted: compatibility layer free→free, api→hybrid.' },
  ranking: { type: 'string', enum: RANKINGS, default: 'balanced', description: 'Final engine-weight preset only; does not change calls, variants, depth or recency filters.' },
  engines: { type: 'array', minItems: 1, items: { type: 'string', enum: ENGINE_POOLS.hybrid }, description: 'Optional exact engine selection overriding the pool. Unavailable/disabled engines are skipped with warnings.' },
  engine_weights: { type: 'object', additionalProperties: false, properties: Object.fromEntries(ENGINE_POOLS.hybrid.map((name) => [name, { type: 'number', minimum: 0 }])), description: 'Override selected preset weights. Zero weight still calls the engine; weights never enable or select engines.' },
  complexity: { type: 'string', enum: ['simple', 'medium', 'complex'], default: 'medium', description: 'Budget only: 1/2/3 query variants; complex uses advanced depth. Default medium.' },
  community: { type: 'boolean', default: false, description: 'Additionally search X for recent developer/community voices. Reuses x_search; all results share the final max_results limit.' },
}
