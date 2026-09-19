/**
 * Zod input/output schemas for MCP tools (JSON Schema via MCP SDK).
 */
import * as z from 'zod'
import { ENGINE_ORDER } from '../../lib/runtime.mjs'

const engineEnum = z.enum(ENGINE_ORDER)

export const fusedSearchInput = {
  query: z.string().describe('Search query (site:, -site:, "phrase", A OR B)'),
  queries: z.array(z.string()).optional().describe('Distinct query angles, not paraphrases; use up to 3 variants'),
  engines: z.array(engineEnum).optional().describe('Engine subset override'),
  max_results: z.number().int().min(1).max(10).optional().describe('Max results (default 6)'),
  include_domains: z.array(z.string()).optional().describe('Restrict results to these hostnames, e.g. nodejs.org; useful for official sources'),
  exclude_domains: z.array(z.string()).optional().describe('Exclude these hostnames from results'),
  recency: z.enum(['day', 'week', 'month', 'year']).optional().describe('Favor recent dated results; omit for historical or version-pinned documentation'),
  complexity: z.enum(['auto', 'simple', 'medium', 'complex']).optional().describe('Search budget: simple for a focused lookup, complex for multi-angle research; default auto'),
  layer: z.enum(['free', 'api']).optional().describe('Override the search layer for this request only; does not persist configuration'),
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
  engineStats: z.record(z.object({
    used: z.boolean(),
    errors: z.number(),
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
  from_date: z.string().optional().describe('YYYY-MM-DD'),
  to_date: z.string().optional().describe('YYYY-MM-DD'),
}

export const xSearchOutput = {
  via: z.string(),
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

/** MCP tool annotations (hints for clients) */
export const ANNOTATIONS = {
  search: { readOnlyHint: true, openWorldHint: true, destructiveHint: false },
  config: { readOnlyHint: false, openWorldHint: false, destructiveHint: false },
  stats: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
}
