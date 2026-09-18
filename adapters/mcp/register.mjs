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
  runResearchRound,
  runXSearch,
  switchLayer,
} from '../../lib/runtime.mjs'
import {
  ANNOTATIONS,
  deepResearchInput,
  deepResearchOutput,
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
      'Multi-engine parallel web search with URL dedupe and cross-ranking. ' +
      'Prefer over built-in WebSearch for version-sensitive facts, APIs, comparisons, and research. ' +
      'Free layer: bing+ddg+yahoo+exa-free (no keys). Api layer adds tavily/brave/exa when keyed.',
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
    description: 'Fetch readable page text via Jina Reader with local HTML fallback. Use focus to filter paragraphs.',
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

  server.registerTool('deep_research', {
    title: 'Deep Research (one round)',
    description:
      'One research round: complex fused search + coverage analysis + gaps + suggested follow-up queries. ' +
      'Call repeatedly with suggested_queries until gaps is empty, then synthesize with citations.',
    inputSchema: deepResearchInput,
    outputSchema: deepResearchOutput,
    annotations: { ...ANNOTATIONS.search, title: 'Deep research round' },
  }, async (args, extra) => {
    try {
      if (!String(args.query ?? '').trim()) return toolErr('deep_research: query is required')
      const signal = abortSignal(extra, 120_000)
      const result = await runResearchRound({
        query: args.query,
        queries: args.queries,
        maxSources: args.max_sources ?? 8,
        recency: args.recency,
        layer: args.layer,
        round: args.round,
        signal,
      })
      const gaps = result.gaps
      const lines = [
        `deep_research round ${result.round}: "${result.query}" — ${result.tookMs}ms`,
        `gaps: ${gaps.length === 0 ? 'none' : gaps.join(', ')}`,
        result.suggested_queries?.length ? `suggested: ${result.suggested_queries.join(' | ')}` : '',
        '',
        ...result.sources.map((s, i) => `${i + 1}. [${s.covered}/${s.total}] ${s.title}\n   ${s.url}`),
      ]
      return toolOk(lines.filter(Boolean).join('\n'), {
        round: result.round,
        query: result.query,
        tookMs: result.tookMs,
        gaps,
        suggested_queries: result.suggested_queries ?? [],
        sources: result.sources.map((s) => ({
          title: s.title,
          url: s.url,
          domain: s.domain,
          covered: s.covered,
          total: s.total,
          corroborated: Boolean(s.corroborated),
        })),
      })
    } catch (err) {
      return toolErr(err instanceof Error ? err.message : String(err))
    }
  })

  server.registerTool('x_search', {
    title: 'X (Twitter) Search',
    description:
      'Real-time X/Twitter search: keyword, semantic, user profile, or thread. ' +
      'Works without credentials (multi-engine + oEmbed fallback). Official path via grok login / XAI_API_KEY.',
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
    description: `Switch or show search layer. free = ${LAYER_LABELS.free}. api = ${LAYER_LABELS.api}.`,
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
    description: 'Diagnostics: cache hits/misses, tier counts, engine availability, recent searches.',
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
    title: 'Search policy',
    description: 'When to search, tool routing, stop conditions (markdown)',
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
    description: 'Optional tool pick when you choose to search; bounded ~3 rounds',
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
          'If external facts matter and repo context is not enough, consider search-boost MCP tools (your call):',
          '- fused_search: quick lookup — versions, APIs, docs, comparisons (complexity=simple first)',
          '- fetch_page: snippets insufficient; official doc body (+ focus)',
          '- x_search: X/Twitter posts, accounts, threads',
          '- deep_research: multi-source synthesis (repeat until gaps empty)',
          '- search_layer: switch free (keyless) vs api (keyed engines)',
          '',
          'Often skip: stable fundamentals, local workspace code, pure creation, user opt-out.',
          'Optional reference: resource search-boost://policy.',
        ].join('\n'),
      },
    }],
  }))
}
