/**
 * Zod input/output schemas for MCP tools (JSON Schema via MCP SDK).
 */
import * as z from 'zod'
import { ENGINE_ORDER } from '../../lib/runtime.mjs'
import { ADAPTIVE_INPUT_SCHEMA } from '../../lib/search/screening/input.js'
import {
  ADAPTIVE_OUTPUT_SCHEMA,
  ADAPTIVE_V5_OUTPUT_SCHEMA, ADAPTIVE_V6_OUTPUT_SCHEMA,
} from '../../lib/search/screening/schema.js'
import { FUSED_PLATFORM_OPTIONS_SCHEMA } from '../../lib/community/fused-input.mjs'
import { jsonSchemaToZod, projectObjectUnion } from '../../lib/search/screening/zod-schema.js'

const engineEnum = z.enum(ENGINE_ORDER)

export const fusedSearchInput = {
  query: z.string().describe('Search query (site:, -site:, "phrase", A OR B)'),
  queries: z.array(z.string()).optional().describe('Distinct query angles, not paraphrases; complexity caps total variants at 1/2/3, including query and OR alternatives'),
  engines: z.array(engineEnum).min(1).optional().describe('Optional exact engine selection overriding engine_pool; unavailable or disabled engines are skipped with warnings'),
  max_results: z.number().int().min(1).max(10).optional().describe('Max results (default 6)'),
  include_domains: z.array(z.string()).optional().describe('Restrict results to these hostnames, e.g. nodejs.org; useful for official sources'),
  exclude_domains: z.array(z.string()).optional().describe('Exclude these hostnames from results'),
  recency: z.enum(['day', 'week', 'month', 'year']).optional().describe('Favor recent dated results; omit for historical or version-pinned documentation'),
  complexity: z.enum(['simple', 'medium', 'complex']).optional().describe('Budget, query variants and depth only; default medium'),
  engine_pool: z.enum(['free', 'api', 'hybrid']).optional().describe('Which engines to search. Omitted: compatibility layer free→free, api→hybrid'),
  ranking: z.enum(['balanced', 'research', 'fresh']).optional().describe('Final engine-weight preset only; default balanced'),
  engine_weights: z.object(Object.fromEntries(ENGINE_ORDER.map((name) => [name, z.number().finite().min(0).optional()]))).strict().optional().describe('Override preset engine weights; zero still calls the engine. Never enables or selects engines'),
  min_score: z.number().finite().min(0).optional().describe('Minimum consensus-v2 quality score; old thresholds need recalibration, default 0'),
  community: z.union([z.boolean(), z.array(z.enum(['reddit', 'x', 'bilibili', 'zhihu', 'xiaohongshu'])).max(5)]).optional().describe('Selected community platforms. false/[] disables; legacy true means X only. Shares final max_results; never enables backends.'),
  platform_options: jsonSchemaToZod(FUSED_PLATFORM_OPTIONS_SCHEMA).optional(),
  layer: z.enum(['free', 'api']).optional().describe('Deprecated compatibility alias: free→free pool, api→hybrid pool; engine_pool takes precedence; not persisted'),
}

export const fusedSearchOutput = {
  scoreVersion: z.string(),
  query: z.string(),
  layer: z.string(),
  tier: z.string(),
  tookMs: z.number(),
  cacheHit: z.boolean(),
  resultCount: z.number(),
  enginesRequested: z.array(z.string()).optional(),
  enginesUsed: z.array(z.string()).optional(),
  enginePool: z.enum(['free', 'api', 'hybrid']),
  ranking: z.enum(['balanced', 'research', 'fresh']),
  effectiveWeights: z.record(z.number()),
  communityUsed: z.boolean(),
  communityPlatforms: z.array(z.string()).optional(),
  communityChannels: z.array(z.object({}).passthrough()).optional(),
  engineStats: z.record(z.object({
    used: z.boolean(),
    errors: z.number(),
    attempts: z.number().optional(),
    successes: z.number().optional(),
    note: z.string().optional(),
  })).optional(),
  warnings: z.array(z.string()).optional(),
  results: z.array(z.object({
    title: z.string(),
    url: z.string(),
    domain: z.string(),
    snippet: z.string(),
    score: z.number(),
    scoreVersion: z.string(),
    rankScore: z.number(), evidenceScore: z.number(), consensusBoost: z.number(),
    metadataDelta: z.number(), selectionScore: z.number().optional(),
    engineRanks: z.record(z.number()), contributions: z.record(z.number()),
    provenance: z.array(z.object({ engine: z.string(), rank: z.number(), variant: z.string().optional(), url: z.string(), title: z.string().optional(), snippet: z.string().optional(), published: z.string().nullable().optional(), platform: z.string().optional(), provider: z.string().optional(), backend: z.string().optional(), retrieval_mode: z.string().optional(), content_type: z.string().optional() })),
    dateStatus: z.enum(['known', 'unknown', 'conflicting']),
    engines: z.array(z.string()),
    published: z.string().nullable(),
    kind: z.enum(['web', 'x']).optional(),
    username: z.string().optional(),
    id: z.string().optional(),
  })),
}

