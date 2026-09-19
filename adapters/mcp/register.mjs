/**
 * MCP host adapter — tool / resource / prompt registration (protocol-native
 * registerTool API). All search logic comes from SearchBoost Core
 * (lib/runtime.mjs); this file only maps MCP arguments in and renders
 * CallToolResult (text + structuredContent) out.
 */
import * as z from 'zod'
import { abortSignal, toolErr, toolOk } from './result.mjs'
import { MCP_POLICY_TEXT } from './policy.mjs'
import {
  X_MODES,
  collectSearchStats,
  describeLayer,
  formatFusedSummary,
  formatAllEnginesFailedMessage,
  allAttemptedEnginesFailed,
  fusedHitToJson,
  getLayer,
  LAYER_LABELS,
  renderXItem,
  runFetchPage,
  runFused,
  runXSearch,
  switchLayer,
} from '../../lib/runtime.mjs'
import {
  ANNOTATIONS,
  fetchPageInput,
  fetchPageOutput,
  fusedSearchInput,
  fusedSearchOutput,
  searchLayerInput,
  searchStatsOutput,
  xSearchInput,
  xSearchOutput,
} from './schemas.mjs'

/** @param {import('@modelcontextprotocol/sdk/server/mcp.js').McpServer} server */
export function registerAll(server) {
  server.registerTool('fused_search', {
    title: 'Fused Web Search',
    description:
      'Find public web evidence for facts, versions, APIs, or comparisons using multi-engine search with URL deduplication. ' +
      'Start with complexity=simple for one fact; use distinct queries for multiple angles. ' +
      'Returns ranked URLs, snippets, dates, and engine warnings. Use fetch_page when snippets do not establish the claim; ' +
      'use x_search for X/Twitter. Free mode needs no keys.',
    inputSchema: fusedSearchInput,
    outputSchema: fusedSearchOutput,
    annotations: { ...ANNOTATIONS.search, title: 'Search the web (multi-engine fusion)' },
  }, async (args, extra) => {
    try {
      if (!String(args.query ?? '').trim()) return toolErr('fused_search: query is required')
      const signal = abortSignal(extra, 90_000)
      const result = await runFused({
        query: args.query,
        queries: args.queries,
        engineList: args.engines,
        maxResults: Math.max(1, Math.min(args.max_results ?? 6, 10)),
        includeDomains: args.include_domains,
        excludeDomains: args.exclude_domains,
        recency: args.recency,
        complexity: args.complexity ?? 'auto',
        layer: args.layer ?? null,
        signal,
      })
      const hits = result.results.map(fusedHitToJson)
      const structured = {
        query: result.query,
        layer: result.layer ?? getLayer(),
        tier: result.tier,
        tookMs: result.tookMs,
        cacheHit: Boolean(result.cacheHit),
        resultCount: hits.length,
        enginesRequested: result.enginesRequested ?? [],
        enginesUsed: result.enginesUsed ?? [],
        results: hits,
        engineStats: result.engineStats ?? {},
        warnings: result.warnings ?? [],
      }
      if (hits.length === 0 && allAttemptedEnginesFailed(result.engineStats)) {
        return toolErr(formatAllEnginesFailedMessage(result), structured)
      }
      return toolOk(formatFusedSummary(result), structured)
    } catch (err) {
      return toolErr(err instanceof Error ? err.message : String(err))
    }
  })

  server.registerTool('fetch_page', {
    title: 'Fetch Page',
    description: 'Read a known public webpage or official documentation URL directly, without searching again. Returns readable text via Jina Reader with HTML fallback; removes page chrome without clipping the body. Use focus for relevant paragraphs, or omit it for the full readable page. If focus matches nothing, retry without it. Not an authenticated browser or live account-state tool.',
    inputSchema: fetchPageInput,
    outputSchema: fetchPageOutput,
    annotations: { ...ANNOTATIONS.search, title: 'Fetch URL content' },
  }, async (args, extra) => {
    try {
      const url = String(args.url ?? '').trim()
      if (!url) return toolErr('fetch_page: url is required')
      const signal = abortSignal(extra, 60_000)
      const page = await runFetchPage(url, args.focus, signal)
      const focusNote = page.focusMiss ? ' (focus matched nothing — content omitted; retry without focus)' : ''
      const summary = `fetch_page: ${page.url} — via ${page.via}, ${page.word_count} words, ${page.tookMs}ms${focusNote}`
      return toolOk(`${summary}\n\n${page.content}`, {
        url: page.url,
        via: page.via,
        word_count: page.word_count,
        tookMs: page.tookMs,
        truncated: Boolean(page.truncated),
        content: page.content,
      })
    } catch (err) {
      return toolErr(err instanceof Error ? err.message : String(err))
    }
  })

  server.registerTool('x_search', {
    title: 'X (Twitter) Search',
    description:
      'Search X/Twitter posts, inspect an account, or retrieve a thread. ' +
      'Choose keyword/semantic with query, user with username, or thread with post_id. ' +
      'Credential-free web/oEmbed fallbacks are available; configured X authentication can improve coverage. ' +
      'Results are not guaranteed to cover all posts or a complete thread; a sample does not establish platform-wide sentiment.',
    inputSchema: xSearchInput,
    outputSchema: xSearchOutput,
    annotations: { ...ANNOTATIONS.search, title: 'Search X/Twitter' },
  }, async (args, extra) => {
    try {
      const kind = X_MODES.includes(args.type) ? args.type : 'keyword'
      const subj = args.query ?? args.username ?? args.post_id ?? ''
      if (!subj) return toolErr('x_search: provide query, username, or post_id')
      const out = await runXSearch({ ...args, type: kind }, { signal: abortSignal(extra, 180_000) })
      if (out.via === 'error') {
        return toolErr(`x_search: no results (${out.error ?? 'primary and fallback failed'})`)
      }
      const items = out.items ?? []
      if (items.length === 0) {
        return toolErr(`x_search: no results (${out.via}${out.note ? `; ${out.note.slice(0, 120)}` : ''})`)
      }
      const header = out.cacheHit
        ? `x_search (cache) — ${items.length} results`
        : `x_search via ${out.via === 'parallel' ? `parallel:${out.credential}` : out.via} — ${items.length} results`
      const text = [header, out.cacheHit ? '' : out.note ?? '', '', items.map(renderXItem).join('\n')].filter(Boolean).join('\n')
      return toolOk(text, {
        via: out.cacheHit ? (out.via ?? 'cache') : out.via,
        results: items.length,
        tookMs: out.tookMs,
        cacheHit: Boolean(out.cacheHit),
        items,
      })
    } catch (err) {
      return toolErr(err instanceof Error ? err.message : String(err))
    }
  })

  server.registerTool('search_layer', {
    title: 'Search Layer',
    description: `Inspect the current search layer with layer=show (default, no change). layer=free or api persists a new default: only change it when authorized. free = ${LAYER_LABELS.free}. api = ${LAYER_LABELS.api}. For a single search, use fused_search.layer instead.`,
    inputSchema: searchLayerInput,
    annotations: { ...ANNOTATIONS.config, title: 'Configure search layer' },
  }, async (args) => {
    try {
      const cmd = args.layer ?? 'show'
      if (cmd === 'free' || cmd === 'api') {
        switchLayer(cmd)
        return toolOk(`layer → ${cmd} (${LAYER_LABELS[cmd]})`, { layer: cmd })
      }
      const info = describeLayer()
      const keyedLine = info.layer === 'api'
        ? `keyed: ${info.keyedEngines.enabled}/${info.keyedEngines.total} enabled (${info.keyedEngines.enabledNames.join(', ') || 'none'})`
        : null
      const text = [
        `layer: ${info.layer} — ${info.label}`,
        keyedLine,
        `engines: ${info.engines.join(', ') || '(none)'}`,
        `x_search: ${info.xOfficial ? 'official' : 'fallback'} (${info.xSource})`,
      ].filter(Boolean).join('\n')
      return toolOk(text, {
        layer: info.layer,
        engines: info.engines,
        keyedEngines: info.layer === 'api' ? info.keyedEngines : undefined,
        xOfficial: info.xOfficial,
        xSource: info.xSource,
      })
    } catch (err) {
      return toolErr(err instanceof Error ? err.message : String(err))
    }
  })

  server.registerTool('search_stats', {
    title: 'Search Stats',
    description: 'Read-only diagnostics for failed or empty searches: cache hits/misses, tier counts, engine availability, and recent activity. Call with no arguments. Inspect tool warnings too; an empty result alone does not imply missing credentials or justify changing configuration.',
    inputSchema: {},
    outputSchema: searchStatsOutput,
    annotations: { ...ANNOTATIONS.stats, title: 'Search diagnostics' },
  }, async () => {
    try {
      const body = collectSearchStats()
      return toolOk(JSON.stringify(body, null, 2), body)
    } catch (err) {
      return toolErr(err instanceof Error ? err.message : String(err))
    }
  })

  server.registerResource('search-policy', 'search-boost://policy', {
    title: 'Search usage reference',
    description: 'Optional examples, evidence limitations, and connection/layer troubleshooting. Not required before tool calls.',
    mimeType: 'text/markdown',
  }, async (uri) => ({
    contents: [{
      uri: uri.href,
      mimeType: 'text/markdown',
      text: MCP_POLICY_TEXT,
    }],
  }))

  server.registerPrompt('search_routing', {
    title: 'Search tool routing',
    description: 'Explicitly requested search-plan helper for a task; not required for normal tool calls.',
    argsSchema: {
      task: z.string().describe('What the user is trying to find out'),
    },
  }, async ({ task }) => ({
    messages: [{
      role: 'user',
      content: {
        type: 'text',
        text: [
          `Task: ${task}`,
          '',
          'Propose the smallest evidence-gathering plan for this task using the available MCP tool descriptions and schemas.',
          'Identify the external claims that need checking, any known source URLs, and what evidence would be sufficient.',
          'If local evidence already answers the task or browsing is forbidden, say so rather than scheduling searches.',
          'Do not change search layers, credentials, or permissions as part of planning. Do not assume subagent tools exist.',
          'Tools can be called directly; neither this prompt nor a skill is a prerequisite. Optional detailed reference: search-boost://policy.',
        ].join('\n'),
      },
    }],
  }))
}
