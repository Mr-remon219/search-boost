#!/usr/bin/env node
import './isolate-tests.mjs'
// Actual host entries (MCP registerTool, Pi extension, DSH ToolRuntime) driven
// through the shared public facade with mocked Jev + engine HTTP. No injected
// hand-written core result: the real client, routing, fusion and screening run,
// and DSH validates the real output schema with Ajv.
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { Context } from '@deepseek-ai/cordis'
import { ToolRuntime, validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import Ajv from 'ajv'

const root = process.argv[2] ? pathToFileURL(`${process.argv[2]}/`).href : new URL('../', import.meta.url).href
const load = (path) => import(new URL(path, root).href)
const { registerAll } = await load('adapters/mcp/register.mjs')
const { default: piExtension } = await load('adapters/pi/index.js')
const { apply: dshApply } = await load('adapters/dsh/index.js')
const { writeKeysFile } = await load('lib/keys.mjs')
const { saveJevConfig, clearJevConfig } = await load('lib/jev-config.mjs')
const { setLayer } = await load('lib/layer-config.mjs')
const { clearAllCaches } = await load('lib/runtime.mjs')
const { __setUndiciLoaderForTests, closeFetchDispatchers } = await load('lib/search/ipv4-fetch.js')
const { ADAPTIVE_INPUT_SCHEMA } = await load('lib/search/screening/input.js')
const { ADAPTIVE_OUTPUT_SCHEMA } = await load('lib/search/screening/schema.js')
const { adaptiveSearchOutput } = await load('adapters/mcp/schemas.mjs')
const { saveToolPreferences } = await load('lib/tool-config.mjs')
const { researchResultsDir, saveResearchResultsV3 } = await load('lib/research-results.mjs')

const ajv = new Ajv({ strict: true, allowUnionTypes: true })
const validOutput = ajv.compile(ADAPTIVE_OUTPUT_SCHEMA)
const HOME = process.env.SEARCH_BOOST_HOME ?? process.env.HOME

writeKeysFile({ brave: 'engine-fixture-secret', enabledEngines: ['brave'] })
saveJevConfig({ apiKey: 'jev-fixture-secret' })
setLayer('api')
saveToolPreferences({ adaptive_search: true })

const INPUT = {
  questions: ['How does Node.js fetch support cancellation?'],
  intent: 'Find traceable implementation references and version limitations',
  preferences: ['Implementation details'],
  max_results: 3,
  page_size: 2,
}
const webDocs = (count) => Array.from({ length: count }, (_, i) => ({
  title: `Node fetch cancellation reference ${i}`,
  url: `https://ref${i}.example/source`,
  description: `Node.js fetch cancellation implementation reference with version information ${i}.`,
}))
const communityPosts = (count) => Array.from({ length: count }, (_, i) => ({
  title: `Community note ${i}`,
  url: `https://x.com/developer${i}/status/${1000000000000 + i}`,
  description: `First-hand community experience about fetch cancellation ${i}.`,
}))

const originalFetch = globalThis.fetch
const requests = []
const unexpectedHosts = []
let communityAnswer = 'disable'
let expectedQuestion = INPUT.questions[0]
let expectedIntent = INPUT.intent
let failAllEngines = false
let failFreeEngines = false
let usageOnWire = true
const ALLOWED_HOSTS = new Set(['api.search.brave.com', 'api.typesafe.ai', 'publish.x.com', 'www.bing.com', 'html.duckduckgo.com', 'search.yahoo.com', 'mcp.exa.ai'])
const node = (d) => ({ title: d.title, url: d.url, description: d.description })
const resultsFor = (query, count) => /x\.com|twitter\.com/.test(query) ? communityPosts(count) : webDocs(count)
const bingPage = (docs) => `<html><body>${docs.map((d) => `<li class="b_algo"><h2><a href="${d.url}">${d.title}</a></h2><p>${d.description}</p></li>`).join('')}</body></html>`
const ddgPage = (docs) => `<html><body>${docs.map((d) => `<a class="result__a" href="${d.url}">${d.title}</a><a class="result__snippet">${d.description}</a>`).join('')}</body></html>`
const yahooPage = (docs) => `<html><body>${docs.map((d) => `<div class="dd fst algo "><div class="compTitle"><a href="${d.url}">result</a></div><h3 class="title">${d.title}</h3><div class="compText"><p>${d.description}</p></div></div>`).join('')}</body></html>`
const exaText = (docs) => docs.map((d) => `Title: ${d.title}\nURL: ${d.url}\nHighlights: ${d.description}`).join('\n---\n')
const queryOf = (url) => url.searchParams.get('q') ?? url.searchParams.get('p') ?? ''
globalThis.fetch = async (raw, init) => {
  const url = new URL(String(raw))
  requests.push(`${url.hostname}${url.pathname}`)
  if (!ALLOWED_HOSTS.has(url.hostname)) {
    unexpectedHosts.push(url.href)
    throw new TypeError('fetch failed', { cause: Object.assign(new Error('fixture'), { code: 'ENOTFOUND' }) })
  }
  if (url.hostname !== 'api.typesafe.ai' && (failAllEngines || (failFreeEngines && url.hostname !== 'api.search.brave.com'))) {
    throw new TypeError('fetch failed', { cause: Object.assign(new Error('fixture'), { code: 'ENOTFOUND' }) })
  }
  if (url.hostname === 'api.search.brave.com') {
    return Response.json({ web: { results: resultsFor(queryOf(url), Number(url.searchParams.get('count') ?? 10)).map(node) } })
  }
  if (url.hostname === 'www.bing.com') return new Response(bingPage(resultsFor(queryOf(url), Number(url.searchParams.get('count') ?? 10)).map(node)), { status: 200 })
  if (url.hostname === 'html.duckduckgo.com') return new Response(ddgPage(resultsFor(queryOf(url), 10).map(node)), { status: 200 })
  if (url.hostname === 'search.yahoo.com') return new Response(yahooPage(resultsFor(queryOf(url), 10).map(node)), { status: 200 })
  if (url.hostname === 'mcp.exa.ai') {
    const body = JSON.parse(init?.body ?? '{}')
    if (body.method === 'initialize') return Response.json({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-03-26', capabilities: {}, serverInfo: { name: 'exa-fixture', version: 'fixture' } } }, { headers: { 'mcp-session-id': 'fixture-session' } })
    if (body.id === undefined) return new Response('', { status: 202, headers: { 'mcp-session-id': 'fixture-session' } })
    const query = body.params?.arguments?.query ?? ''
    return Response.json({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: exaText(resultsFor(query, Number(body.params?.arguments?.numResults ?? 5)).map(node)) }] } }, { headers: { 'mcp-session-id': 'fixture-session' } })
  }
  if (url.hostname === 'publish.x.com') {
    return Response.json({ author_name: 'Fixture author', author_url: 'https://x.com/fixture', html: '<blockquote>Fixture community post full text</blockquote>' })
  }
  assert.equal(url.hostname, 'api.typesafe.ai', `all non-fixture network is forbidden: ${url.href}`)
  const wire = JSON.parse(init.body)
  assert.equal(url.pathname.endsWith('/systemone'), true)
  assert.equal(wire.model, 'jev-latest')
  assert.equal(wire.state.question, expectedQuestion, 'the original question is sent unchanged')
  assert.equal(wire.state.intent, expectedIntent, 'the original intent is sent unchanged')
  const answers = Object.fromEntries(Object.entries(wire.questions).map(([id]) => [id, {
    type: 'choice',
    choice: id === 'strategy.ranking' ? 'research'
      : id === 'strategy.community' ? communityAnswer
        : id.startsWith('safety.') ? 'clear'
          : id.startsWith('value.') ? '4'
            : id.startsWith('discount.') ? 'none'
              : 'match',
    confidence: 0.8,
  }]))
  return Response.json({
    model: 'jev-fixture-2026-10',
    answers,
    ...(usageOnWire ? { usage: { input_tokens: 1200, output_tokens: 300 } } : {}),
  })
}
__setUndiciLoaderForTests(async () => ({ ...(await import('undici')), fetch: (...args) => globalThis.fetch(...args) }))

