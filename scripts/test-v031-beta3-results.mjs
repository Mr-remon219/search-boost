import './isolate-tests.mjs'
// Frozen beta.3 samples. Expectations were written with the rules, before the
// wall-time printout. Wall time is not a network measurement.
import assert from 'node:assert/strict'
import { normalizeSearchHit, normalizeUrl, displayUrl } from '../lib/search/results.js'
import { runFused, fusedResultIsError, fusedOutcome, formatAllEnginesFailedMessage, invalidateSearchCaches } from '../lib/runtime.mjs'

assert.equal(normalizeUrl('https://EX.com/a/?id=1&utm_source=z#one'), 'https://ex.com/a?id=1')
assert.equal(normalizeUrl('https://ex.com/a#one'), normalizeUrl('https://ex.com/a#two'))
assert.notEqual(normalizeUrl('https://ex.com/a?id=1'), normalizeUrl('https://ex.com/a?id=2'))
assert.equal(normalizeUrl('https://ex.com/a?id=1'), normalizeUrl('https://www.ex.com/a/?id=1#'))
assert.equal(displayUrl('https://ex.com/a#one'), 'https://ex.com/a#one')
assert.equal(normalizeSearchHit({ url: 'https://ex.com/a', title: null, snippet: 's' }).title, '')
assert.equal(normalizeSearchHit({ url: 'javascript:alert(1)', title: 'x' }), null)
assert.equal(normalizeSearchHit({ url: 'https://user:secret@ex.com/a', title: 'x' }), null)

function fake(name, impl) {
  return { available: () => true, search: impl }
}
const calls = []
const engines = {
  bing: fake('bing', async () => {
    calls.push('bing')
    return [{ title: '', url: 'https://ex.com/doc?id=1', snippet: 'from bing', summary: null }]
  }),
  ddg: fake('ddg', async () => {
    calls.push('ddg')
    return [{ title: 'Kept title', url: 'https://ex.com/doc?id=2', snippet: 'from ddg', summary: 'agent summary' }]
  }),
  'deepseek-search': fake('deepseek-search', async (query) => {
    calls.push(['deepseek-search', query])
    return [{ title: 'D', url: 'https://ex.com/same?id=1&utm_source=a', snippet: 'short', summary: '' }]
  }),
  tavily: fake('tavily', async () => {
    calls.push('tavily')
    return [{ title: 'T', url: 'https://ex.com/same?id=1&utm_source=b', snippet: '', summary: 'from tavily', siteName: 'Example' }]
  }),
}
const snapshot = (fingerprint) => () => ({ engines, routing: { enabledNames: [] }, fingerprint, capability: {} })

invalidateSearchCaches()
calls.length = 0
const fragments = await runFused({ query: 'fragments', engineList: ['bing', 'ddg'], complexity: 'simple' }, { snapshot: snapshot('fragments') })
assert.deepEqual(calls.sort(), ['bing', 'ddg'])
assert.equal(fragments.results.length, 2, 'different query ids stay separate')
assert.equal(fragments.outcome, 'results')
assert.equal(fusedResultIsError(fragments), false)
const titled = fragments.results.find((row) => row.url.endsWith('id=2'))
const untitled = fragments.results.find((row) => row.url.endsWith('id=1'))
assert.equal(titled.title, 'Kept title')
assert.equal(untitled.title, '')
assert.equal(untitled.summary, null)
assert.equal(Object.hasOwn(titled, 'summary'), true)
assert.equal(titled.summary, 'agent summary')
assert.equal(titled.provenance.length, 1)
assert.equal(untitled.provenance.length, 1)

calls.length = 0
engines.bing = fake('bing', async () => {
  calls.push('bing')
  return [{ title: '', url: 'https://ex.com/page#one', snippet: 'bing', summary: null }]
})
engines.ddg = fake('ddg', async () => {
  calls.push('ddg')
  return [{ title: 'Page title', url: 'https://ex.com/page#two', snippet: 'ddg', summary: 'kept summary' }]
})
const sameDoc = await runFused({ query: 'page', engineList: ['bing', 'ddg'], complexity: 'simple' }, { snapshot: snapshot('same-doc') })
assert.equal(sameDoc.results.length, 1)
assert.equal(sameDoc.results[0].url, 'https://ex.com/page#two')
assert.deepEqual(sameDoc.results[0].provenance.map((row) => row.url).sort(), ['https://ex.com/page#one', 'https://ex.com/page#two'])
assert.equal(sameDoc.results[0].title, 'Page title')
assert.equal(sameDoc.results[0].summary, 'kept summary')
assert.equal(sameDoc.results[0].provenance.length, 2)
assert.ok(sameDoc.results[0].provenance.some((row) => row.summary === null))
assert.ok(sameDoc.results[0].provenance.some((row) => row.summary === 'kept summary'))

