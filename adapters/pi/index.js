import { FETCH_DESCRIPTION, X_DESCRIPTION } from '../../lib/search/tool-descriptions.js'
import { FUSED_DESCRIPTION, FUSED_ROUTING_PROPERTIES } from '../../lib/search/routing.js'
// pi host adapter — pi coding agent extension.
//
// Loaded by pi via package.json `pi.extensions` (pi install npm:search-boost),
// by `pi -e <this file>`, or through the ~/.pi/agent/extensions shim written by
// `search-boost install -t pi`. Registers the search tools (fused_search,
// fetch_page, search-parallel-subagent, x_search), the TUI commands
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
  formatRuntimeCapabilities,
  excerptForTool,
  getLayer,
  hostOf,
  jwtTier,
  runAdaptiveSearch,
  runFetchPage,
  runFused,
  runXSearch,
  switchLayer,
  tierName,
  xAuthCommands,
} from '../../lib/runtime.mjs'
import { normalizeTasks, runSearchParallel } from './search-parallel-subagent.js'
import {
  ADAPTIVE_DESCRIPTION,
  ADAPTIVE_PROMPT_GUIDELINES,
  ADAPTIVE_QUESTIONS_PARAM,
  ADAPTIVE_TOOL_NAME,
  adaptiveTextContent,
} from '../../lib/search/adaptive/describe.js'

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
    const base = event.systemPrompt
      .replace(/\n?<search_capabilities>[\s\S]*?<\/search_capabilities>/g, '')
      .replace(/\n?\[search budget\][^\n]*/g, '')
    const policy = rules && !base.includes('<search_balance>') ? `\n${rules}` : ''
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
      ? `\n[search budget] Recent audit sample: ${todayCount} direct searches dated today (UTC), from at most 400 events; not an account quota or complete usage count. Reuse sufficient evidence and follow the task budget.`
      : ''
    return { systemPrompt: `${base}${policy}${budgetNote}\n${formatRuntimeCapabilities()}` }
  })

  const onProgress = (onUpdate) => (msg) => {
    onUpdate?.({ content: [text(msg)] })
  }

  /* ------------------------------ fused_search ------------------------------ */

  pi.registerTool({
    name: 'fused_search',
    label: 'Fused Web Search',
    description: FUSED_DESCRIPTION,
    promptSnippet: 'Search the web across multiple engines in parallel with keyword variants',
    promptGuidelines: ['Use the evidence returned by this search before starting another round; inspect warnings rather than treating an empty result as proof of absence.'],
    parameters: {
      type: 'object',
      properties: {
        ...FUSED_ROUTING_PROPERTIES,
        query: { type: 'string', description: 'The question or topic to search for' },
        queries: { type: 'array', items: { type: 'string' }, description: 'Optional distinct query angles; complexity caps total variants at 1/2/3, including query and OR alternatives' },
        max_results: { type: 'integer', minimum: 1, maximum: 20, default: 10, description: 'Max fused results' },
        site: { type: 'string', description: 'Deprecated: restrict to a domain (alias for include_domains)' },
        include_domains: { type: 'array', items: { type: 'string' }, description: 'Only keep results from these domains, including subdomains; provider hints plus a client-side hard filter' },
        exclude_domains: { type: 'array', items: { type: 'string' }, description: 'Drop results from these domains, e.g. exclude wikipedia.org when a term is ambiguous' },
        recency: { type: 'string', enum: RECENCY_ENUM, description: 'Recency window: results with a publish date outside the window decay exponentially (half-life scaled to window); undated results are mildly demoted (default any)' },
        min_score: { type: 'number', minimum: 0, maximum: 5, default: 0, description: 'Drop results below this fused score floor (Grok\'s min_score, default 0 = off)' },
        depth: { type: 'string', enum: ['basic', 'advanced'], description: 'Tavily search depth: basic or advanced. Advanced may return extracted content; fetch the source only when the returned text is insufficient' },
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
        complexity: params.complexity ?? 'medium',
        enginePool: params.engine_pool, ranking: params.ranking, engineWeights: params.engine_weights, community: params.community,
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
        `Pool: ${res.enginePool}; ranking: ${res.ranking}; enginesUsed: ${res.enginesUsed.join(', ')}; effectiveWeights: ${JSON.stringify(res.effectiveWeights)}; communityUsed: ${res.communityUsed}`,
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
            ? `   [content: ${countWords(r.content)} words — engine-extracted material; check relevance and completeness]\n${excerptForTool(r.content).split('\n').map((l) => `   ${l}`).join('\n')}`
            : '',
          r.snippet ? `   ${r.snippet.slice(0, 240)}` : '',
          '',
        )
      })
      return {
        content: [text(lines.join('\n').trim())],
        details: { enginesUsed: res.enginesUsed, effectiveWeights: res.effectiveWeights, communityUsed: res.communityUsed, warnings: res.warnings, enginePool: res.enginePool, ranking: res.ranking, engineStats: res.engineStats, cacheHit: Boolean(res.cacheHit), tookMs: res.tookMs, layer: res.layer, tier: res.tier },
      }
    },
  })

  /* --------------------------- fetch_page (reader) --------------------------- */

  pi.registerTool({
    name: 'fetch_page',
    label: 'Fetch Page (Reader Mode)',
    description: FETCH_DESCRIPTION,
    promptSnippet: 'Read a known public URL, optionally focusing on matching paragraphs',
    promptGuidelines: ['Respect fetch failures and policy limitations; do not work around them by using an unguarded network tool.'],
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Absolute http(s) URL to fetch' },
        focus: { type: 'string', description: 'Optional focus terms: when provided, only paragraphs relevant to these terms are returned. Pass the research question or the specific thing you need from the page. Omit to keep the full preprocessed body.' },
      },
      required: ['url'],
    },
    async execute(_toolCallId, params, signal, onUpdate) {
      const progress = onProgress(onUpdate)
      const started = Date.now()
      progress(`fetch_page: ${params.url}`)
      let page
      try {
        page = await runFetchPage(params.url, params.focus, signal)
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
          page.limitation ? `WARNING: ${page.limitation.kind}: ${page.limitation.message}` : '',
          '',
          page.content,
        ].filter((l, i) => l !== '' || i === 3).join('\n'))],
        details: { via: page.via, fetchedAt: page.fetched_at, wordCount: page.word_count, focusMiss: Boolean(page.focusMiss), ...(page.limitation ? { limitation: page.limitation } : {}) },
      }
    },
  })

  /* --------------------------- adaptive_search (Jev) --------------------------- */

  pi.registerTool({
    name: ADAPTIVE_TOOL_NAME,
    label: 'Adaptive Search (Jev)',
    description: ADAPTIVE_DESCRIPTION,
    promptSnippet: 'Gather per-question coverage evidence for 1–6 independent questions (Jev-driven)',
    promptGuidelines: ADAPTIVE_PROMPT_GUIDELINES,
    parameters: {
      type: 'object',
      properties: {
        questions: {
          type: 'array',
          minItems: 1,
          maxItems: 6,
          items: { type: 'string', minLength: 1, maxLength: 400 },
          description: ADAPTIVE_QUESTIONS_PARAM,
        },
      },
      required: ['questions'],
    },
    async execute(_toolCallId, params, signal, onUpdate) {
      const progress = onProgress(onUpdate)
      const started = Date.now()
      const questions = Array.isArray(params?.questions) ? params.questions : []
      progress(`adaptive_search: ${questions.length} question(s) — planning engines, judging per question…`)
      const res = await runAdaptiveSearch({ questions }, {
        signal,
        host: 'pi',
        audit,
        onProgress: (message) => progress(`adaptive_search: ${message}`),
      })
      const domains = new Set()
      for (const q of res.questions) for (const item of q.evidence ?? []) if (item.domain) domains.add(item.domain)
      audit.write({
        type: 'research',
        ts: new Date().toISOString(),
        query: `[${questions.length} adaptive question(s); text omitted]`,
        mode: ADAPTIVE_TOOL_NAME,
        rounds: res.rounds,
        stopReason: res.stopReason,
        sources: res.evidence?.total ?? 0,
        domains: domains.size,
        uncovered: (res.uncovered ?? []).map((entry) => entry.id),
        tookMs: Date.now() - started,
        subtasks: res.questions.length,
        successfulSubtasks: res.questions.filter((q) => q.status === 'covered').length,
      })
      return {
        content: adaptiveTextContent(res),
        details: res,
      }
    },
  })

  /* ----------------- search-parallel-subagent (pi child processes) ----------------- */

  pi.registerTool({
    name: 'search-parallel-subagent',
    label: 'Search Parallel Subagent',
    description: 'Run authorized isolated Pi searcher or summarizer children. Use {agent, task} for one child or {tasks:[{agent,task},...]} for a concurrent wave. Searchers have fused_search/fetch_page; summarizers have no tools. Returns each child report with completion/failure status. The caller chooses the wave size; this runner has no concurrency cap. Use direct search for ordinary lookups.',
    promptSnippet: 'Run a bounded research task or a wave of authorized searcher/summarizer children',
    promptGuidelines: [
      'The /fast-parallel and /complex-parallel templates own the multi-wave workflow; do not infer permission to delegate from tool availability.',
      'Assess source independence and quality, not just domain counts. Identify single-source claims without automatically rejecting an authoritative primary source.',
    ],
    parameters: {
      type: 'object',
      properties: {
        agent: { type: 'string', enum: ['searcher', 'summarizer'], description: 'Single-mode agent' },
        task: { type: 'string', description: 'Single-mode task for that agent' },
        tasks: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              agent: { type: 'string', enum: ['searcher', 'summarizer'] },
              task: { type: 'string' },
            },
            required: ['agent', 'task'],
          },
          description: 'Parallel wave — all items run concurrently; you choose how many',
        },
      },
    },
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const progress = onProgress(onUpdate)
      const tasks = normalizeTasks(params)
      const started = Date.now()
      const dispatch = {
        model: ctx?.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
        thinkingLevel: ctx?.thinkingLevel,
      }
      const res = await runSearchParallel({ tasks, signal, progress, dispatch })
      audit.write({
        type: 'research',
        ts: new Date().toISOString(),
        query: tasks.map((t) => t.task).join(' | ').slice(0, 240),
        mode: 'search-parallel-subagent',
        rounds: 1,
        stopReason: `${res.okCount}/${res.results.length} tasks ok`,
        sources: res.sourceUrls.length,
        domains: res.domains.length,
        uncovered: [],
        tookMs: Date.now() - started,
        subtasks: res.results.length,
        successfulSubtasks: res.okCount,
        turns: res.totalTurns,
        agents: [...new Set(tasks.map((t) => t.agent))],
      })
      const lines = [
        `search-parallel-subagent: ${res.okCount}/${res.results.length} tasks completed in ${(res.totalMs / 1000).toFixed(1)}s`,
        '',
      ]
      res.results.forEach((r, i) => {
        lines.push(`### ${i + 1}. ${r.agent}: ${r.task}`)
        if (!r.ok) {
          lines.push(`[FAILED in ${(r.tookMs / 1000).toFixed(1)}s: ${r.error}]`)
        } else {
          lines.push(`(${(r.tookMs / 1000).toFixed(1)}s, ${r.turns} turns${r.attempts > 1 ? `, ${r.attempts} attempts` : ''}, ${r.sources.length} cited sources)`)
        }
        lines.push(r.result)
        if (r.truncated) lines.push('[report truncated; do not treat missing text as evidence]')
        lines.push('')
      })
      return {
        content: [text(lines.join('\n').trim())],
        details: {
          results: res.results.map((r) => ({
            agent: r.agent, task: r.task, ok: r.ok, status: r.status, truncated: r.truncated, tookMs: r.tookMs, turns: r.turns,
            attempts: r.attempts, sources: r.sources, domains: r.domains, error: r.error,
          })),
          sourceUrls: res.sourceUrls,
          domains: res.domains,
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
          return `[${e.ts.slice(11, 19)}] research "${e.query.slice(0, 60)}" r${e.round ?? e.rounds ?? '?'} ${e.sources}s ${e.tookMs}ms`
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
    description: X_DESCRIPTION,
    promptSnippet: 'Retrieve available X posts, account material or thread material',
    promptGuidelines: ['A retrieved sample or incomplete thread does not establish overall sentiment, completeness or real-time availability.'],
    parameters: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: X_MODES, description: 'Which X search mode: keyword (X advanced syntax), semantic (natural language), user (accounts), thread (conversation by post id)' },
        query: { type: 'string', description: 'Search query (keyword: X advanced syntax; semantic: natural language)' },
        username: { type: 'string', description: 'Username/handle to search (type=user), or from: target for keyword' },
        post_id: { type: 'string', description: 'X post/status id or x.com/.../status/<id> URL (type=thread)' },
        max_results: { type: 'integer', minimum: 1, maximum: 10, default: 5, description: 'Max results' },
        from_date: { type: 'string', description: 'Inclusive start date, YYYY-MM-DD (UTC); in user mode filters recent posts' },
        to_date: { type: 'string', description: 'Inclusive end date, YYYY-MM-DD (UTC); in user mode filters recent posts' },
        allowed_x_handles: { type: 'array', items: { type: 'string' }, description: 'Only consider posts from these handles (max 20)' },
        excluded_x_handles: { type: 'array', items: { type: 'string' }, description: 'Exclude posts from these handles (max 20; not with allowed_x_handles)' },
        model: { type: 'string', description: 'Driving model (default grok-4.6)' },
        reasoning_effort: { type: 'string', enum: ['minimal', 'low', 'medium', 'high', 'xhigh'], description: 'Reasoning effort for the hosted X model (default low); results and latency can differ' },
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
