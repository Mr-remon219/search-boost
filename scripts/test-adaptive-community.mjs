#!/usr/bin/env node
import './isolate-tests.mjs'
import assert from 'node:assert/strict'
import { runAdaptiveSearch, runFused, runXSearch, clearAllCaches } from '../lib/runtime.mjs'
import { normalizeAdaptiveInput } from '../lib/search/screening/input.js'
import { communitySearch } from '../lib/community/service.mjs'
import { CommunityRegistry } from '../lib/community/registry.mjs'
import { existingXProvider } from '../lib/community/providers/x.mjs'
import { webIndexProvider } from '../lib/community/providers/web.mjs'
import { summarizeCommunityChannel, publicEvidenceProvenance } from '../lib/community/evidence.mjs'
import { saveResearchResultsV3, loadResearchResults } from '../lib/research-results.mjs'
import { makeHarness, forbiddenDeps, outputValidator } from './screening-run-fixture.mjs'

const question = 'Node migration developer experience'
const input = { questions: [question], intent: 'Find first-hand migration evidence', community: ['reddit', 'zhihu'],
  platform_options: { reddit: { subreddits: ['node'], max_pages: 1, allowed_authors: ['alice'] }, zhihu: { content_type: 'answer', from_date: null } }, max_results: 8 }
// Use a real implemented archive source identity; configuration never loads code.
const native = {
  id: 'reddit-arctic', platform: 'reddit', label: 'Offline archive fixture', version: 1, operations: ['keyword'], retrievalMode: 'archive',
  validateConfig: () => ({}), describeAvailability: () => ({ ready: true }),
}
native.search = async function(args) {
  observed.push({ platform: 'reddit', args })
  return { via: 'archive', items: [
    { url: 'https://www.reddit.com/r/node/comments/abc/', title: question, text: 'First-hand Node migration developer experience with traceable reproduction details.', author: 'alice', published: '2026-01-02', engineRanks: { 'community-reddit-arctic': 1 } },
    { url: 'https://www.reddit.com/r/node/comments/def/', title: question, text: 'Other author migration evidence with enough text.', author: 'bob', published: '2026-01-02', engineRanks: { 'community-reddit-arctic': 2 } },
  ], enginesUsed: ['community-reddit-arctic'], engineStats: { 'community-reddit-arctic': { used: true, attempts: 1, successes: 1, errors: 0 } } }
}
const registry = new CommunityRegistry().register(native).register(existingXProvider).register(webIndexProvider('zhihu')).register(webIndexProvider('bilibili')).register(webIndexProvider('xiaohongshu'))
const config = { backends: registry.list().map(provider => ({ id: `${provider.platform}-fixture`, provider: provider.id, enabled: true, config: {} })) }
let observed = [], webCalls = 0, communityCalls = 0
const answerUrl = 'https://www.zhihu.com/question/123/answer/456'
const engine = { available: () => true, async search() { webCalls++; return [{ url: 'https://docs.example/migration', title: question, snippet: 'Primary implementation migration documentation and reproducible change details.' }] } }
const state = { engines: { bing: engine }, fingerprint: 'adaptive-community-fixture', capability: { availableEngines: ['bing'], x: { official: { available: true }, fallback: { available: true } } } }
const snapshot = () => state
const service = (args, context) => {
  communityCalls++
  return communitySearch(args, { ...context, registry, config, webSearch: async opts => {
    observed.push({ platform: 'zhihu', args: opts })
    return { results: [
      { url: answerUrl, title: question, snippet: 'Answer: first-hand Node migration experience with a detailed reproducible problem.', engineRanks: { bing: 1 } },
      { url: 'https://www.zhihu.com/question/123', title: question, snippet: 'Question without an answer.', engineRanks: { bing: 2 } },
    ] }
  } })
}
const validate = outputValidator()
const valid = result => assert.equal(validate(result), null)

// Fused must own the full platform-options integration before Adaptive can use it.
const fused = await runFused({ query: question, community: input.community, platform_options: input.platform_options, candidateSelection: 'snapshot' }, { snapshot, communityService: service })
assert.deepEqual(observed.find(row => row.platform === 'reddit').args.subreddits, ['node'])
assert.equal(observed.find(row => row.platform === 'reddit').args.max_pages, 1)
assert.ok(fused.results.some(row => row.url === answerUrl), JSON.stringify(fused))
assert.ok(!fused.results.some(row => row.url.endsWith('/def/')))
assert.ok(!fused.results.some(row => row.url === 'https://www.zhihu.com/question/123'))
assert.equal(webCalls, 1); assert.equal(communityCalls, 1)
console.log('ok: fused base shares independent platform parameters, archive/author scope and content categories')

