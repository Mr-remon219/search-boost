import { ADAPTIVE_INPUT_SCHEMA } from '../../lib/search/adaptive/input.js'
import { FETCH_DESCRIPTION, X_DESCRIPTION } from '../../lib/search/tool-descriptions.js'
import { FUSED_DESCRIPTION, FUSED_ROUTING_PROPERTIES } from '../../lib/search/routing.js'
// DSH host adapter — DeepSeek Harness (Cordis) bundle plugin.
//
// Loaded via adapters/dsh/cordis.patch.yml (see package.json `dsh.bundle`):
// one row mounts this plugin, one repoints the `web` seam's searchProvider /
// fetchProvider at it, so the built-in `web_search` / `web_fetch` run on
// SearchBoost Core while keeping the native citation cards. Beside the
// providers we register fused_search / fetch_page / x_search /
// research_parallel / search_stats, the proactive-search policy section, a
// live status section, and the /web_change, /x-login, /x-logout commands.
//
// Everything search-related comes from lib/runtime.mjs. This file owns only
// DSH-specific glue: ctx wiring, JSON-schema parameters, presentation cards,
// lossless-JSON output, commands, and the system-prompt sections.

import { readFileSync } from 'node:fs'
import { renderResearchTemplate } from '../../lib/search/parallel-contract.mjs'
import { promptPath } from '../../agents/router.mjs'
import {
  ADAPTIVE_DESCRIPTION,
  ADAPTIVE_TOOL_NAME,
  adaptiveTextContent,
} from '../../lib/search/adaptive/describe.js'
import {
  ENGINE_ORDER,
  LAYER_LABELS,
  X_MODES,
  cacheSizes,
  cleanJsonValue,
  collectSearchStats,
  describeLayer,
  formatRuntimeCapabilities,
  getLayer,
  hostOf,
  isSsrfError,
  parallelResearch,
  runAdaptiveSearch,
  runFetchPage,
  runFused,
  runXSearch,
  switchLayer,
  xAuthAvailableSync,
  xAuthCommands,
} from '../../lib/runtime.mjs'

export const name = 'search-boost'
export const inject = ['web', 'tools', 'systemPrompt', 'timer', 'commands']

/** Provider id the `web` seam is repointed at (cordis.patch.yml). */
export const PROVIDER_ID = 'search-boost'

const LOG_PREFIX = '[search-boost/dsh]'

/** Host-level search policy (agents/dsh/policy.md) as a systemPrompt section. */
export function loadPolicySection() {
  let text = ''
  try {
    text = renderResearchTemplate(readFileSync(promptPath('dsh'), 'utf8')).trim()
  } catch (err) {
    console.error(`${LOG_PREFIX} policy load failed:`, err instanceof Error ? err.message : String(err))
  }
  return { name: 'search:policy', order: 115, text }
}

export function apply(ctx, config = {}) {
  const safe = (label, fn) => {
    try {
      fn()
    } catch (err) {
      console.error(`${LOG_PREFIX} ${label} registration failed:`, err instanceof Error ? err.message : String(err))
    }
  }
  // Registrations are kept alive for the process lifetime (bundle plugin).
  // NOTE: do NOT hand registration disposers to ctx.effect — the loader's
  // entry fiber commits right after apply() and would run every disposer,
  // silently UNREGISTERING providers/tools/commands/sections (empirically
  // reproduced in the DSH host). Built-in plugins drop the disposer too.
  safe('searchProvider', () => { if (config.searchProvider !== false) registerSearchProvider(ctx) })
  safe('fetchProvider', () => { if (config.fetchProvider !== false) registerFetchProvider(ctx) })
  safe('fused_search', () => { if (config.fusedSearch !== false) registerFusedSearchTool(ctx) })
  safe('fetch_page', () => { if (config.fetchPage !== false) registerFetchPageTool(ctx) })
  safe('adaptive_search', () => { if (config.adaptiveSearch !== false) registerAdaptiveSearchTool(ctx) })
  safe('x_search', () => { if (config.xSearch !== false) registerXSearchTool(ctx) })
  safe('research_parallel', () => { if (config.researchParallel !== false) registerParallelTool(ctx, config.researchProvider) })
  safe('search_stats', () => { if (config.searchStats !== false) registerStatsTool(ctx) })
  safe('policy section', () => { if (config.policy !== false) ctx.systemPrompt?.section(loadPolicySection()) })
  safe('search status section', () => registerStatusSection(ctx))
  safe('web_change command', () => registerWebChangeCommand(ctx))
  safe('x-login command', () => registerXLoginCommand(ctx))
  safe('x-logout command', () => registerXLogoutCommand(ctx))
}

