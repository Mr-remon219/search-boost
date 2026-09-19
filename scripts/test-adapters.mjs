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
for (const k of ['TAVILY_API_KEY', 'BRAVE_API_KEY', 'EXA_API_KEY', 'PI_SEARCH_TAVILY_KEY', 'PI_SEARCH_BRAVE_KEY', 'PI_SEARCH_EXA_KEY']) delete process.env[k]
mkdirSync(process.env.HOME, { recursive: true })

const {
  buildXToolConfig, parseFinalMessage, salvageJson, salvageJsonForKind, readGrokClientInfo, buildXSearchPrompt,
} = await import('../lib/search/xsearch.js')
const { fusedSearch, makeCache } = await import('../lib/search/fusion.js')
const { makePageCache, toFetchPageResult } = await import('../lib/search/fetch.js')
const { preprocessPage, looksLikeHtml } = await import('../lib/search/page-preprocess.js')
const { envProxyUrl } = await import('../lib/search/ipv4-fetch.js')
const { containsSearchTerm, countWords, tokenize } = await import('../lib/search/text.js')
const { pickExcerpts, pickParagraphs, excerptForTool } = await import('../lib/search/evidence.js')
const { AuditLog } = await import('../lib/search/audit.js')
const { configPiLegacyPath, configReadCandidates, piAgentDir } = await import('../lib/config-paths.mjs')
const runtime = await import('../lib/runtime.mjs')
const { ROUTES, HOST_RUNTIME_IDS, promptPath, piSubagentTemplatePaths, piWorkflowPromptPaths } = await import('../agents/router.mjs')
const dsh = await import('../adapters/dsh/index.js')
const pi = await import('../adapters/pi/index.js')
const piSub = await import('../adapters/pi/search-parallel-subagent.js')
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
// Core: env proxy selection (HTTP(S)_PROXY / ALL_PROXY → ipv4Fetch)
// ---------------------------------------------------------------------------
{
  const saved = {}
  for (const k of ['http_proxy', 'https_proxy', 'all_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY']) {
    saved[k] = process.env[k]
    delete process.env[k]
  }
  assert('envProxyUrl empty without proxy env', envProxyUrl() === '' && envProxyUrl('http') === '')
  process.env.ALL_PROXY = 'http://127.0.0.1:7890'
  assert('envProxyUrl falls back to ALL_PROXY', envProxyUrl() === 'http://127.0.0.1:7890')
  process.env.http_proxy = 'http://127.0.0.1:7890'
  process.env.HTTPS_PROXY = 'http://example.invalid:9'
  assert('envProxyUrl lowercase http_proxy beats HTTPS_PROXY', envProxyUrl('http') === 'http://127.0.0.1:7890')
  process.env.https_proxy = 'http://127.0.0.1:7890'
  assert('envProxyUrl prefers https_proxy for https', envProxyUrl('https') === 'http://127.0.0.1:7890')
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
}

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
// Core: fetch_page preprocess (keep evidence, drop chrome) + no clip
// ---------------------------------------------------------------------------
{
  const base = 'https://docs.example.com/guide/intro'
  const html = `<!doctype html><html><head>
<style>.ad{color:red}</style>
<script>window.ads=1</script>
</head><body>
<nav>Docs <a href="https://api.example/ref">API reference</a></nav>
<h1>Release notes</h1>
<p>Node.js 24 entered Active LTS in October 2026.</p>
<pre><code>npm install foo</code></pre>
<table><tr><th>Version</th><th>Status</th></tr><tr><td>24</td><td>Active LTS</td></tr></table>
<iframe src="https://doubleclick.net/ad" title="ad"></iframe>
<img width="1" height="1" src="https://tracker.example/pixel">
<img alt="architecture diagram" src="/arch.png">
</body></html>`
  assert('looksLikeHtml detects documents', looksLikeHtml(html) && !looksLikeHtml('# Title\n\nA short markdown page.'))
  const cleaned = preprocessPage(html, base)
  assert('preprocess drops style and script', !/window\.ads|\.ad\{color/.test(cleaned))
  assert('preprocess drops ad iframe and tracking pixel', !/doubleclick|tracker\.example/.test(cleaned))
  assert('preprocess keeps heading', /# Release notes/.test(cleaned))
  assert('preprocess keeps paragraph', /Active LTS/.test(cleaned))
  assert('preprocess keeps code', /npm install foo/.test(cleaned))
  assert('preprocess keeps table cells', /24/.test(cleaned) && /Active LTS/.test(cleaned))
  assert('preprocess keeps nav link with href', /\[API reference\]\(https:\/\/api\.example\/ref\)/.test(cleaned))
  assert('preprocess keeps image alt and resolves src', /!\[architecture diagram\]\(https:\/\/docs\.example\.com\/arch\.png\)/.test(cleaned))

  const indented = `<!doctype html><html><body>
<pre><code>def foo():
    if x:
        return 1
</code></pre>
<p>done</p>
</body></html>`
  const indentedOut = preprocessPage(indented, base)
  assert('preprocess keeps python indent in pre', /def foo\(\):\n    if x:\n        return 1/.test(indentedOut))

  const nested = `<!doctype html><html><body>
<ul>
<li><a href="https://docs.example.com/api">API Docs</a></li>
<li><img alt="badge" src="./badge.svg"></li>
</ul>
<h2>See <a href="/docs/api">API</a></h2>
<blockquote>Read the <a href="../reference/foo">reference</a></blockquote>
<table><tr><td><a href="/api/foo">foo()</a></td></tr></table>
<iframe title="Authentication Guide" src="/docs/auth.html"></iframe>
<p>Show &amp;lt;literal&gt; and &#x27;quote&#39;.</p>
<template>aaa<template>bbb</template>ccc</template>
<p>keep-me</p>
</body></html>`
  const nestedOut = preprocessPage(nested, base)
  assert('preprocess keeps list link href', /\- \[API Docs\]\(https:\/\/docs\.example\.com\/api\)/.test(nestedOut))
  assert('preprocess keeps list image', /!\[badge\]\(https:\/\/docs\.example\.com\/guide\/badge\.svg\)/.test(nestedOut))
  assert('preprocess keeps heading link', /#+\s*See \[API\]\(https:\/\/docs\.example\.com\/docs\/api\)/.test(nestedOut))
  assert('preprocess keeps blockquote link', /\[reference\]\(https:\/\/docs\.example\.com\/reference\/foo\)/.test(nestedOut))
  assert('preprocess keeps table cell link', /\[foo\(\)\]\(https:\/\/docs\.example\.com\/api\/foo\)/.test(nestedOut))
  assert('preprocess keeps iframe src', /\[Embedded: Authentication Guide\]\(https:\/\/docs\.example\.com\/docs\/auth\.html\)/.test(nestedOut))
  assert('preprocess decodes entities once', /Show &lt;literal> and 'quote'/.test(nestedOut) && !/Show <literal>/.test(nestedOut))
  assert('preprocess drops nested template without leftover close', /keep-me/.test(nestedOut) && !/aaa|bbb|ccc|<\/template>/.test(nestedOut))

  const relativeKeep = preprocessPage('<!doctype html><html><body><a href="/docs/api">API</a></body></html>')
  assert('preprocess keeps relative href without baseUrl', /\[API\]\(\/docs\/api\)/.test(relativeKeep))

  const md = '# Guide\n\nCall `fused_search` then `fetch_page`.\n\n<style>x{}</style>\n<script>evil()</script>\n\n| Col |\n|---|\n| val |\n'
  const mdOut = preprocessPage(md)
  assert('preprocess markdown keeps body and table', /fused_search/.test(mdOut) && /\| val \|/.test(mdOut))
  assert('preprocess markdown drops embedded script/style', !/evil\(\)|x\{\}/.test(mdOut))

  const mdCode = '# Example\n\n```python\ndef foo():\n    if x:\n        return 1\n```\n\n```html\n<script>\n  console.log("hello")\n</script>\n<style>x{}</style>\n```\n\nMore text.\n'
  const mdCodeOut = preprocessPage(mdCode)
  assert('preprocess markdown keeps fenced indent', /def foo\(\):\n    if x:\n        return 1/.test(mdCodeOut))
  assert('preprocess markdown keeps fenced html examples', /<script>[\s\S]*console\.log\("hello"\)[\s\S]*<\/script>/.test(mdCodeOut) && /<style>x\{\}<\/style>/.test(mdCodeOut))

  const mdHtmlFence = `# Guide\n\n\`\`\`html\n${'<div><span><section><article><p><table><tr><td><ul><ol><li>x</li></ol></ul></td></tr></table></p></article></section></span></div>\n'.repeat(2)}\`\`\`\n`
  assert('looksLikeHtml ignores fenced html examples', !looksLikeHtml(mdHtmlFence))

  const mdIndent = '- A\n  - B\n\n    indented code\n'
  const mdIndentOut = preprocessPage(mdIndent)
  assert('markdown keeps nested list indent', /^- A\n  - B/m.test(mdIndentOut))
  assert('markdown keeps 4-space indented code', /\n    indented code/.test(mdIndentOut))

  const dataHref = preprocessPage('<!doctype html><html><body><a data-href="/fake" href="/real">Real</a></body></html>', 'https://example.com/page')
  assert('attr does not treat data-href as href', /\[Real\]\(https:\/\/example.com\/real\)/.test(dataHref) && !/\/fake/.test(dataHref))

  const fallbackHtml = `<!doctype html><html><body><table><caption>${'KeepThisEvidence '.repeat(20)}<a href="/real">RealLink</a><img alt="UsefulAlt" src="/x.png"></caption><tr><td>tiny</td></tr></table></body></html>`
  const fallbackOut = preprocessPage(fallbackHtml, 'https://example.com/page')
  assert('fallback keeps link href', /\[RealLink\]\(https:\/\/example.com\/real\)/.test(fallbackOut))
  assert('fallback keeps img alt and src', /UsefulAlt/.test(fallbackOut) && /https:\/\/example.com\/x\.png/.test(fallbackOut))

  const nestedList = `<!doctype html><html><body>
<ol>
  <li>Step 1<ul><li>Sub A</li><li>Sub B</li></ul></li>
  <li>Step 2</li>
</ol>
</body></html>`
  const nestedListOut = preprocessPage(nestedList, base)
  assert('preprocess keeps ordered + nested list structure', /1\.\s+Step 1\n\s+- Sub A\n\s+- Sub B\n2\.\s+Step 2/.test(nestedListOut))
  assert('preprocess does not flatten nested list onto one line', !/Step 1 Sub A/.test(nestedListOut))

  const longerClose = '```js\nkeep-this-code\n````\n\n<script>BAD()</script>\n'
  const longerCloseOut = preprocessPage(longerClose)
  assert('markdown longer closing fence still ends the block', /keep-this-code/.test(longerCloseOut) && !/BAD\(\)/.test(longerCloseOut))

  const preTicks = `<!doctype html><html><body><pre><code>use \`\`\` fences</code></pre><p>after-pre</p></body></html>`
  const preTicksOut = preprocessPage(preTicks, base)
  assert('pre fence avoids backtick collision', /use ``` fences/.test(preTicksOut) && /after-pre/.test(preTicksOut))

  const long = 'word '.repeat(20_000)
  const shaped = toFetchPageResult('https://example.com/doc', 'jina', long, undefined, false, Date.now())
  assert('fetch result is not clipped', shaped.content === long && shaped.truncated === false && shaped.word_count > 10_000)
}

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
for (const fn of ['runFused', 'runFetchPage', 'runXSearch', 'describeLayer', 'switchLayer', 'invalidateSearchCaches', 'clearAllCaches', 'cacheSizes', 'xAuthCommands']) {
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
assert('pi subagent templates exist', piSubagentTemplatePaths().length === 2 && piSubagentTemplatePaths().every((p) => existsSync(p)))
assert('pi workflow prompts exist', piWorkflowPromptPaths().length === 2 && piWorkflowPromptPaths().every((p) => existsSync(p)))
const searcherMd = piSub.parseAgentMarkdown(readFileSync(piSub.resolveAgentPath('searcher'), 'utf8'), 'searcher.md')
const summarizerMd = piSub.parseAgentMarkdown(readFileSync(piSub.resolveAgentPath('summarizer'), 'utf8'), 'summarizer.md')
assert('pi searcher md name+tools', searcherMd?.name === 'searcher' && searcherMd.tools.join(',') === 'fused_search,fetch_page')
assert('pi summarizer md has no tools', summarizerMd?.name === 'summarizer' && summarizerMd.tools.length === 0)
const searcherArgs = piSub.buildChildCliArgs(searcherMd, 'q', '/tmp/p.md')
const summarizerArgs = piSub.buildChildCliArgs(summarizerMd, 'q', '/tmp/p.md')
assert('searcher child gets tools whitelist', searcherArgs.includes('--tools') && searcherArgs.includes('fused_search,fetch_page') && searcherArgs.includes('-e'))
assert('summarizer child gets --no-tools', summarizerArgs.includes('--no-tools') && !summarizerArgs.includes('--tools') && !summarizerArgs.includes('-e'))

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
  assert('dsh registers all tools', ['fused_search', 'fetch_page', 'x_search', 'research_parallel', 'search_stats'].every((n) => m.tools.has(n)))
  assert('dsh does not register deep_research', !m.tools.has('deep_research'))
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
  assert('pi registers all tools', ['fused_search', 'fetch_page', 'search-parallel-subagent', 'x_search'].every((n) => tools.has(n)))
  assert('pi does not register deep_research', !tools.has('deep_research'))
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
  const parallel = tools.get('search-parallel-subagent')
  await rejects('pi parallel rejects missing mode', () => parallel.execute('id', { query: 'q' }), /exactly one of/)
  await rejects('pi parallel rejects empty tasks', () => parallel.execute('id', { tasks: [] }), /must not be empty/)
  await rejects('pi parallel rejects unknown agent', () => parallel.execute('id', { agent: 'scout', task: 'x' }), /unknown agent/)
  assert('pi parallel extracts cited URLs', piSub.extractSourceUrls('see (https://en.wikipedia.org/wiki/Foo_(bar)) and https://a.com/x).').length === 2)
  assert('pi parallel entry points at adapter', piSub.SEARCH_BOOST_EXT.endsWith(join('adapters', 'pi', 'index.js')))
  assert('pi parallel transient detection', piSub.isTransientProviderTransportError('WebSocket closed') && !piSub.isTransientProviderTransportError('bad prompt'))
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
const injected = hostRuntime.piInjectPairs().map((p) => p.dest)
assert('pi install injects owned agents+prompts', injected.length === 4 && injected.every((f) => existsSync(f) && readFileSync(f, 'utf8').includes('search-boost: owned')))
const userPrompt = join(PATHS.pi.promptsDir, 'user-own.md')
writeFileSync(userPrompt, '# mine\n')
writeFileSync(join(process.env.PI_CODING_AGENT_DIR, 'extensions', 'other.js'), '// user file')
await AGENTS.pi.uninstall({ dryRun: false })
assert('pi uninstall removes only our shim', !existsSync(PATHS.pi.extension) && existsSync(join(process.env.PI_CODING_AGENT_DIR, 'extensions', 'other.js')))
assert('pi uninstall removes owned md and keeps user prompts', injected.every((f) => !existsSync(f)) && existsSync(userPrompt))
writeFileSync(PATHS.pi.extension, '// user-owned file')
await AGENTS.pi.uninstall({ dryRun: false })
assert('pi uninstall leaves foreign file at shim path', existsSync(PATHS.pi.extension))
rmSync(PATHS.pi.extension)
assert('pi print config mentions injected prompts', AGENTS.pi.printConfig().includes('/fast-parallel') && AGENTS.pi.printConfig().includes('pi install npm:search-boost'))
assert('dsh plugin add args', hostRuntime.dshPluginArgs('add', 'web').slice(0, 4).join(' ') === 'plugin --profile web add')
assert('dsh plugin remove args use package name', hostRuntime.dshPluginArgs('remove', 'headless').join(' ') === 'plugin --profile headless remove search-boost')
assert('dsh print config uses profile', AGENTS.dsh.printConfig({ profile: 'sdk' }).includes('--profile sdk add'))
const dshDry = await AGENTS.dsh.install({ dryRun: true, profile: 'web' })
assert('dsh dry-run install returns profile manifest path', dshDry[0].endsWith(join('profiles', 'web', 'package.json')))
mkdirSync(join(process.env.DSH_HOME, 'profiles', 'web'), { recursive: true })
writeFileSync(join(process.env.DSH_HOME, 'profiles', 'web', 'package.json'), JSON.stringify({ dependencies: { 'search-boost': '^0.2.0' }, dsh: { profile: { bundles: ['search-boost'] } } }))
assert('dsh configured when a profile depends on the package', agentDetected('dsh') && agentConfigured('dsh'))
assert('--profile flag parses', installOpts(parseFlags(['-t', 'dsh', '--profile', 'sdk'])).profile === 'sdk')

// package manifests
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
assert('package exports pi + dsh adapters', pkg.exports['./pi'] === './adapters/pi/index.js' && pkg.exports['./dsh'] === './adapters/dsh/index.js')
assert('package declares pi extension manifest', pkg.pi.extensions[0] === './adapters/pi/index.js')
assert('package declares dsh bundle patch', pkg.dsh.bundle.patch === './adapters/dsh/cordis.patch.yml' && existsSync(new URL('../adapters/dsh/cordis.patch.yml', import.meta.url)))
assert('cordis patch imports the dsh export', readFileSync(new URL('../adapters/dsh/cordis.patch.yml', import.meta.url), 'utf8').includes('name: search-boost/dsh'))
assert('package files ship adapters', pkg.files.includes('adapters/') && !pkg.files.includes('tools/'))

rmSync(TMP, { recursive: true, force: true })

if (failed) {
  console.error(`\n${failed} adapter test(s) failed`)
  process.exit(1)
}
console.log('\nAll adapter boundary tests passed.')
