#!/usr/bin/env node
import './isolate-tests.mjs'
/**
 * Jev System One client tests — hermetic: a fake fetch, no network, no HOME.
 *
 * Verifies the transport contract (endpoint, Bearer header, body shape, usage),
 * answer-shape validation, error classification with bounded retry, same-origin
 * redirect refusal, self-imposed size limits, cancellation, and the guarantee
 * that the API key never appears in request bodies, error details or describe().
 */
import assert from 'node:assert/strict'
import { createJevClient, jevEndpoint, JEV_ERROR_KINDS, JevError, validateJevAnswers, estimateJevTokens } from '../lib/jev/client.mjs'

const SENTINEL = 'SENTINEL-KEY-9f4b1c-never-log'
let count = 0
async function test(name, fn) {
  try {
    await fn()
    count++
    console.log(`ok: ${name}`)
  } catch (err) {
    console.error(`FAIL: ${name}\n${err instanceof Error ? err.stack : err}`)
    process.exitCode = 1
  }
}

const jsonResponse = (body, init = {}) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...init })

function makeClient(responder, overrides = {}) {
  const calls = []
  const client = createJevClient({
    baseUrl: 'https://api.typesafe.ai/v1',
    apiKey: SENTINEL,
    perRequestMs: 5_000,
    maxRetries: overrides.maxRetries ?? 2,
    maxRequestChars: overrides.maxRequestChars ?? 60_000,
    maxBackoffMs: 1,
    sleep: overrides.sleep ?? (() => Promise.resolve()),
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init })
      return responder({ url: String(url), init, index: calls.length })
    },
    ...overrides.client,
  })
  return { client, calls }
}

const questions = () => ({
  'a.one': { type: 'noul', instructions: 'x', criteria: { true: 'y', false: 'n' } },
  'a.two': { type: 'choice', instructions: 'pick', criteria: { left: 'L', right: 'R' } },
})

await test('endpoint keeps the /v1 or gateway prefix and appends systemone', () => {
  assert.equal(jevEndpoint('https://api.typesafe.ai/v1'), 'https://api.typesafe.ai/v1/systemone')
  assert.equal(jevEndpoint('https://api.typesafe.ai/v1/'), 'https://api.typesafe.ai/v1/systemone')
  assert.equal(jevEndpoint('https://gateway.example.com/proxy/llm/'), 'https://gateway.example.com/proxy/llm/systemone')
  assert.throws(() => jevEndpoint(''), /not_configured/)
})

await test('request carries state/model/questions and a Bearer header, never the key in the body', async () => {
  const { client, calls } = makeClient(() => jsonResponse({ model: 'jev-1.13.0', answers: { 'a.one': { type: 'noul', noul: 0.9 }, 'a.two': { type: 'choice', choice: 'left', confidence: 0.8, probabilities: { left: 0.8, right: 0.2 } } }, usage: { input_tokens: 120, output_tokens: 7 } }))
  const out = await client.ask({ state: { task: 'fixture' }, questions: questions(), phase: 'plan' })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'https://api.typesafe.ai/v1/systemone')
  assert.equal(calls[0].init.method, 'POST')
  assert.equal(calls[0].init.headers.authorization, `Bearer ${SENTINEL}`)
  assert.equal(calls[0].init.headers['content-type'], 'application/json')
  assert.ok(!String(calls[0].init.body).includes(SENTINEL), 'the key must never be in the body')
  const body = JSON.parse(String(calls[0].init.body))
  assert.deepEqual(Object.keys(body).sort(), ['model', 'questions', 'state'])
  assert.equal(body.model, 'jev-latest')
  assert.equal(out.model, 'jev-1.13.0')
  assert.equal(out.entries.get('a.one').value, 0.9)
  assert.equal(out.entries.get('a.two').choice, 'left')
  const usage = client.usage()
  assert.equal(usage.calls, 1)
  assert.equal(usage.httpAttempts, 1)
  assert.equal(usage.inputTokens, 120)
  assert.equal(usage.outputTokens, 7)
  assert.ok(!JSON.stringify(client.describe()).includes(SENTINEL))
  assert.ok(!JSON.stringify(usage).includes(SENTINEL))
})

await test('out-of-range, wrong-type and non-offered answers never reach the success branch', async () => {
  const { client } = makeClient(() => jsonResponse({
    model: 'jev-1.13.0',
    answers: {
      'a.one': { type: 'noul', noul: 1.4 },
      'a.two': { type: 'choice', choice: 'middle', confidence: 0.9 },
    },
  }))
  const out = await client.ask({ state: {}, questions: questions() })
  assert.equal(out.entries.size, 0)
  assert.deepEqual(out.invalidIds.sort(), ['a.one:noul_out_of_range', 'a.two:choice_not_offered'])
})