calls.length = 0
engines.bing = fake('bing', async () => {
  calls.push('bing')
  return [{ title: 'Same page', url: 'https://ex.com/same?id=1&utm_source=a', snippet: 'bing', summary: null }]
})
const merged = await runFused({ query: 'same page', engineList: ['bing', 'tavily'], complexity: 'simple' }, { snapshot: snapshot('merged') })
assert.deepEqual(calls.sort(), ['bing', 'tavily'])
assert.equal(merged.results.length, 1, 'tracking parameters do not keep two copies')
assert.equal(merged.results[0].summary, 'from tavily')
assert.equal(merged.results[0].siteName, 'Example')
assert.equal(merged.results[0].provenance.length, 2)
assert.ok(merged.results[0].provenance.some((row) => row.summary === null))
assert.ok(merged.results[0].provenance.some((row) => row.summary === 'from tavily'))
assert.equal(merged.outcome, 'results')

calls.length = 0
const repeated = await runFused({ query: 'alpha', queries: ['alpha'], engineList: ['deepseek-search'], complexity: 'medium' }, { snapshot: snapshot('repeated') })
assert.equal(calls.length, 1, 'beta.2 dispatched this identical pair twice')
assert.deepEqual(calls[0], ['deepseek-search', 'alpha'])
assert.equal(repeated.engineStats['deepseek-search'].attempts, 1)
assert.equal(repeated.outcome, 'results')

calls.length = 0
engines['deepseek-search'] = fake('deepseek-search', async () => { calls.push('deepseek-search'); throw Object.assign(new Error('deepseek down'), { kind: 'http_401' }) })
const failed = await runFused({ query: 'only', engineList: ['deepseek-search'], complexity: 'simple' }, { snapshot: snapshot('failed') })
assert.deepEqual(calls, ['deepseek-search'])
assert.equal(failed.outcome, 'failed')
assert.equal(fusedResultIsError(failed), true)
assert.equal(failed.results.length, 0)

calls.length = 0
engines['deepseek-search'] = fake('deepseek-search', async () => { calls.push('deepseek-search'); return [] })
const empty = await runFused({ query: 'empty', engineList: ['deepseek-search'], complexity: 'simple' }, { snapshot: snapshot('empty') })
assert.deepEqual(calls, ['deepseek-search'])
assert.equal(empty.outcome, 'empty_success')
assert.equal(fusedResultIsError(empty), false)

calls.length = 0
engines.tavily = fake('tavily', async () => { calls.push('tavily'); throw Object.assign(new Error('tavily down'), { kind: 'http_401' }) })
engines.bing = fake('bing', async () => { calls.push('bing'); return [{ title: 'Kept', url: 'https://ex.com/kept', snippet: 'ok' }] })
const partial = await runFused({ query: 'partial', engineList: ['tavily', 'bing'], complexity: 'simple' }, { snapshot: snapshot('partial') })
assert.deepEqual(calls.sort(), ['bing', 'tavily'])
assert.equal(partial.outcome, 'partial')
assert.equal(fusedResultIsError(partial), false)
assert.equal(partial.results.length, 1)

calls.length = 0
const blocked = {
  'deepseek-search': { available: () => false, search: async () => { calls.push('deepseek-search'); return [] } },
  bing: { available: () => true, search: async () => { calls.push('bing'); return [{ title: 'Free', url: 'https://ex.com/free', snippet: 'no' }] } },
}
const unavailable = await runFused({ query: 'missing-key', engineList: ['deepseek-search'], complexity: 'simple' }, { snapshot: () => ({ engines: blocked, routing: { enabledNames: [] }, fingerprint: 'unavailable', capability: {} }) })
assert.deepEqual(calls, [])
assert.equal(unavailable.enginePool, 'api')
assert.equal(unavailable.outcome, 'unavailable')
assert.equal(fusedResultIsError(unavailable), true)
assert.doesNotMatch(unavailable.warnings.join('\n'), /requested free pool/)
const text = formatAllEnginesFailedMessage(unavailable)
assert.equal(text.includes('..'), false)
assert.equal(text.includes('。.'), false)
assert.match(text, /engine_pool=api did not run/)
assert.match(text, /config keys --show/)

engines['deepseek-search'] = fake('deepseek-search', async (query) => {
  calls.push(['deepseek-search', query])
  return [{ title: 'D', url: 'https://ex.com/timed', snippet: 'timed', summary: 'kept' }]
})
const samples = []
for (let i = 0; i < 5; i++) {
  const started = performance.now()
  const once = await runFused({ query: 'alpha', queries: ['alpha'], engineList: ['deepseek-search'], complexity: 'medium' }, { snapshot: snapshot(`time-${i}`) })
  samples.push({ ms: performance.now() - started, attempts: once.engineStats['deepseek-search'].attempts, rows: once.results.length, outcome: once.outcome })
}
const times = samples.map((row) => row.ms).sort((a, b) => a - b)
const median = times[2]
const range = times[4] - times[0]
console.log(`beta.3 fixture wall time n=5 medianMs=${median.toFixed(3)} rangeMs=${range.toFixed(3)} attempts=${samples.map((row) => row.attempts).join(',')} rows=${samples.map((row) => row.rows).join(',')} outcome=${samples.map((row) => row.outcome).join(',')}`)
console.log('wall time is in-process fixture work. No network limiter was measured. Verdict for network speed: inconclusive.')
assert.ok(samples.every((row) => row.attempts === 1 && row.rows === 1 && row.outcome === 'results'))
console.log('v0.3.1-beta.3 frozen result samples passed (fixture engines, no live provider).')
