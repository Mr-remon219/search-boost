// Offline fixture for the single N_off screening flow: a fake Jev client, a fake
// shared fused result and an in-memory private store. No network, no credentials
// and no live service; assertions observe the injected call counts instead.
import Ajv from 'ajv'
import { ADAPTIVE_OUTPUT_SCHEMA } from '../lib/search/screening/schema.js'

export const FIXTURE_SAVED_ID = '11111111-1111-4111-8111-111111111111'

export const fixtureRows = (count = 4) => Array.from({ length: count }, (_, index) => ({
  url: `https://evidence${index}.example/doc`,
  title: `Evidence ${index}`,
  snippet: `Traceable implementation evidence number ${index} with enough words to read.`,
  score: 1 - index / (count + 1),
  scoreVersion: 'consensus-v2.1',
  engineRanks: { bing: index + 1 },
  engines: ['bing'],
  provenance: [{ engine: 'bing', rank: index + 1 }],
}))

/** Assertions about "no external call happened" use this instead of a harness. */
export const forbiddenDeps = new Proxy({}, {
  get: (_target, property) => () => { throw new Error(`dependency ${String(property)} must not be called for rejected input`) },
})

export function outputValidator() {
  const validate = new Ajv({ strict: true, allowUnionTypes: true }).compile(ADAPTIVE_OUTPUT_SCHEMA)
  return (value) => (validate(value) ? null : JSON.stringify(validate.errors))
}

/**
 * `answer` may be an object of per-question overrides `{ ranking, community,
 * safety, value, discount, preference }` or a function receiving the request and
 * returning a full answers object (or null to drop the answer).
 */
export function makeHarness(options = {}) {
  const calls = { jev: [], search: [], save: [], load: [], progress: [] }
  const rows = options.rows ?? fixtureRows()
  const store = new Map()
  const answerFor = typeof options.answer === 'function' ? options.answer : () => options.answer ?? {}
  const deps = {
    readConfig: () => options.config ?? { apiKey: 'jev-fixture-secret', baseUrl: 'https://jev.fixture.invalid' },
    snapshot: () => options.state ?? { engines: {}, fingerprint: 'fixture-fingerprint' },
    route: (state, ranking) => options.route ? options.route(state, ranking) : { engineNames: ['bing'], effectiveWeights: { bing: 1 }, enginePool: 'hybrid' },
    toolState: () => options.toolState ?? { requested: true, enabled: true, locked: false, reason: '' },
    createClient: (config) => {
      calls.clientConfig = config
      return {
        describe: () => ({ provider: options.config?.provider ?? 'jev', transport: options.config?.transport ?? 'systemone', requestedModel: options.config?.model ?? 'jev-latest', adapterVersion: 1 }),
        usage: () => ({ model: options.model ?? 'fixture-jev', resolvedModel: options.model ?? 'fixture-jev', calls: calls.jev.length }),
        async ask(request) {
          calls.jev.push({ request, config })
          const attempts = options.attempts ?? 1
          const attemptChars = Number.isFinite(options.attemptChars)
            ? options.attemptChars
            : JSON.stringify({ state: request.state, questions: request.questions }).length
          for (let attempt = 0; attempt < attempts; attempt++) {
            if (typeof config.beforeAttempt === 'function') config.beforeAttempt(attemptChars)
          }
          if (options.failAt && calls.jev.length === options.failAt) {
            throw Object.assign(new Error('jev fixture failure'), { kind: options.failKind ?? 'network' })
          }
          const overrides = answerFor(request)
          // A null whole-object means "the service answered nothing for this request".
          if (overrides === null) return { entries: {}, usage: options.usage ?? { inputTokens: 10, outputTokens: 5 } }
          const entries = {}
          for (const [id, spec] of Object.entries(request.questions)) {
            const kind = id.split('.')[0]
            const slot = id === 'strategy.ranking' ? { key: 'ranking', fallback: 'research' }
              : id === 'strategy.community' ? { key: 'community', fallback: 'disable' }
                : kind === 'safety' ? { key: 'safety', fallback: 'clear' }
                  : kind === 'value' ? { key: 'value', fallback: '5' }
                    : kind === 'discount' ? { key: 'discount', fallback: 'none' }
                      : id.startsWith('pref.') ? { key: 'preference', fallback: 'match' }
                        : { key: 'other', fallback: null }
            const value = Object.hasOwn(overrides ?? {}, slot.key) ? overrides[slot.key] : slot.fallback
            if (value === null || value === undefined) continue
            entries[id] = { type: 'choice', choice: value, confidence: overrides.confidence ?? .8 }
          }
          return {
            entries,
            usage: options.usage ?? { inputTokens: 10, outputTokens: 5 },
            invalidIds: options.invalidIds ?? [],
            missingIds: options.missingIds ?? [],
            shapeError: options.shapeError ?? false,
          }
        },
      }
    },
    search: async (args, state) => {
      calls.search.push({ args, state })
      if (options.searchError) throw options.searchError
      const requested = args.community === true
      return {
        results: rows,
        cacheHit: false,
        engineStats: { bing: { used: true, attempts: 1, successes: 1, errors: 0 } },
        effectiveWeights: { bing: 1 },
        contributionWeights: { bing: 1, ...(requested ? { 'x-official': 1, 'x-fallback': 1 } : {}) },
        enginePool: 'hybrid',
        queriesUsed: [args.query],
        funnel: { fusionRows: rows.length },
        communityExecution: requested
          ? { requested: true, effective: true, outcome: 'succeeded', cacheHit: false, reason: null, usage: { logicalOperations: 1, providerRequests: 2 } }
          : { requested: false, effective: false, outcome: 'not_requested', cacheHit: false, reason: null, usage: { logicalOperations: 0 } },
        ...options.searchResult,
      }
    },
  }
  if (options.persist === false) {
    deps.saveResults = undefined
    deps.loadResults = undefined
  } else {
    deps.saveResults = options.saveResults ?? ((results, metadata) => {
      calls.save.push({ results, metadata })
      store.set(FIXTURE_SAVED_ID, { format: 'search-boost-research-v3', schemaVersion: 6, results, metadata })
      return FIXTURE_SAVED_ID
    })
    deps.loadResults = options.loadResults ?? ((id) => {
      calls.load.push(id)
      const record = store.get(id)
      if (!record) throw new Error('Saved research results not found in this SearchBoost home')
      return record
    })
  }
  return { deps, calls, rows, store }
}
