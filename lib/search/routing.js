import { COMMUNITY_SELECTION_SCHEMA } from '../community/selection.mjs'
import { FUSED_PLATFORM_OPTIONS_SCHEMA } from '../community/parameters.mjs'
/** Pool selection and final-scoring weights are independent of search budget. */
export const ENGINE_POOLS = {
  free: ['bing', 'ddg', 'exa-free', 'anysearch'],
  api: ['tavily', 'brave', 'exa', 'anysearch', 'tinyfish', 'deepseek-search', 'firecrawl', 'keenable'],
}
ENGINE_POOLS.hybrid = [...new Set([...ENGINE_POOLS.free, ...ENGINE_POOLS.api])]
export const RANKINGS = ['balanced', 'research', 'fresh']
// Uncalibrated cold-start defaults. Existing priors retain their original scale;
// DDG is reduced to 60% and TinyFish/DeepSeek start neutral. No new GM normalization.
// One strategy table across all pools; never normalize by runtime availability.
export const SHARED_RANKING_WEIGHTS = {
  "balanced": {
    "bing": 0.9572312859948126,
    "ddg": 0.5885221115535021,
    "exa-free": 1.0039526424966523,
    "tavily": 1.0485943361780756,
    "brave": 1.0039526424966523,
    "exa": 1.0485943361780756,
    "anysearch": 1.0039526424966523,
    "tinyfish": 1,
    "deepseek-search": 1,
    "firecrawl": 1.0,
    "keenable": 1.0
  },
  "research": {
    "bing": 0.9273071097009062,
    "ddg": 0.5415446777772274,
    "exa-free": 1.0847595020446763,
    "tavily": 1.1054234445617832,
    "brave": 0.9513970202877831,
    "exa": 1.1456337201776512,
    "anysearch": 1.042203218309638,
    "tinyfish": 1,
    "deepseek-search": 1,
    "firecrawl": 1.0,
    "keenable": 1.0
  },
  "fresh": {
    "bing": 1.0197555682848762,
    "ddg": 0.5561093771946695,
    "exa-free": 0.9509269706554807,
    "tavily": 1.0842235630053483,
    "brave": 1.12515196525981,
    "exa": 1.0631686740118014,
    "anysearch": 0.9509269706554807,
    "tinyfish": 1,
    "deepseek-search": 1,
    "firecrawl": 1.0,
    "keenable": 1.0
  }
}
export const RANKING_WEIGHTS = Object.fromEntries(Object.entries(ENGINE_POOLS).map(([pool, names]) => [pool,
  Object.fromEntries(RANKINGS.map((ranking) => [ranking, Object.fromEntries(names.map((name) => [name, SHARED_RANKING_WEIGHTS[ranking][name]]))])),
]))
export const legacyPool = (layer) => layer === 'free' ? 'free' : 'hybrid'
// Default selection is configuration-based, never a retry/failover after dispatch.
export function defaultEnginePool(engines) {
  return ENGINE_POOLS.api.some(name => engines[name]?.availableForPool?.('api') ?? engines[name]?.available()) ? 'api' : 'free'
}