// ---------- web seam providers (power the built-in web_search / web_fetch) ----------

function registerSearchProvider(ctx) {
  return ctx.web.registerSearchProvider({
    id: PROVIDER_ID,
    available: () => true,
    async search(request, signal) {
      const count = Math.max(1, Math.min(request.maxResults ?? 6, 10))
      // NOTE: do not add a deepseek-native engine here — ctx.web.search
      // resolves the configured seam (this provider after the patch) and
      // would recurse into itself.
      const result = await runFused({ query: request.query, maxResults: count, complexity: 'medium', signal })
      if (result.results.length === 0) {
        const errs = Object.entries(result.engineStats ?? {})
          .filter(([, v]) => v.errors > 0)
          .map(([k, v]) => `${k}: ${v.note ?? 'error'}`)
        throw new Error(`search-boost: no engine could answer (${errs.join('; ') || 'all engines unavailable'})`)
      }
      const summary = result.results.map((h, i) => {
        const when = h.published ? ` (${h.published})` : ''
        return `${i + 1}. ${h.title} — ${h.domain}${when}`
      }).join('\n')
      return {
        content: summary || `[search-boost] ${result.results.length} sources`,
        sources: result.results.map(sourceOf),
        truncated: Boolean(result.truncated),
      }
    },
  })
}

function registerFetchProvider(ctx) {
  return ctx.web.registerFetchProvider({
    id: PROVIDER_ID,
    available: () => true,
    async fetch(request, signal) {
      try {
        const page = await runFetchPage(request.url, undefined, signal)
        return {
          url: page.url,
          statusCode: 200,
          body: { kind: 'text', content: page.content },
          truncated: page.truncated,
        }
      } catch (err) {
        if (isSsrfError(err)) {
          throw new Error(`search-boost: ${err instanceof Error ? err.message : String(err)}`)
        }
        throw err
      }
    },
  })
}

function sourceOf(h) {
  return {
    url: h.url,
    ...(h.title ? { title: h.title } : {}),
    ...(h.snippet ? { snippet: h.snippet } : {}),
    ...(h.published ? { publishedAt: h.published } : {}),
  }
}

// ---------- systemPrompt section: live search status ----------

// One line the model sees in every assembly, so it natively knows the active
// layer and whether x_search uses the official path or the fallback chain.
// Implemented as a DYNAMIC section (text as a function evaluated per
// assembly): systemPrompt.variable() throws inside the real DSH host.
function registerStatusSection(ctx) {
  return ctx.systemPrompt?.section({
    name: 'search:status',
    order: 116, // right after the search policy section (115)
    text: () => formatRuntimeCapabilities(),
  })
}

// ---------- fused_search ----------

