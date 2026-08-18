/**
 * Unit checks for fused_search engine failure surfacing.
 */
import { fusedSearch } from '../lib/search/fusion.js'
import { engineRegistry } from '../lib/search/engines.js'
import {
  KEY_NAMES,
  keyedPoolSummary,
  partialKeyedPoolWarning,
  readEngineRoutingFromDoc,
  resolveKeyedEngines,
} from '../lib/keys.mjs'
import {
  allAttemptedEnginesFailed,
  annotateFusedLayerEngines,
  apiLayerFreeOnlyWarning,
  allocateResearchRound,
  availableEngines,
  formatAllEnginesFailedMessage,
  formatEngineStatsLine,
  formatFusedSummary,
  layerTierTable,
} from '../lib/runtime.mjs'

let failed = 0

function assert(name, cond) {
  if (!cond) {
    console.error(`FAIL: ${name}`)
    failed++
  } else {
    console.log(`ok: ${name}`)
  }
}

const allFailStats = {
  bing: { used: true, errors: 1, note: 'bing: timeout' },
  ddg: { used: true, errors: 1, note: 'ddg: HTTP 202 (bot challenge)' },
  yahoo: { used: true, errors: 1, note: 'yahoo: http 403' },
  'exa-free': { used: true, errors: 1, note: 'exa-free: rate-limited (429)' },
}

const partialStats = {
  bing: { used: true, errors: 1, note: 'bing: timeout' },
  ddg: { used: true, errors: 0 },
  yahoo: { used: true, errors: 0 },
}

assert('allAttemptedEnginesFailed true', allAttemptedEnginesFailed(allFailStats))
assert('allAttemptedEnginesFailed false on partial', !allAttemptedEnginesFailed(partialStats))
assert('allAttemptedEnginesFailed false when unused', !allAttemptedEnginesFailed({ bing: { used: false, errors: 0 } }))

const engineLine = formatEngineStatsLine(allFailStats)
assert('formatEngineStatsLine lists FAIL', engineLine.includes('bing: FAIL') && engineLine.includes('ddg: FAIL (ddg: HTTP 202'))

const msg = formatAllEnginesFailedMessage({ query: 'test query', layer: 'free', engineStats: allFailStats })
assert('failure message mentions search_layer', msg.includes('search_layer api'))
assert('failure message mentions keys path', msg.includes('.search-boost-keys.json'))

const summary = formatFusedSummary({
  query: 'q',
  layer: 'free',
  tier: 'simple',
  results: [],
  tookMs: 12,
  cacheHit: false,
  engineStats: partialStats,
  warnings: ['ddg slow'],
})
assert('summary includes engines line', summary.includes('engines: bing: FAIL'))
assert('summary includes warnings', summary.includes('warnings: ddg slow'))

const freeOnlyWarn = apiLayerFreeOnlyWarning('api', ['bing', 'ddg', 'yahoo', 'exa-free'])
assert('apiLayerFreeOnlyWarning on api+free', freeOnlyWarn?.includes('layer api but using free engines only'))
assert('apiLayerFreeOnlyWarning null on free layer', apiLayerFreeOnlyWarning('free', ['bing']) === null)
assert('apiLayerFreeOnlyWarning null when keyed used', apiLayerFreeOnlyWarning('api', ['bing', 'tavily']) === null)
assert('apiLayerFreeOnlyWarning null with single keyed engine', apiLayerFreeOnlyWarning('api', ['bing', 'ddg', 'tavily']) === null)

const tavilyOnlyKeys = { tavily: 'tvly-test-key-12345678', brave: undefined, exa: undefined }
const emptyRouting = readEngineRoutingFromDoc({})
assert('resolveKeyedEngines single configured key', resolveKeyedEngines(tavilyOnlyKeys, emptyRouting).join() === 'tavily')
assert(
  'resolveKeyedEngines enabledEngines filter',
  resolveKeyedEngines(
    { tavily: 'a', brave: 'b', exa: 'c' },
    readEngineRoutingFromDoc({ enabledEngines: ['exa'] }),
  ).join() === 'exa',
)
assert(
  'resolveKeyedEngines per-engine enabled false',
  resolveKeyedEngines(
    { tavily: 'a', brave: 'b' },
    readEngineRoutingFromDoc({ engines: { brave: { enabled: false } } }),
  ).join() === 'tavily',
)

