/**
 * Core ↔ host-adapter boundary tests (hermetic — no network, no writes to the
 * real home dir). Covers:
 *   - Core additions merged from pi/dsh (xsearch salvage, fusion depth/minScore,
 *     evidence extraction, research loop, audit log, config legacy paths)
 *   - runtime facade contracts every adapter relies on
 *   - adapters/dsh (mock Cordis ctx), adapters/pi (mock ExtensionAPI)
 *   - install adapters for pi / dsh
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// ---- isolate every state path before importing anything that reads env ----
const TMP = mkdtempSync(join(tmpdir(), 'sb-adapters-'))
process.env.HOME = join(TMP, 'home')
process.env.USERPROFILE = process.env.HOME
process.env.SEARCH_BOOST_HOME = join(TMP, 'sb-home')
process.env.PI_CODING_AGENT_DIR = join(TMP, 'pi-agent')
process.env.DSH_HOME = join(TMP, 'dsh-home')
delete process.env.XAI_API_KEY
delete process.env.SEARCH_BOOST_LAYER
for (const k of ['TAVILY_API_KEY', 'BRAVE_API_KEY', 'EXA_API_KEY']) delete process.env[k]
mkdirSync(process.env.HOME, { recursive: true })

const {
  buildXToolConfig, parseFinalMessage, salvageJson, salvageJsonForKind, readGrokClientInfo, buildXSearchPrompt,
} = await import('../lib/search/xsearch.js')
const { fusedSearch, makeCache } = await import('../lib/search/fusion.js')
const { makePageCache } = await import('../lib/search/fetch.js')
const { containsSearchTerm, countWords, tokenize } = await import('../lib/search/text.js')
const { pickExcerpts, pickParagraphs, excerptForTool } = await import('../lib/search/evidence.js')
const { runResearchLoop, evaluateCoverage, mergeInitialQueries } = await import('../lib/search/research-loop.js')
const { AuditLog } = await import('../lib/search/audit.js')
const { configPiLegacyPath, configReadCandidates, piAgentDir } = await import('../lib/config-paths.mjs')
const runtime = await import('../lib/runtime.mjs')
const { ROUTES, HOST_RUNTIME_IDS, promptPath } = await import('../agents/router.mjs')
const dsh = await import('../adapters/dsh/index.js')
const pi = await import('../adapters/pi/index.js')
const piParallel = await import('../adapters/pi/parallel.js')
const hostRuntime = await import('../lib/agents/host-runtime.mjs')
const { AGENTS, AGENT_IDS, parseTargetSpec } = await import('../lib/agents/index.mjs')
const { PATHS, agentConfigured, agentDetected } = await import('../lib/paths.mjs')
const { parseFlags, installOpts } = await import('../lib/cli/args.mjs')

let failed = 0
function assert(name, cond) {
  if (!cond) {
    console.error(`FAIL: ${name}`)
    failed++
  } else {
    console.log(`ok: ${name}`)
  }
}
async function rejects(name, fn, re) {
  try {
    await fn()
    assert(`${name} (should throw)`, false)
  } catch (err) {
    assert(name, !re || re.test(err instanceof Error ? err.message : String(err)))
  }
}

// ---------------------------------------------------------------------------
// Core: x_search parsing (merged from dsh-search-boost v0.1.3)
// ---------------------------------------------------------------------------
assert('salvageJson recovers prefixed array', Array.isArray(salvageJson('Here you go:\n[{"id":"1","text":"hi","url":"https://x.com/a/status/1"}]')))
assert('salvageJson prefers full array over lone object', salvageJson('note {"x":1} then [{"id":"2","text":"t"}]').length === 1)
assert('salvageJson still salvages a lone object', salvageJson('prose {"a":1} tail').a === 1)
assert('salvageJsonForKind user prefers profile object', salvageJsonForKind('[{"id":"9","text":"post","url":"u"}] {"username":"nasa","name":"NASA","followers":1}', 'user').username === 'nasa')
assert('salvageJsonForKind user rejects empty array', salvageJsonForKind('[]', 'user') === null)
assert('salvageJsonForKind keyword strips fences', Array.isArray(salvageJsonForKind('```json\n[{"id":"1","text":"a"}]\n```', 'keyword')))
const finalMsg = parseFinalMessage({ output: [
  { type: 'message', content: [{ type: 'output_text', text: '[{"id":"1","text":"first"}]' }] },
  { type: 'message', content: [{ type: 'output_text', text: '   ' }] },
] })
assert('parseFinalMessage uses last message with content', Array.isArray(finalMsg.data) && finalMsg.data[0].id === '1')
assert('buildXToolConfig carries hosted filters', buildXToolConfig({ from_date: '2026-01-01', allowed_x_handles: ['a'] }).allowed_x_handles?.[0] === 'a')
await rejects('buildXToolConfig rejects allowed+excluded', async () => buildXToolConfig({ allowed_x_handles: ['a'], excluded_x_handles: ['b'] }), /mutually exclusive/)
const grokInfo = readGrokClientInfo()
assert('readGrokClientInfo has defaults without grok install', typeof grokInfo.version === 'string' && typeof grokInfo.defaultModel === 'string')
assert('buildXSearchPrompt user asks for one object', /ONLY one valid JSON object/.test(buildXSearchPrompt('user', { username: 'nasa' }, 5)))
await rejects('buildXSearchPrompt unknown kind', async () => buildXSearchPrompt('nope', {}, 5), /unknown type/)

// ---------------------------------------------------------------------------
// Core: fusion extras (depth / minScore / content / maxResultsCap / clear)
// ---------------------------------------------------------------------------
const seenOpts = []
const fakeRunOne = async (engine, q, n, o) => {
  seenOpts.push({ engine, depth: o.depth })
  return [
    { title: `${engine} A`, url: `https://a.example.com/${engine}`, snippet: 'alpha beta', content: engine === 'tavily' ? 'full text '.repeat(50) : undefined },
    { title: `${engine} B`, url: 'https://b.example.org/shared', snippet: 'alpha' },
  ]
}
const fusedBasic = await fusedSearch({ query: 'alpha beta', engines: ['tavily', 'bing'], tier: 'complex', depth: 'basic', runOne: fakeRunOne, layer: 'api' })
assert('fusion depth override reaches engines', seenOpts.every((o) => o.depth === 'basic') && fusedBasic.depth === 'basic')
assert('fusion keeps engine content on results', fusedBasic.results.some((r) => typeof r.content === 'string' && r.content.length > 100))
seenOpts.length = 0
await fusedSearch({ query: 'alpha beta', engines: ['bing'], tier: 'complex', runOne: fakeRunOne, layer: 'free' })
assert('fusion complex tier defaults to advanced depth', seenOpts[0].depth === 'advanced')
const fusedFloor = await fusedSearch({ query: 'alpha beta', engines: ['bing'], tier: 'simple', minScore: 99, runOne: fakeRunOne, layer: 'free' })
assert('fusion minScore prunes everything above floor', fusedFloor.results.length === 0)
const many = async (engine) => Array.from({ length: 15 }, (_, i) => ({ title: `t${i}`, url: `https://d${i}.example.com/p`, snippet: 'alpha beta' }))
const capped10 = await fusedSearch({ query: 'alpha beta', engines: ['bing'], tier: 'simple', maxResults: 15, runOne: many, layer: 'free' })
const capped15 = await fusedSearch({ query: 'alpha beta', engines: ['bing'], tier: 'simple', maxResults: 15, maxResultsCap: 20, runOne: many, layer: 'free' })
assert('fusion default cap stays 10 (MCP/DSH contract)', capped10.results.length === 10)
assert('fusion maxResultsCap lifts cap for pi', capped15.results.length === 15)
const c = makeCache()
c.set('k', 1)
c.clear()
assert('makeCache.clear empties', c.size() === 0 && c.get('k') === undefined)
const pc = makePageCache()
pc.set('p', 'x')
pc.clear()
assert('makePageCache.clear empties', pc.size() === 0)

// ---------------------------------------------------------------------------
// Core: text / evidence (ported from pi)
// ---------------------------------------------------------------------------
assert('countWords counts CJK', countWords('多头注意力机制') >= 3 && countWords('one two three') === 3)
assert('tokenize segments CJK runs', tokenize('多头注意力机制').length >= 2)
assert('containsSearchTerm respects latin boundaries', containsSearchTerm('the results are in', 'results') && !containsSearchTerm('the results are in', 'lts'))
const page = [
  'Navigation [a](https://x) [b](https://y) [c](https://z)',
  'Node.js 24 entered Active LTS in October 2026 and is the recommended release for production.',
  '| Version | Status | EOL |\n|---|---|---|\n| 24 | Active LTS | 2029-04 |\n| 22 | Maintenance | 2027-04 |',
  'Unrelated paragraph about cooking pasta with tomatoes and basil in a large pot.',
].join('\n\n')
const excerpts = pickExcerpts(page, 'Node.js 24 LTS status', 2)
assert('pickExcerpts picks the relevant sentence', excerpts.some((e) => /Active LTS/.test(e)) && !excerpts.some((e) => /pasta/.test(e)))
const paras = pickParagraphs(page, 'Node.js 24 LTS status')
assert('pickParagraphs keeps the data table', paras.some((p) => p.includes('| 24 |')))
assert('pickParagraphs drops link-list boilerplate', !paras.some((p) => p.startsWith('Navigation')))
assert('excerptForTool truncates at boundary', excerptForTool('a\n\n'.repeat(2000), 100).endsWith('[content truncated]'))

// ---------------------------------------------------------------------------
// Core: research loop (hermetic search/fetch)
// ---------------------------------------------------------------------------
const doc = (domain, text) => ({ url: `https://${domain}/doc`, via: 'jina', content: text, fetched_at: '2026-09-18T00:00:00.000Z', word_count: countWords(text) })
const corpus = {
  'nodejs.org': 'Node.js 24 is the Active LTS release as of October 2026. Node.js 24 became LTS in 2026 with V8 upgrades and stable permission model improvements.',
  'endoflife.date': 'Node.js 24 Active LTS started in October 2026. Node.js 24 will move to maintenance in October 2027 according to the release schedule.',
  'blog.example.com': 'Node.js 24 Active LTS in 2026 brings a faster runtime; many teams upgraded in 2026 to Node.js 24 after the LTS promotion.',
}
const calls = { search: 0, fetch: 0 }
const deps = {
  search: async (o) => {
    calls.search++
    assert('research loop asks for complex/advanced', o.complexity === 'complex' && o.depth === 'advanced')
    return { results: Object.keys(corpus).map((d) => ({ title: `${d} page`, url: `https://${d}/doc`, snippet: 'Node.js 24 LTS' })), engineStats: { bing: { used: true, errors: 0 } } }
  },
  fetch: async (url) => {
    calls.fetch++
    const domain = new URL(url).hostname
    return doc(domain, corpus[domain])
  },
}
const step = await runResearchLoop({ query: 'Node.js 24 LTS', mode: 'step', maxSources: 4, perRound: 3, ...deps })
assert('research loop step mode = one round', step.rounds === 1 && step.stopReason === 'step')
assert('research loop fetched pages and built excerpts', step.sources.length === 3 && step.sources.every((s) => s.excerpt.length > 0))
assert('research loop corroborates across domains', step.sources.some((s) => s.corroboratedBy.length >= 1))
assert('research loop coverage covers query terms', step.coverage.uncoveredTerms.length === 0)
const auto = await runResearchLoop({ query: 'Node.js 24 LTS', mode: 'auto', maxRounds: 3, maxSources: 6, perRound: 3, ...deps })
assert('research loop auto stops when covered', auto.stopReason === 'query_evidence_covered' && auto.rounds === 1)
assert('research loop skips fetch when engine content is rich', await (async () => {
  const seen = { fetch: 0 }
  const r = await runResearchLoop({
    query: 'tokio runtime', mode: 'step', perRound: 2,
    search: async () => ({ results: [{ title: 'rich', url: 'https://tokio.rs/x', content: 'tokio runtime '.repeat(200) }], engineStats: {} }),
    fetch: async () => { seen.fetch++; return doc('tokio.rs', 'x') },
  })
  return seen.fetch === 0 && r.sources[0].via === 'search'
})())
await rejects('research loop requires query', () => runResearchLoop({ query: '', ...deps }), /query is required/)
assert('evaluateCoverage flags goal terms needing two domains', evaluateCoverage('q', 'establish tokio maturity', [
  { domain: 'a.com', excerpt: 'tokio maturity is high' },
]).uncoveredGoalTerms.includes('tokio'))
assert('mergeInitialQueries keeps goal participation', mergeInitialQueries('q', 'g', ['custom'])[0] === 'q g')

// ---------------------------------------------------------------------------
// Core: audit log
// ---------------------------------------------------------------------------
const auditFile = join(TMP, 'audit', 'a.jsonl')
const audit = new AuditLog(auditFile)
audit.write({ type: 'search', ts: '2026-09-18T01:00:00.000Z', query: 'q1', queriesUsed: ['q1'], engines: ['bing'], engineErrors: {}, results: 3, cacheHits: 0, tookMs: 1, topUrls: [] })
audit.write({ type: 'fetch', ts: '2026-09-18T01:00:01.000Z', url: 'https://a/b', domain: 'a', via: 'jina', ok: true, cacheHit: false, tookMs: 1 })
assert('audit writes JSONL', readFileSync(auditFile, 'utf8').split('\n').filter(Boolean).length === 2)
assert('audit readTail returns last N chronologically', audit.readTail(1)[0].type === 'fetch' && audit.readAll().length === 2)
audit.clear()
assert('audit clear removes file', !existsSync(auditFile))

// ---------------------------------------------------------------------------
// Core: config paths honour pi legacy state files (read-only)
// ---------------------------------------------------------------------------
assert('piAgentDir follows PI_CODING_AGENT_DIR', piAgentDir() === process.env.PI_CODING_AGENT_DIR)
assert('layer read candidates include pi legacy file', configReadCandidates('layer').includes(configPiLegacyPath('layer')))
assert('xauth pi legacy path is xsearch-auth.json', configPiLegacyPath('xauth').endsWith('xsearch-auth.json'))
assert('keys have no pi legacy path (keys come from the TUI only)', configPiLegacyPath('keys') === null)
mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true })
writeFileSync(configPiLegacyPath('layer'), JSON.stringify({ layer: 'free' }))
assert('getLayer reads pi legacy layer file', runtime.getLayer() === 'free')
runtime.switchLayer('api')
assert('switchLayer persists and wins over legacy', runtime.getLayer() === 'api' && existsSync(join(process.env.SEARCH_BOOST_HOME, 'config', 'layer.json')))
runtime.switchLayer('free')

// ---------------------------------------------------------------------------
// runtime facade contracts
// ---------------------------------------------------------------------------
for (const fn of ['runFused', 'runFetchPage', 'runResearchRound', 'runResearchLoop', 'runXSearch', 'describeLayer', 'switchLayer', 'invalidateSearchCaches', 'clearAllCaches', 'cacheSizes', 'xAuthCommands']) {
  assert(`runtime exports ${fn}`, fn in runtime)
}
const info = runtime.describeLayer()
assert('describeLayer shape', info.layer === 'free' && Array.isArray(info.engines) && typeof info.xOfficial === 'boolean' && info.keyedEngines.total === 3)
const k1 = runtime.xSearchCacheKey('keyword', { query: 'a' }, 5)
runtime.switchLayer('api')
const k2 = runtime.xSearchCacheKey('keyword', { query: 'a' }, 5)
runtime.switchLayer('free')
assert('x cache key embeds layer', k1 !== k2 && k1.includes('"auth":"none"'))
runtime.X_CACHE.keyword.set('probe', { via: 'x' })
runtime.SEARCH_CACHE.set('probe', { results: [] })
runtime.invalidateSearchCaches()
assert('invalidateSearchCaches clears search + x caches', runtime.X_CACHE.keyword.size() === 0 && runtime.SEARCH_CACHE.size() === 0)
await rejects('runXSearch requires a subject', () => runtime.runXSearch({ type: 'keyword' }), /provide query/)
await rejects('runXSearch rejects allowed+excluded', () => runtime.runXSearch({ type: 'keyword', query: 'x', allowed_x_handles: ['a'], excluded_x_handles: ['b'] }), /mutually exclusive/)
await rejects('runFused requires query', () => runtime.runFused({ query: '  ' }), /query is required/)
await rejects('runFetchPage requires url', async () => runtime.runFetchPage(''), /url is required/)
const sizes = runtime.cacheSizes()
assert('cacheSizes covers every cache', ['search', 'page', 'x_keyword', 'x_semantic', 'x_user', 'x_thread'].every((k) => k in sizes))
assert('xAuthCommands.status without creds', runtime.xAuthCommands.status().source === 'none')
assert('xAuthCommands.logout is a no-op without creds', runtime.xAuthCommands.logout() === false)

// ---------------------------------------------------------------------------
// agents router: host-runtime routes + prompt assets
// ---------------------------------------------------------------------------
assert('router has pi and dsh host-runtime routes', HOST_RUNTIME_IDS.includes('pi') && HOST_RUNTIME_IDS.includes('dsh') && ROUTES.pi.injectKind === 'host-runtime')
assert('pi prompt asset exists', existsSync(promptPath('pi')) && readFileSync(promptPath('pi'), 'utf8').includes('<search_balance>'))
assert('dsh policy asset exists', existsSync(promptPath('dsh')) && readFileSync(promptPath('dsh'), 'utf8').startsWith('# 搜索政策'))

// ---------------------------------------------------------------------------
// adapters/dsh — mock Cordis ctx
// ---------------------------------------------------------------------------
function mockDshCtx() {
  const tools = new Map()
  const commands = new Map()
  const sections = []
  const providers = {}
  const ctx = {
    effect() {},
    get: (n) => n === 'commands' ? { register: (c) => { commands.set(c.name, c); return c } }
      : n === 'timer' ? { timeout: (ms) => new Promise((r) => setTimeout(r, ms)) }
        : n === 'subagents' ? null : undefined,
    web: { registerSearchProvider: (p) => { providers.search = p }, registerFetchProvider: (p) => { providers.fetch = p } },
    tools: { register: (t) => { tools.set(t.name, t) } },
    systemPrompt: { section: (s) => sections.push(s) },
    timeout: (ms) => new Promise((r) => setTimeout(r, ms)),
  }
  return { ctx, tools, commands, sections, providers }
}
{
  const m = mockDshCtx()
  dsh.apply(m.ctx, {})
  assert('dsh plugin name + inject', dsh.name === 'search-boost' && dsh.inject.includes('web') && dsh.inject.includes('commands'))
  assert('dsh registers all tools', ['fused_search', 'fetch_page', 'x_search', 'deep_research', 'research_parallel', 'search_stats'].every((n) => m.tools.has(n)))
  assert('dsh registers commands', ['web_change', 'x-login', 'x-logout'].every((n) => m.commands.has(n)))
  assert('dsh registers both web providers with shared id', m.providers.search?.id === dsh.PROVIDER_ID && m.providers.fetch?.id === dsh.PROVIDER_ID)
  const policy = m.sections.find((s) => s.name === 'search:policy')
  const status = m.sections.find((s) => s.name === 'search:status')
  assert('dsh policy section order 115 with text', policy?.order === 115 && policy.text.includes('工具路由'))
  assert('dsh status section is dynamic and reflects layer', status?.order === 116 && typeof status.text === 'function' && status.text().includes('layer: free'))
  const show = m.commands.get('web_change').handler({ rawInput: 'show' })
  assert('/web_change show', show.kind === 'success' && /current layer: \*\*free\*\*/.test(show.text))
  const toApi = m.commands.get('web_change').handler({ rawInput: 'api' })
  assert('/web_change api persists via Core', toApi.kind === 'success' && runtime.getLayer() === 'api')
  m.commands.get('web_change').handler({ rawInput: 'free' })
  assert('/web_change bad arg', m.commands.get('web_change').handler({ rawInput: 'nope' }).kind === 'error')
  assert('/x-login status', /x-login status — none/.test(m.commands.get('x-login').handler({ rawInput: 'status' }).text))
  assert('/x-logout without creds', /already on the fallback chain/.test(m.commands.get('x-logout').handler({ rawInput: '' }).text))
  const stats = await m.tools.get('search_stats').execute({}, {})
  assert('dsh search_stats shape', stats.layer === 'free' && stats.caches && typeof stats.grok === 'boolean' && stats.x.source === 'none')
  const fused = m.tools.get('fused_search')
  assert('dsh fused_search schema uses Core engine enum', fused.parameters.properties.engines.items.enum.join() === runtime.ENGINE_ORDER.join())
  assert('dsh presentation cards present', typeof fused.presentCall === 'function' && typeof fused.presentResult === 'function' && typeof fused.output.presentationMeta === 'function')
  const meta = fused.output.presentationMeta({}, { results: [{ url: 'https://a', title: 't', snippet: 's', published: '2026-01-01' }], truncated: false })
  assert('dsh presentationMeta maps sources', meta.sources[0].publishedAt === '2026-01-01' && fused.presentResult({}, { meta }).card === 'web')
  await rejects('dsh x_search requires subject', () => m.tools.get('x_search').execute({}, {}), /provide query/)
  await rejects('dsh research_parallel needs subagents service', () => m.tools.get('research_parallel').execute({ query: 'q' }, {}), /subagents service unavailable/)
}
{
  const m = mockDshCtx()
  dsh.apply(m.ctx, { xSearch: false, researchParallel: false, searchProvider: false, policy: false })
  assert('dsh config flags disable surfaces', !m.tools.has('x_search') && !m.tools.has('research_parallel') && !m.providers.search && !m.sections.some((s) => s.name === 'search:policy'))
}