clearAllCaches(); observed = []; webCalls = 0; communityCalls = 0
const harness = makeHarness({ state })
harness.deps.search = (args, runtimeState) => runFused(args, { snapshot: () => runtimeState, communityService: service })
const result = await runAdaptiveSearch(input, {}, harness.deps)
valid(result)
assert.equal(result.usage.fusedCalls, 1)
assert.equal(webCalls, 1); assert.equal(communityCalls, 1)
assert.deepEqual(Object.keys(harness.calls.jev[0].request.questions), ['strategy.ranking'])
assert.equal(result.run.community.platforms.length, 2)
assert.equal(result.run.community.channels.find(channel => channel.platform === 'reddit').retrieval_mode, 'archive')
assert.ok(result.results.some(row => row.provenance?.some(source => source.platform === 'reddit')))
assert.ok(!result.results.some(row => row.url.endsWith('/def/')))
assert.ok(!result.results.some(row => row.url === 'https://www.zhihu.com/question/123'))
console.log('ok: Adaptive screens one actual fused web/community snapshot, retains routes/provenance and does not call community pages')

for (const bad of [
  { ...input, community: false }, { ...input, community: undefined },
  { ...input, platform_options: { x: null } },
  { ...input, platform_options: { reddit: { max_pages: 0 } } },
  { ...input, platform_options: { reddit: { allowed_authors: ['alice'], excluded_authors: ['bob'] } } },
  { ...input, platform_options: { zhihu: { from_date: '2026-02-30' } } },
  { cursor: 's6:invalid', platform_options: null },
]) await assert.rejects(() => runAdaptiveSearch(bad, {}, forbiddenDeps))
assert.equal(normalizeAdaptiveInput({ ...input, platform_options: null }).platformOptions, null)
console.log('ok: wrong-platform, disabled/implicit selection, contradictory/invalid parameters and mixed read/search modes reject before any dependency')

clearAllCaches()
const noWeb = { ...state, engines: {}, fingerprint: 'community-without-web' }
const noWebHarness = makeHarness({ state: noWeb, route: () => ({ engineNames: [], enginePool: 'hybrid', effectiveWeights: {} }) })
noWebHarness.deps.search = (args, runtimeState) => runFused(args, { snapshot: () => runtimeState, communityService: service })
const nativeOnly = await runAdaptiveSearch({ ...input, community: ['reddit'], platform_options: { reddit: input.platform_options.reddit } }, {}, noWebHarness.deps)
valid(nativeOnly)
assert.ok(nativeOnly.results.some(row => row.url.includes('reddit.com')))
assert.equal(nativeOnly.usage.fusedCalls, 1)
assert.notEqual(nativeOnly.stopReason, 'no_engines')
console.log('ok: an explicit independent archive source is screened through fused even when no Web engine is available')

// Actual hosted X Core account and thread modes, not a second implementation.
for (const mode of ['user', 'thread', 'semantic', 'keyword']) {
  clearAllCaches()
  let officialCalls = 0
  const xQuery = mode === 'keyword' ? 'from:alice migration' : 'migration experience'
  const options = { type: mode, query: xQuery, ...(mode === 'user' ? { username: 'alice' } : mode === 'thread' ? { post_id: '123' } : { allowed_x_handles: ['alice'] }) }
  const xSearch = (args, deps) => runXSearch(args, { ...deps, officialSearch: async params => {
    officialCalls++
    assert.equal(params.type, mode)
    return { credential: 'fixture', data: mode === 'user' ? { id: '999', username: 'alice', name: 'Alice', bio: 'Node migration developer experience with reproducible implementation details.', created_at: '2020-01-01', recent_posts: [] }
      : [{ url: 'https://x.com/alice/status/123', text: 'Node migration developer experience with a reproducible implementation report.', created_at: '2026-01-02' }] }
  }, fallbackSearch: async () => ({ via: 'fixture', data: [] }) })
  const xService = (args, context) => communitySearch(args, { ...context, registry, config, xSearch })
  const xHarness = makeHarness({ state: noWeb, route: () => ({ engineNames: [], enginePool: 'hybrid', effectiveWeights: {} }) })
  xHarness.deps.search = (args, runtimeState) => runFused(args, { snapshot: () => runtimeState, communityService: xService })
  const xResult = await runAdaptiveSearch({ questions: [question], intent: input.intent, community: ['x'], platform_options: { x: options }, max_results: 1 }, {}, xHarness.deps)
  valid(xResult)
  assert.equal(officialCalls, 1)
  assert.equal(xResult.results.length, 1, JSON.stringify(xResult))
  assert.ok(xResult.results[0].engines.includes('x-official'))
  assert.equal(xResult.results[0].provenance.find(source => source.platform === 'x').content_type, mode === 'user' ? 'account' : 'post')
  if (mode === 'user') { assert.equal(xResult.results[0].url, 'https://x.com/alice'); assert.equal(xResult.results[0].published, null) }
}
console.log('ok: all four hosted X modes use the shared runtime once; account provider ranks survive without treating account creation as a post date')