function registerFusedSearchTool(ctx) {
  return ctx.tools.register({
    name: 'fused_search',
    description: FUSED_DESCRIPTION,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ...FUSED_ROUTING_PROPERTIES,
        query: { type: 'string', description: 'The search query (supports site:, -site:, "phrase", A OR B).' },
        queries: { type: 'array', items: { type: 'string' }, description: 'Optional distinct query angles; complexity caps total variants at 1/2/3, including query and OR alternatives.' },
        max_results: { type: 'number', description: 'Max results to return (default 6, max 10).' },
        include_domains: { type: 'array', items: { type: 'string' }, description: 'Only keep results from these domains (subdomain match).' },
        exclude_domains: { type: 'array', items: { type: 'string' }, description: 'Drop results from these domains (subdomain match).' },
        recency: { type: 'string', enum: ['day', 'week', 'month', 'year'], description: 'Soft freshness preference; unknown dates are neutral.' },
        min_score: { type: 'number', minimum: 0, description: 'Minimum consensus-v2 quality score; old thresholds need recalibration (default 0).' },
        layer: { type: 'string', enum: ['free', 'api'], description: 'Deprecated compatibility alias: free→free, api→hybrid. engine_pool takes precedence.' },
      },
      required: ['query'],
    },
    presentCall: (args) => ({
      card: 'generic',
      title: `fused_search: "${String(args?.query ?? '').slice(0, 60)}"`,
      kind: 'search',
      rawInput: args?.query,
    }),
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          scoreVersion: { type: 'string' },
          query: { type: 'string' },
          queriesUsed: { type: 'array', items: { type: 'string' } },
          tier: { type: 'string' },
          depth: { type: 'string' },
          layer: { type: 'string' },
          enginePool: { type: 'string' }, ranking: { type: 'string' }, effectiveWeights: { type: 'object', additionalProperties: { type: 'number' } }, communityUsed: { type: 'boolean' },
          enginesRequested: { type: 'array', items: { type: 'string' } },
          enginesUsed: { type: 'array', items: { type: 'string' } },
          warnings: { type: 'array', items: { type: 'string' } },
          engineStats: { type: 'object' },
          results: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                title: { type: 'string' }, url: { type: 'string' }, domain: { type: 'string' },
                scoreVersion: { type: 'string' },
                rankScore: { type: 'number' }, evidenceScore: { type: 'number' }, consensusBoost: { type: 'number' },
                metadataDelta: { type: 'number' }, selectionScore: { type: 'number' },
                engineRanks: { type: 'object', additionalProperties: { type: 'number' } },
                contributions: { type: 'object', additionalProperties: { type: 'number' } },
                provenance: { type: 'array', items: { type: 'object' } }, dateStatus: { type: 'string' },
                snippet: { type: 'string' }, score: { type: 'number' }, engines: { type: 'array', items: { type: 'string' } },
                published: { type: ['string', 'null'] }, content: { type: 'string' }, kind: { type: 'string' }, username: { type: 'string' }, id: { type: 'string' },
              },
              required: ['title', 'url', 'domain'],
            },
          },
          tookMs: { type: 'number' },
          cacheHit: { type: 'boolean' },
          truncated: { type: 'boolean' },
        },
        required: ['query', 'results'],
      },
      render: (_args, value) => [{ type: 'text', text: renderFused(value) }],
      // lossless structured projection; presentResult narrows it into a native web card
      presentationMeta: (_args, value) => ({
        sources: (value.results ?? []).map(sourceOf),
        truncated: Boolean(value.truncated),
      }),
    },
    presentResult: (_args, result) => {
      const meta = result.meta
      if (!meta || !Array.isArray(meta.sources)) return undefined
      return {
        card: 'web',
        kind: 'search',
        title: `fused_search: ${meta.sources.length} sources`,
        sources: meta.sources,
        truncated: Boolean(meta.truncated),
      }
    },
    timeoutMs: 90000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      // DSH validates executed values as lossless JSON — strip stray undefined
      return cleanJsonValue(await runFused({
        query: args.query,
        queries: args.queries,
        engineList: args.engines,
        maxResults: Math.max(1, Math.min(args.max_results ?? 6, 10)),
        includeDomains: args.include_domains,
        excludeDomains: args.exclude_domains,
        recency: args.recency,
        complexity: args.complexity ?? 'medium',
        minScore: args.min_score ?? 0, enginePool: args.engine_pool, ranking: args.ranking, engineWeights: args.engine_weights, community: args.community,
        layer: args.layer ?? null,
        signal: exec?.signal,
      }))
    },
  })
}

function renderFused(value) {
  const lines = []
  lines.push(`**fused_search: "${value.query}"** — layer ${value.layer ?? 'api'}, tier ${value.tier}, ${value.results.length} hits, ${value.tookMs}ms${value.cacheHit ? ' (cache hit)' : ''}`)
  lines.push(`scoreVersion: ${value.scoreVersion}; engine_pool: ${value.enginePool}; ranking: ${value.ranking}; enginesUsed: ${(value.enginesUsed ?? []).join(', ')}; effectiveWeights: ${JSON.stringify(value.effectiveWeights ?? {})}; communityUsed: ${!!value.communityUsed}`)
  for (const [i, r] of value.results.entries()) {
    const eng = (r.engines ?? []).join('+')
    lines.push(`${i + 1}. [${r.score}] ${r.title} — ${r.domain} (${eng})${r.published ? `, ${r.published}` : ''}`)
    lines.push(`   ${r.url}`)
    if (r.snippet) lines.push(`   ${r.snippet.slice(0, 200)}`)
  }
  const errs = Object.entries(value.engineStats ?? {}).filter(([, v]) => v.errors > 0)
  if (errs.length > 0) {
    lines.push(`engine errors: ${errs.map(([k, v]) => `${k}(${v.errors}: ${v.note ?? ''})`).join(', ')}`)
  }
  for (const w of value.warnings ?? []) lines.push(`WARNING: ${w}`)
  return lines.join('\n')
}

