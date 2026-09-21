import { __setUndiciLoaderForTests, closeFetchDispatchers } from '../lib/search/ipv4-fetch.js'
// Hermetic X contract + runtime regression tests: no credentials or live HTTP.
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const temp = mkdtempSync(join(tmpdir(), 'sb-x-pipeline-'))
process.env.HOME = join(temp, 'home')
process.env.USERPROFILE = process.env.HOME
process.env.SEARCH_BOOST_HOME = join(temp, 'state')
process.env.PI_CODING_AGENT_DIR = join(temp, 'pi')
for (const key of ['KEYS', 'LAYER', 'XAUTH', 'XGUEST']) process.env[`SEARCH_BOOST_${key}_FILE`] = join(temp, `${key.toLowerCase()}.json`)
process.env.SEARCH_BOOST_LAYER = 'free'
for (const key of ['XAI_API_KEY', 'TAVILY_API_KEY', 'BRAVE_API_KEY', 'EXA_API_KEY', 'PI_SEARCH_TAVILY_KEY', 'PI_SEARCH_BRAVE_KEY', 'PI_SEARCH_EXA_KEY']) delete process.env[key]
mkdirSync(process.env.HOME, { recursive: true })

const { createXPipeline, normalizePosts, normalizeUsers, snowflakeDate, xIdentity } = await import('../lib/search/x/x-pipeline.js')
const { parseTweets, hitToPost, fallbackXSearch } = await import('../lib/search/x/xfallback.js')
const { buildXSearchPrompt } = await import('../lib/search/x/xsearch.js')
const runtime = await import('../lib/runtime.mjs')
let count = 0
async function test(name, fn) { await fn(); count++; console.log(`ok: ${name}`) }
const idAt = (date, sequence = 0) => (((BigInt(Date.parse(date)) - 1288834974657n) << 22n) + BigInt(sequence)).toString()
const post = (handle, date, extra = {}) => ({ url: `https://x.com/${handle}/status/${idAt(date)}`, text: 'fixture text', ...extra })
const finish = (args, data, limit = 5) => createXPipeline({ type: 'keyword', query: 'topic', ...args }, limit).finish([{ source: 'engines', data }])
const first = post('Alice', '2025-01-01T00:00:00.000Z')
const last = post('Alice', '2025-01-31T23:59:59.999Z')
const after = post('Alice', '2025-02-01T00:00:00.000Z')
const bob = post('Bob', '2025-01-15T12:00:00.000Z')
const originalFetch = globalThis.fetch
__setUndiciLoaderForTests(async () => ({ ...await import('undici'), fetch: (...args) => globalThis.fetch(...args) }))