clearAllCaches()
let acquisition = 0
const allPlatforms = ['reddit', 'x', 'bilibili', 'zhihu', 'xiaohongshu']
const chineseUrls = { bilibili: 'https://www.bilibili.com/video/BV1alpha', zhihu: answerUrl, xiaohongshu: 'https://www.xiaohongshu.com/explore/abcdef' }
const allService = (args, context) => {
  acquisition++
  return communitySearch(args, { ...context, registry, config,
    xSearch: (params, deps) => runXSearch(params, { ...deps, officialSearch: async () => ({ credential: 'fixture', data: [{ url: 'https://x.com/alice/status/123', text: 'Node migration developer experience with concrete implementation details.', created_at: '2026-01-02' }] }), fallbackSearch: async () => ({ via: 'fixture', data: [] }) }),
    webSearch: async opts => ({ results: [{ url: chineseUrls[opts.includeDomains[0].split('.')[0]], title: question, snippet: 'First-hand Node migration developer experience, with reproducible implementation details.', engineRanks: { bing: 1 } }] }),
  })
}
const allHarness = makeHarness({ state })
allHarness.deps.search = (args, runtimeState) => runFused(args, { snapshot: () => runtimeState, communityService: allService })
allHarness.deps.saveResults = saveResearchResultsV3
allHarness.deps.loadResults = loadResearchResults
const allInput = { ...input, community: allPlatforms, platform_options: { ...input.platform_options, x: { allowed_x_handles: ['alice'] }, bilibili: { content_type: 'video' }, xiaohongshu: { content_type: 'note' } }, max_results: 10, page_size: 2, save_results: true }
const first = await runAdaptiveSearch(allInput, {}, allHarness.deps)
valid(first)
assert.equal(acquisition, 1); assert.equal(first.usage.fusedCalls, 1)
assert.deepEqual(first.run.community.channels.map(channel => channel.platform), allPlatforms)
assert.ok(first.savedResultId)
const stored = loadResearchResults(first.savedResultId)
assert.deepEqual(stored.metadata.inputSummary.platform_options, allInput.platform_options)
for (const platform of allPlatforms) assert.ok(stored.results.some(row => row.provenance?.some(source => source.platform === platform)), platform)
assert.ok(stored.results.every(row => new Set(row.engines).size === row.engines.length))
const beforeReads = allHarness.calls.jev.length
allHarness.deps.search = () => { throw new Error('Snapshot reads must not retrieve') }
const next = await runAdaptiveSearch({ cursor: first.nextCursor, page_size: 50 }, {}, allHarness.deps)
valid(next)
const restored = await runAdaptiveSearch({ saved_result_id: first.savedResultId, page_size: 50 }, {}, allHarness.deps)
valid(restored)
assert.equal(acquisition, 1); assert.equal(allHarness.calls.jev.length, beforeReads)
assert.deepEqual(restored.results, stored.results)
assert.deepEqual(restored.run.community, first.run.community)
console.log('ok: five platforms compete in one snapshot; typed original provenance/options/routes persist and pages/restores perform zero new acquisition or judgment')
const largeHarness = makeHarness({ state })
largeHarness.deps.search = (args, runtimeState) => runFused(args, { snapshot: () => runtimeState, communityService: allService })
largeHarness.deps.saveResults = saveResearchResultsV3
const largeOptions = Object.fromEntries(allPlatforms.map(platform => [platform, { ...allInput.platform_options[platform], query: '迁'.repeat(2000) }]))
const large = await runAdaptiveSearch({ ...allInput, platform_options: largeOptions }, {}, largeHarness.deps)
valid(large)
assert.ok(large.savedResultId)
assert.equal(large.inputSummary.platform_options, undefined)
assert.equal(large.inputSummary.question, question)
assert.ok(large.warnings.some(warning => warning.includes('Platform parameter details were omitted')))
assert.deepEqual(loadResearchResults(large.savedResultId).metadata.inputSummary.platform_options, largeOptions)
console.log('ok: large nullable platform summaries respect page metadata bytes without altering the saved input, reviewed evidence or original question')