// ---------- fetch_page ----------

function registerFetchPageTool(ctx) {
  return ctx.tools.register({
    name: 'fetch_page',
    description: FETCH_DESCRIPTION,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        url: { type: 'string', description: 'The http(s) URL to fetch.' },
        focus: { type: 'string', description: 'Optional topic to keep: only paragraphs containing these terms (plus context) are returned.' },
      },
      required: ['url'],
    },
    presentCall: (args) => ({
      card: 'generic',
      title: `fetch_page: ${hostOf(String(args?.url ?? '')) || String(args?.url ?? '').slice(0, 60)}`,
      kind: 'fetch',
      rawInput: args?.url,
    }),
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          url: { type: 'string' }, via: { type: 'string' }, fetched_at: { type: 'string' },
          word_count: { type: 'number' }, content: { type: 'string' }, truncated: { type: 'boolean' },
          limitation: { type: 'object', properties: { kind: { type: 'string' }, message: { type: 'string' } }, required: ['kind', 'message'] },
          focusMiss: { type: 'boolean' }, cacheHit: { type: 'boolean' }, tookMs: { type: 'number' },
        },
        required: ['url', 'via', 'content'],
      },
      render: (_args, value) => [{
        type: 'text',
        text: `**fetch_page: ${value.url}** — via ${value.via}, ${value.word_count} words, ${value.tookMs}ms${value.cacheHit ? ' (cache)' : ''}${value.truncated ? ' (truncated)' : ''}${value.focusMiss ? ' (focus matched nothing — retry without focus)' : ''}\n\n${value.content}${value.limitation ? `\nWARNING: ${value.limitation.kind}: ${value.limitation.message}` : ''}`,
      }],
      presentationMeta: (_args, value) => ({
        url: value.url,
        via: value.via,
        statusCode: 200, // both fetch paths throw on non-2xx
        truncated: Boolean(value.truncated),
      }),
    },
    presentResult: (_args, result) => {
      const meta = result.meta
      if (!meta || typeof meta.url !== 'string') return undefined
      return {
        card: 'web',
        kind: 'fetch',
        title: `fetch_page: ${meta.url}`,
        url: meta.url,
        statusCode: meta.statusCode ?? 200,
        truncated: Boolean(meta.truncated),
      }
    },
    timeoutMs: 60000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      return cleanJsonValue(await runFetchPage(args.url, args.focus, exec?.signal))
    },
  })
}

// ---------- adaptive_search (Jev) ----------

function registerAdaptiveSearchTool(ctx) {
  return ctx.tools.register({
    name: ADAPTIVE_TOOL_NAME,
    description: ADAPTIVE_DESCRIPTION,
    parameters: ADAPTIVE_INPUT_SCHEMA,
    presentCall: (args) => ({
      card: 'generic',
      title: args?.cursor ? 'adaptive_search: result page' : 'adaptive_search: target search',
      kind: 'search',
      rawInput: (args?.questions ?? []).join(' | ').slice(0, 60),
    }),
    output: {
      schema: {
        type: 'object',
        properties: {
          results: { type: 'array', items: { type: 'object', properties: { url: { type: 'string' }, title: { type: 'string' }, description: { type: 'string' } }, required: ['url', 'title', 'description'] } },
          totalResults: { type: 'number' }, nextCursor: { type: ['string', 'null'] }, expiresAt: { type: 'string' },
          coverageComplete: { type: 'boolean' }, stopReason: { type: 'string' }, warnings: { type: 'array', items: { type: 'string' } },
        },
        required: ['results', 'totalResults', 'nextCursor', 'expiresAt', 'coverageComplete', 'stopReason', 'warnings'],
      },
      render: (_args, value) => adaptiveTextContent(value),
      presentationMeta: (_args, value) => ({
        truncated: Boolean(value.nextCursor), total: value.totalResults,
        sources: value.results.map((item) => ({ url: item.url, title: item.title, snippet: item.description })),
      }),
    },
    presentResult: (_args, result) => {
      const meta = result.meta
      if (!meta) return undefined
      return {
        card: 'web',
        kind: 'search',
        title: `adaptive_search: ${meta.total} approved results`,
        sources: meta.sources ?? [],
        truncated: Boolean(meta.truncated),
      }
    },
    timeoutMs: 180000,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      return cleanJsonValue(await runAdaptiveSearch(args, { signal: exec?.signal, host: 'dsh' }))
    },
  })
}