// ---------------------------------------------------------------------------
// adapters/pi — mock ExtensionAPI
// ---------------------------------------------------------------------------
{
  const tools = new Map()
  const commands = new Map()
  const handlers = new Map()
  const mockPi = { registerTool: (t) => tools.set(t.name, t), registerCommand: (n, c) => commands.set(n, c), on: (ev, fn) => handlers.set(ev, fn) }
  pi.default(mockPi)
  assert('pi registers all tools', ['fused_search', 'fetch_page', 'deep_research', 'research_parallel', 'x_search'].every((n) => tools.has(n)))
  assert('pi registers all commands', ['web_change', 'x-login', 'x-logout', 'search-cache', 'search-audit'].every((n) => commands.has(n)))
  for (const t of tools.values()) {
    assert(`pi ${t.name} parameters are plain JSON schema`, t.parameters.type === 'object' && typeof t.parameters.properties === 'object' && Array.isArray(t.promptGuidelines))
  }
  assert('pi fused_search keeps pi-only params', ['site', 'min_score', 'depth'].every((k) => k in tools.get('fused_search').parameters.properties) && tools.get('fused_search').parameters.properties.max_results.maximum === 20)
  assert('pi x_search requires type', tools.get('x_search').parameters.required.includes('type'))
  const injected = await handlers.get('before_agent_start')({ systemPrompt: 'BASE' })
  assert('pi injects <search_balance> once', injected.systemPrompt.startsWith('BASE\n<search_balance>') && Object.keys(await handlers.get('before_agent_start')({ systemPrompt: '<search_balance>' })).length === 0)
  const notes = []
  const ctx = { ui: { notify: (m) => notes.push(m) } }
  await commands.get('web_change').handler('show', ctx)
  assert('/web_change show (pi) points keys at the TUI', /web layer: free/.test(notes.at(-1)) && /search-boost config keys/.test(notes.at(-1)))
  await commands.get('web_change').handler('api', ctx)
  assert('/web_change api (pi) persists via Core', runtime.getLayer() === 'api' && /free → api/.test(notes.at(-1)))
  await commands.get('web_change').handler('free', ctx)
  runtime.SEARCH_CACHE.set('z', { results: [] })
  await commands.get('search-cache').handler('clear', ctx)
  assert('/search-cache clear empties Core caches', runtime.SEARCH_CACHE.size() === 0 && /cleared/.test(notes.at(-1)))
  await commands.get('search-audit').handler('stats', ctx)
  assert('/search-audit stats reads pi agent dir', notes.at(-1).includes(pi.auditFilePath()) && pi.auditFilePath().startsWith(process.env.PI_CODING_AGENT_DIR))
  await commands.get('x-login').handler('status', ctx)
  assert('/x-login status (pi)', /x-login status: none/.test(notes.at(-1)))
  await commands.get('x-login').handler('-k ', ctx)
  assert('/x-login -k without key errors', /missing API key/.test(notes.at(-1)))
  const bad = await tools.get('x_search').execute('id', { type: 'thread' }, undefined, undefined)
  assert('pi x_search thread without post_id reports error', /post_id required/.test(bad.content[0].text))
  const both = await tools.get('x_search').execute('id', { type: 'keyword', query: 'q', allowed_x_handles: ['a'], excluded_x_handles: ['b'] })
  assert('pi x_search rejects allowed+excluded', both.details.error === 'mutually_exclusive_handles')
  await rejects('pi research_parallel needs 2 subtasks', () => tools.get('research_parallel').execute('id', { query: 'q', subtasks: ['one'] }), /at least 2 subtasks/)
  assert('pi parallel extracts cited URLs', piParallel.extractSourceUrls('see (https://en.wikipedia.org/wiki/Foo_(bar)) and https://a.com/x).').length === 2)
  assert('pi parallel entry points at adapter', piParallel.SEARCH_BOOST_EXT.endsWith(join('adapters', 'pi', 'index.js')))
  assert('pi parallel transient detection', piParallel.isTransientProviderTransportError('WebSocket closed') && !piParallel.isTransientProviderTransportError('bad prompt'))
}