await test('type mismatch, confidence range and unknown ids are reported, not guessed', async () => {
  const { client } = makeClient(() => jsonResponse({
    answers: {
      'a.one': { type: 'choice', choice: 'left', confidence: 0.5 },
      'a.two': { type: 'choice', choice: 'left', confidence: 2 },
      'unknown.id': { type: 'noul', noul: 1 },
    },
  }))
  const out = await client.ask({ state: {}, questions: questions() })
  assert.equal(out.entries.size, 0)
  assert.deepEqual(out.invalidIds, ['a.one:type_mismatch', 'a.two:confidence_out_of_range'])
  assert.deepEqual(out.unknownIds, ['unknown.id'])
})

await test('missing answers key is a malformed response without retry', async () => {
  const { client, calls } = makeClient(() => jsonResponse({ model: 'x', usage: {} }))
  await assert.rejects(() => client.ask({ state: {}, questions: questions() }), (err) => err instanceof JevError && err.kind === JEV_ERROR_KINDS.malformedResponse && err.detail === 'missing_answers')
  assert.equal(calls.length, 1)
})

await test('an HTML gateway page is classified and retried a bounded number of times', async () => {
  const { client, calls } = makeClient(() => new Response('<!doctype html><html><body>502 Bad Gateway</body></html>', { status: 200, headers: { 'content-type': 'text/html' } }))
  await assert.rejects(() => client.ask({ state: {}, questions: questions() }), (err) => err.kind === JEV_ERROR_KINDS.gatewayResponse && err.detail === 'html_body')
  assert.equal(calls.length, 3, 'maxRetries=2 means three HTTP attempts total, then stop')
})

await test('429 honours retry-after, retries, and then succeeds', async () => {
  const { client, calls } = makeClient(({ index }) => (index === 1
    ? new Response('{"error":"rate limited"}', { status: 429, headers: { 'retry-after': '0', 'content-type': 'application/json' } })
    : jsonResponse({ model: 'jev-1.13.0', answers: { 'a.one': { type: 'noul', noul: 0.7 }, 'a.two': { type: 'choice', choice: 'right', confidence: 0.6, probabilities: { right: 0.6, left: 0.4 } } } })))
  const out = await client.ask({ state: {}, questions: questions() })
  assert.equal(calls.length, 2)
  assert.equal(out.attempts, 2)
  assert.equal(client.usage().retries, 1)
  assert.equal(client.usage().calls, 1)
})

await test('401/403 and 422 are fatal, single-attempt, and leak no server body', async () => {
  const { client, calls } = makeClient(() => new Response(JSON.stringify({ error: 'invalid key', echoed: SENTINEL }), { status: 401, headers: { 'content-type': 'application/json' } }))
  await assert.rejects(() => client.ask({ state: {}, questions: questions() }), (err) => {
    assert.equal(err.kind, JEV_ERROR_KINDS.unauthorized)
    const serialized = `${err.message} ${JSON.stringify(err.toJSON())}`
    assert.ok(!serialized.includes(SENTINEL), 'no credential echo in errors')
    return true
  })
  assert.equal(calls.length, 1)
  const second = makeClient(() => new Response(JSON.stringify({ error: 'bad', detail: { field: 'questions' }, echoed: SENTINEL }), { status: 422, headers: { 'content-type': 'application/json' } }))
  await assert.rejects(() => second.client.ask({ state: {}, questions: questions() }), (err) => {
    assert.equal(err.kind, JEV_ERROR_KINDS.invalidRequest)
    assert.equal(err.detail, 'field:questions')
    assert.ok(!JSON.stringify(err.toJSON()).includes(SENTINEL))
    return true
  })
  assert.equal(second.calls.length, 1)
})

await test('a credential-bearing cross-origin redirect is refused, not followed', async () => {
  const { client, calls } = makeClient(() => new Response('', { status: 307, headers: { location: 'https://evil.example.com/v1/systemone' } }))
  await assert.rejects(() => client.ask({ state: {}, questions: questions() }), (err) => err.kind === JEV_ERROR_KINDS.redirectBlocked && err.detail === 'cross_origin_redirect_blocked')
  assert.equal(calls.length, 1, 'the redirect target must never be requested')
})