// ---------- x_search ----------

function registerXSearchTool(ctx) {
  return ctx.tools.register({
    name: 'x_search',
    description: X_DESCRIPTION,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        type: { type: 'string', enum: X_MODES, description: 'Which X search mode: keyword (X advanced syntax), semantic (natural language), user (accounts), thread (conversation by post id).' },
        query: { type: 'string', description: 'The search query (keyword/semantic) or the target handle for user.' },
        username: { type: 'string', description: 'Target account for type=user.' },
        post_id: { type: 'string', description: 'Post id or x.com/.../status/<id> URL for type=thread.' },
        max_results: { type: 'number', description: 'Max results (default 5, max 10).' },
        from_date: { type: 'string', description: 'Inclusive start date, YYYY-MM-DD (UTC); user mode filters recent posts.' },
        to_date: { type: 'string', description: 'Inclusive end date, YYYY-MM-DD (UTC); user mode filters recent posts.' },
        allowed_x_handles: { type: 'array', items: { type: 'string' }, description: 'Author filter on all paths, including without login (max 20).' },
        excluded_x_handles: { type: 'array', items: { type: 'string' }, description: 'Author exclusion on all paths (max 20, mutually exclusive with allowed).' },
      },
      required: [],
    },
    presentCall: (args) => {
      const kind = X_MODES.includes(args?.type) ? args.type : 'keyword'
      const subj = args?.query ?? args?.username ?? args?.post_id ?? ''
      return { card: 'generic', title: `x_search ${kind}: "${String(subj).slice(0, 60)}"`, kind: 'search', rawInput: subj }
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          via: { type: 'string' },
          results: { type: 'number' },
          tookMs: { type: 'number' },
          credential: { type: 'string' },
          note: { type: 'string' },
          error: { type: 'string' },
          cacheHit: { type: 'boolean' },
          inFlight: { type: 'boolean' },
          xResults: { type: 'number' },
          engineResults: { type: 'number' },
          items: { type: 'array', items: { type: 'object', additionalProperties: true } },
        },
        required: ['via'],
      },
      render: (_args, value) => [{ type: 'text', text: renderX(value) }],
      presentationMeta: (_args, value) => {
        const sources = []
        for (const it of value.items ?? []) {
          const posts = Array.isArray(it.recent_posts) ? it.recent_posts : [it]
          for (const p of posts) {
            const text = String(p.text ?? '')
            const url = p.url ?? (p.id ? `https://x.com/i/status/${p.id}` : '')
            if (!url) continue
            sources.push({
              url,
              title: (p.author ? `${p.author}${p.username ? ` (@${p.username})` : ''}: ` : '') + text.slice(0, 120),
              ...(text ? { snippet: text.slice(0, 300) } : {}),
            })
          }
        }
        return { sources, truncated: false }
      },
    },
    presentResult: (_args, result) => {
      const meta = result.meta
      if (!meta || !Array.isArray(meta.sources)) return undefined
      return {
        card: 'web',
        kind: 'search',
        title: `x_search: ${meta.sources.length} posts`,
        sources: meta.sources,
        truncated: Boolean(meta.truncated),
      }
    },
    timeoutMs: 180000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const kind = X_MODES.includes(args?.type) ? args.type : 'keyword'
      const subj = args.query ?? args.username ?? args.post_id ?? ''
      if (!subj) throw new Error('x_search: provide query (keyword/semantic/user) or post_id (thread).')
      // note wording is DSH's ("primary failed: …"); Core reports "primary: …"
      const out = await runXSearch({ ...args, type: kind }, { signal: exec?.signal })
      if (out.note?.startsWith('primary: ')) out.note = `primary failed: ${out.note.slice('primary: '.length)}`
      return cleanJsonValue(out)
    },
  })
}

