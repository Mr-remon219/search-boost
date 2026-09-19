/**
 * Zod input/output schemas for MCP tools (JSON Schema via MCP SDK).
 */
import * as z from 'zod'
import { ENGINE_ORDER } from '../../lib/runtime.mjs'

const engineEnum = z.enum(ENGINE_ORDER)

export const fusedSearchInput = {
  query: z.string().describe('Search query (site:, -site:, "phrase", A OR B)'),
  queries: z.array(z.string()).optional().describe('Distinct query angles, not paraphrases; use up to 3 variants'),
  engines: z.array(engineEnum).min(1).optional().describe('Optional exact engine selection overriding engine_pool; unavailable or disabled engines are skipped with warnings'),
  max_results: z.number().int().min(1).max(10).optional().describe('Max results (default 6)'),
  include_domains: z.array(z.string()).optional().describe('Restrict results to these hostnames, e.g. nodejs.org; useful for official sources'),
  exclude_domains: z.array(z.string()).optional().describe('Exclude these hostnames from results'),
  recency: z.enum(['day', 'week', 'month', 'year']).optional().describe('Favor recent dated results; omit for historical or version-pinned documentation'),
  complexity: z.enum(['simple', 'medium', 'complex']).optional().describe('Budget, query variants and depth only; default medium'),
  engine_pool: z.enum(['free', 'api', 'hybrid']).optional().describe('Which engines to search. Omitted: compatibility layer free→free, api→hybrid'),
  ranking: z.enum(['balanced', 'research', 'fresh']).optional().describe('Final engine-weight preset only; default balanced'),
  engine_weights: z.object(Object.fromEntries(ENGINE_ORDER.map((name) => [name, z.number().finite().min(0).optional()]))).strict().optional().describe('Override preset engine weights; never enables or selects engines'),
  community: z.boolean().optional().describe('Add X developer/community voices when relevant; default false; shares final max_results'),
  layer: z.enum(['free', 'api']).optional().describe('Deprecated compatibility alias: free→free pool, api→hybrid pool; engine_pool takes precedence; not persisted'),
}

export const fusedSearchOutput = {
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
    engines: z.array(z.string()),
    published: z.string().nullable(),
    kind: z.enum(['web', 'x']).optional(),
    username: z.string().optional(),
    id: z.string().optional(),
  })),
}

export const fetchPageInput = {
  url: z.string().url().describe('http(s) URL to fetch'),
  focus: z.string().optional().describe('Keep paragraphs matching these terms (optional; full page is returned when omitted)'),
}

export const fetchPageOutput = {
  url: z.string(),
  via: z.string(),
  word_count: z.number(),
  tookMs: z.number(),
  truncated: z.boolean().optional(),
  content: z.string(),
}

export const xSearchInput = {
  type: z.enum(['keyword', 'semantic', 'user', 'thread']).optional().describe('Mode: keyword (default) or semantic uses query; user uses username; thread uses post_id'),
  query: z.string().optional().describe('Search terms and X filters (e.g. from:OpenAI), or a natural-language topic for semantic mode'),
  username: z.string().optional().describe('X account handle for type=user'),
  post_id: z.string().optional().describe('Real X post ID or status URL for type=thread'),
  max_results: z.number().int().min(1).max(10).optional().describe('Requested result limit, 1–10'),
  from_date: z.string().optional().describe('Inclusive start date, YYYY-MM-DD (UTC)'),
  to_date: z.string().optional().describe('Inclusive end date, YYYY-MM-DD (UTC)'),
  allowed_x_handles: z.array(z.string()).max(20).optional().describe('Only these authors; mutually exclusive with excluded_x_handles'),
  excluded_x_handles: z.array(z.string()).max(20).optional().describe('Exclude these authors; mutually exclusive with allowed_x_handles'),
}

