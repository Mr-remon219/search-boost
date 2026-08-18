/**
 * Unit checks for fused_search engine failure surfacing.
 */
import { fusedSearch } from '../lib/search/fusion.js'
import {
  allAttemptedEnginesFailed,
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
