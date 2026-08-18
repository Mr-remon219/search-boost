/**
 * Unit checks for fused_search engine failure surfacing.
 */
import { fusedSearch } from '../lib/search/fusion.js'
import {
  allAttemptedEnginesFailed,
  annotateFusedLayerEngines,
  apiLayerFreeOnlyWarning,
  allocateResearchRound,
  formatAllEnginesFailedMessage,
  formatEngineStatsLine,
  formatFusedSummary,
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

if (failed) {
  console.error(`\n${failed} test(s) failed`)
  process.exit(1)
}
console.log('\nAll fusion error tests passed.')