export const fetchPageInput = {
  url: z.string().url().describe('http(s) URL to fetch'),
  focus: z.string().optional().describe('Keep matching paragraphs; omit for the readable body. Output may still be windowed; inspect nextOffset and limitations'),
  offset: z.number().int().min(0).optional().describe('Character offset into the page body (default 0); pass nextOffset from a previous call to continue a long page from cache'),
}

export const fetchPageOutput = {
  requestedUrl: z.string().optional(),
  focusMiss: z.boolean().optional(),
  limitation: z.object({ kind: z.string(), message: z.string() }).optional(),
  url: z.string(),
  via: z.string(),
  word_count: z.number(),
  tookMs: z.number(),
  truncated: z.boolean().optional(),
  totalChars: z.number().optional(),
  offset: z.number().optional(),
  nextOffset: z.number().optional(),
  windowNote: z.string().optional(),
  content: z.string(),
}

export const searchLayerInput = {
  layer: z.enum(['free', 'api', 'show']).optional().describe('show (default) reads current state; free/api persist a new default and require authorization'),
}

export const searchStatsOutput = {
  startedAt: z.string(),
  layer: z.string(),
  cacheHits: z.number(),
  cacheMisses: z.number(),
  tierCounts: z.record(z.number()),
  keyedEngines: z.object({
    configured: z.number(),
    enabled: z.number(),
    total: z.number(),
    enabledNames: z.array(z.string()),
  }),
  engines: z.record(z.boolean()),
  xOfficial: z.boolean(),
  xSource: z.string(),
  recent: z.array(z.record(z.unknown())),
}

/**
 * MCP translates the SAME host-neutral contracts the core uses. Both are strict
 * Zod objects (not SDK silencers): a retired or unknown field such as `keywords`
 * is refused before the handler runs instead of being stripped and executed.
 */
export const adaptiveSearchInput = jsonSchemaToZod(ADAPTIVE_INPUT_SCHEMA)
/** v6 runs, unchanged v5 runs and historical restores: the shared exact-one
 * union projected to a strict object for SDK discovery. */
export const adaptiveSearchOutput = jsonSchemaToZod(projectObjectUnion(ADAPTIVE_OUTPUT_SCHEMA))
// The SDK requires an object-shaped discovery schema. Validate the complete
// disjoint union separately before returning a response; projection alone would
// otherwise allow missing branch-specific required fields or a hybrid record.
const adaptiveOutputContract = jsonSchemaToZod(ADAPTIVE_OUTPUT_SCHEMA)
export function validateAdaptiveSearchOutput(value) {
  if (!adaptiveOutputContract.safeParse(value).success) {
    throw new TypeError('adaptive_search: invalid response contract')
  }
  return value
}
/** The v6 branch for new runs; v5 remains available for old snapshots. */
export const adaptiveSearchV6Output = jsonSchemaToZod(ADAPTIVE_V6_OUTPUT_SCHEMA)
export const adaptiveSearchV5Output = jsonSchemaToZod(ADAPTIVE_V5_OUTPUT_SCHEMA)
export { ADAPTIVE_INPUT_SCHEMA }

/** MCP tool annotations (hints for clients) */export const ANNOTATIONS = {
  search: { readOnlyHint: true, openWorldHint: true, destructiveHint: false },
  config: { readOnlyHint: false, openWorldHint: false, destructiveHint: false },
  stats: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
}