await test('an oversized request is refused locally without any HTTP attempt', async () => {
  const { client, calls } = makeClient(() => jsonResponse({ answers: {} }), { maxRequestChars: 200 })
  await assert.rejects(() => client.ask({ state: { big: 'x'.repeat(500) }, questions: questions() }), (err) => err.kind === JEV_ERROR_KINDS.requestTooLarge && /chars_/.test(err.detail ?? ''))
  assert.equal(calls.length, 0)
})

await test('cancellation during backoff stops further attempts', async () => {
  const controller = new AbortController()
  const { client, calls } = makeClient(
    () => new Response('{"error":"busy"}', { status: 529, headers: { 'content-type': 'application/json' } }),
    { sleep: async () => { controller.abort(new Error('user cancelled')) } },
  )
  await assert.rejects(() => client.ask({ state: {}, questions: questions(), signal: controller.signal }), (err) => err.kind === JEV_ERROR_KINDS.cancelled)
  assert.equal(calls.length, 1, 'one attempt, then the abort during backoff stops the retry loop')
})

await test('validateJevAnswers reports entry-level problems independently', async () => {
  const out = validateJevAnswers({ ok: { type: 'noul', noul: 0.5 }, bad: { type: 'noul', noul: Number.NaN } }, { ok: { type: 'noul' }, bad: { type: 'noul' }, absent: { type: 'noul' } })
  assert.equal(out.entries.get('ok').value, 0.5)
  assert.deepEqual(out.invalidIds, ['bad:noul_out_of_range'])
  assert.deepEqual(out.missingIds, ['absent'])
  const shape = validateJevAnswers(null, { ok: { type: 'noul' } })
  assert.equal(shape.shapeError, 'answers_not_object')
})

await test('estimateJevTokens is a conservative size heuristic, not a tokenizer claim', () => {
  assert.equal(estimateJevTokens(0), 0)
  assert.equal(estimateJevTokens(100), 50)
  assert.ok(estimateJevTokens(4000) > 1000)
})

await test('beforeAttempt observes the real send path of every attempt, retries included', async () => {
  let sends = 0
  const reservations = []
  const busy = () => new Response('{"error":"busy"}', { status: 529, headers: { 'content-type': 'application/json' } })
  const { client, calls } = makeClient(({ index }) => {
    sends++
    return index <= 3 ? busy() : jsonResponse({ answers: { 'a.one': { type: 'noul', noul: 0.9 } } })
  }, { maxRetries: 3, client: { beforeAttempt: (chars) => reservations.push({ chars, sends }) } })
  const out = await client.ask({ state: { task: 'fixture' }, questions: questions() })
  assert.equal(out.attempts, 4)
  assert.equal(calls.length, 4)
  assert.deepEqual(reservations.map((r) => r.sends), [0, 1, 2, 3], 'every observation happens before its own HTTP request')
  for (const reservation of reservations) assert.equal(reservation.chars, String(calls[0].init.body).length, 'the hook receives the serialized request size')
})

await test('observation only: growing usage never stops dispatch, even past the removed cumulative caps', async () => {
  const reservations = []
  const busy = () => new Response('{"error":"busy"}', { status: 529, headers: { 'content-type': 'application/json' } })
  let sends = 0
  // 20 logical calls with ~30k-char states exceed the removed 16-logical,
  // 180_000 input-token and 420_000 total-token cumulative values; one further
  // call with 25 retries passes the removed 20-HTTP-attempt cap by itself.
  // Every one of them must complete.
  const { client, calls } = makeClient(({ index }) => {
    sends++
    return index >= 21 && index <= 45 ? busy() : jsonResponse({ answers: { 'a.one': { type: 'noul', noul: 0.9 } } })
  }, { maxRetries: 30, client: { beforeAttempt: (chars) => reservations.push(chars) } })
  const bigState = { task: 'x'.repeat(30_000) }
  for (let i = 0; i < 20; i++) {
    const out = await client.ask({ state: bigState, questions: questions() })
    assert.equal(out.entries.get('a.one').value, 0.9, `call ${i + 1} must complete`)
  }
  const perCallChars = reservations[0]
  const inputTokens = 20 * Math.ceil(perCallChars / 2)
  const reservedTokens = 20 * (Math.ceil(perCallChars / 2) + 12_000)
  assert.ok(inputTokens > 180_000, `cumulative input estimate ${inputTokens} must exceed the removed 180000 cap`)
  assert.ok(reservedTokens > 420_000, `cumulative reserved estimate ${reservedTokens} must exceed the removed 420000 cap`)
  const retried = await client.ask({ state: { task: 'retry fixture' }, questions: questions() })
  assert.equal(retried.attempts, 26, 'one logical call may exceed the removed 20-attempt cap when the service retries it')
  const usage = client.usage()
  assert.equal(usage.calls, 21, 'more than the removed 16 logical calls completed')
  assert.equal(usage.httpAttempts, 20 + 26)
  assert.equal(reservations.length, usage.httpAttempts, 'every actual send is observed exactly once')
  assert.equal(calls.length, usage.httpAttempts)
})