function renderItem(item) {
  if (Array.isArray(item.recent_posts)) {
    const posts = item.recent_posts.slice(0, 3)
    const followers = item.followers != null ? item.followers : '?'
    return `${item.name} (@${item.username}) — followers ${followers}, verified ${item.verified ?? false}\n  bio: ${item.bio ?? ''}\n  recent: ${posts.map((p) => String(p.text).slice(0, 80)).join(' | ') || '(none)'}`
  }
  const author = item.author ? item.author + (item.username ? ` (@${item.username})` : '') + ': ' : ''
  return `${author}${item.text || item.url}`
}

function renderX(value) {
  const lines = []
  lines.push(`**x_search** — via ${value.via}, ${value.results} result(s), ${value.tookMs}ms${value.cacheHit ? ' (cache hit)' : ''}`)
  if (value.note) lines.push(`note: ${value.note}`)
  if (value.error) {
    lines.push(`ERROR: ${value.error}`)
    return lines.join('\n')
  }
  for (const [i, item] of (value.items ?? []).entries()) lines.push(`${i + 1}. ${renderItem(item)}`)
  return lines.join('\n')
}

// ---------- /x-login / /x-logout ----------

function registerXLoginCommand(ctx) {
  const commands = ctx.get('commands')
  if (!commands) {
    console.error(`${LOG_PREFIX} commands service unavailable — /x-login not registered`)
    return
  }
  return commands.register({
    name: 'x-login',
    description: 'Enable the official hosted x_search path: /x-login (import your grok login from ~/.grok/auth.json), /x-login -k <XAI_API_KEY> (public api.x.ai), /x-login status. /x-logout disables it again.',
    input: { hint: '[-k <XAI_API_KEY> | status]' },
    // the API key lives in the state file, not the session log — never record
    // the raw input (DSH idiom: the domain event owns the payload)
    recordInput: false,
    handler: ({ rawInput }) => {
      const parts = String(rawInput ?? '').trim().split(/\s+/)
      try {
        if (parts[0] === 'status') {
          const st = xAuthCommands.status()
          return { kind: 'success', text: `x-login status — ${st.source}: ${st.detail}` }
        }
        if (parts[0] === '-k') {
          xAuthCommands.setApiKey(parts[1] ?? '')
          return { kind: 'success', text: `x-login: API key saved → ${xAuthCommands.path()} (public api.x.ai will be used for x_search)` }
        }
        const entry = xAuthCommands.importGrok()
        return {
          kind: 'success',
          text: `x-login: grok login imported → ${xAuthCommands.path()} (${entry.email ?? entry.user_id ?? '?'}); official hosted x_search enabled. /x-logout disables it.`,
        }
      } catch (err) {
        return { kind: 'error', text: `x-login failed: ${err instanceof Error ? err.message : String(err)}` }
      }
    },
  })
}

function registerXLogoutCommand(ctx) {
  const commands = ctx.get('commands')
  if (!commands) {
    console.error(`${LOG_PREFIX} commands service unavailable — /x-logout not registered`)
    return
  }
  return commands.register({
    name: 'x-logout',
    description: 'Remove the /x-login credentials: the official hosted x_search path is disabled and x_search uses only the multi-engine / guest-GraphQL / oEmbed fallback chain. grok CLI\'s own login is untouched. Usage: /x-logout',
    handler: () => {
      const removed = xAuthCommands.logout()
      return {
        kind: 'success',
        text: removed
          ? 'x-logout: /x-login credentials removed — x_search now uses the multi-engine / guest-GraphQL / oEmbed fallback chain only.\nRun /x-login to re-enable the official hosted x_search path. (grok CLI\'s own login is untouched.)'
          : 'x-logout: no /x-login credentials found — x_search is already on the fallback chain. Run /x-login to enable the official path.',
      }
    },
  })
}

// ---------- research_parallel (DSH native subagents) ----------