const partialSummary = keyedPoolSummary(tavilyOnlyKeys, emptyRouting)
const poolWarn = partialKeyedPoolWarning(partialSummary)
assert('partialKeyedPoolWarning when 1 of 3', poolWarn?.includes('1/3 keyed engine') && poolWarn?.includes('tavily'))
assert('partialKeyedPoolWarning null when all three', partialKeyedPoolWarning(keyedPoolSummary(
  { tavily: 'a', brave: 'b', exa: 'c' },
  emptyRouting,
)) === null)
assert('partialKeyedPoolWarning null when none enabled', partialKeyedPoolWarning(keyedPoolSummary(
  Object.fromEntries(KEY_NAMES.map((n) => [n, undefined])),
  emptyRouting,
)) === null)

process.env.TAVILY_API_KEY = 'tvly-env-key-12345678'
delete process.env.BRAVE_API_KEY
delete process.env.EXA_API_KEY
const enginesTavilyOnly = engineRegistry({ tavily: process.env.TAVILY_API_KEY, brave: undefined, exa: undefined })
const tierPool = layerTierTable('api').complex
const availableTavily = availableEngines(enginesTavilyOnly, tierPool)
assert('availableEngines api complex with tavily only', availableTavily.includes('tavily') && !availableTavily.includes('brave'))
delete process.env.TAVILY_API_KEY

const annotated = annotateFusedLayerEngines(
  { query: 'q', warnings: [], results: [], tier: 'simple', tookMs: 1 },
  'api',
  ['bing', 'ddg', 'tavily', 'brave'],
  ['bing', 'ddg', 'exa-free'],
)
assert('annotateFusedLayerEngines sets enginesRequested', annotated.enginesRequested?.includes('tavily'))
assert('annotateFusedLayerEngines sets enginesUsed', annotated.enginesUsed?.includes('exa-free'))
assert('annotateFusedLayerEngines adds api warning', annotated.warnings?.some((w) => w.includes('free engines only')))

const apiSummary = formatFusedSummary({
  query: 'q',
  layer: 'api',
  tier: 'simple',
  results: [],
  tookMs: 12,
  cacheHit: false,
  engineStats: partialStats,
  warnings: [freeOnlyWarn],
})
assert('summary warns api free-only', apiSummary.includes('layer api but using free engines only'))

const singleKeyedAnnotated = annotateFusedLayerEngines(
  { query: 'q', warnings: [], results: [], tier: 'complex', tookMs: 1 },
  'api',
  tierPool,
  ['bing', 'ddg', 'tavily'],
)
assert('single keyed engine no free-only warning', !singleKeyedAnnotated.warnings?.some((w) => w.includes('free engines only')))

assert('allocateResearchRound explicit', allocateResearchRound(3) === 3)
const autoA = allocateResearchRound()
const autoB = allocateResearchRound()
assert('allocateResearchRound auto-increment', autoA >= 1 && autoB === autoA + 1)

const fused = await fusedSearch({
  query: 'node mcp test',
  engines: ['bing', 'ddg'],
  maxResults: 3,
  layer: 'free',
  tier: 'simple',
  runOne: async () => { throw new Error('mock engine down') },
})
assert('fusedSearch records engineStats on errors', fused.results.length === 0 && allAttemptedEnginesFailed(fused.engineStats))
assert('fusedSearch engineStats notes', fused.engineStats.bing?.note === 'mock engine down')

const enabled = resolveKeyedEngines(
  { tavily: 'k1', brave: 'k2', exa: 'k3' },
  readEngineRoutingFromDoc({ enabledEngines: ['exa'] }),
)
assert('resolveKeyedEngines honors enabledEngines whitelist', enabled.length === 1 && enabled[0] === 'exa')

const registry = engineRegistry({ tavily: 'k1', brave: 'k2', exa: 'k3' }, new Set(['exa']))
assert('engineRegistry honors enabled set', registry.tavily.available() === false && registry.exa.available() === true)

const mockHit = async (_engine, q) => [{ title: q, url: 'https://example.com/score-test', snippet: 'snippet' }]
const scoreOpts = {
  query: 'score test',
  engines: ['exa'],
  maxResults: 2,
  layer: 'api',
  tier: 'simple',
  runOne: mockHit,
}
const singleKeyedFused = await fusedSearch({ ...scoreOpts, singleKeyedPool: true })
const discountedFused = await fusedSearch({ ...scoreOpts, singleKeyedPool: false })
const skipScore = singleKeyedFused.results[0]?.score ?? 0
const discScore = discountedFused.results[0]?.score ?? 0
assert('singleKeyedPool skips single-engine discount', skipScore > 0 && Math.abs(discScore / skipScore - 0.9) < 0.001)
assert('default single-engine discount applies', discScore < skipScore)

if (failed) {
  console.error(`\n${failed} test(s) failed`)
  process.exit(1)
}
console.log('\nAll fusion error tests passed.')
