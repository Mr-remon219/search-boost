#!/usr/bin/env node
/** Hermetic cross-host contract/lifecycle tests: no LLM, credentials, or external CLI. */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { EventEmitter } from 'node:events'
import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { parallelResearch } from '../lib/search/research.js'
import { researchRole, researchResult, researchSummary, normalizeResearchTasks } from '../lib/search/parallel-contract.mjs'

const home = mkdtempSync(join(tmpdir(), 'sb research '))
process.env.HOME = home
process.env.USERPROFILE = home
process.env.PI_CODING_AGENT_DIR = join(home, 'pi')
process.env.SEARCH_BOOST_HOME = join(home, 'search-boost')
mkdirSync(process.env.PI_CODING_AGENT_DIR)
const parent = { session: { id: 'test-parent' } }
const item = (task, agent = 'searcher') => ({ agent, task })
const terminal = (text, stopReason = 'completed') => ({ stopReason, output: [{ type: 'text', text }] })
function deferred() {
  let resolve, reject
  const promise = new Promise((a, b) => { resolve = a; reject = b })
  return { promise, resolve, reject }
}
function nativeService(start) {
  return {
    getProvider: (name) => name === 'spawn' ? { inheritsParentContext: false, capabilities: { toolFilter: true, depthLimit: true, persona: true } } : undefined,
    start,
  }
}
function run(subagents, opts = {}) {
  return parallelResearch({ subagents, agent: parent, tasks: [item('one'), item('two')], maxSeconds: 2, ...opts })
}
const originalSpawn = childProcess.spawn
try {
  for (const bad of [{}, { agent: 'searcher' }, { tasks: [] }, { tasks: 'not-array' }, { agent: 'unknown', task: 'q' }, { tasks: [item(42)] }, { tasks: [item('q')], agent: 'searcher' }]) {
    assert.throws(() => normalizeResearchTasks(bad))
  }
  const summary = researchSummary([
    researchResult(item('ok'), { result: 'https://example.com/doc?utm_source=test' }),
    researchResult(item('failed'), { status: 'error', result: 'https://unverified.example/' }),
  ], Date.now())
  assert.equal(summary.okCount, 1)
  assert.deepEqual(summary.sourceUrls, ['https://example.com/doc'])
  assert.equal(researchResult(item('empty')).status, 'error')
  const clipped = researchResult(item('long'), { result: 'a'.repeat(50_010) + 'https://not-visible.example/' })
  assert(clipped.truncated && clipped.sources.length === 0)
  console.log('ok: common task validation, explicit empty/truncated results, failed evidence excluded')

  // Require actual native capabilities before starting anything; never choose the first unrelated provider.
  let starts = 0
  for (const subagents of [null, nativeService(() => { starts++ }), { start: () => { starts++ } }]) {
    if (subagents?.getProvider) subagents.getProvider = () => undefined
    await assert.rejects(run(subagents), /unavailable|unsupported/)
  }
  for (const feature of ['toolFilter', 'depthLimit', 'persona', 'fresh-context']) {
    const subagents = nativeService(() => { starts++ })
    const descriptor = subagents.getProvider('spawn')
    if (feature === 'fresh-context') descriptor.inheritsParentContext = true
    else descriptor.capabilities[feature] = false
    subagents.getProvider = () => descriptor
    await assert.rejects(run(subagents), /lacks|isolation/)
  }
  assert.equal(starts, 0)
  console.log('ok: missing provider/capabilities fail closed without starting a child or runtime fallback')

  const requests = [], disposed = [], gate = deferred()
  const service = nativeService(async (provider, request) => {
    requests.push(request)
    assert.equal(provider, 'spawn')
    assert.equal(request.parent, parent)
    assert.equal(request.maxDepth, 1)
    assert(request.signal instanceof AbortSignal)
    assert.deepEqual(request.toolFilter.allow, ['fused_search', 'fetch_page'])
    assert.equal(request.persona, researchRole('searcher'))
    if (requests.length === 2) gate.resolve()
    return { result: gate.promise.then(() => terminal(`Evidence https://example.com/${requests.indexOf(request)}`)), dispose: async () => { disposed.push(request) } }
  })
  const res = await run(service)
  assert.equal(requests.length, 2)
  assert.equal(disposed.length, 2)
  assert.equal(res.okCount, 2)
  assert.equal(res.results.length, res.sub_tasks.length)
  assert.deepEqual(res.sourceUrls, res.merged_sources)
  assert(res.results.every((r) => r.status === 'completed'))
  console.log('ok: DSH starts independent children concurrently, restricts tools, disposes successful handles')

  let summarizerRequest
  await run(nativeService(async (_provider, request) => {
    summarizerRequest = request
    return { result: Promise.resolve(terminal('## need_another_round\nno')), dispose: async () => {} }
  }), { tasks: undefined, agentRole: 'summarizer', task: 'Question and all reports' })
  assert.deepEqual(summarizerRequest.toolFilter.allow, [])
  assert.equal(summarizerRequest.persona, researchRole('summarizer'))
  assert(summarizerRequest.prompt[0].text.includes('all reports'))
  console.log('ok: native summarizer has an empty tool allowlist and the same shared role as Pi')

  let cleanupCount = 0
  const outcomes = ['completed', 'error', 'refusal', 'max-tokens', 'empty', 'throw', 'cleanup-error']
  const failed = await run(nativeService(async (_p, req) => {
    const kind = outcomes.shift()
    if (kind === 'throw') throw Error('provider startup failed')
    return {
      result: Promise.resolve(terminal(kind === 'empty' ? '' : `partial https://${kind}.example/`, ['empty', 'cleanup-error'].includes(kind) ? 'completed' : kind)),
      dispose: async () => { cleanupCount++; if (kind === 'cleanup-error') throw Error('dispose failure') },
    }
  }), { tasks: Array.from({ length: 7 }, (_, i) => item(`task ${i}`)) })
  assert.equal(failed.okCount, 1)
  assert.equal(cleanupCount, 6)
  assert.equal(failed.sourceUrls.length, 1)
  assert(failed.results.at(-1).error.includes('cleanup failed'))
  assert.deepEqual(failed.results.map((r) => r.status), ['completed', 'error', 'refusal', 'max-tokens', 'error', 'error', 'error'])
  console.log('ok: partial failures/refusals/empty output/disposal errors are not successful research')

  const legacy = await run(service, { tasks: undefined, query: 'question', subQueries: ['facts', 'counterevidence'] })
  assert.equal(legacy.sub_tasks.length, 2)
  assert(legacy.query === 'question')
  await assert.rejects(run(service, { query: 'q', subQueries: ['a', 'b'] }), /do not mix/)
  await assert.rejects(run(service, { tasks: undefined, query: 'q', subQueries: ['one'] }), /2-4/)
  await assert.rejects(run(service, { maxSeconds: NaN }), /max_seconds/)
  await assert.rejects(run(service, { maxSources: 20 }), /max_sources/)
  console.log('ok: legacy query/sub_queries remains usable; ambiguous modes and invalid budgets rejected')

  const controller = new AbortController()
  let abortSignal, abortDisposed = 0
  const running = run(nativeService(async (_p, request) => {
    abortSignal = request.signal
    return { result: new Promise(() => {}), dispose: async () => { abortDisposed++ } }
  }), { signal: controller.signal })
  controller.abort()
  const aborted = await running
  await delay(0)
  assert(abortSignal.aborted && abortDisposed === 2)
  assert(aborted.results.every((r) => r.status === 'aborted'))
  let preAbortStarts = 0
  await run(nativeService(async () => { preAbortStarts++ }), { signal: controller.signal })
  assert.equal(preAbortStarts, 0)
  console.log('ok: cancellation propagates and pre-aborted calls spawn nothing')

  // Startup itself must be bounded, including a provider that publishes a handle after cancellation.
  const late = deferred()
  let lateDisposed = 0, lateSignal
  const deadlineRun = run(nativeService(async (_p, request) => {
    lateSignal = request.signal
    return late.promise
  }), { tasks: [item('slow startup')], maxSeconds: 1 })
  const timed = await deadlineRun
  assert(timed.results[0].status === 'timeout' && lateSignal.aborted)
  late.resolve({ result: Promise.reject(Error('late result rejection')), dispose: async () => { lateDisposed++ } })
  await delay(10)
  assert.equal(lateDisposed, 1)
  console.log('ok: deadline covers startup; late handles/results are observed and disposed')

  // Exercise the Pi JSONL path with a local deterministic process double, never a real CLI/model.
  const pi = await import('../adapters/pi/search-parallel-subagent.js')
  const spawned = []
  childProcess.spawn = (_command, args) => {
    const child = new EventEmitter()
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.kill = () => { queueMicrotask(() => child.emit('close', null)); return true }
    const promptPath = args[args.indexOf('--append-system-prompt') + 1]
    spawned.push({ args, promptPath, prompt: readFileSync(promptPath, 'utf8') })
    queueMicrotask(() => {
      const report = args.includes('--no-tools') ? '## need_another_round\nno' : '## Conclusion\nFact https://example.com/source'
      const event = JSON.stringify({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: report }] } })
      child.stdout.emit('data', event.slice(0, 31))
      child.stdout.emit('data', event.slice(31) + '\n')
      child.emit('close', 0)
    })
    return child
  }
  syncBuiltinESMExports()
  const piResult = await pi.runSearchParallel({ tasks: [item('facts'), item('Question and reports', 'summarizer')] })
  assert.equal(piResult.okCount, 2)
  assert(spawned[0].args.includes('fused_search,fetch_page'))
  assert(spawned[1].args.includes('--no-tools'))
  assert.equal(spawned[0].prompt, researchRole('searcher'))
  assert.equal(spawned[1].prompt, researchRole('summarizer'))
  assert(spawned.every((s) => !existsSync(s.promptPath)))
  assert.deepEqual(Object.keys(piResult.results[0]).sort(), Object.keys(res.results[0]).sort())
  assert.deepEqual(piResult.sourceUrls, ['https://example.com/source'])
  console.log('ok: Pi child dispatch, shared prompts, split JSONL parsing, result parity, temp cleanup')

  // The registered DSH tool accepts the new mode and exposes every result field in its schema.
  const dsh = await import('../adapters/dsh/index.js')
  const tools = new Map()
  const commands = { register() {} }
  dsh.apply({
    get: (name) => name === 'subagents' ? nativeService(async () => ({ result: Promise.resolve(terminal('https://example.com/tool')), dispose: async () => {} })) : name === 'commands' ? commands : undefined,
    tools: { register: (tool) => tools.set(tool.name, tool) },
    web: { registerSearchProvider() {}, registerFetchProvider() {} },
    systemPrompt: { section() {} },
  })
  const tool = tools.get('research_parallel')
  const actual = await tool.execute({ agent: 'summarizer', task: 'Reports', max_seconds: 1 }, { agent: parent })
  for (const key of Object.keys(actual)) assert(key in tool.output.schema.properties, `missing output schema field ${key}`)
  assert.equal(actual.results[0].agent, 'summarizer')
  assert(tool.output.render({}, actual)[0].text.includes('https://example.com/tool'))
  console.log('ok: DSH tool adapter forwards role dispatch and describes the full output contract')
} finally {
  childProcess.spawn = originalSpawn
  syncBuiltinESMExports()
  rmSync(home, { recursive: true, force: true })
}
console.log('All parallel research tests passed.')
