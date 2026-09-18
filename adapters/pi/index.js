// pi host adapter — pi coding agent extension.
//
// Loaded by pi via package.json `pi.extensions` (pi install npm:search-boost-mcp),
// by `pi -e <this file>`, or through the ~/.pi/agent/extensions shim written by
// `search-boost install -t pi`. Registers the search tools (fused_search,
// fetch_page, deep_research, research_parallel, x_search), the TUI commands
// (/web_change, /x-login, /x-logout, /search-cache, /search-audit) and injects
// the <search_balance> policy (agents/pi/inject.md) into pi's system prompt.
//
// All search logic is SearchBoost Core (lib/runtime.mjs). This file owns only
// pi-specific glue: ExtensionAPI registration, JSON-schema parameters, progress
// updates, audit wiring, and pi-flavoured rendering. It imports nothing from
// pi itself — parameters are plain JSON Schema (pi validates those natively).

import { readFileSync } from 'node:fs'
import * as path from 'node:path'
import { promptPath } from '../../agents/router.mjs'
import { piAgentDir } from '../../lib/config-paths.mjs'
import {
  AuditLog,
  ENGINE_ORDER,
  LAYER_LABELS,
  X_MODES,
  cacheSizes,
  clearAllCaches,
  countWords,
  describeLayer,
  excerptForTool,
  getLayer,
  hostOf,
  jwtTier,
  runFetchPage,
  runFused,
  runResearchLoop,
  runXSearch,
  switchLayer,
  tierName,
  xAuthCommands,
} from '../../lib/runtime.mjs'
import { runParallelResearch } from './parallel.js'

const RECENCY_ENUM = ['day', 'week', 'month', 'year', 'any']

/** Host prompt policy (agents/pi/inject.md). */
export function loadSearchBalanceRules() {
  try {
    return readFileSync(promptPath('pi'), 'utf8').trim()
  } catch {
    return ''
  }
}

export function auditFilePath() {
  return path.join(piAgentDir(), 'search-boost-audit.jsonl')
}

const text = (t) => ({ type: 'text', text: t })