function registerParallelTool(ctx, provider = 'spawn') {
  return ctx.tools.register({
    name: 'research_parallel',
    description: 'Run authorized DSH-native research children: searchers receive fused_search/fetch_page, summarizers receive no tools. Use {agent, task} for one child or {tasks:[{agent,task},...]} for a concurrent wave. Returns reports with execution status; missing capabilities fail explicitly, without a Pi CLI fallback. Legacy {query, sub_queries} remains supported. Ordinary lookups use direct search; the shared workflow governs follow-up waves.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        agent: { type: 'string', enum: ['searcher', 'summarizer'], description: 'Single child role; use with task, not tasks/sub_queries.' },
        task: { type: 'string', minLength: 1, description: 'Bounded research task or question + reports for a summarizer.' },
        tasks: {
          type: 'array', minItems: 1,
          items: {
            type: 'object', additionalProperties: false,
            properties: { agent: { type: 'string', enum: ['searcher', 'summarizer'] }, task: { type: 'string', minLength: 1 } },
            required: ['agent', 'task'],
          },
          description: 'One concurrent wave, usually 2–4 independent research tasks. Choose a size within the host budget.',
        },
        query: { type: 'string', description: 'Question context; required only for legacy query/sub_queries mode.' },
        goal: { type: 'string', description: 'What the evidence must establish.' },
        sub_queries: { type: 'array', minItems: 2, maxItems: 4, items: { type: 'string' }, description: 'Legacy independent angles; do not combine with tasks or agent/task.' },
        max_seconds: { type: 'number', minimum: 1, maximum: 300, description: 'Whole-wave deadline, including startup (default 120 seconds). Cancellation requests host cleanup.' },
        max_sources: { type: 'integer', minimum: 1, maximum: 10, description: 'Requested results per child search (default 6); prompt budget, not a hard tool-call cap.' },
      },
    },
    presentCall: (args) => ({
      card: 'generic',
      title: `research_parallel: "${String(args?.query ?? args?.task ?? `${args?.tasks?.length ?? 0} tasks`).slice(0, 60)}"`,
      kind: 'search',
      rawInput: args?.query,
    }),
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          query: { type: 'string' },
          sub_tasks: { type: 'array', items: { type: 'object', additionalProperties: true } },
          results: { type: 'array', items: { type: 'object', additionalProperties: true } },
          okCount: { type: 'number' },
          sourceUrls: { type: 'array', items: { type: 'string' } },
          domains: { type: 'array', items: { type: 'string' } },
          totalTurns: { type: 'number' },
          totalMs: { type: 'number' },
          merged_sources: { type: 'array', items: { type: 'string' } },
          took_ms: { type: 'number' },
          note: { type: 'string' },
        },
        required: ['query', 'sub_tasks', 'merged_sources'],
      },
      render: (_args, value) => [{ type: 'text', text: renderParallel(value) }],
      presentationMeta: (_args, value) => ({
        taskCount: (value.sub_tasks ?? []).length,
        sourceCount: (value.merged_sources ?? []).length,
      }),
    },
    presentResult: (_args, result) => {
      const meta = result.meta
      if (!meta) return undefined
      return {
        card: 'generic',
        title: `research_parallel: ${meta.taskCount} tasks, ${meta.sourceCount} merged sources`,
      }
    },
    timeoutMs: 310000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const subagents = ctx.get('subagents')
      return cleanJsonValue(await parallelResearch({
        query: args.query,
        agentRole: args.agent,
        task: args.task,
        tasks: args.tasks,
        provider,
        goal: args.goal,
        subQueries: args.sub_queries,
        maxSeconds: args.max_seconds,
        maxSources: args.max_sources,
        subagents,
        tools: ctx.tools,
        agent: exec?.agent,
        signal: exec?.signal,
      }))
    },
  })
}

function renderParallel(value) {
  const lines = []
  lines.push(`**research_parallel: "${value.query}"** — ${value.sub_tasks.length} tasks, ${value.took_ms}ms`)
  lines.push(`merged sources (${value.merged_sources.length}):`)
  for (const u of value.merged_sources.slice(0, 12)) lines.push(`- ${u}`)
  for (const st of value.sub_tasks) {
    lines.push(`\n--- [${st.status}] ${st.title} ---`)
    lines.push(String(st.output ?? ''))
    if (st.error) lines.push(`Error: ${st.error}`)
    if (st.truncated) lines.push('[report truncated; do not treat missing text as evidence]')
  }
  return lines.join('\n')
}

// ---------- /web_change ----------

