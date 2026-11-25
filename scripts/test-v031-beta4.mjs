import './isolate-tests.mjs'
import assert from 'node:assert/strict'
import * as z from 'zod'
import { runFused, fusedResultIsError, fusedOutcome, fusedHitToJson, invalidateSearchCaches } from '../lib/runtime.mjs'
import { fusedSearchOutput } from '../adapters/mcp/schemas.mjs'

const outputSchema = z.object(fusedSearchOutput)

function fake(impl) {
  return { available: () => true, search: impl }
}

function row(url, extra = {}) {
  return { title: 'T', url, snippet: 's', ...extra }
}

async function fuse(query, list, engines, fingerprint) {
  return runFused({ query, engineList: list, complexity: 'simple' }, {
    snapshot: () => ({ engines, routing: { enabledNames: [] }, fingerprint, capability: {} }),
  })
}

function summaryOf(result, engine) {
  const entry = result.results[0].provenance.find((item) => item.engine === engine)
  return Object.hasOwn(entry, 'summary') ? entry.summary : undefined
}

invalidateSearchCaches()
const page = 'https://ex.com/doc?id=1'
for (const [name, first, second] of [
  ['missing-then-null', {}, { summary: null }],
  ['null-then-missing', { summary: null }, {}],
]) {
  const out = await fuse('alpha', ['bing', 'ddg'], {
    bing: fake(async () => [{ title: 'alpha report', url: page, snippet: 's', ...first }]),
    ddg: fake(async () => [{ title: 'note', url: `${page}&utm_source=b`, snippet: 's', ...second }]),
  }, name)
  assert.equal(out.results.length, 1, name)
  if (!Object.hasOwn(first, 'summary') && second.summary === null) assert.equal(Object.hasOwn(out.results[0], 'summary'), false, name)
  if (first.summary === null && !Object.hasOwn(second, 'summary')) assert.equal(out.results[0].summary, null, name)
  const bingState = Object.hasOwn(first, 'summary') ? first.summary : undefined
  const ddgState = Object.hasOwn(second, 'summary') ? second.summary : undefined
  assert.equal(summaryOf(out, 'bing'), bingState)
  assert.equal(summaryOf(out, 'ddg'), ddgState)
}

const three = await fuse('alpha', ['bing', 'ddg', 'tavily'], {
  bing: fake(async () => [{ title: 'alpha report', url: page, snippet: 's' }]),
  ddg: fake(async () => [{ title: 'note', url: `${page}&utm_source=c`, snippet: 's', summary: null }]),
  tavily: fake(async () => [{ title: 'other', url: `${page}&utm_source=d`, snippet: 's', summary: '' }]),
}, 'three-empty')
assert.equal(Object.hasOwn(three.results[0], 'summary'), false)
assert.equal(summaryOf(three, 'bing'), undefined)
assert.equal(summaryOf(three, 'ddg'), null)
assert.equal(summaryOf(three, 'tavily'), '')

const filled = await fuse('alpha', ['bing', 'ddg', 'tavily'], {
  bing: fake(async () => [{ title: 'other', url: page, snippet: 's' }]),
  ddg: fake(async () => [{ title: 'note', url: `${page}&utm_source=c`, snippet: 's', summary: null }]),
  tavily: fake(async () => [{ title: 'alpha report', url: `${page}&utm_source=d`, snippet: 'ui line', summary: 'agent text' }]),
}, 'three-text')
assert.equal(filled.results[0].summary, 'agent text')
assert.equal(filled.results[0].snippet, 'ui line')
assert.notEqual(filled.results[0].summary, filled.results[0].snippet)
assert.equal(summaryOf(filled, 'bing'), undefined)
assert.equal(summaryOf(filled, 'ddg'), null)
assert.equal(summaryOf(filled, 'tavily'), 'agent text')

