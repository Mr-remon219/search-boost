/** Pool selection and final-scoring weights are independent of search budget. */
export const ENGINE_POOLS = {
  free: ['bing', 'ddg', 'yahoo', 'exa-free', 'anysearch'],
  api: ['tavily', 'brave', 'exa', 'anysearch'],
}
ENGINE_POOLS.hybrid = [...new Set([...ENGINE_POOLS.free, ...ENGINE_POOLS.api])]
export const RANKINGS = ['balanced', 'research', 'fresh']
// Uncalibrated cold-start priors: sqrt(native prior / fixed eight-engine GM).
// One strategy table across all pools; never normalize by runtime availability.
export const SHARED_RANKING_WEIGHTS = {
  "balanced": {
    "bing": 0.9572312859948126,
    "ddg": 0.9808701859225035,
    "yahoo": 0.9572312859948126,
    "exa-free": 1.0039526424966523,
    "tavily": 1.0485943361780756,
    "brave": 1.0039526424966523,
    "exa": 1.0485943361780756,
    "anysearch": 1.0039526424966523
  },
  "research": {
    "bing": 0.9273071097009062,
    "ddg": 0.9025744629620456,
    "yahoo": 0.8771447125079198,
    "exa-free": 1.0847595020446763,
    "tavily": 1.1054234445617832,
    "brave": 0.9513970202877831,
    "exa": 1.1456337201776512,
    "anysearch": 1.042203218309638
  },
  "fresh": {
    "bing": 1.0197555682848762,
    "ddg": 0.9268489619911159,
    "yahoo": 0.9021285347266256,
    "exa-free": 0.9509269706554807,
    "tavily": 1.0842235630053483,
    "brave": 1.12515196525981,
    "exa": 1.0631686740118014,
    "anysearch": 0.9509269706554807
  }
}
export const RANKING_WEIGHTS = Object.fromEntries(Object.entries(ENGINE_POOLS).map(([pool, names]) => [pool,
  Object.fromEntries(RANKINGS.map((ranking) => [ranking, Object.fromEntries(names.map((name) => [name, SHARED_RANKING_WEIGHTS[ranking][name]]))])),
]))
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
  const names = requested.filter((name) => (engines[name]?.availableForPool?.(pool) ?? engines[name]?.available()))
  const warnings = requested.filter((name) => !names.includes(name)).map((name) => `${name} unavailable (missing credentials, disabled, or locally unavailable); not called`)
  if (!names.length) warnings.push(`No available engines in requested ${pool} pool; no implicit fallback`)
  // An explicit engines override can cross pool boundaries. Missing preset
  // entries use that engine's native free/api preset, not a routing change.
  const effectiveWeights = Object.fromEntries(names.map((name) => [name, engineWeights[name]
    ?? RANKING_WEIGHTS[pool][ranking][name]
    ?? RANKING_WEIGHTS[ENGINE_POOLS.api.includes(name) ? 'api' : 'free'][ranking][name]]))
  return { enginePool: pool, ranking, enginesRequested: requested, engineNames: names, effectiveWeights, warnings }
}

export const FUSED_DESCRIPTION = 'Main Web Search entry point for public evidence, APIs, versions and comparisons. Normally omit engines: engine_pool chooses which sources to search; ranking changes only final engine scoring weights; complexity controls budget, query variants and depth. Optional engine_weights override scoring, never engine selection. Enable community only when recent developer/community voices on X are relevant (default false); use x_search directly for X-only account/thread searches. Returns scoreVersion, ranked evidence, enginesUsed, effectiveWeights, communityUsed and warnings. Consensus-v2 scores are not probabilities; legacy min_score thresholds need recalibration. Current availability is reported by runtime capabilities, not guaranteed by a preset. Use fetch_page when snippets are insufficient.'
export const FUSED_ROUTING_PROPERTIES = {
  engine_pool: { type: 'string', enum: ['free', 'api', 'hybrid'], description: 'Which pool to search. Omitted: compatibility layer free→free, api→hybrid.' },
  ranking: { type: 'string', enum: RANKINGS, default: 'balanced', description: 'Final engine-weight preset only; does not change calls, variants, depth or recency filters.' },
  engines: { type: 'array', minItems: 1, items: { type: 'string', enum: ENGINE_POOLS.hybrid }, description: 'Optional exact engine selection overriding the pool. Unavailable/disabled engines are skipped with warnings.' },
  engine_weights: { type: 'object', additionalProperties: false, properties: Object.fromEntries(ENGINE_POOLS.hybrid.map((name) => [name, { type: 'number', minimum: 0 }])), description: 'Override selected preset weights. Zero weight still calls the engine; weights never enable or select engines.' },
  complexity: { type: 'string', enum: ['simple', 'medium', 'complex'], default: 'medium', description: 'Budget only: 1/2/3 query variants; complex uses advanced depth. Default medium.' },
  community: { type: 'boolean', default: false, description: 'Additionally search X for recent developer/community voices. Reuses x_search; all results share the final max_results limit.' },
}