function registerWebChangeCommand(ctx) {
  const commands = ctx.get('commands')
  if (!commands) {
    console.error(`${LOG_PREFIX} commands service unavailable — /web_change not registered`)
    return
  }
  const show = () => {
    const info = describeLayer()
    return [
      `current layer: **${info.layer}** — ${info.label}`,
      `engines available in this layer: ${info.engines.join(', ') || '(none)'}`,
      `all engines now: ${info.allEngines.join(', ') || '(none)'}`,
      info.layer === 'api'
        ? `keyed engines: ${info.keyedEngines.enabled}/${info.keyedEngines.total} enabled (${info.keyedEngines.enabledNames.join(', ') || 'none — configure with search-boost config keys'})`
        : '',
      `usage: /web_change [free|api|show]`,
    ].filter(Boolean).join('\n')
  }
  return commands.register({
    name: 'web_change',
    description: 'Switch search layer: free (keyless bing/ddg/yahoo/exa-free) vs api (full pool incl. keyed tavily/brave/exa). Usage: /web_change [free|api|show]',
    input: { hint: 'free | api | show' },
    handler: ({ rawInput }) => {
      const cmd = String(rawInput ?? '').trim().toLowerCase()
      try {
        if (cmd === 'free' || cmd === 'api') {
          switchLayer(cmd)
          return { kind: 'success', text: `web layer → **${cmd}** — ${LAYER_LABELS[cmd]}. Future searches use this layer.` }
        }
        if (cmd === 'show' || cmd === '') {
          return { kind: 'success', text: show() }
        }
        return { kind: 'error', text: 'usage: /web_change [free|api|show]' }
      } catch (err) {
        return { kind: 'error', text: `web_change failed: ${err instanceof Error ? err.message : String(err)}` }
      }
    },
  })
}

// ---------- search_stats ----------

function registerStatsTool(ctx) {
  return ctx.tools.register({
    name: 'search_stats',
    description: 'search-boost audit: cache hits/misses, tier distribution, engine availability, and the most recent searches.',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    presentCall: () => ({ card: 'generic', title: 'search-boost stats', kind: 'other' }),
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          startedAt: { type: 'string' }, cacheHits: { type: 'number' }, cacheMisses: { type: 'number' },
          tierCounts: { type: 'object' }, engines: { type: 'object' }, grok: { type: 'boolean' },
          x: { type: 'object', additionalProperties: true },
          keyedEngines: { type: 'object', additionalProperties: true },
          layer: { type: 'string' },
          caches: { type: 'object', additionalProperties: true },
          recent: { type: 'array', items: { type: 'object', additionalProperties: true } },
        },
        required: ['startedAt'],
      },
      render: (_args, value) => [{
        type: 'text',
        text: `**search-boost stats** (since ${value.startedAt})\n` +
          `layer: ${value.layer ?? 'api'} (switch with /web_change)\n` +
          `cache: ${value.cacheHits} hits / ${value.cacheMisses} misses\n` +
          `tiers: ${JSON.stringify(value.tierCounts)}\n` +
          `engines: ${JSON.stringify(value.engines)}\n` +
          `x_search: ${value.grok ? 'official path ready' : 'fallback chain only'} (${value.x?.source ?? '?'}${value.x?.official ? ', enabled' : ', disabled'})\n` +
          `recent: ${(value.recent ?? []).map((r) => `"${r.query}"(${r.tookMs}ms,${r.results}r${r.cacheHit ? ',hit' : ''})`).join(' | ')}`,
      }],
      presentationMeta: (_args, value) => ({
        cacheHits: value.cacheHits,
        cacheMisses: value.cacheMisses,
        layer: value.layer ?? 'api',
        xOfficial: Boolean(value.grok),
      }),
    },
    presentResult: (_args, result) => {
      const meta = result.meta
      if (!meta) return undefined
      return {
        card: 'generic',
        title: `search stats: ${meta.cacheHits} cache hits / ${meta.cacheMisses} misses (${meta.layer}, x_search ${meta.xOfficial ? 'official' : 'fallback'})`,
      }
    },
    timeoutMs: 10000,
    isConcurrencySafe: () => true,
    async execute() {
      const stats = collectSearchStats()
      return cleanJsonValue({
        ...stats,
        caches: cacheSizes(),
        grok: xAuthAvailableSync(),
        x: { official: stats.xOfficial, source: stats.xSource },
        layer: getLayer(),
      })
    },
  })
}