// ---------------------------------------------------------------------------
// install adapters: pi shim + dsh plugin forwarding
// ---------------------------------------------------------------------------
assert('AGENTS include pi and dsh', AGENT_IDS.includes('pi') && AGENT_IDS.includes('dsh') && parseTargetSpec('all').includes('dsh'))
assert('pi detected via agent dir; dsh not detected in empty home', agentDetected('pi') && !agentDetected('dsh') && !agentConfigured('pi') && !agentConfigured('dsh'))
const shim = hostRuntime.piShimSource()
assert('pi shim re-exports adapter via file URL', shim.includes('search-boost pi extension shim') && /export \{ default \} from 'file:\/\/.*adapters\/pi\/index\.js'/.test(shim))
const piFiles = await AGENTS.pi.install({ dryRun: false })
assert('pi install writes shim under PI_CODING_AGENT_DIR', piFiles[0] === PATHS.pi.extension && existsSync(PATHS.pi.extension) && agentConfigured('pi'))
writeFileSync(join(process.env.PI_CODING_AGENT_DIR, 'extensions', 'other.js'), '// user file')
await AGENTS.pi.uninstall({ dryRun: false })
assert('pi uninstall removes only our shim', !existsSync(PATHS.pi.extension) && existsSync(join(process.env.PI_CODING_AGENT_DIR, 'extensions', 'other.js')))
writeFileSync(PATHS.pi.extension, '// user-owned file')
await AGENTS.pi.uninstall({ dryRun: false })
assert('pi uninstall leaves foreign file at shim path', existsSync(PATHS.pi.extension))
rmSync(PATHS.pi.extension)
assert('pi print config mentions pi install', AGENTS.pi.printConfig().includes('pi install npm:search-boost-mcp'))
assert('dsh plugin add args', hostRuntime.dshPluginArgs('add', 'web').slice(0, 4).join(' ') === 'plugin --profile web add')
assert('dsh plugin remove args use package name', hostRuntime.dshPluginArgs('remove', 'headless').join(' ') === 'plugin --profile headless remove search-boost-mcp')
assert('dsh print config uses profile', AGENTS.dsh.printConfig({ profile: 'sdk' }).includes('--profile sdk add'))
const dshDry = await AGENTS.dsh.install({ dryRun: true, profile: 'web' })
assert('dsh dry-run install returns profile manifest path', dshDry[0].endsWith(join('profiles', 'web', 'package.json')))
mkdirSync(join(process.env.DSH_HOME, 'profiles', 'web'), { recursive: true })
writeFileSync(join(process.env.DSH_HOME, 'profiles', 'web', 'package.json'), JSON.stringify({ dependencies: { 'search-boost-mcp': '^0.2.0' }, dsh: { profile: { bundles: ['search-boost-mcp'] } } }))
assert('dsh configured when a profile depends on the package', agentDetected('dsh') && agentConfigured('dsh'))
assert('--profile flag parses', installOpts(parseFlags(['-t', 'dsh', '--profile', 'sdk'])).profile === 'sdk')

// package manifests
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
assert('package exports pi + dsh adapters', pkg.exports['./pi'] === './adapters/pi/index.js' && pkg.exports['./dsh'] === './adapters/dsh/index.js')
assert('package declares pi extension manifest', pkg.pi.extensions[0] === './adapters/pi/index.js')
assert('package declares dsh bundle patch', pkg.dsh.bundle.patch === './adapters/dsh/cordis.patch.yml' && existsSync(new URL('../adapters/dsh/cordis.patch.yml', import.meta.url)))
assert('cordis patch imports the dsh export', readFileSync(new URL('../adapters/dsh/cordis.patch.yml', import.meta.url), 'utf8').includes('name: search-boost-mcp/dsh'))
assert('package files ship adapters', pkg.files.includes('adapters/') && !pkg.files.includes('tools/'))

rmSync(TMP, { recursive: true, force: true })

if (failed) {
  console.error(`\n${failed} adapter test(s) failed`)
  process.exit(1)
}
console.log('\nAll adapter boundary tests passed.')
