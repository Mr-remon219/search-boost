/**
 * Zod input/output schemas for MCP tools (JSON Schema via MCP SDK).
 */
import * as z from 'zod'
import { ENGINE_ORDER } from '../lib/runtime.mjs'

const engineEnum = z.enum(ENGINE_ORDER)

export const fusedSearchInput = {
  query: z.string().describe('Search query (site:, -site:, "phrase", A OR B)'),
  queries: z.array(z.string()).optional().describe('Extra query variants (max 3)'),
  engines: z.array(engineEnum).optional().describe('Engine subset override'),
  max_results: z.number().int().min(1).max(10).optional().describe('Max results (default 6)'),
  include_domains: z.array(z.string()).optional(),
  exclude_domains: z.array(z.string()).optional(),
  recency: z.enum(['day', 'week', 'month', 'year']).optional(),
  complexity: z.enum(['auto', 'simple', 'medium', 'complex']).optional(),
  layer: z.enum(['free', 'api']).optional(),
}

export const fusedSearchOutput = {
  query: z.string(),
  layer: z.string(),
  tier: z.string(),
  tookMs: z.number(),
  cacheHit: z.boolean(),
  resultCount: z.number(),
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
  focus: z.string().optional().describe('Keep paragraphs matching these terms (~90% token savings)'),
}

export const fetchPageOutput = {
  url: z.string(),
  via: z.string(),
  word_count: z.number(),
  tookMs: z.number(),
  truncated: z.boolean().optional(),
  content: z.string(),
}

export const deepResearchInput = {
  query: z.string(),
  queries: z.array(z.string()).optional(),
  max_sources: z.number().int().min(2).max(12).optional(),
  recency: z.enum(['day', 'week', 'month', 'year']).optional(),
  layer: z.enum(['free', 'api']).optional(),
}

export const deepResearchOutput = {
  round: z.number(),
  query: z.string(),
  tookMs: z.number(),
  gaps: z.array(z.string()),
  suggested_queries: z.array(z.string()),
  sources: z.array(z.object({
    title: z.string(),
    url: z.string(),
    domain: z.string(),
    covered: z.number(),
    total: z.number(),
    corroborated: z.boolean(),
  })),
}

export const xSearchInput = {
  type: z.enum(['keyword', 'semantic', 'user', 'thread']).optional(),
  query: z.string().optional(),
  username: z.string().optional(),
  post_id: z.string().optional(),
  max_results: z.number().int().min(1).max(10).optional(),
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
  layer: z.enum(['free', 'api', 'show']).optional(),
}

export const searchStatsOutput = {
  startedAt: z.string(),
  layer: z.string(),
  cacheHits: z.number(),
  cacheMisses: z.number(),
  tierCounts: z.record(z.number()),
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