try {
  await test('canonical identity: aliases, mobile, query strings, i/web; no spoof hosts', () => {
    assert.deepEqual(xIdentity('https://mobile.twitter.com/Alice/status/123/photo/1?s=20'), { id: '123', username: 'alice' })
    assert.deepEqual(xIdentity('https://x.com/i/web/status/123'), { id: '123', username: '' })
    assert.deepEqual(xIdentity('https://x.com.evil.test/alice/status/123'), {})
    assert.deepEqual(xIdentity('https://x.com/search?q=alice'), {})
    assert.deepEqual(xIdentity('https://x.com/ALICE?lang=en'), { username: 'alice' })
  })
  await test('normalization restores author/time; preserves unknown counts rather than inventing zero', () => {
    const [p] = normalizePosts([{ ...first, likes: 'unknown', reposts: '12', replies: 0, views: Infinity, username: 'wrong' }])
    assert.equal(p.username, 'alice')
    assert.equal(p.created_at, '2025-01-01T00:00:00.000Z')
    assert.equal(p.reposts, 12)
    assert.equal(p.replies, 0)
    assert.ok(!('likes' in p) && !('views' in p))
    assert.equal(normalizePosts([{ id: 1888930000000000000, text: 'unsafe number' }]).length, 0)
    assert.equal(snowflakeDate('20'), undefined)
    assert.equal(snowflakeDate('9999999999999999999'), undefined)
    assert.deepEqual(normalizePosts([{ url: 'https://x.com/alice', text: 'profile' }, { text: 'no identity' }]), [])
    assert.equal(normalizePosts([{ id: '20', text: 'old', created_at: 'Tue Mar 21 20:50:14 +0000 2006' }])[0].created_at, '2006-03-21T20:50:14.000Z')
  })
  await test('field date boundaries include the entire to_date; query until excludes that day', () => {
    assert.deepEqual(finish({ from_date: '2025-01-01', to_date: '2025-01-31' }, [first, last, after]).items.map((p) => p.id), [idAt('2025-01-01T00:00Z'), idAt('2025-01-31T23:59:59.999Z')])
    assert.equal(finish({ query: 'topic since:2025-01-01 until:2025-01-31' }, [first, last, after]).results, 1)
    assert.equal(finish({ from_date: '2025-01-01T01:00:00+01:00', to_date: '2025-01-01T00:00:00Z' }, [first, last]).results, 1)
    assert.equal(finish({ query: 'since:2025-01-15', to_date: '2025-01-31' }, [first, bob, last, after]).results, 2)
  })
  await test('allowed/excluded handles and username are case-insensitive intersections', () => {
    assert.equal(finish({ allowed_x_handles: [' @ALICE ', 'alice'] }, [first, bob]).results, 1)
    assert.equal(finish({ excluded_x_handles: ['@Alice'] }, [first, bob]).items[0].username, 'bob')
    assert.equal(finish({ username: '@ALICE', query: 'topic from:bob' }, [first, bob]).results, 0)
    assert.equal(finish({ query: 'topic -from:alice' }, [first, bob]).items[0].username, 'bob')
  })
  await test('query metadata AND/OR groups and quoted literals do not over-filter', () => {
    assert.equal(finish({ query: '(from:alice OR from:bob) since:2025-01-01' }, [first, bob]).results, 2)
    assert.equal(finish({ query: 'from:alice OR (from:bob until:2025-01-10)' }, [first, bob]).results, 1)
    assert.equal(finish({ query: '"from:bob" "since:2099-01-01"' }, [first, bob]).results, 2)
    assert.equal(finish({ query: '-(from:bob OR from:charlie)' }, [first, bob]).results, 1)
    assert.equal(finish({ query: 'from:"alice"' }, [first, bob]).results, 1)
    assert.equal(finish({ query: 'async() C++ (lambda)' }, [first, bob]).results, 2)
    const deferred = finish({ query: '-(from:bob OR word)' }, [first, bob])
    assert.equal(deferred.results, 2)
    assert.match(deferred.note, /Negated groups/)
    assert.match(finish({ query: 'filter:images' }, [first]).note, /provider-side only/)
  })
  await test('engagement/language filters require observed metadata', () => {
    const out = finish({ query: 'min_faves:10 min_retweets:2 min_replies:1 lang:en' }, [first, { ...bob, likes: '10', reposts: '2', replies: 1, lang: 'EN' }])
    assert.equal(out.results, 1)
    assert.equal(out.items[0].username, 'bob')
    assert.match(out.note, /missing metadata/)
    assert.equal(finish({ query: '-min_faves:10' }, [first]).results, 0)
  })
  await test('unknown dates/authors fail closed only when required; no fabricated facts', () => {
    const unknown = { id: '20', text: 'legacy' }
    assert.equal(finish({}, [unknown]).results, 1)
    for (const args of [{ from_date: '2025-01-01' }, { allowed_x_handles: ['alice'] }, { excluded_x_handles: ['alice'] }]) {
      const result = finish(args, [unknown])
      assert.equal(result.results, 0)
      assert.match(result.note, /missing metadata/)
    }
  })
  await test('dedupe merges metadata before filtering; limit and source counts apply afterward', () => {
    const pipeline = createXPipeline({ type: 'keyword', query: 'min_faves:10', allowed_x_handles: ['alice'] }, 1)
    const out = pipeline.finish([
      { source: 'official', data: [{ id: idAt('2025-01-01T00:00Z'), text: 'official full text', likes: 12 }, bob] },
      { source: 'engines', data: [{ ...first, url: first.url.replace('x.com', 'twitter.com') + '?s=20' }, last] },
    ])
    assert.equal(out.results, 1)
    assert.equal(out.xResults, 1)
    assert.equal(out.engineResults, 0)
    assert.equal(out.items[0].text, 'official full text')
    assert.equal(out.items[0].username, 'alice')
    assert.match(out.items[0].url, /^https:\/\/x.com\/alice\/status\//)
    assert.equal(finish({ allowed_x_handles: ['alice'] }, [bob, first, last], 1).items[0].id, xIdentity(first.url).id)
  })
  await test('profile creation date is not filtered as a post; recent_posts use the same pipeline', () => {
    const profiles = [{ username: '@Alice', created_at: '2006-03-21', recent_posts: [first, last, after, bob] }]
    const out = finish({ type: 'user', username: 'ALICE', from_date: '2025-01-01', to_date: '2025-01-31' }, profiles)
    assert.equal(out.results, 1)
    assert.equal(out.items[0].created_at, '2006-03-21T00:00:00.000Z')
    assert.equal(out.items[0].recent_posts.length, 2)
    assert.equal(normalizeUsers([{ url: 'https://twitter.com/alice?lang=en' }])[0].username, 'alice')
  })
  await test('validation rejects contradictory fields, invalid dates/handles, excessive handle lists', () => {
    for (const args of [
      { allowed_x_handles: ['alice'], excluded_x_handles: ['bob'] },
      { from_date: '2025-02-30' }, { from_date: 'tomorrow' }, { to_date: '2025-01-01T12:00:00' },
      { from_date: '2025-02-01', to_date: '2025-01-01' }, { username: 'not a handle' },
      { allowed_x_handles: Array.from({ length: 21 }, (_, i) => `u${i}`) },
      { query: 'from:bad!name' }, { query: 'min_faves:nope' }, { query: 'since:' },
      { query: 'from:alice OR' }, { query: 'OR from:alice' }, { query: '(from:alice' }, { query: 'from:alice AND' },
    ]) assert.throws(() => createXPipeline({ type: 'keyword', ...args }), /x_search:/)
  })
  await test('guest decoding keeps dates, counts, language and long post text', () => {
    const posts = parseTweets({ entries: [{ entryType: 'TimelineTimelineItem', itemContent: { itemType: 'TimelineTweet', tweet_results: { result: {
      rest_id: idAt('2025-01-01T00:00Z'), core: { user_results: { result: { core: { screen_name: 'Alice', name: 'Display' } } } },
      legacy: { full_text: 'short', created_at: 'Wed Jan 01 00:00:00 +0000 2025', lang: 'en', favorite_count: 4 },
      views: { count: '42' }, note_tweet: { note_tweet_results: { result: { text: 'long text' } } },
    } } } }] })
    const [p] = normalizePosts(posts)
    assert.equal(p.created_at, '2025-01-01T00:00:00.000Z')
    assert.equal(p.views, 42)
    assert.equal(p.lang, 'en')
    assert.equal(p.text, 'long text')
    assert.match(buildXSearchPrompt('keyword', { query: 'topic' }, 5), /created_at/)
    assert.equal(hitToPost({ url: first.url }).username, 'alice')
  })

  // Exercise actual orchestration + engine/hosted/oEmbed providers, replacing
  // only HTTP. Unrecognized URLs fail, so these tests cannot hit the network.
  let hits = [bob, first, last, after]
  let hosted = [first, last, after, bob]
  let hostedFails = false
  let guestEnabled = false
  const calls = []
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input))
    calls.push({ url, init })
    if (url.hostname === 'www.bing.com') {
      return new Response(hits.map((p) => `<li class="b_algo"><h2><a href="${p.url}">Alice on X: fixture text</a></h2><p>fixture snippet</p></li>`).join(''))
    }
    if (url.hostname === 'api.x.ai') {
      return hostedFails ? new Response('fixture denied', { status: 403 }) : Response.json({ output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(hosted) }] }] })
    }
    if (url.hostname === 'publish.x.com') {
      const target = new URL(url.searchParams.get('url'))
      const id = target.pathname.split('/').pop()
      const source = hits.find((p) => xIdentity(p.url).id === id)
      return source ? Response.json({ author_name: 'Display', author_url: `https://twitter.com/${xIdentity(source.url).username}`, html: '<blockquote>Full oEmbed fixture text, longer than forty characters.</blockquote>' }) : new Response('', { status: 404 })
    }
    if (guestEnabled && url.pathname === '/1.1/guest/activate.json') return Response.json({ guest_token: 'fixture-token' })
    if (guestEnabled && url.pathname.endsWith('/UserByScreenName')) return Response.json({ data: { user: { result: { rest_id: '123', core: { screen_name: 'Alice', name: 'Alice', created_at: '2006-03-21' } } } } })
    if (guestEnabled && url.pathname.endsWith('/UserTweets')) return Response.json({ entries: hits.map((p) => ({ entryType: 'TimelineTimelineItem', itemContent: { itemType: 'TimelineTweet', tweet_results: { result: { rest_id: xIdentity(p.url).id, core: { user_results: { result: { core: { screen_name: xIdentity(p.url).username } } } }, legacy: { full_text: p.text } } } } })) })
    return new Response('fixture unavailable', { status: 503 })
  }
  const args = { type: 'keyword', query: 'fixture topic', from_date: '2025-01-01', to_date: '2025-01-31', allowed_x_handles: ['@ALICE'], max_results: 2 }
  await test('logged-out runtime filters engine posts, supplies hints and caches filtered output', async () => {
    const [out, shared] = await Promise.all([runtime.runXSearch(args), runtime.runXSearch(args)])
    assert.equal(out.results, 2)
    assert.equal(shared.inFlight, true)
    assert.ok(out.items.every((p) => p.username === 'alice' && p.created_at.startsWith('2025-01-')))
    assert.ok(!calls.some((c) => c.url.hostname === 'api.x.ai'))
    const q = calls.find((c) => c.url.hostname === 'www.bing.com').url.searchParams.get('q')
    assert.match(q, /from:alice/)
    assert.match(q, /since:2025-01-01/)
    assert.match(q, /until:2025-02-01/)
    const before = calls.length
    const cached = await runtime.runXSearch(args)
    assert.equal(cached.cacheHit, true)
    assert.equal(calls.length, before)
    assert.deepEqual(cached.items, out.items)
  })

  // A shared x_search run must outlive a waiter that cancels, and a waiter must
  // never be forced to keep waiting for a result it no longer wants.
  const flight = (query) => {
    let open
    let seen
    const gate = new Promise((resolve) => { open = resolve })
    const fallbackSearch = async ({ signal }) => {
      seen = signal
      await gate
      signal?.throwIfAborted()
      return { via: 'fixture', data: [] }
    }
    return { query, open, fallbackSearch, sharedSignal: () => seen }
  }
  const flightSnapshot = () => ({ fingerprint: 'fixture', engines: {}, capability: { x: { official: { available: false } } } })
  const waitTick = () => new Promise((resolve) => setImmediate(resolve))

  await test('cancelling one waiter leaves the shared run other callers need alive', async () => {
    runtime.invalidateSearchCaches()
    const f = flight('flight-joiner-abort')
    const owner = runtime.runXSearch({ type: 'keyword', query: f.query }, { snapshot: flightSnapshot, fallbackSearch: f.fallbackSearch })
    await waitTick()
    const joinerAbort = new AbortController()
    const joiner = runtime.runXSearch({ type: 'keyword', query: f.query }, { signal: joinerAbort.signal, snapshot: flightSnapshot, fallbackSearch: f.fallbackSearch })
    await waitTick()
    joinerAbort.abort()
    await assert.rejects(() => joiner, (err) => err.name === 'AbortError')
    assert.equal(f.sharedSignal().aborted, false, 'the shared run must not be aborted by one leaving waiter')
    f.open()
    assert.equal((await owner).via, 'fallback:fixture')
  })

  await test('cancelling the first caller does not cancel joiners still waiting', async () => {
    runtime.invalidateSearchCaches()
    const f = flight('flight-owner-abort')
    const ownerAbort = new AbortController()
    const owner = runtime.runXSearch({ type: 'keyword', query: f.query }, { signal: ownerAbort.signal, snapshot: flightSnapshot, fallbackSearch: f.fallbackSearch })
    await waitTick()
    const joiner = runtime.runXSearch({ type: 'keyword', query: f.query }, { snapshot: flightSnapshot, fallbackSearch: f.fallbackSearch })
    await waitTick()
    ownerAbort.abort()
    await assert.rejects(() => owner, (err) => err.name === 'AbortError')
    assert.equal(f.sharedSignal().aborted, false, 'a joiner still needs the run the first caller abandoned')
    f.open()
    const joined = await joiner
    assert.equal(joined.via, 'fallback:fixture')
    assert.equal(joined.inFlight, true)
  })

  await test('the last waiter leaving aborts the shared run instead of wasting it', async () => {
    runtime.invalidateSearchCaches()
    const f = flight('flight-last-abort')
    const onlyAbort = new AbortController()
    const only = runtime.runXSearch({ type: 'keyword', query: f.query }, { signal: onlyAbort.signal, snapshot: flightSnapshot, fallbackSearch: f.fallbackSearch })
    await waitTick()
    onlyAbort.abort()
    await assert.rejects(() => only, (err) => err.name === 'AbortError')
    await waitTick()
    assert.equal(f.sharedSignal().aborted, true, 'nobody is waiting, so the run must stop')
  })

  await test('logged-in parallel path uses the identical filters, one web search, one final limit', async () => {
    runtime.invalidateSearchCaches()
    process.env.XAI_API_KEY = 'xai-fixture-not-a-real-secret'
    calls.length = 0
    const out = await runtime.runXSearch(args)
    assert.equal(out.via, 'parallel')
    assert.equal(out.results, 2)
    assert.equal(out.xResults + out.engineResults, out.results)
    assert.ok(out.items.every((p) => p.username === 'alice' && p.created_at.startsWith('2025-01-')))
    assert.equal(calls.filter((c) => c.url.hostname === 'www.bing.com').length, 1)
    const body = JSON.parse(calls.find((c) => c.url.hostname === 'api.x.ai').init.body)
    assert.deepEqual(body.tools[0].allowed_x_handles, ['alice'])
    assert.equal(body.tools[0].to_date, '2025-01-31')
  })
  await test('hosted failure reuses completed web outcome instead of repeating retrieval', async () => {
    runtime.invalidateSearchCaches()
    hostedFails = true
    calls.length = 0
    const out = await runtime.runXSearch(args)
    assert.match(out.via, /^fallback:/)
    assert.equal(out.results, 2)
    assert.equal(calls.filter((c) => c.url.hostname === 'www.bing.com').length, 1)
    hostedFails = false
  })
  await test('logged-out username-only keyword and semantic structured filters work', async () => {
    delete process.env.XAI_API_KEY
    runtime.invalidateSearchCaches()
    assert.ok((await runtime.runXSearch({ type: 'keyword', username: 'Alice' })).items.every((p) => p.username === 'alice'))
    const out = await runtime.runXSearch({ ...args, type: 'semantic', query: 'What changed?' })
    assert.equal(out.results, 2)
  })
  await test('all candidates filtered out is a successful empty result with explanation', async () => {
    const out = await runtime.runXSearch({ ...args, from_date: '2024-01-01', to_date: '2024-01-31' })
    assert.notEqual(out.via, 'error')
    assert.equal(out.results, 0)
    assert.match(out.note, /removed by local filters/)
  })
  await test('thread URL with digits in username resolves the real post ID; date filters still apply', async () => {
    const out = await runtime.runXSearch({ type: 'thread', post_id: first.url.replace('Alice', 'user123'), to_date: '2025-01-01' })
    assert.equal(out.results, 1)
    assert.equal(out.items[0].id, xIdentity(first.url).id)
    const empty = await runtime.runXSearch({ type: 'thread', post_id: first.url, from_date: '2025-02-01' })
    assert.equal(empty.results, 0)
  })
  await test('guest user profile and recent_posts go through the shared pipeline', async () => {
    guestEnabled = true
    const out = await runtime.runXSearch({ ...args, type: 'user', username: 'Alice', query: undefined })
    assert.equal(out.results, 1)
    assert.equal(out.items[0].recent_posts.length, 2)
    assert.ok(out.items[0].recent_posts.every((p) => p.username === 'alice'))
    guestEnabled = false
  })
  await test('empty credential-free retrieval is not retried as a provider error', async () => {
    const result = await fallbackXSearch({ type: 'keyword', query: 'nothing', webSearch: async () => [] })
    assert.deepEqual(result.data, [])
  })
  await test('cache identity includes layer, model, reasoning effort and filters', () => {
    const base = runtime.xSearchCacheKey('keyword', args, 2)
    for (const patch of [{ layer: 'api' }, { model: 'another-model' }, { reasoning_effort: 'high' }, { allowed_x_handles: ['bob'] }, { to_date: '2025-02-01' }]) {
      assert.notEqual(runtime.xSearchCacheKey('keyword', { ...args, ...patch }, 2), base)
    }
  })
  console.log(`\n${count} X pipeline tests passed.`)
} finally {
  globalThis.fetch = originalFetch
  await closeFetchDispatchers(); __setUndiciLoaderForTests(null)
  rmSync(temp, { recursive: true, force: true })
}