const server = new McpServer({ name: 'screening-host-fixture', version: '1.0.0' })
const stop = registerAll(server)
const client = new Client({ name: 'fixture', version: '1.0.0' })
const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair()
const ctx = new Context()
ctx.provide('systemPrompt'); ctx.set('systemPrompt', { tools() {}, section() {} })
let nativeSearchProvider
ctx.provide('web'); ctx.set('web', { registerSearchProvider(provider) { nativeSearchProvider = provider }, registerFetchProvider() {} })
ctx.provide('commands'); ctx.set('commands', { register() {} })
const dshTools = new ToolRuntime(ctx); dshApply(ctx)
const piTools = new Map(), piHandlers = new Map()
piExtension({ registerTool: (tool) => piTools.set(tool.name, tool), registerCommand() {}, on: (name, handler) => piHandlers.set(name, handler) })

const adaptive = (host) => host === 'mcp' ? client : host === 'pi' ? piTools.get('adaptive_search') : dshTools.get('adaptive_search')
const call = async (host, args) => {
  if (host === 'mcp') return client.callTool({ name: 'adaptive_search', arguments: args })
  if (host === 'pi') return piTools.get('adaptive_search').execute('fixture', args, new AbortController().signal)
  return dshTools.get('adaptive_search').execute(args, { signal: new AbortController().signal })
}
const structured = (host, result) => host === 'mcp' ? result.structuredContent : host === 'pi' ? result.details : result
const bodyText = (host, result) => host === 'mcp' ? result.content.map((part) => part.text).join('\n')
  : host === 'pi' ? result.content.map((part) => part.text).join('\n') : dshTools.get('adaptive_search').output.render({}, result).map((part) => part.text).join('\n')