export function resolveSearchRoute({ enginePool, layer, engineList, ranking = 'balanced', engineWeights = {}, engines }) {
  const pool = enginePool ?? (layer === 'free' || layer === 'api' ? legacyPool(layer) : defaultEnginePool(engines))
  if (!Object.hasOwn(ENGINE_POOLS, pool)) throw new Error('engine_pool must be free, api or hybrid')
  if (!RANKINGS.includes(ranking)) throw new Error('ranking must be balanced, research or fresh')
  if (!engineWeights || typeof engineWeights !== 'object' || Array.isArray(engineWeights)) throw new Error('engine_weights must be an object')
  for (const [name, weight] of Object.entries(engineWeights)) {
    if (!ENGINE_POOLS.hybrid.includes(name) || typeof weight !== 'number' || !Number.isFinite(weight) || weight < 0) throw new Error(`Invalid engine_weights entry: ${name}`)
  }
  if (engineList != null && (!Array.isArray(engineList) || !engineList.length)) throw new Error('engines must be a non-empty array')
  const available = name => engines[name]?.availableForPool?.(pool) ?? engines[name]?.available()
  const automatic = enginePool == null && layer !== 'free' && layer !== 'api' && engineList == null
  // Automatic selection is a supported subset, not a request for every vendor.
  // Explicit pools/lists still disclose unavailable engines rather than hiding them.
  const requested = [...new Set(engineList ?? (automatic ? ENGINE_POOLS[pool].filter(available) : ENGINE_POOLS[pool]))]
  if (requested.some((name) => !ENGINE_POOLS.hybrid.includes(name))) throw new Error('Unknown search engine')
  const names = requested.filter(available)
  const warnings = requested.filter((name) => !names.includes(name)).map((name) => `${name} unavailable (missing credentials, disabled, or locally unavailable); not called`)
  const listedOnly = engineList != null && enginePool == null && layer !== 'free' && layer !== 'api'
  const listedPool = listedOnly
    ? (requested.every((name) => ENGINE_POOLS.api.includes(name)) ? 'api'
      : requested.every((name) => ENGINE_POOLS.free.includes(name)) ? 'free' : 'hybrid')
    : pool
  const reportedPool = !names.length && listedOnly ? listedPool : pool
  if (!names.length) {
    warnings.push(engineList != null
      ? `No selected engine was called (${requested.join(', ')}). engine_pool=${reportedPool} did not run.`
      : `No available engines in requested ${pool} pool; no implicit fallback`)
  }
  // An explicit engines override can cross pool boundaries. Missing preset
  // entries use that engine's native free/api preset, not a routing change.
  const effectiveWeights = Object.fromEntries(names.map((name) => [name, engineWeights[name]
    ?? RANKING_WEIGHTS[pool][ranking][name]
    ?? RANKING_WEIGHTS[ENGINE_POOLS.api.includes(name) ? 'api' : 'free'][ranking][name]]))
  return { enginePool: reportedPool, ranking, enginesRequested: requested, engineNames: names, effectiveWeights, warnings }
}

/** Keyed engines documented as possibly billed. TinyFish stays out: its docs describe a zero price. */
export const CHARGEABLE_ENGINES = Object.freeze(['tavily', 'brave', 'exa', 'anysearch', 'deepseek-search', 'firecrawl', 'keenable'])

/**
 * Read-only description of the engines used when a call omits engine_pool.
 * This is not a search and does not change the 0.3.0 selection rule.
 */
export function describeDefaultSearch(enabledNames = [], { whitelist = null, language = 'both' } = {}) {
  const enabled = [...enabledNames]
  const engines = enabled.length ? enabled : [...ENGINE_POOLS.free]
  const chargeable = enabled.filter((name) => CHARGEABLE_ENGINES.includes(name))
  const en = []
  const zh = []
  if (!enabled.length) {
    en.push(`Automatic search: ${engines.join(', ')}.`)
    en.push('No keyed API is enabled. engine_pool omitted uses these keyless engines. This is a complete setup.')
    zh.push('自动搜索：免 Key 引擎。')
    zh.push(`${engines.join(', ')}。\n没有已启用的 API。这是完整配置。`)
  } else {
    en.push(`Automatic search: ${engines.join(', ')}.`)
    zh.push(`自动搜索：${engines.join(', ')}。`)
    if (chargeable.length) {
      en.push('May incur charges. Check with the provider.')
      zh.push('可能收费，以服务商为准。')
    }
    if (enabled.includes('tinyfish')) en.push('tinyfish is documented as zero-priced. Confirm the current provider rule.')
    en.push('Effective sources when engine_pool is omitted are the names above. This call only: engine_pool=free, and do not list keyed engines.')
    zh.push('有效源就是上面的名单。仅本次免 Key：engine_pool=free，且不要列出 Key 引擎。')
  }
  en.push(Array.isArray(whitelist)
    ? `Saving a key does not change the stored engine whitelist (${whitelist.join(', ') || 'empty'}).`
    : 'No whitelist: saving another key adds it to default search.')
  zh.push(Array.isArray(whitelist)
    ? `保存 Key 不改白名单（${whitelist.join(', ') || '空'}）。`
    : '没有白名单时，再保存一把 Key 会进入默认搜索。')
  en.push('Protocol: POST /v1/tools/search only. No live check.')
  zh.push('协议：只调用 POST /v1/tools/search。没有 live 验证。')
  const menuHint = !enabled.length
    ? `${engines.join(', ')} · keyless, complete`
    : `${engines.join(', ')} · ${chargeable.length ? 'may charge' : 'enabled'}`
  const menuHintZh = !enabled.length
    ? `${engines.join(', ')} · 免 Key，完整配置`
    : `${engines.join(', ')} · ${chargeable.length ? '可能收费' : '已启用'}`
  const lines = language === 'zh-CN' ? zh : language === 'en' ? en : [...en, ...zh]
  const hint = language === 'zh-CN' ? menuHintZh : menuHint
  return { when: 'engine_pool omitted', engines, chargeable, whitelist: Array.isArray(whitelist) ? [...whitelist] : null, lines, menuHint: hint }
}