// Generated recency stays soft on non-X; caller bounds stay strict per edge.
const old = 'https://www.zhihu.com/question/222/answer/1', fresh = 'https://www.zhihu.com/question/222/answer/2', unknown = 'https://www.zhihu.com/question/222/answer/3'
const datedRows = [
  { url: old, published: '2020-01-02', engineRanks: { bing: 1 } },
  { url: fresh, published: '2026-01-02T01:00:00Z', engineRanks: { bing: 2 } },
  { url: unknown, engineRanks: { bing: 3 } },
].map(row => ({ ...row, title: question, snippet: 'Node migration developer experience with a detailed implementation report.' }))
const datedState = { ...state, fingerprint: 'platform-date-boundaries', engines: { bing: { available: () => true, search: async () => datedRows } } }
const datedService = (args, context) => communitySearch(args, { ...context, registry, config, webSearch: async () => ({ results: datedRows }) })
const dated = params => runFused({ query: question, community: ['zhihu'], candidateSelection: 'snapshot', recency: 'day', ...params }, { snapshot: () => datedState, communityService: datedService })
const soft = await dated({})
assert.equal(soft.results.length, 3)
const strictFrom = await dated({ platform_options: { zhihu: { from_date: '2026-01-01' } } })
assert.deepEqual(strictFrom.results.map(row => row.url), [fresh])
const strictTo = await dated({ platform_options: { zhihu: { to_date: '2021-01-01' } } })
assert.deepEqual(strictTo.results.map(row => row.url), [old], 'explicit upper bound must not make the soft generated lower bound hard')
const preciseBound = await dated({ platform_options: { zhihu: { from_date: '2026-01-02T00:30:00Z', to_date: '2026-01-02T01:30:00Z' } } })
assert.deepEqual(preciseBound.results.map(row => row.url), [fresh])
const reusedBound = await dated({ platform_options: { zhihu: { from_date: '2026-01-01' } } })
assert.equal(reusedBound.cacheHit, true)
assert.ok(reusedBound.communityChannels.every(channel => channel.cache_hit))
assert.equal(reusedBound.communityExecution.usage.dispatchedNow, false)
console.log('ok: per-edge hard dates cannot be bypassed by Web results; recency remains soft, precise native timestamps survive and distinct options partition caches')

let dependencies = 0
for (const bad of [
  { platform_options: { reddit: { subreddits: ['node'] } } },
  { community: ['zhihu'], platform_options: { reddit: null } },
  { community: ['reddit'], platform_options: { reddit: { allowed_authors: ['alice'], excluded_authors: ['bob'] } } },
]) await assert.rejects(() => runFused({ query: question, ...bad }, { snapshot: () => { dependencies++; return state } }))
assert.equal(dependencies, 0)
const explicitQuery = 'Caller-supplied platform query'
let actualWebQuery, actualPlatformQuery
const overridden = await runFused({ query: question, community: ['zhihu'], platform_options: { zhihu: { query: explicitQuery, content_type: 'answer' } }, candidateSelection: 'snapshot' }, {
  snapshot: () => ({ ...state, fingerprint: 'explicit-platform-query', engines: { bing: { available: () => true, search: async query => { actualWebQuery = query; return [] } } } }),
  communityService: (args, context) => communitySearch(args, { ...context, registry, config, webSearch: async opts => { actualPlatformQuery = opts.query; return { results: datedRows } } }),
})
assert.equal(actualWebQuery, question); assert.equal(actualPlatformQuery, explicitQuery)
assert.ok(overridden.results.length > 0)
console.log('ok: fused and Adaptive reject invalid platform options before configuration; an explicit platform query does not rewrite the Web question or use model expansion')
const boundedChannel = summarizeCommunityChannel({ platform: 'reddit', backend: 'reddit-default', provider: 'reddit-arctic', retrieval_mode: 'archive', status: 'ok',
  diagnostics: { coverage: 'unknown', checkpoint_key: 'PRIVATE_SENTINEL', raw: { cookie: 'PRIVATE_SENTINEL' } },
  usage: { requests: 1, token: 'PRIVATE_SENTINEL' }, engine_stats: { 'reddit-arctic': { results: 1, success: true, authorization: 'PRIVATE_SENTINEL' } },
  config: { token: 'PRIVATE_SENTINEL' },
})
assert.equal(boundedChannel.diagnostics.coverage, 'unknown')
assert.equal(JSON.stringify(boundedChannel).includes('PRIVATE_SENTINEL'), false)
const projected = publicEvidenceProvenance([{ engine: 'reddit-arctic', rank: 1, platform: 'reddit', retrieval_mode: 'archive', snippet: 'UNREVIEWED_PRIVATE_SENTINEL', raw: 'PRIVATE_SENTINEL' }])
assert.equal(projected.length, 1)
assert.equal(JSON.stringify(projected).includes('PRIVATE_SENTINEL'), false)
assert.equal(publicEvidenceProvenance(Array.from({ length: 70 }, () => ({ engine: 'bing', rank: 1 }))).length, 64)
console.log('ok: route/usage/provenance projections are bounded and closed; raw config/checkpoint/credentials and unreviewed duplicate snippets never enter Adaptive output')