try {
  await server.connect(serverTransport); await client.connect(clientTransport)

  // ---- shared schema agreement across the three real host entries --------
  const listed = (await client.listTools()).tools.find((tool) => tool.name === 'adaptive_search')
  assert.ok(listed, 'adaptive_search is registered in MCP')
  assert.deepEqual(Object.keys(listed.inputSchema.properties).sort(), Object.keys(ADAPTIVE_INPUT_SCHEMA.properties).sort())
  assert.equal(listed.inputSchema.additionalProperties, false)
  assert.deepEqual(piTools.get('adaptive_search').parameters, ADAPTIVE_INPUT_SCHEMA)
  assert.deepEqual(Object.keys(dshTools.get('adaptive_search').parameters.properties).sort(), Object.keys(ADAPTIVE_INPUT_SCHEMA.properties).sort())
  for (const name of ['adaptive_search', 'fused_search', 'x_search']) {
    assert.equal(dshTools.get(name).timeoutMs, undefined, `no self-imposed whole-call timeout survives on DSH ${name}`)
  }
  console.log('ok: MCP/Pi/DSH translate the same shared adaptive input schema')

  // ---- successful new run with explicit community=false -------------------
  for (const host of ['mcp', 'pi', 'dsh']) {
    clearAllCaches()
    const result = await call(host, { ...INPUT, community: false })
    const value = structured(host, result)
    assert.equal(result.isError, undefined ?? result.isError)
    assert.equal(validOutput(value), true, `${host}: ${JSON.stringify(validOutput.errors)}`)
    assert.equal(value.schemaVersion, 6)
    assert.equal(value.policyVersion, 'fused-screening-mix-v2-prototype')
    assert.equal(value.judgementPolicyVersion, 'screening-judgement-v4-no-scope-no-language')
    assert.equal(value.strategyPolicyVersion, 'screening-strategy-v2-community-no-language')
    assert.equal(value.admissionPolicyVersion, 'no-scope-v1')
    assert.equal(value.run.ranking, 'research')
    assert.deepEqual(value.run.community, {
      input: false, source: 'explicit', choice: null, requested: false, effective: false,
      outcome: 'not_requested', cacheHit: false, reason: null, usage: {},
    }, 'no community branch was requested: no counter is reported, and none is invented')
    assert.equal(value.selection.requested, 3)
    assert.equal(value.selection.incomplete, false)
    assert.equal(value.totalResults, 3)
    assert.equal(value.pageResults, 2)
    assert.match(value.nextCursor, /^s6:[a-f0-9-]{36}\.\d+$/)
    assert.equal(value.results.every((row) => row.rank >= 1 && row.valueLevel >= 3), true)
    assert.equal(value.results.every((row) => row.engines.length > 0 && row.engines.every((name) => ['brave', 'bing', 'ddg', 'yahoo', 'exa-free'].includes(name))), true)
    assert.equal(value.results.every((row) => row.url.startsWith('https://ref')), true)
    assert.equal(value.diagnostics.snapshotCandidates >= 3, true)
    assert.equal(value.run.host, host)
    for (const field of ['keywordProgress', 'coverageComplete', 'convergence', 'retrievalSufficient', 'finalReview', 'scopeSummary']) {
      assert.equal(field in value, false, `${host}: retired v3 field ${field} must not appear`)
    }
    const text = bodyText(host, result)
    assert.match(text, /https:\/\/ref0\.example\/source/, `${host}: reviewed material reaches the model-visible body`)
    assert.match(text, new RegExp(value.nextCursor.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `${host}: the cursor reaches the text body`)
    assert.equal(piTools.get('adaptive_search') === undefined, false)
    if (host === 'mcp') assert.ok(result.content.map((part) => part.text).join('\n').includes(JSON.stringify(value)), 'MCP returns the complete result body')
  }
  console.log('ok: one N_off run produces the same schema-v5 contract through MCP, Pi and DSH')

  // ---- automatic community: same single strategy request ------------------
  communityAnswer = 'enable'
  clearAllCaches()
  const auto = await call('mcp', { ...INPUT })
  const autoValue = auto.structuredContent
  assert.equal(validOutput(autoValue), true, JSON.stringify(validOutput.errors))
  assert.equal(autoValue.run.community.input, 'auto')
  assert.equal(autoValue.run.community.source, 'judge')
  assert.equal(autoValue.run.community.choice, 'enable')
  assert.equal(autoValue.run.community.requested, true)
  assert.equal(autoValue.run.community.effective, true)
  assert.equal(autoValue.run.community.outcome, 'succeeded')
  assert.equal(autoValue.run.strategy.community.choice, 'enable')
  assert.equal(autoValue.selection.incomplete, false)
  assert.equal(autoValue.totalResults, 3)
  assert.equal(autoValue.pageResults, 2)
  assert.equal(autoValue.usage.jevCalls >= 2, true, 'one strategy call plus the screening batches')
  assert.equal(autoValue.usage.jevInputTokens, autoValue.usage.jevCalls * 1200, 'real reported tokens are summed across every logical call')
  assert.equal(autoValue.usage.jevOutputTokens, autoValue.usage.jevCalls * 300)
  assert.equal(autoValue.usage.engineHttpRequests, null, 'provider-internal HTTP attempts stay unknown')
  assert.equal(requests.filter((entry) => entry.startsWith('api.typesafe.ai')).length >= 2, true)
  assert.equal(autoValue.results.some((row) => row.url.includes('x.com')), true, 'community material competes in the same snapshot and selection')
  assert.equal(autoValue.run.community.usage.logicCalls, 1, 'one community branch execution')
  assert.equal(autoValue.run.community.usage.engineRequests >= 1, true, 'the credential-free fallback dispatches real engines')
  assert.equal(autoValue.run.community.usage.httpAttempts, null, 'provider-internal HTTP attempts stay unknown')
  assert.equal(autoValue.run.community.usage.officialAttempted, false)
  assert.equal(autoValue.run.community.usage.fallbackAttempted, true)
  assert.equal(autoValue.run.community.usage.dispatchedNow, true)
  assert.equal(autoValue.run.community.usage.inFlight, false)
  assert.equal(autoValue.diagnostics.snapshotCandidates, 32)
  console.log('ok: community is decided inside the same strategy request and its execution status is structured')

  // unknown answer falls back to no community and stays disclosed
  communityAnswer = 'unknown'
  clearAllCaches()
  const unknown = (await call('mcp', { ...INPUT })).structuredContent
  assert.equal(validOutput(unknown), true)
  assert.equal(unknown.run.community.choice, 'unknown')
  assert.equal(unknown.run.community.requested, false)
  assert.equal(unknown.run.community.outcome, 'not_requested')
  assert.equal(unknown.selection.incomplete, false)
  assert.equal(unknown.warnings.some((warning) => /community choice unknown/.test(warning)), true)
  communityAnswer = 'disable'

  // ---- pagination and restore are zero-network ---------------------------
  clearAllCaches()
  const first = (await call('mcp', { ...INPUT, community: false })).structuredContent
  const before = requests.length
  for (const host of ['mcp', 'pi', 'dsh']) {
    const page = await call(host, { cursor: first.nextCursor, page_size: 1 })
    const value = structured(host, page)
    assert.equal(validOutput(value), true)
    assert.equal(value.results.length, 1)
    assert.deepEqual(value.selection, first.selection, `${host}: page_size must not change selection`)
    assert.equal(value.results[0].rank, 3)
    assert.equal(value.nextCursor, null)
  }
  assert.equal(requests.length, before, 'cursor reads never touch the network')
  const saved = (await call('mcp', { ...INPUT, community: false, save_results: true, page_size: 1 })).structuredContent
  assert.equal(typeof saved.savedResultId, 'string')
  const afterSave = requests.length
  clearAllCaches()
  const restored = (await call('pi', { saved_result_id: saved.savedResultId, page_size: 2 })).details
  assert.equal(validOutput(restored), true)
  assert.equal(restored.savedResultId, saved.savedResultId)
  assert.equal(restored.totalResults, 3)
  assert.equal(restored.results.length, 2)
  assert.match(restored.nextCursor, /^s6:/)
  assert.equal(requests.length, afterSave, 'a saved_result_id restore performs no network call')
  assert.equal(readdirSync(researchResultsDir()).length, 1)
  console.log('ok: s5 pagination and v2 restore stay offline through every host')

  // ---- historical v1 restore -------------------------------------------
  const legacyId = '44444444-4444-4444-8444-444444444444'
  writeFileSync(join(researchResultsDir(), `${legacyId}.json`), JSON.stringify({
    format: 'search-boost-research-v1', id: legacyId, savedAt: '2026-10-01T00:00:00.000Z',
    results: [{ url: 'https://legacy.example/a', title: 'Legacy A', description: 'Stored v1 passage' }],
    metadata: {
      coverageComplete: false, stopReason: 'not_configured', warnings: [], schemaVersion: 3,
      inputSummary: { question: 'Legacy question', intent: 'legacy intent', keywords: ['k'], constraints: [], constraintPolicy: 'explicit_per_material' },
    },
  }, null, 2))
  const historical = await call('dsh', { saved_result_id: legacyId })
  assert.equal(validOutput(historical), true, JSON.stringify(validOutput.errors))
  assert.deepEqual(historical.restoration, { historical: true, originalFormat: 'search-boost-research-v1', originalSchemaVersion: 3 })
  assert.equal('selection' in historical, false)
  assert.equal(historical.totalResults, 1)
  assert.match(bodyText('dsh', historical), /historical/i)
  const mcpHistorical = await call('mcp', { saved_result_id: legacyId })
  assert.equal(mcpHistorical.isError, undefined, 'reading a snapshot whose stored stopReason was not_configured is a successful read, not this call\'s failure')
  assert.equal(mcpHistorical.structuredContent.restoration.historical, true)
  assert.equal(/Jev is not configured/.test(mcpHistorical.content.map((part) => part.text).join('\n')), false)
  assert.equal(requests.length, afterSave, 'historical restores perform no network call')
  console.log('ok: the historical v1 branch reaches every host without inventing v5 fields or reporting a false failure')

  // ---- strict input migration at each host ------------------------------
  for (const field of ['keywords', 'tasks', 'targets', 'facts', 'time_range']) {
    const mcpBad = await call('mcp', { ...INPUT, [field]: [] })
    assert.equal(mcpBad.isError, true, `mcp must refuse retired ${field}`)
    await assert.rejects(call('pi', { ...INPUT, [field]: [] }), new RegExp(field === 'keywords' ? 'keywords|invalid' : 'invalid|Unsupported'), `pi must refuse retired ${field}`)
    await assert.rejects(call('dsh', { ...INPUT, [field]: [] }), /invalid arguments/, `dsh must refuse retired ${field}`)
  }
  const constrained = await call('mcp', { ...INPUT, constraints: ['Only official sources'] })
  assert.equal(constrained.isError, true)
  assert.match(constrained.content.map((part) => part.text).join('\n'), /adaptive_constraints_removed/)
  const missingIntent = await call('mcp', { questions: ['Only a question'] })
  assert.equal(missingIntent.isError, true)
  assert.match(missingIntent.content.map((part) => part.text).join('\n'), /intent is required/)
  expectedQuestion = 'Node.js 22 或 24 如何取消 fetch？排除实验性 API。'
  expectedIntent = '寻找可追溯的实现说明与版本限制，并保留反例。'
  const chinese = (await call('mcp', {
    questions: [expectedQuestion],
    intent: expectedIntent,
    community: false,
    max_results: 2,
  })).structuredContent
  expectedQuestion = INPUT.questions[0]
  expectedIntent = INPUT.intent
  assert.equal(validOutput(chinese), true)
  assert.equal(chinese.results.length, 2, 'a non-English question runs the same flow with the original text')
  assert.equal(requests.length > before, true)
  console.log('ok: retired fields, non-empty constraints and missing intent are refused at the host boundary; non-English input still runs')

  // ---- real failure paths ---------------------------------------------
  clearJevConfig()
  // Semantic invalid input is rejected before Jev/tool configuration checks,
  // even with the public entry locked. Valid reads still cannot bypass the lock.
  const beforeInvalid = requests.length
  const invalidWhileLocked = await call('mcp', { questions: ['Q?'] })
  assert.equal(invalidWhileLocked.isError, true)
  assert.match(invalidWhileLocked.content.map(part => part.text).join('\n'), /intent is required/)
  await assert.rejects(call('pi', { questions: ['Q?'] }), /intent is required/)
  await assert.rejects(call('dsh', { questions: ['Q?'] }), /intent is required/)
  assert.equal(requests.length, beforeInvalid)
  const locked = await call('mcp', { ...INPUT })
  assert.equal(locked.isError, true)
  assert.match(locked.content.map((part) => part.text).join('\n'), /Judgment model not configured/)
  saveJevConfig({ apiKey: 'jev-fixture-secret' })
  saveToolPreferences({ adaptive_search: false })
  const off = await call('mcp', { ...INPUT })
  assert.equal(off.isError, true)
  await assert.rejects(call('dsh', { ...INPUT }), /Disabled by user/)
  assert.equal((await call('mcp', { saved_result_id: saved.savedResultId })).isError, true, 'the explicit OFF switch also blocks saved reads')
  saveToolPreferences({ adaptive_search: true })
  usageOnWire = false
  failAllEngines = true
  clearAllCaches()
  for (const host of ['mcp', 'pi', 'dsh']) {
    clearAllCaches()
    const response = await call(host, { ...INPUT, community: false })
    const failed = structured(host, response)
    assert.equal(validOutput(failed), true, JSON.stringify(validOutput.errors))
    assert.equal(failed.results.length, 0)
    assert.equal(failed.diagnostics.snapshotCandidates, 0)
    assert.equal(failed.diagnostics.collected, 0)
    assert.equal(failed.stopReason, 'all_engines_failed', host)
    assert.equal(failed.run.halted, 'all_engines_failed')
    assert.equal(failed.error, 'all_engines_failed')
    assert.equal(failed.selection.targetMet, false)
    assert.equal(failed.selection.incomplete, true)
    assert.equal(failed.usage.jevCalls, 1, 'only strategy runs; an unavailable pool is not screened')
    assert.equal(failed.usage.jevInputTokens, null, 'unreported tokens stay unknown')
    assert.equal(Object.values(failed.run.engineStats).every(stat => stat.successes === 0 && stat.errors > 0), true)
    if (host === 'mcp') assert.equal(response.isError, true, 'MCP must expose the failure in its outer envelope')
    assert.match(bodyText(host, response), /all_engines_failed/)
  }
  clearAllCaches()
  await assert.rejects(nativeSearchProvider.search({ query: INPUT.questions[0], maxResults: 6 }), /no engine could answer/)
  failAllEngines = false
  usageOnWire = true

  // A successful empty result (domain filtering) and a mixed failure with one
  // successful empty response are BOTH ordinary zero-hit searches, not outages.
  expectedQuestion = 'fixture empty search site:nomatch.example'
  for (const partial of [false, true]) {
    failFreeEngines = partial
    for (const host of ['mcp', 'pi', 'dsh']) {
      clearAllCaches()
      const response = await call(host, { ...INPUT, questions: [expectedQuestion], community: false })
      const empty = structured(host, response)
      assert.equal(validOutput(empty), true, JSON.stringify(validOutput.errors))
      assert.equal(empty.results.length, 0)
      assert.equal(empty.stopReason, 'candidate_pool_exhausted')
      assert.equal(empty.selection.incomplete, false)
      assert.equal(empty.run.halted, null)
      assert.equal(empty.error, undefined)
      assert.equal(Object.values(empty.run.engineStats).some(stat => stat.successes > 0), true)
      assert.equal(Object.values(empty.run.engineStats).some(stat => stat.errors > 0), partial)
      if (host === 'mcp') assert.notEqual(response.isError, true)
    }
    clearAllCaches()
    const direct = await dshTools.get('fused_search').execute({ query: expectedQuestion, community: false }, {})
    assert.deepEqual(direct.results, [])
    assert.equal(Object.values(direct.engineStats).filter(stat => stat.successes > 0).length, partial ? 1 : 5)
    clearAllCaches()
    const native = await nativeSearchProvider.search({ query: expectedQuestion, maxResults: 6 })
    assert.deepEqual(native.sources, [])
    assert.match(native.content, /0 sources/)
  }
  // Partial failure also retains usable successful results.
  expectedQuestion = INPUT.questions[0]
  clearAllCaches()
  const partial = structured('pi', await call('pi', { ...INPUT, community: false }))
  assert.equal(partial.results.length > 0, true)
  assert.equal(partial.run.halted, null)
  assert.equal(partial.error, undefined)
  failFreeEngines = false
  console.log('ok: all-failed, successful-empty and partial-success states agree across hosts and DSH native provider')
  assert.deepEqual(unexpectedHosts, [], 'no host outside the fixture set was contacted')
  console.log('ok: locked/disabled entries and real engine failures stay honest at the host boundary')
} finally {
  stop(); await client.close(); await server.close()
  piHandlers.get('session_shutdown')?.()
  saveToolPreferences({ adaptive_search: true })
  clearJevConfig()
  rmSync(researchResultsDir(), { recursive: true, force: true })
  mkdirSync(HOME, { recursive: true })
  globalThis.fetch = originalFetch
  await closeFetchDispatchers()
  __setUndiciLoaderForTests(null)
}
console.log('screening host fixtures: MCP/Pi/DSH real entries, shared schema union, strict migration, pagination, persistence and failures PASS')