/** One sentence for the engines actually selected. It does not add or remove engines. */
export function explainSelection({ explicitEngines = false, explicitPool = false, engineNames = [], enabledNames = [], enginePool = 'free' } = {}) {
  const names = engineNames.length ? engineNames.join(', ') : '(none)'
  const protocol = engineNames.includes('deepseek-search')
    ? ' deepseek-search calls POST /v1/tools/search only.'
    : ''
  let sentence
  if (!engineNames.length) sentence = `No engine was called. engine_pool=${enginePool} did not run; it is only the routing label. Check search-boost config keys --show.`
  else if (explicitEngines) sentence = `Used ${names} because this call listed engines. No other engine is added if this set fails or is empty.`
  else if (explicitPool) sentence = `Used ${names} because this call set engine_pool. A failure does not switch pools.`
  else if (!enabledNames.length) sentence = `Used ${names} because no keyed API is enabled.`
  else if (engineNames.length === 1) sentence = `Used ${names} because engine_pool was omitted and it is the only enabled API.`
  else sentence = `Used ${names} because engine_pool was omitted and these APIs are enabled.`
  return `${sentence}${protocol}`
}

export const FUSED_DESCRIPTION = [
  'Use for the vast majority of public-web research tasks, from precise lookups to difficult investigations. This general-purpose multi-engine search does not require Jev. If adaptive_search is unavailable, disabled or no judgment profile is configured, use enabled fused_search normally; do not delay research or require judgment setup.',
  'When both tools are available, choose fused_search for direct retrieval, varied query angles or explicit source control. Prefer adaptive_search for higher-quality intent-guided evidence selection when a medium-to-high difficulty or uncertain question benefits from screening noisy or mixed-relevance results. Choose by the evidence need, not merely by which tools are configured.',
  'Omitting engine_pool uses enabled keyed APIs when at least one is configured, otherwise keyless engines; no manual layer switch is needed. API failures do not silently switch pools. A single enabled API is supported. routeExplanation states why those engines were called. An explicit engines list, or that single API, is not filled from other engines when it fails or is empty.',
  'Returns ranked extracts, source attribution and execution diagnostics, including failures and warnings. Normally omit engines; request-local choices do not change persistent defaults. Use community platform arrays for Reddit, X, Bilibili, Zhihu or Xiaohongshu; legacy community=true means X only. Use platform_options for independent selected-platform conditions, shared with community_search and Adaptive. Community candidates share the fused pool and final limit without a separate paged call. Use community_search for community-only tasks; select engines:["x"] for X-only retrieval.',
  'Scores do not verify claims, and multiple engines finding the same page do not independently corroborate it. Use fetch_page to read decisive sources when extracts are insufficient.',
].join(' ')
export const FUSED_ROUTING_PROPERTIES = {
  engine_pool: { type: 'string', enum: ['free', 'api', 'hybrid'], description: 'Which pool to search. Omitted: enabled keyed APIs when at least one is configured; otherwise keyless engines. Explicit pools retain their membership.' },
  ranking: { type: 'string', enum: RANKINGS, default: 'balanced', description: 'Final engine-weight preset only; does not change calls, variants, depth or recency filters.' },
  engines: { type: 'array', minItems: 1, items: { type: 'string', enum: ENGINE_POOLS.hybrid }, description: 'Optional exact engine selection overriding the pool. Unavailable/disabled engines are skipped with warnings.' },
  engine_weights: { type: 'object', additionalProperties: false, properties: Object.fromEntries(ENGINE_POOLS.hybrid.map((name) => [name, { type: 'number', minimum: 0 }])), description: 'Override selected preset weights. Zero weight still calls the engine; weights never enable or select engines.' },
  complexity: { type: 'string', enum: ['simple', 'medium', 'complex'], default: 'medium', description: 'Search breadth/depth only: up to 1/2/3 total query variants (including query and OR alternatives); complex uses advanced depth. Default medium.' },
  community: { ...COMMUNITY_SELECTION_SCHEMA, default: false },
  platform_options: FUSED_PLATFORM_OPTIONS_SCHEMA,
}
