/**
 * MCP tool / resource / prompt registration (protocol-native registerTool API).
 */
import * as z from 'zod'
import { abortSignal, toolErr, toolOk } from '../lib/mcp-result.mjs'
import { MCP_POLICY_TEXT } from '../lib/mcp-policy.mjs'
import {
  X_MODES,
  X_CACHE,
  activeLayer,
  authStatus,
  availableEngines,
  bumpEngines,
  cleanJsonValue,
  collectSearchStats,
  domainSearch,
  ENGINE_ORDER,
  fallbackXSearch,
  fetchPage,
  filterResearchGaps,
  formatFusedSummary,
  formatAllEnginesFailedMessage,
  allAttemptedEnginesFailed,
  fusedHitToJson,
  getLayer,
  hitToPost,
  layerTierTable,
  LAYER_LABELS,
  PAGE_CACHE,
  persistLayer,
  renderXItem,
  researchRound,
  allocateResearchRound,
  runEngine,
  runFused,
  runXTool,
  stats,
  xAuthAvailableSync,
} from '../lib/runtime.mjs'
import { readKeysRouting } from '../lib/keys.mjs'
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
      'Free layer: bing+ddg+yahoo+exa-free (no keys). Api layer adds antigravity+tavily/brave/exa when keyed.',
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
      const page = await fetchPage(url, args.focus, PAGE_CACHE, signal)
      const summary = `fetch_page: ${page.url} — via ${page.via}, ${page.word_count} words, ${page.tookMs}ms`
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
      const engines = bumpEngines()
      const active = activeLayer(args.layer)
      const round = allocateResearchRound(args.round)
      const result = await researchRound({
        query: args.query,
        queries: args.queries,
        maxSources: Math.min(args.max_sources ?? 8, 12),
        recency: args.recency,
        layer: active,
        round,
        engines: availableEngines(engines, layerTierTable(active).complex),
        runOne: (engineName, q, n, o) => runEngine(engines, engineName, q, n, o),
        signal,
      })
      const gaps = filterResearchGaps(result.gaps)
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
      const started = Date.now()
      const kind = X_MODES.includes(args.type) ? args.type : 'keyword'
      const subj = args.query ?? args.username ?? args.post_id ?? ''
      if (!subj) return toolErr('x_search: provide query, username, or post_id')
      const maxResults = Math.min(Math.max(args.max_results ?? 5, 1), 10)
      const engines = bumpEngines()
      const cacheKey = JSON.stringify({ kind, q: args.query, u: args.username, pid: args.post_id, m: maxResults })
      const cached = X_CACHE[kind].get(cacheKey)
      if (cached) {
        const items = cached.items ?? []
        return toolOk(`x_search (cache) — ${items.length} results\n\n${items.map(renderXItem).join('\n')}`, {
          via: cached.via ?? 'cache',
          results: items.length,
          tookMs: 0,
          cacheHit: true,
          items,
        })
      }

      const engineSearch = (q, n) => domainSearch(engines, { query: q, maxResults: n, signal: abortSignal(extra, 180_000) })
      const webSearch = (q, n) => engineSearch(q, n).then((hits) =>
        hits.map((h) => ({ title: h.title, url: h.url, snippet: h.snippet, domain: h.domain })))

      const finish = (via, items, note) => {
        const out = { via, items, results: items.length, tookMs: Date.now() - started }
        if (items.length) X_CACHE[kind].set(cacheKey, out)
        const text = [`x_search via ${via} — ${items.length} results`, note ?? '', '', items.map(renderXItem).join('\n')].filter(Boolean).join('\n')
        return toolOk(text, { via, results: items.length, tookMs: out.tookMs, cacheHit: false, items })
      }

      const runFallback = async (primaryErr) => {
        const fb = await fallbackXSearch({ type: kind, query: args.query, username: args.username, post_id: args.post_id, limit: maxResults, webSearch })
        const items = Array.isArray(fb.data) ? fb.data : [fb.data]
        if (!items.length) {
          return toolErr(`x_search: no results (${fb.via ?? 'fallback'}; ${String(primaryErr).slice(0, 120)})`)
        }
        return finish(`fallback:${fb.via}`, items, `primary: ${String(primaryErr).slice(0, 200)}`)
      }

      if (!xAuthAvailableSync()) return runFallback('no xAI credentials')

      if (kind === 'keyword' || kind === 'semantic') {
        const engQuery = args.query ?? (args.username ? `from:${args.username}` : subj)
        const [xOutcome, engOutcome] = await Promise.allSettled([
          runXTool({ type: kind, query: args.query, username: args.username, from_date: args.from_date, to_date: args.to_date, max_results: maxResults }),
          engineSearch(engQuery, maxResults),
        ])
        if (xOutcome.status === 'fulfilled') {
          const xPosts = Array.isArray(xOutcome.value.data) ? xOutcome.value.data : []
          const extra = engOutcome.status === 'fulfilled'
            ? engOutcome.value.filter((h) => h.title || h.snippet).map(hitToPost)
                .filter((p) => !xPosts.some((x) => (x.id && p.id && x.id === p.id) || (x.url && p.url && x.url === p.url)))
            : []
          const merged = cleanJsonValue([...xPosts, ...extra])
          return finish('parallel:' + xOutcome.value.credential, merged)
        }
        return runFallback(xOutcome.reason instanceof Error ? xOutcome.reason.message : String(xOutcome.reason))
      }

      try {
        const res = await runXTool({ type: kind, query: args.query, username: args.username, post_id: args.post_id, max_results: maxResults })
        const items = Array.isArray(res.data) ? res.data : [res.data]
        return finish(res.credential, items)
      } catch (err) {
        return runFallback(err instanceof Error ? err.message : String(err))
      }
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
        persistLayer(cmd)
        return toolOk(`layer → ${cmd} (${LAYER_LABELS[cmd]})`, { layer: cmd })
      }
      const engines = bumpEngines()
      const layer = getLayer()
      const { summary } = readKeysRouting()
      const tierTable = layerTierTable(layer)
      const names = [...new Set(Object.values(tierTable).flat())]
      const actual = availableEngines(engines, names)
      const x = authStatus()
      const keyedLine = layer === 'api'
        ? `keyed: ${summary.enabled}/${summary.total} enabled (${summary.enabledNames.join(', ') || 'none'})`
        : null
      const text = [
        `layer: ${layer} — ${LAYER_LABELS[layer]}`,
        keyedLine,
        `engines: ${actual.join(', ') || '(none)'}`,
        `x_search: ${xAuthAvailableSync() ? 'official' : 'fallback'} (${x.source})`,
      ].filter(Boolean).join('\n')
      return toolOk(text, {
        layer,
        engines: actual,
        keyedEngines: layer === 'api' ? {
          configured: summary.configured,
          enabled: summary.enabled,
          total: summary.total,
          enabledNames: summary.enabledNames,
        } : undefined,
        xOfficial: xAuthAvailableSync(),
        xSource: x.source,
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