/** @param {import('@earendil-works/pi-coding-agent').ExtensionAPI} pi */
export default function searchBoostExtension(pi) {
  const audit = new AuditLog(auditFilePath())
  const rules = loadSearchBalanceRules()

  /* -------------------- Proactive search rules (injected into system prompt) -------------------- */

  pi.on('before_agent_start', async (event) => {
    if (!rules || event.systemPrompt.includes('<search_balance>')) {
      return {} // already injected by an earlier handler
    }
    // budget state (not just a slogan): count today's searches so the model
    // can calibrate effort — research tasks may spend more, simple lookups
    // should not push the day's total into the hundreds
    let todayCount = 0
    try {
      const today = new Date().toISOString().slice(0, 10)
      for (const e of audit.readTail(400)) {
        if (e.type === 'search' && e.ts.startsWith(today)) todayCount++
      }
    } catch {
      /* audit must never break agent start */
    }
    const budgetNote = todayCount > 0
      ? `\n[search budget] Searches used today: ${todayCount}. Research tasks may spend more; for simple lookups, prefer answering from what you already have when the day's total is high.`
      : ''
    return { systemPrompt: `${event.systemPrompt}\n${rules}${budgetNote}` }
  })

  const onProgress = (onUpdate) => (msg) => {
    onUpdate?.({ content: [text(msg)] })
  }

  /* ------------------------------ fused_search ------------------------------ */

  pi.registerTool({
    name: 'fused_search',
    label: 'Fused Web Search',
    description:
      'Web search: runs keyword variants across the active layer\'s engines in parallel (layer = free: keyless bing/ddg/yahoo/exa-free, or api: the same plus keyed Tavily/Brave/Exa; switched with /web_change), deduplicates by URL, and cross-ranks results by engine agreement and domain quality. Returns up to max_results ranked hits with the engines that found each one. This is the only search tool — use it for everything from single quick lookups to multi-faceted research (pass complexity simple for the former).',
    promptSnippet: 'Search the web across multiple engines in parallel with keyword variants',
    promptGuidelines: [
      'fused_search: it is the single search entry point — for a quick lookup pass complexity=simple (1 variant, cheap); for multi-faceted or research-oriented questions let the tier default to medium/complex and give keyword variants.',
      'fused_search query style: write queries like Grok Build does — stack 3-6 domain keywords plus a few specific terms (e.g. "OpenRLHF architecture training rollout infrastructure documentation"). You may use `site:example.com` (auto-translated to a client-side include filter) and `"phrase" OR "phrase2"` (auto-split into parallel query variants).',
      'fused_search angles: when a topic needs depth, call it repeatedly with a different angle each time (component, use-case, comparison, official docs, community discussion) instead of one broad query.',
      'fused_search: when a term is ambiguous, pass `exclude_domains` to drop known noise (e.g. exclude wikipedia.org / baike.baidu.com when the query has a generic acronym).',
      'fused_search: for time-sensitive questions pass `recency` (day/week/month/year) — results with a publish date outside the window are demoted, and dated results are shown with their publish date.',
      'fused_search: the active layer (free = keyless bing/ddg/yahoo/exa-free; api = plus keyed tavily/brave/exa) is selected with /web_change. In free layer expect occasional 429 on exa-free — prefer fewer variants and rely on cache; switch to api when stakes are high.',
      'fused_search: to restrict to specific sites use `include_domains` (e.g. official docs domains); note engines ignore site: operators, so this is a strict client-side filter.',
    ],
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The question or topic to search for' },
        queries: { type: 'array', items: { type: 'string' }, description: 'Optional keyword variants; if omitted, variants are derived automatically' },
        engines: { type: 'array', items: { type: 'string', enum: ENGINE_ORDER }, description: 'Engine subset override (default: active layer\'s engines; run /web_change to switch layers)' },
        max_results: { type: 'integer', minimum: 1, maximum: 20, default: 10, description: 'Max fused results' },
        site: { type: 'string', description: 'Deprecated: restrict to a domain (alias for include_domains)' },
        include_domains: { type: 'array', items: { type: 'string' }, description: 'Only keep results from these domains (client-side hard filter; engines ignore site: operators)' },
        exclude_domains: { type: 'array', items: { type: 'string' }, description: 'Drop results from these domains, e.g. exclude wikipedia.org when a term is ambiguous' },
        recency: { type: 'string', enum: RECENCY_ENUM, description: 'Recency window: results with a publish date outside the window decay exponentially (half-life scaled to window); undated results are mildly demoted (default any)' },
        min_score: { type: 'number', minimum: 0, maximum: 5, default: 0, description: 'Drop results below this fused score floor (Grok\'s min_score, default 0 = off)' },
        depth: { type: 'string', enum: ['basic', 'advanced'], description: 'Tavily search depth: basic = fast NLP summaries; advanced = query-aligned full extraction (results carry content you can use directly, skipping fetch_page)' },
        complexity: { type: 'string', enum: ['auto', 'simple', 'medium', 'complex'], description: 'Search budget tier: auto = heuristic (default). simple = 1 variant, medium = 2 variants, complex = 3 variants + Tavily advanced. Explicit tier overrides the heuristic.' },
      },
      required: ['query'],
    },
    async execute(_toolCallId, params, signal, onUpdate) {
      const progress = onProgress(onUpdate)
      const started = Date.now()
      progress(`fused_search: ${params.queries?.length ?? 'auto'} keyword variant(s) x ${params.engines?.join(',') ?? 'default engines'}`)
      const includeDomains = [...(params.include_domains ?? []), ...(params.site ? [params.site] : [])]
      const res = await runFused({
        query: params.query,
        queries: params.queries,
        engineList: params.engines,
        maxResults: params.max_results ?? 10,
        maxResultsCap: 20,
        includeDomains: includeDomains.length ? includeDomains : undefined,
        excludeDomains: params.exclude_domains,
        recency: params.recency && params.recency !== 'any' ? params.recency : undefined,
        minScore: params.min_score ?? 0,
        depth: params.depth ?? null,
        complexity: params.complexity ?? 'auto',
        signal,
      })
      audit.write({
        type: 'search',
        ts: new Date().toISOString(),
        query: params.query,
        queriesUsed: res.queriesUsed ?? [params.query],
        engines: Object.keys(res.engineStats ?? {}),
        engineErrors: Object.fromEntries(
          Object.entries(res.engineStats ?? {})
            .filter(([, s]) => s.errors > 0)
            .map(([e, s]) => [e, s.note ?? String(s.errors)]),
        ),
        results: res.results.length,
        cacheHits: res.cacheHit ? 1 : 0,
        tier: res.tier,
        layer: res.layer,
        tookMs: Date.now() - started,
        topUrls: res.results.slice(0, 5).map((r) => r.url),
      })
      const stats = Object.entries(res.engineStats ?? {})
        .map(([e, s]) => `${e}${s.errors ? `(err:${s.errors})` : ''}`)
        .join(', ')
      const lines = [
        `Fused search: "${res.query}"`,
        `Layer: ${res.layer} — ${LAYER_LABELS[res.layer]}`,
        `Tier: ${res.tier} — Queries used: ${(res.queriesUsed ?? []).join(' | ')}`,
        `Engines: ${stats}${res.cacheHit ? ' — cache hit' : ''} — ${res.tookMs}ms`,
        ...(res.warnings ?? []).map((w) => `WARNING: ${w}`),
        includeDomains.length > 0 ? `Include domains: ${includeDomains.join(', ')}` : '',
        params.exclude_domains?.length ? `Excluded domains: ${params.exclude_domains.join(', ')}` : '',
        params.recency && params.recency !== 'any' ? `Recency: ${params.recency}` : '',
        '',
      ]
      if (res.results.length === 0) {
        lines.push('No results. Consider retrying with different keyword variants or engines.')
      }
      res.results.forEach((r, i) => {
        const usable = r.content && countWords(r.content) >= 300
        lines.push(
          `${i + 1}. [${r.score}] ${r.title} (${r.domain}${r.published ? `, published ${r.published}` : ''})`,
          `   ${r.url}`,
          `   engines: ${r.engines.join(', ')}`,
          usable
            ? `   [content: ${countWords(r.content)} words — usable directly, no fetch needed]\n${excerptForTool(r.content).split('\n').map((l) => `   ${l}`).join('\n')}`
            : '',
          r.snippet ? `   ${r.snippet.slice(0, 240)}` : '',
          '',
        )
      })
      return {
        content: [text(lines.join('\n').trim())],
        details: { engineStats: res.engineStats, cacheHit: Boolean(res.cacheHit), tookMs: res.tookMs, layer: res.layer, tier: res.tier },
      }
    },
  })

  /* --------------------------- fetch_page (reader) --------------------------- */

  pi.registerTool({
    name: 'fetch_page',
    label: 'Fetch Page (Reader Mode)',
    description:
      'Fetch a URL and extract its readable content as Markdown. Uses the Jina Reader service (keyless) with a local heuristic extractor as fallback. Returns content (truncated to max_chars), word count, fetch method and timestamp. Results are cached for 24h.',
    promptSnippet: 'Fetch a web page and extract readable content',
    promptGuidelines: [
      'fetch_page: use it to read full pages when search snippets are not enough — it returns clean article text.',
      'fetch_page focus: pass the `focus` parameter (your question or the specific thing you need) to keep only relevant paragraphs — typically drops 80-95% of tokens. Always pass focus when you only need part of a page.',
    ],
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Absolute http(s) URL to fetch' },
        max_chars: { type: 'integer', minimum: 1000, maximum: 60000, default: 12000, description: 'Max content chars' },
        focus: { type: 'string', description: 'Optional focus terms: when provided, only paragraphs relevant to these terms are returned (dynamic filtering) — typically drops 80-95% of tokens. Pass the research question or the specific thing you need from the page.' },
      },
      required: ['url'],
    },
    async execute(_toolCallId, params, signal, onUpdate) {
      const progress = onProgress(onUpdate)
      const started = Date.now()
      progress(`fetch_page: ${params.url}`)
      let page
      try {
        page = await runFetchPage(params.url, params.focus, signal, { maxChars: params.max_chars ?? 12000 })
      } catch (err) {
        audit.write({
          type: 'fetch',
          ts: new Date().toISOString(),
          url: params.url,
          domain: hostOf(params.url),
          via: 'failed',
          ok: false,
          error: err instanceof Error ? err.message.slice(0, 200) : String(err),
          cacheHit: false,
          tookMs: Date.now() - started,
        })
        throw err
      }
      audit.write({
        type: 'fetch',
        ts: new Date().toISOString(),
        url: page.url,
        domain: hostOf(page.url),
        via: page.via,
        ok: true,
        wordCount: page.word_count,
        bytes: page.content.length,
        cacheHit: Boolean(page.cacheHit),
        tookMs: Date.now() - started,
      })
      return {
        content: [text([
          `URL: ${page.url}`,
          `via: ${page.via} — fetched: ${page.fetched_at} — words: ${page.word_count}${page.truncated ? ' — [truncated]' : ''}`,
          params.focus ? (page.focusMiss
            ? '[dynamic filtering: focus matched nothing — retry without focus to read the whole page]'
            : `[dynamic filtering: kept ${page.word_count} words relevant to focus]`) : '',
          '',
          page.content,
        ].filter((l, i) => l !== '' || i === 3).join('\n'))],
        details: { via: page.via, fetchedAt: page.fetched_at, wordCount: page.word_count, focusMiss: Boolean(page.focusMiss) },
      }
    },
  })

  /* ------------------------ research_parallel (pi child processes) ------------------------ */

  pi.registerTool({
    name: 'research_parallel',
    label: 'Parallel Multi-Agent Research',
    description:
      'Multi-agent research (Grok Deep Research pattern): decompose the question into 2-4 subtasks, then each subtask runs as an independent pi child process (own context window, own search budget) with fused_search + fetch_page. Subtasks run in parallel (bounded by max_parallel), and the results are returned as per-subtask reports for you to synthesize and cross-check. Use for questions that have clearly separable angles (e.g. compare X vs Y, investigate components of a system, gather evidence from different source types). For a single-angle deep dive, use deep_research instead.',
    promptSnippet: 'Run parallel multi-agent research with independent subtask agents',
    promptGuidelines: [
      'research_parallel: decompose the question into 2-4 well-separated subtasks yourself and pass them in `subtasks` — the quality of the decomposition determines the quality of the result. Each subtask gets an independent agent with its own search budget.',
      'research_parallel citations: synthesize the subtask reports with citations; require >=2 independent domains for key claims, mark single-source claims as unverified.',
      'research_parallel: prefer it over deep_research when the question has separable angles (comparisons, multi-component systems, conflicting viewpoints); prefer deep_research for a single deep dive.',
    ],
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The overall research question' },
        subtasks: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 4, description: '2-4 well-separated subtasks; each runs as an independent agent' },
        max_parallel: { type: 'integer', minimum: 1, maximum: 4, default: 2, description: 'Concurrent subtask agents (default 2; 3-4 is faster but hits search rate limits sooner)' },
        per_subtask_sources: { type: 'integer', minimum: 1, maximum: 8, default: 3, description: 'Max sources each subtask agent may cite' },
        timeout_seconds: { type: 'integer', minimum: 30, maximum: 600, default: 150, description: 'Per-subtask timeout; killed on expiry' },
      },
      required: ['query', 'subtasks'],
    },
    async execute(_toolCallId, params, signal, onUpdate) {
      const progress = onProgress(onUpdate)
      if (!Array.isArray(params.subtasks) || params.subtasks.length < 2) {
        throw new Error('research_parallel requires at least 2 subtasks (pass 2-4 well-separated angles)')
      }
      const started = Date.now()
      const res = await runParallelResearch({
        query: params.query,
        subtasks: params.subtasks.slice(0, 4),
        maxParallel: params.max_parallel,
        perSubtaskSources: params.per_subtask_sources,
        timeoutSeconds: params.timeout_seconds,
        signal,
        progress,
      })
      audit.write({
        type: 'research',
        ts: new Date().toISOString(),
        query: params.query,
        mode: 'parallel',
        rounds: 1,
        stopReason: `${res.okCount}/${res.results.length} subtasks ok`,
        sources: res.sourceUrls.length,
        domains: res.domains.length,
        uncovered: [],
        tookMs: Date.now() - started,
        subtasks: res.results.length,
        successfulSubtasks: res.okCount,
        turns: res.totalTurns,
      })
      const lines = [
        `Parallel research: "${res.query}" — ${res.okCount}/${res.results.length} subtasks completed in ${(res.totalMs / 1000).toFixed(1)}s`,
        '',
      ]
      res.results.forEach((r, i) => {
        lines.push(`### Subtask ${i + 1}: ${r.subtask}`)
        if (!r.ok) {
          lines.push(`[FAILED in ${(r.tookMs / 1000).toFixed(1)}s: ${r.error}]`)
        } else {
          lines.push(`(${(r.tookMs / 1000).toFixed(1)}s, ${r.turns} turns${r.attempts > 1 ? `, ${r.attempts} attempts` : ''}, ${r.sources.length} cited sources)`)
        }
        lines.push(r.result)
        lines.push('')
      })
      lines.push('Synthesize these reports into the final answer, with cross-source verification.')
      return {
        content: [text(lines.join('\n').trim())],
        details: {
          results: res.results.map((r) => ({
            subtask: r.subtask, ok: r.ok, tookMs: r.tookMs, turns: r.turns,
            attempts: r.attempts, sources: r.sources, domains: r.domains, error: r.error,
          })),
          sourceUrls: res.sourceUrls,
          domains: res.domains,
        },
      }
    },
  })

  /* --------------------------- deep_research (evidence loop) --------------------------- */

  pi.registerTool({
    name: 'deep_research',
    label: 'Deep Research',
    description:
      'Multi-round research loop for questions needing depth and multiple sources. Each round: fused search -> fetch top unseen pages -> extract query/goal-relevant evidence -> evidence coverage check -> follow-up queries. Query coverage is based only on selected excerpts; goal terms require >=2 independent domains. Time-sensitive goals additionally require recent dated, claim-aligned evidence. The loop does not perform an LLM semantic goal check and never claims that word coverage alone proves the goal. `corroboratedBy` is conservative claim-segment alignment using shared factual anchors, not proof.\n\nMode auto runs up to max_rounds. Mode step runs one round and returns gaps + suggested queries. Cite source URLs and independently verify key claims; treat single-source claims as unverified.',
    promptSnippet: 'Run a multi-round deep research loop with coverage checking and corroboration',
    promptGuidelines: [
      'deep_research: use it for questions that need depth and multiple independent sources — it iterates search+fetch rounds until coverage, then reports per-source excerpts with corroboration.',
      'deep_research citations: every factual claim in your answer must cite source URL(s) from the research report; do not cite pages that are not in the report.',
      'deep_research corroboration: corroboratedBy is heuristic claim alignment, not proof. For key claims inspect the excerpts and require >=2 independent domains; mark single-source claims as unverified.',
      'deep_research source hierarchy: prefer primary sources (official documentation, papers, raw data, .gov/.edu) over secondary ones (news, blogs); note when a claim rests on a secondary source.',
      'deep_research freshness: for time-sensitive facts, state the access date (fetchedAt) and prefer recently fetched sources.',
      'deep_research step mode: when mode=step, the report lists uncovered terms and suggested queries — call deep_research again with those queries in `queries` to continue until coverage is reached.',
    ],
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The research question' },
        queries: { type: 'array', items: { type: 'string' }, description: 'Keyword variants for this round (step-mode continuation). If omitted, variants are derived from query.' },
        goal: { type: 'string', description: 'What the final answer must establish; drives search, excerpt selection, and multi-domain evidence coverage. Semantic goal satisfaction is left to the calling model.' },
        mode: { type: 'string', enum: ['auto', 'step'], default: 'auto' },
        max_rounds: { type: 'integer', minimum: 1, maximum: 5, default: 3 },
        max_sources: { type: 'integer', minimum: 2, maximum: 15, default: 8 },
        per_round: { type: 'integer', minimum: 2, maximum: 6, default: 4, description: 'Pages fetched per round' },
        engines: { type: 'array', items: { type: 'string', enum: ENGINE_ORDER }, description: 'Engine subset override (default: active layer\'s engines; run /web_change to switch layers)' },
        include_domains: { type: 'array', items: { type: 'string' }, description: 'Only research these domains (strict client-side filter)' },
        exclude_domains: { type: 'array', items: { type: 'string' }, description: 'Skip these domains during research' },
        recency: { type: 'string', enum: RECENCY_ENUM, description: 'Only recent results are favored' },
      },
      required: ['query'],
    },
    async execute(_toolCallId, params, signal, onUpdate) {
      const progress = onProgress(onUpdate)
      progress(`deep_research (${params.mode ?? 'auto'}): "${params.query}"`)
      const res = await runResearchLoop({
        query: params.query,
        queries: params.queries,
        goal: params.goal,
        mode: params.mode === 'step' ? 'step' : 'auto',
        maxRounds: params.max_rounds,
        maxSources: params.max_sources,
        perRound: params.per_round,
        engines: params.engines,
        includeDomains: params.include_domains,
        excludeDomains: params.exclude_domains,
        recency: params.recency,
        signal,
        progress,
      })
      audit.write({
        type: 'research',
        ts: new Date().toISOString(),
        query: params.query,
        mode: res.mode,
        rounds: res.rounds,
        stopReason: res.stopReason,
        sources: res.coverage.totalSources,
        domains: res.coverage.distinctDomains,
        uncovered: [...res.coverage.uncoveredTerms, ...res.coverage.uncoveredGoalTerms],
        tookMs: res.tookMs,
      })

      const lines = [
        `Research report: "${res.query}"`,
        res.goal ? `Goal: ${res.goal}` : '',
        `Rounds: ${res.rounds} — stopped: ${res.stopReason} — sources: ${res.coverage.totalSources} — domains: ${res.coverage.distinctDomains} — ${res.tookMs}ms`,
        `Query evidence terms covered: ${res.coverage.coveredTerms.join(', ') || '(none)'}`,
        `Query evidence terms uncovered: ${res.coverage.uncoveredTerms.join(', ') || '(none)'}`,
        res.goal ? `Goal evidence terms (>=2 domains): ${res.coverage.coveredGoalTerms.join(', ') || '(none)'}` : '',
        res.goal ? `Goal evidence gaps: ${res.coverage.uncoveredGoalTerms.join(', ') || '(none)'}` : '',
        res.goal ? `Goal evidence covered: ${res.coverage.goalEvidenceCovered ? 'yes' : 'no'}; semantic goal check: not performed` : '',
        `Corroboration method: ${res.corroborationMethod}`,
        res.coverage.primaryDomains.length > 0 ? `Primary/authoritative domains: ${res.coverage.primaryDomains.join(', ')}` : '',
        '',
        'Sources:',
      ]
      res.sources.forEach((s, i) => {
        lines.push(
          `${i + 1}. ${s.title} — ${s.domain} [via ${s.via}, ${String(s.fetchedAt ?? '').slice(0, 10)}, ${s.wordCount} words]`,
          `   URL: ${s.url}`,
          s.corroboratedBy.length > 0
            ? `   claim-aligned domains (heuristic): ${s.corroboratedBy.join(', ')}`
            : '   claim-aligned domains: (none — single-source claim, treat as unverified)',
          s.excerpt ? `   Evidence excerpt used for coverage/alignment: ${s.excerpt}` : '',
          '',
        )
      })
      if (res.suggestedQueries.length > 0) {
        lines.push(`Suggested follow-up queries: ${res.suggestedQueries.join(' | ')}`)
      }
      if (params.mode === 'step') {
        lines.push('', 'STEP MODE: this was one round. Call deep_research again with the suggested queries (or your own) to continue until coverage is reached.')
      }
      return {
        content: [text(lines.join('\n').trim())],
        details: {
          coverage: res.coverage,
          sources: res.sources.map((s) => ({
            title: s.title, url: s.url, domain: s.domain, fetchedAt: s.fetchedAt,
            excerpt: s.excerpt, corroboratedBy: s.corroboratedBy,
            freshCorroboratedBy: s.freshCorroboratedBy ?? [],
          })),
          engineStats: res.engineStats,
          suggestedQueries: res.suggestedQueries,
        },
      }
    },
  })

  /* --------------------------- cache + audit admin --------------------------- */

  pi.registerCommand('search-cache', {
    description: 'Show or clear the search-boost caches (usage: /search-cache [stats|clear])',
    handler: async (args, ctx) => {
      const cmd = (args ?? '').trim().toLowerCase()
      const sizes = cacheSizes()
      const total = Object.values(sizes).reduce((a, b) => a + b, 0)
      if (cmd === 'clear') {
        clearAllCaches()
        ctx.ui.notify(`search-boost cache cleared (was ${total} entries)`, 'info')
        return
      }
      ctx.ui.notify(
        `search-boost cache (in-memory, this session): ${total} entries\n${Object.entries(sizes).map(([k, v]) => `${k}=${v}`).join(', ')}`,
        'info',
      )
    },
  })

  pi.registerCommand('search-audit', {
    description: 'Analyze the search-boost audit log (usage: /search-audit [stats|recent|failures|domains|clear])',
    handler: async (args, ctx) => {
      const cmd = (args ?? '').trim().toLowerCase().split(/\s+/)[0] || 'stats'
      const events = audit.readAll()
      if (cmd === 'clear') {
        audit.clear()
        ctx.ui.notify('search-boost audit log cleared', 'info')
        return
      }
      if (cmd === 'recent') {
        const n = Math.min(30, Math.max(1, parseInt((args ?? '').split(/\s+/)[1] ?? '10', 10) || 10))
        const recent = audit.readTail(n).reverse()
        const lines = recent.map((e) => {
          if (e.type === 'search') {
            return `[${e.ts.slice(11, 19)}] search "${e.query.slice(0, 60)}" -> ${e.results} results, engines: ${e.engines.join(',')}${Object.keys(e.engineErrors ?? {}).length ? ` ERRORS: ${JSON.stringify(e.engineErrors)}` : ''}, ${e.tookMs}ms`
          }
          if (e.type === 'fetch') {
            return `[${e.ts.slice(11, 19)}] fetch ${e.ok ? 'ok' : 'FAIL'} ${e.via} ${e.domain}${e.ok ? ` (${e.wordCount} words, ${e.tookMs}ms)` : `: ${e.error}`}`
          }
          if (e.type === 'xsearch') {
            return `[${e.ts.slice(11, 19)}] x_search ${e.subtype} "${(e.query ?? e.postId ?? '').slice(0, 60)}" -> ${e.results} results${e.error ? ` ERROR: ${e.error.slice(0, 80)}` : ''}, ${e.tookMs}ms${e.cacheHit ? ' (cache)' : ''}`
          }
          return `[${e.ts.slice(11, 19)}] research "${e.query.slice(0, 60)}" ${e.rounds}r ${e.stopReason} ${e.sources}s/${e.domains}d ${e.tookMs}ms`
        })
        ctx.ui.notify(`search-boost audit (last ${recent.length}):\n${lines.join('\n')}`, 'info')
        return
      }
      if (cmd === 'failures') {
        const fails = audit.readTail(200).filter((e) => e.type === 'fetch' && !e.ok)
        if (fails.length === 0) {
          ctx.ui.notify('no fetch failures recorded', 'info')
          return
        }
        const lines = fails.slice(-15).reverse().map((e) => `${e.domain} ${e.url.slice(0, 90)} -> ${e.error}`)
        ctx.ui.notify(`fetch failures (${fails.length} total, last ${lines.length}):\n${lines.join('\n')}`, 'info')
        return
      }
      if (cmd === 'domains') {
        const counts = new Map()
        for (const e of audit.readTail(400)) {
          if (e.type !== 'fetch') continue
          const c = counts.get(e.domain) ?? { ok: 0, fail: 0 }
          if (e.ok) c.ok++
          else c.fail++
          counts.set(e.domain, c)
        }
        const lines = [...counts.entries()]
          .sort((a, b) => b[1].ok + b[1].fail - (a[1].ok + a[1].fail))
          .slice(0, 20)
          .map(([d, c]) => `${d}: ${c.ok} ok / ${c.fail} fail`)
        ctx.ui.notify(`fetch by domain (${counts.size} domains):\n${lines.join('\n')}`, 'info')
        return
      }
      // stats
      const searches = events.filter((e) => e.type === 'search')
      const fetches = events.filter((e) => e.type === 'fetch')
      const research = events.filter((e) => e.type === 'research')
      const okFetches = fetches.filter((e) => e.ok)
      const failed = fetches.filter((e) => !e.ok)
      const viaCounts = new Map()
      for (const e of okFetches) viaCounts.set(e.via, (viaCounts.get(e.via) ?? 0) + 1)
      const avg = (arr) => (arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : 0)
      const tierCounts = new Map()
      const layerCounts = new Map()
      for (const e of searches) {
        if (e.tier) tierCounts.set(e.tier, (tierCounts.get(e.tier) ?? 0) + 1)
        if (e.layer) layerCounts.set(e.layer, (layerCounts.get(e.layer) ?? 0) + 1)
      }
      // tavily credit estimate: basic=1, advanced=2 (per query per variant);
      // only searches where tavily actually ran consume credits
      let creditEstimate = 0
      for (const e of searches) {
        if (!e.engines.includes('tavily')) continue
        const depth = e.tier === 'complex' ? 2 : 1
        creditEstimate += depth * Math.max(1, e.queriesUsed.length)
      }
      // duplicate-query detection (runtime anti-loop)
      const dupByQuery = new Map()
      for (const e of searches) {
        const q = e.query.toLowerCase().trim()
        dupByQuery.set(q, (dupByQuery.get(q) ?? 0) + 1)
      }
      const dupLines = [...dupByQuery.entries()]
        .filter(([, n]) => n > 1)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([q, n]) => `${n}x "${q.slice(0, 50)}"`)
      const words = okFetches.map((e) => e.wordCount ?? 0).filter((w) => w > 0)
      const shortPages = okFetches.filter((e) => (e.wordCount ?? 9999) < 80).length
      const errByDomain = new Map()
      for (const e of failed) errByDomain.set(e.domain, (errByDomain.get(e.domain) ?? 0) + 1)
      const topErrDomains = [...errByDomain.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)
      const engineErrorCounts = new Map()
      for (const e of searches) {
        for (const eng of Object.keys(e.engineErrors ?? {})) engineErrorCounts.set(eng, (engineErrorCounts.get(eng) ?? 0) + 1)
      }
      ctx.ui.notify(
        [
          `search-boost audit (${events.length} events)`,
          `searches: ${searches.length} | fetches: ${fetches.length} (${okFetches.length} ok, ${failed.length} fail = ${fetches.length ? Math.round((failed.length / fetches.length) * 100) : 0}%) | research runs: ${research.length}`,
          `fetch via: ${[...viaCounts.entries()].map(([v, n]) => `${v}=${n}`).join(', ')}`,
          `avg fetch: ${avg(okFetches.map((e) => e.tookMs))}ms | avg words/page: ${avg(words)} | short pages(<80w): ${shortPages}`,
          `engine errors: ${JSON.stringify(Object.fromEntries(engineErrorCounts))}`,
          `tiers: ${[...tierCounts.entries()].map(([t, n]) => `${t}=${n}`).join(', ') || '(no tier data)'} | layers: ${[...layerCounts.entries()].map(([l, n]) => `${l}=${n}`).join(', ') || '(no layer data)'} | tavily credits est: ~${creditEstimate} (free 1000/mo)`,
          dupLines.length > 0 ? `repeated queries (loop?): ${dupLines.join(' | ')}` : 'no repeated queries',
          topErrDomains.length ? `top failing domains: ${topErrDomains.map(([d, n]) => `${d}(${n})`).join(', ')}` : 'no failing domains',
          `file: ${auditFilePath()}`,
        ].join('\n'),
        'info',
      )
    },
  })

  /* ------------------------------ x_search ------------------------------ */

  pi.registerTool({
    name: 'x_search',
    label: 'X (Twitter) Search',
    description:
      'Search X/Twitter in real time (posts, users, threads). Keyword/semantic run as PARALLEL instant search: the xAI x_search hosted tool (grok login / XAI_API_KEY, results merged, deduped) alongside the fused multi-engine route (site-restricted to x.com). Works even with NO credentials — routes straight to multi-engine + oEmbed full-text enhancement. Four modes: keyword (X advanced syntax: from:user, since:YYYY-MM-DD, min_faves:N), semantic (natural language), user (structured profile + timeline via guest GraphQL), thread (full conversation by post id). Configure credentials with /x-login.',
    promptSnippet: 'Search X/Twitter posts, users, and threads via the xAI x_search API (direct, no subprocess)',
    promptGuidelines: [
      'x_search: type=keyword for real-time post search with X advanced syntax (from:user, since:/until:date, min_faves:N, lang:xx); type=semantic for natural-language relevance; type=user to get a structured account profile + recent timeline (followers, bio, posts with engagement); type=thread with a post id (or x.com/.../status/<id> URL) for the full conversation.',
      'x_search: keyword/semantic run x_search ∥ multi-engine in parallel and merge results (real-time posts + engine-indexed posts, deduped). user prefers guest GraphQL (structured); thread uses oEmbed.',
      'x_search works without any X credentials (multi-engine + oEmbed fallback); with grok login (/x-login) or XAI_API_KEY the hosted x_search tool runs in parallel for live in-app search results.',
      'Route X-specific questions (trends, sentiment, what people say on X, account info, thread reconstruction) to x_search; general web questions to fused_search.',
    ],
    parameters: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: X_MODES, description: 'Which X search mode: keyword (X advanced syntax), semantic (natural language), user (accounts), thread (conversation by post id)' },
        query: { type: 'string', description: 'Search query (keyword: X advanced syntax; semantic: natural language)' },
        username: { type: 'string', description: 'Username/handle to search (type=user), or from: target for keyword' },
        post_id: { type: 'string', description: 'X post/status id or x.com/.../status/<id> URL (type=thread)' },
        max_results: { type: 'integer', minimum: 1, maximum: 10, default: 5, description: 'Max results' },
        from_date: { type: 'string', description: 'Date range start (ISO8601 YYYY-MM-DD), keyword/semantic' },
        to_date: { type: 'string', description: 'Date range end (ISO8601 YYYY-MM-DD), keyword/semantic' },
        allowed_x_handles: { type: 'array', items: { type: 'string' }, description: 'Only consider posts from these handles (max 20)' },
        excluded_x_handles: { type: 'array', items: { type: 'string' }, description: 'Exclude posts from these handles (max 20; not with allowed_x_handles)' },
        model: { type: 'string', description: 'Driving model (default grok-4.6)' },
        reasoning_effort: { type: 'string', enum: ['minimal', 'low', 'medium', 'high', 'xhigh'], description: 'Reasoning effort (default low = fast; results identical, latency much lower)' },
      },
      required: ['type'],
    },
    async execute(_toolCallId, params, signal, onUpdate) {
      const progress = onProgress(onUpdate)
      const started = Date.now()
      const kind = X_MODES.includes(params.type) ? params.type : 'keyword'
      const subj = kind === 'thread' ? params.post_id : params.query ?? params.username
      const evt = {
        type: 'xsearch',
        ts: new Date().toISOString(),
        subtype: kind,
        query: kind === 'thread' ? undefined : subj,
        postId: kind === 'thread' ? params.post_id : undefined,
        results: 0,
        cacheHit: false,
        tookMs: 0,
      }
      if (!subj) {
        evt.error = kind === 'thread' ? 'post_id required' : 'query or username required'
        evt.tookMs = Date.now() - started
        audit.write(evt)
        return { content: [text(`x_search ${kind} failed: ${evt.error}`)], details: { error: evt.error } }
      }
      if (params.allowed_x_handles?.length && params.excluded_x_handles?.length) {
        return {
          content: [text('x_search failed: allowed_x_handles and excluded_x_handles are mutually exclusive — pass only one')],
          details: { error: 'mutually_exclusive_handles' },
        }
      }
      progress(`x_search: ${kind} "${subj}" — hosted x_search ∥ multi-engine…`)
      try {
        const out = await runXSearch({ ...params, type: kind }, { signal })
        evt.tookMs = Date.now() - started
        evt.results = out.results
        evt.cacheHit = Boolean(out.cacheHit)
        evt.credential = out.credential
        if (out.via === 'error') {
          evt.error = out.error
          audit.write(evt)
          return { content: [text(`x_search ${kind} failed: ${out.error}`)], details: { error: out.error } }
        }
        audit.write(evt)
        const body = renderItems(out.items ?? [])
        const header = out.cacheHit
          ? `X search: ${kind} "${subj}" — CACHE HIT (${evt.tookMs}ms)`
          : out.via.startsWith('fallback:')
            ? `X search: ${kind} "${subj}" — FALLBACK (via ${out.via.slice('fallback:'.length)}) ${out.results} result(s) in ${evt.tookMs}ms\n(${out.note ?? ''})`
            : `X search: ${kind} "${subj}" — ${out.results} result(s) in ${evt.tookMs}ms (${out.credential})`
        return {
          content: [text(`${header}\n\n${body}`)],
          details: {
            results: out.results,
            tookMs: evt.tookMs,
            credential: out.credential,
            cacheHit: Boolean(out.cacheHit),
            xResults: out.xResults,
            engineResults: out.engineResults,
          },
        }
      } catch (err) {
        evt.tookMs = Date.now() - started
        evt.error = err instanceof Error ? err.message.slice(0, 500) : String(err)
        audit.write(evt)
        return { content: [text(`x_search ${kind} failed: ${evt.error}`)], details: { error: evt.error } }
      }
    },
  })

  function renderItems(items) {
    return items
      .map((it) => {
        if (Array.isArray(it.recent_posts)) {
          const posts = it.recent_posts.slice(0, 3)
          return `${it.name} (@${it.username}) — followers ${it.followers ?? '?'}, verified ${it.verified ?? false}\n  bio: ${it.bio ?? ''}\n  recent: ${posts.map((p) => `${p.text}`.slice(0, 80)).join(' | ') || '(none)'}`
        }
        return `${it.author ? it.author + (it.username ? ` (@${it.username})` : '') + ': ' : ''}${it.text || it.url}`
      })
      .join('\n')
  }

  /* ------------------------------ /x-login /x-logout /web_change ------------------------------ */

  pi.registerCommand('x-login', {
    description:
      'Import xAI credentials for x_search: /x-login (from your grok login), /x-login -k <XAI_API_KEY>, /x-login status. No grok subprocess needed afterwards.',
    handler: async (args, ctx) => {
      const cmd = (args ?? '').trim()
      try {
        if (cmd === '') {
          const imported = xAuthCommands.importGrok()
          const claims = jwtTier(imported.key ?? '')
          ctx.ui.notify(
            `x-login: imported grok session → ${xAuthCommands.path()}\nemail: ${imported.email ?? '?'} | tier: ${tierName(claims?.tier)} | expires: ${claims?.exp ? new Date(claims.exp * 1000).toISOString() : '?'}`,
            'info',
          )
          return
        }
        if (cmd === 'status') {
          const st = xAuthCommands.status()
          ctx.ui.notify(`x-login status: ${st.source} — ${st.detail}\n(local file: ${xAuthCommands.path()})`, 'info')
          return
        }
        if (/^(-k|--key)(\s|$)/.test(cmd)) {
          const key = cmd.replace(/^(-k|--key)\s*/, '').trim()
          if (!key) {
            ctx.ui.notify('x-login: missing API key after -k / --key', 'error')
            return
          }
          xAuthCommands.setApiKey(key)
          ctx.ui.notify(`x-login: API key saved → ${xAuthCommands.path()} (public api.x.ai will be used for x_search)`, 'info')
          return
        }
        ctx.ui.notify('usage: /x-login | /x-login -k <XAI_API_KEY> | /x-login status', 'info')
      } catch (err) {
        ctx.ui.notify(`x-login failed: ${err instanceof Error ? err.message : String(err)}`, 'error')
      }
    },
  })

  pi.registerCommand('x-logout', {
    description:
      'Remove the local xAI credentials: the official hosted x_search path is disabled and x_search falls back to the multi-engine / guest-GraphQL / oEmbed chain. grok CLI\'s own login is untouched. Usage: /x-logout',
    handler: async (_args, ctx) => {
      const removed = xAuthCommands.logout()
      ctx.ui.notify(
        removed
          ? 'x-logout: local credentials removed — x_search now uses the multi-engine / guest-GraphQL / oEmbed fallback chain only.\nRun /x-login to re-enable the official hosted x_search path. (grok CLI\'s own login is untouched.)'
          : 'x-logout: no local credentials found — x_search is already on the fallback chain. Run /x-login to enable the official path.',
        'info',
      )
    },
  })

  pi.registerCommand('web_change', {
    description: 'Switch the search layer: free (keyless bing/ddg/yahoo/exa-free) vs api (plus keyed tavily/brave/exa). Usage: /web_change [free|api|show]',
    handler: async (args, ctx) => {
      const cmd = (args ?? '').trim().toLowerCase()
      const current = getLayer()
      if (cmd === 'free' || cmd === 'api') {
        switchLayer(cmd)
        ctx.ui.notify(`web layer: ${current} → ${cmd} — ${LAYER_LABELS[cmd]}. Future fused_search calls use this layer.`, 'info')
        return
      }
      if (cmd === 'show' || cmd === '') {
        const info = describeLayer()
        const hints = []
        if (info.layer === 'api' && info.keyedEngines.enabled === 0) {
          hints.push('no API keys configured — the api layer currently runs the keyless engines only; add keys with `search-boost config keys`, or run /web_change free')
        } else if (info.layer === 'api' && info.keyedEngines.enabled < info.keyedEngines.total) {
          hints.push(`keyed engines: ${info.keyedEngines.enabledNames.join(', ')} — configure all three (tavily, brave, exa) via \`search-boost config keys\` for the fullest fusion`)
        }
        if (info.layer === 'free') {
          hints.push('keyless mode — run /web_change api after configuring keys (`search-boost config keys`) to add tavily/brave/exa to the fusion')
        }
        ctx.ui.notify(
          [
            `web layer: ${info.layer} — ${info.label}`,
            `engines available in this layer: ${info.engines.join(', ') || '(none)'}`,
            `x_search: ${info.xOfficial ? 'official path' : 'fallback chain'} (${info.xSource})`,
            ...hints,
          ].join('\n'),
          'info',
        )
        return
      }
      ctx.ui.notify('usage: /web_change [free|api|show]', 'info')
    },
  })
}