const distinct = await fuse('alpha', ['bing', 'ddg'], {
  bing: fake(async () => [{ title: 'alpha report', url: page, snippet: 'left line', summary: 'left summary' }]),
  ddg: fake(async () => [{ title: 'note', url: `${page}&utm_source=e`, snippet: 'right line', summary: 'right summary' }]),
}, 'distinct-text')
assert.equal(distinct.results[0].summary, 'left summary')
assert.equal(distinct.results[0].snippet, 'left line')
assert.equal(summaryOf(distinct, 'ddg'), 'right summary')
assert.notEqual(distinct.results[0].summary, distinct.results[0].snippet)

const failed = await fuse('down', ['bing'], {
  bing: fake(async () => { throw new Error('fixture down') }),
}, 'failed')
assert.equal(failed.outcome, 'failed')
assert.equal(failed.results.length, 0)
assert.equal(fusedResultIsError(failed), true)

const partial = await fuse('alpha', ['bing', 'ddg'], {
  bing: fake(async () => [{ title: 'alpha report', url: page, snippet: 's', summary: 'kept' }]),
  ddg: fake(async () => { throw new Error('fixture down') }),
}, 'partial')
assert.equal(partial.outcome, 'partial')
assert.equal(fusedResultIsError(partial), false)

const cited = await fuse('chapter', ['bing', 'ddg'], {
  bing: fake(async () => [{ title: 'Chapter', url: 'https://ex.com/guide#install', snippet: 'steps' }]),
  ddg: fake(async () => [{ title: 'Chapter', url: 'https://ex.com/guide#usage', snippet: 'steps' }]),
}, 'chapter')
assert.equal(cited.results.length, 1)
assert.ok(cited.results[0].url.includes('#'))
assert.deepEqual(cited.results[0].provenance.map((item) => item.url).sort(), ['https://ex.com/guide#install', 'https://ex.com/guide#usage'])

const bare = await fuse('bare', ['bing'], {
  bing: fake(async () => [{ title: '', url: 'https://ex.com/only#src', snippet: '', summary: null }]),
  ddg: fake(async () => { throw new Error('must not run') }),
}, 'bare')
assert.equal(bare.results.length, 0)
assert.equal(bare.outcome, 'empty_success')
assert.equal(fusedResultIsError(bare), false)
assert.match(bare.warnings.join('\n'), /no title, snippet, or summary/)
assert.match(bare.warnings.join('\n'), /https:\/\/ex\.com\/only#src/)
assert.equal(bare.engineStats.bing.attempts, 1)

for (const sample of [three, filled, distinct, cited, bare, failed, partial]) {
  const hits = sample.results.map(fusedHitToJson)
  const payload = JSON.parse(JSON.stringify({
    scoreVersion: sample.scoreVersion,
    query: sample.query,
    layer: sample.layer,
    tier: sample.tier,
    tookMs: sample.tookMs,
    cacheHit: false,
    resultCount: hits.length,
    enginesRequested: sample.enginesRequested ?? [],
    enginesUsed: sample.enginesUsed ?? [],
    enginePool: sample.enginePool,
    ranking: sample.ranking,
    routeExplanation: sample.routeExplanation,
    outcome: sample.outcome,
    effectiveWeights: sample.effectiveWeights,
    communityUsed: sample.communityUsed,
    communityPlatforms: sample.communityPlatforms,
    communityChannels: sample.communityChannels,
    engineStats: sample.engineStats ?? {},
    warnings: sample.warnings ?? [],
    results: hits,
  }))
  const parsed = outputSchema.safeParse(payload)
  if (!parsed.success) console.error(sample.query, sample.outcome, parsed.error.issues.slice(0, 8))
  assert.equal(parsed.success, true, `${sample.query} ${sample.outcome}`)
  assert.equal(payload.outcome, sample.outcome)
  assert.equal(fusedOutcome(sample), sample.outcome)
}
console.log('v0.3.1-beta.4 source contract passed (fixture engines, no live provider).')