await test('a throwing observation hook is handled by the generic error rules, and cancellation still stops before dispatch', async () => {
  let sends = 0
  const { client, calls } = makeClient(() => {
    sends++
    return jsonResponse({ answers: { 'a.one': { type: 'noul', noul: 0.9 } } })
  }, { maxRetries: 2, client: { beforeAttempt: () => { throw new Error('observer failed') } } })
  await assert.rejects(() => client.ask({ state: {}, questions: questions() }), (err) => {
    assert.equal(err.kind, JEV_ERROR_KINDS.network, 'no budget_* vocabulary: a real error is classified as usual')
    return true
  })
  assert.equal(calls.length, 0, 'the throwing hook never let bytes leave the process')
  assert.equal(client.usage().httpAttempts, 0)

  const cancelledFirst = new AbortController()
  cancelledFirst.abort(new Error('caller cancelled'))
  const stops = makeClient(() => jsonResponse({ answers: { 'a.one': { type: 'noul', noul: 0.9 } } }), { client: { beforeAttempt: () => { throw new Error('must not be reached') } } })
  await assert.rejects(() => stops.client.ask({ state: {}, questions: questions(), signal: cancelledFirst.signal }), (err) => {
    assert.ok(err instanceof Error)
    assert.ok(err.kind === JEV_ERROR_KINDS.cancelled || err.message === 'caller cancelled', 'the caller cancellation reason is preserved')
    return true
  })
  assert.equal(stops.calls.length, 0, 'an aborted caller signal stops the call before any dispatch')
})

await test('the gateway/SDK path observes beforeAttempt before its request', async () => {
  const reservations = []
  let sends = 0
  const client = createJevClient({
    baseUrl: 'https://ai-gateway.vercel.sh/v1', apiKey: 'fixture', maxRetries: 2, sleep: () => Promise.resolve(), maxBackoffMs: 1,
    beforeAttempt: (chars) => reservations.push({ chars, sends }),
    fetchImpl: async (url, init) => {
      sends++
      assert.equal(new URL(url).origin, 'https://ai-gateway.vercel.sh')
      return Response.json({ answers: { yes: { type: 'boolean', probability: 0.95 } }, usage: { inputTokens: 10, outputTokens: 2 }, providerMetadata: { typesafe: { confidence: {} } } })
    },
  })
  const out = await client.ask({ state: 'provided evidence', questions: { yes: { type: 'noul', instructions: 'Is evidence present?' } } })
  assert.equal(out.entries.get('yes').value, 0.95)
  assert.equal(reservations.length, 1)
  assert.deepEqual(reservations.map((r) => r.sends), [0])
  assert.ok(reservations[0].chars > 0, 'the gateway body size is observed')

  const controller = new AbortController()
  let reached = 0
  const cancelled = createJevClient({
    baseUrl: 'https://ai-gateway.vercel.sh/v1', apiKey: 'fixture', maxRetries: 2, sleep: () => Promise.resolve(),
    beforeAttempt: () => controller.abort(new Error('caller cancelled')),
    fetchImpl: async (url, init) => {
      // The real transport rejects an already-aborted signal; mirror that contract here.
      if (init?.signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' })
      reached++
      return Response.json({ answers: {} })
    },
  })
  await assert.rejects(() => cancelled.ask({ state: 'x', questions: { yes: { type: 'noul', instructions: 'Is evidence present?' } }, signal: controller.signal }), (err) => {
    assert.equal(err.kind, JEV_ERROR_KINDS.cancelled, 'the caller abort stays the reported reason')
    return true
  })
  assert.equal(reached, 0, 'the gateway transport is never entered once the caller cancels')
})

await test('clients without beforeAttempt keep their previous behavior', async () => {
  const { client, calls } = makeClient(() => jsonResponse({ answers: { 'a.one': { type: 'noul', noul: 0.9 } } }))
  const out = await client.ask({ state: {}, questions: questions() })
  assert.equal(out.attempts, 1)
  assert.equal(calls.length, 1)
  assert.equal(client.usage().httpAttempts, 1)
  assert.ok(!('beforeAttempt' in client))
})

console.log(`\n${count} Jev client tests passed.`)
if (process.exitCode) console.error('FAILURES PRESENT')