export const xSearchOutput = {
  via: z.string(),
  note: z.string().optional(),
  results: z.number(),
  tookMs: z.number(),
  cacheHit: z.boolean().optional(),
  items: z.array(z.record(z.unknown())),
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

export const adaptiveSearchInput = {
  questions: z.array(z.string().min(1).max(400)).min(1).max(6)
    .describe('1–6 independent questions (blank answers and over-long items are rejected, never truncated). Each question is searched and judged on its own and keeps its output position; identical questions reuse one execution.'),
}

const adaptiveJudgment = z.object({
  relevance: z.number().nullable(),
  states_evidence: z.number().nullable(),
  premise_conflict: z.number().nullable(),
  injection: z.number().nullable(),
})

const adaptiveEvidence = z.object({
  evidenceId: z.string(),
  url: z.string(),
  title: z.string(),
  domain: z.string(),
  published: z.string().nullable(),
  textBasis: z.enum(['snippet', 'engine_content', 'fetched_page']).nullable(),
  reviewedText: z.string(),
  textVersion: z.string().nullable(),
  engines: z.array(z.string()),
  fusionScore: z.number(),
  status: z.enum(['answer_capable', 'mention_only', 'off_topic', 'unassessed', 'excluded_injection', 'no_text']),
  assessed: z.boolean(),
  judgment: adaptiveJudgment.nullable(),
  premiseConflict: z.boolean(),
  injectionSuspected: z.boolean(),
  usedForCoverage: z.boolean(),
  firstRound: z.number().optional(),
  changeCount: z.number().optional(),
  textTruncated: z.boolean().optional(),
  fetch: z.object({ state: z.string(), via: z.string().nullable(), words: z.number() }).nullable().optional(),
})

const adaptiveCoverage = z.object({
  probability: z.number().nullable(),
  threshold: z.number(),
  basis: z.string().nullable(),
  textBasis: z.string().nullable(),
  snippetOnly: z.boolean(),
  snippetSelfSufficient: z.number().nullable(),
  judgedAtRound: z.number().nullable(),
  evidenceVersionSignature: z.string(),
  missingExplicitRequirements: z.array(z.string()),
  evidenceIds: z.array(z.string()),
})

const adaptiveQuestion = z.object({
  id: z.string(),
  canonicalId: z.string().nullable(),
  question: z.string(),
  status: z.enum(['covered', 'insufficient', 'unassessed', 'not_searched', 'failed']),
  assessed: z.boolean(),
  coverage: adaptiveCoverage.nullable(),
  evidence: z.array(adaptiveEvidence),
  evidenceCount: z.number(),
  evidenceTruncated: z.boolean(),
  conflictCount: z.number(),
  uncoveredReason: z.string().nullable(),
  uncoveredReasons: z.array(z.string()),
  conflicts: z.array(z.record(z.unknown())),
  searchedEngines: z.array(z.string()),
})

export const adaptiveSearchOutput = {
  schemaVersion: z.number(),
  tool: z.string(),
  questions: z.array(adaptiveQuestion),
  uncovered: z.array(z.object({
    id: z.string(),
    canonicalId: z.string().nullable(),
    question: z.string(),
    status: z.string(),
    reasons: z.array(z.string()),
    qualifiedEvidence: z.number(),
    conflicts: z.number(),
  })),
  rounds: z.number(),
  stopReason: z.string(),
  stopDetail: z.string().nullable(),
  evidence: z.object({
    total: z.number(),
    sources: z.number(),
    withText: z.number(),
    answerCapable: z.number(),
    dropped: z.number(),
    byBasis: z.record(z.number()),
  }),
  usage: z.record(z.unknown()),
  roundLog: z.array(z.record(z.unknown())),
  jev: z.record(z.unknown()),
  limits: z.record(z.unknown()),
  warnings: z.array(z.string()),
  outputTruncated: z.boolean().optional(),
  fallback: z.record(z.unknown()).optional(),
  configurationHint: z.string().optional(),
}

/** MCP tool annotations (hints for clients) */export const ANNOTATIONS = {
  search: { readOnlyHint: true, openWorldHint: true, destructiveHint: false },
  config: { readOnlyHint: false, openWorldHint: false, destructiveHint: false },
  stats: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
}
