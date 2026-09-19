// Engine request bodies — assert what actually goes on the wire.
//
// A parameter an adapter drops, renames or misspells is invisible to a test that
// only reads the adapter's return value, so these cases inspect the real HTTP
// body. Hermetic: globalThis.fetch is replaced, no key is used against a live API.
import assert from 'node:assert/strict'

const { engineRegistry } = await import('../lib/search/engines.js')

const originalFetch = globalThis.fetch
const calls = []
globalThis.fetch = async (input, init = {}) => {
  calls.push({ url: new URL(String(input)), body: init.body ? JSON.parse(init.body) : null })
  return new Response(JSON.stringify({ results: [], web: { results: [] } }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}
let count = 0
const test = async (name, fn) => { await fn(); count++; console.log(`ok: ${name}`) }
const lastCall = () => calls[calls.length - 1]

try {
  const engines = engineRegistry({ exa: 'fixture-key', tavily: 'fixture-key', brave: 'fixture-key' })

  await test('exa sends the documented startPublishedDate for recency', async () => {
    await engines.exa.search('fixture query', 3, { recency: 'week' })
    const { url, body } = lastCall()
    assert.equal(url.href, 'https://api.exa.ai/search')
    assert.equal(body.query, 'fixture query')
    assert.equal(body.publishedAfter, undefined, 'publishedAfter is not part of the Exa search schema')
    assert.match(body.startPublishedDate, /^\d{4}-\d{2}-\d{2}/)
    const days = Math.round((Date.now() - Date.parse(body.startPublishedDate)) / 86_400_000)
    assert.ok(days >= 6 && days <= 8, `week recency should reach back ~7 days, got ${days}`)
  })

  await test('exa omits the date filter when no recency was requested', async () => {
    await engines.exa.search('fixture query', 3, {})
    assert.equal(lastCall().body.startPublishedDate, undefined)
  })

  await test('tavily and brave keep their own documented recency fields', async () => {
    await engines.tavily.search('fixture query', 3, { recency: 'month' })
    assert.equal(lastCall().body.time_range, 'month')
    await engines.brave.search('fixture query', 3, { recency: 'month' })
    assert.equal(lastCall().url.searchParams.get('freshness'), 'pm')
  })

  console.log(`\n${count} engine request tests passed.`)
} finally {
  globalThis.fetch = originalFetch
}
