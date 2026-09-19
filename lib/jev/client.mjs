// TypeSafe Jev "System One" HTTP client.
//
// Official protocol (verified against https://docs.typesafe.ai/api):
//   POST {baseUrl}/systemone
//   Authorization: Bearer <API_KEY>
//   Content-Type: application/json
//   body: { state, model, questions }  ->  { model, answers, usage }
// The body carries data and typed questions only: never a key, never a
// fingerprint, never host credentials.
//
// The client owns transport concerns and nothing else: endpoint building,
// abort/deadline merging, bounded retry for 429/529 (+ network and gateway
// pages), error classification into whitelisted codes, response shape
// validation, and usage accounting. It never returns or logs the key, never
// copies a server response body into an error, and refuses to follow a
// credential-bearing redirect to another origin.

import { ipv4Fetch } from '../search/ipv4-fetch.js'
import { mergeSignals, readLimited } from '../search/ssrf.js'
import { throwIfAborted } from '../search/text.js'
import { JEV_DEFAULT_MODEL } from '../jev-config.mjs'

/** Official System One alias — the response `model` field carries the real version. */
export { JEV_DEFAULT_MODEL }
export const JEV_ENDPOINT_PATH = 'systemone'

/** Whitelisted error kinds — the only failure vocabulary that leaves this module. */
export const JEV_ERROR_KINDS = {
  notConfigured: 'not_configured',
  unauthorized: 'unauthorized',
  invalidRequest: 'invalid_request',
  rateLimited: 'rate_limited',
  overloaded: 'overloaded',
  serverError: 'server_error',
  gatewayResponse: 'gateway_response',
  malformedResponse: 'malformed_response',
  network: 'network',
  timeout: 'timeout',
  redirectBlocked: 'redirect_blocked',
  requestTooLarge: 'request_too_large',
  cancelled: 'cancelled',
}

/** Kinds that mean "our request is wrong" — Jev stays off for the rest of the call. */
export const JEV_FATAL_KINDS = new Set([
  JEV_ERROR_KINDS.notConfigured,
  JEV_ERROR_KINDS.unauthorized,
  JEV_ERROR_KINDS.invalidRequest,
  JEV_ERROR_KINDS.malformedResponse,
  JEV_ERROR_KINDS.redirectBlocked,
  JEV_ERROR_KINDS.requestTooLarge,
])

export class JevError extends Error {
  /**
   * @param {string} kind one of JEV_ERROR_KINDS
   * @param {{ status?: number|null, retryable?: boolean, detail?: string|null, attempts?: number, phase?: string|null, retryAfter?: number|null }} [opts]
   */
  constructor(kind, opts = {}) {
    super(`jev ${kind}${opts.status ? ` (http ${opts.status})` : ''}`)
    this.name = 'JevError'
    this.kind = kind
    this.status = opts.status ?? null
    this.retryable = Boolean(opts.retryable)
    this.detail = opts.detail ?? null
    this.attempts = opts.attempts ?? 0
    this.phase = opts.phase ?? null
    this.retryAfter = opts.retryAfter ?? null
  }

  /** Safe, whitelisted projection — no response body, no inputs, no credentials. */
  toJSON() {
    return {
      kind: this.kind,
      ...(this.status ? { status: this.status } : {}),
      ...(this.detail ? { detail: this.detail } : {}),
      ...(this.phase ? { phase: this.phase } : {}),
      attempts: this.attempts,
      retryable: this.retryable,
    }
  }
}

/** `{baseUrl}/systemone`, preserving a `/v1` or gateway prefix. */
export function jevEndpoint(baseUrl, path = JEV_ENDPOINT_PATH) {
  const base = String(baseUrl ?? '').trim().replace(/\/+$/, '')
  if (!base) throw new JevError(JEV_ERROR_KINDS.notConfigured, { detail: 'base_url_missing' })
  return `${base}/${path}`
}

/** Endpoint origin — used for same-origin redirect checks, never printed with credentials. */
function originOf(url) {
  try {
    return new URL(url).origin
  } catch {
    return null
  }
}

/** Keep only a short, credential-free server hint (never the whole body). */
export function safeServerDetail(body, status) {
  if (typeof body !== 'string' || !body.trim()) return status ? `http_${status}` : null
  try {
    const parsed = JSON.parse(body)
    // A validation field name is the most useful safe hint; then a short code.
    const field = parsed?.detail?.field ?? parsed?.field
    if (typeof field === 'string' && /^[A-Za-z0-9_.\[\]-]{1,64}$/.test(field)) return `field:${field}`
    for (const key of ['error', 'code', 'type']) {
      const value = parsed?.[key]
      if (typeof value === 'string' && /^[A-Za-z0-9_.-]{1,48}$/.test(value)) return value
      if (value && typeof value === 'object' && typeof value.code === 'string' && /^[A-Za-z0-9_.-]{1,48}$/.test(value.code)) return value.code
    }
  } catch {
    /* not JSON */
  }
  return status ? `http_${status}` : null
}

function retryAfterMs(headers, nowMs) {
  const raw = headers?.get?.('retry-after')
  if (!raw) return null
  const seconds = Number(String(raw).trim())
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000)
  const at = Date.parse(String(raw))
  return Number.isFinite(at) ? Math.max(0, at - nowMs) : null
}

/**
 * Classify an HTTP response into a whitelisted kind.
 * @param {number} status
 */
export function classifyStatus(status) {
  if (status === 401 || status === 403) return { kind: JEV_ERROR_KINDS.unauthorized, retryable: false }
  if (status === 422) return { kind: JEV_ERROR_KINDS.invalidRequest, retryable: false }
  if (status === 429) return { kind: JEV_ERROR_KINDS.rateLimited, retryable: true }
  if (status === 529) return { kind: JEV_ERROR_KINDS.overloaded, retryable: true }
  if (status >= 500) return { kind: JEV_ERROR_KINDS.serverError, retryable: true }
  if (status >= 300 && status < 400) return { kind: JEV_ERROR_KINDS.redirectBlocked, retryable: false }
  return { kind: JEV_ERROR_KINDS.invalidRequest, retryable: false }
}

const isNumber = (value) => typeof value === 'number' && Number.isFinite(value)
const inUnit = (value) => isNumber(value) && value >= 0 && value <= 1

/**
 * Shape-validate the `answers` map against the questions we sent.
 *
 * Expected-field problems (missing/NaN/out-of-range/wrong type/choice outside
 * the offered options) never reach a success branch: the entry is dropped and
 * reported by id. Unknown ids are ignored and reported. This function never
 * throws for entry-level problems.
 *
 * @param {unknown} raw
 * @param {Record<string, { type: string, criteria?: Record<string, unknown> }>} questions
 */
export function validateJevAnswers(raw, questions) {
  const requested = Object.keys(questions ?? {})
  const requestedSet = new Set(requested)
  const entries = new Map()
  const invalidIds = []
  const unknownIds = []
  const missingIds = []
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { entries, invalidIds: requested, unknownIds: [], missingIds: [], shapeError: 'answers_not_object' }
  }
  for (const [id, value] of Object.entries(/** @type {Record<string, unknown>} */ (raw))) {
    if (!requestedSet.has(id)) {
      unknownIds.push(id)
      continue
    }
    const spec = questions[id]
    const expected = spec?.type
    const invalid = (reason) => invalidIds.push(`${id}:${reason}`)
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      invalid('not_object')
      continue
    }
    const answer = /** @type {Record<string, unknown>} */ (value)
    if (answer.type !== expected) {
      invalid('type_mismatch')
      continue
    }
    if (expected === 'noul') {
      if (!inUnit(answer.noul)) {
        invalid('noul_out_of_range')
        continue
      }
      entries.set(id, { type: 'noul', value: answer.noul })
      continue
    }
    if (expected === 'choice') {
      const options = Object.keys(spec.criteria ?? {})
      if (typeof answer.choice !== 'string' || !options.includes(answer.choice)) {
        invalid('choice_not_offered')
        continue
      }
      /** @type {Record<string, number>} */
      const probabilities = {}
      const rawProbabilities = answer.probabilities
      if (rawProbabilities && typeof rawProbabilities === 'object' && !Array.isArray(rawProbabilities)) {
        for (const [key, p] of Object.entries(/** @type {Record<string, unknown>} */ (rawProbabilities))) {
          if (!options.includes(key) || !inUnit(p)) {
            invalid('probabilities_invalid')
            break
          }
          probabilities[key] = p
        }
      }
      if (invalidIds.at(-1)?.startsWith(`${id}:`)) continue
      if (answer.confidence !== undefined && !inUnit(answer.confidence)) {
        invalid('confidence_out_of_range')
        continue
      }
      entries.set(id, {
        type: 'choice',
        choice: answer.choice,
        probabilities,
        ...(answer.confidence !== undefined ? { confidence: answer.confidence } : {}),
      })
      continue
    }
    invalid('unsupported_type')
  }
  for (const id of requested) if (!entries.has(id) && !invalidIds.some((entry) => entry.startsWith(`${id}:`))) missingIds.push(id)
  return { entries, invalidIds, unknownIds, missingIds, shapeError: null }
}

function readUsage(raw) {
  const usage = raw && typeof raw === 'object' ? /** @type {Record<string, unknown>} */ (raw) : {}
  const num = (...names) => {
    for (const name of names) {
      const value = usage[name]
      if (isNumber(value) && value >= 0) return value
    }
    return null
  }
  return {
    inputTokens: num('input_tokens', 'inputTokens', 'prompt_tokens'),
    outputTokens: num('output_tokens', 'outputTokens', 'completion_tokens'),
  }
}

/** Conservative serialized-size budget: tokenizer-free, so sizes are estimated, not predicted. */
export function estimateJevTokens(chars) {
  return Math.ceil(Number(chars ?? 0) / 2)
}

const sleepAbortable = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(abortErr(signal))
  const timer = setTimeout(() => {
    signal?.removeEventListener('abort', onAbort)
    resolve()
  }, Math.max(0, ms))
  const onAbort = () => {
    clearTimeout(timer)
    reject(abortErr(signal))
  }
  signal?.addEventListener('abort', onAbort, { once: true })
})

function abortErr(signal) {
  return signal?.reason instanceof Error ? signal.reason : new JevError(JEV_ERROR_KINDS.cancelled)
}

/**
 * Jev System One client. One instance per adaptive_search call: retry counters
 * and usage accumulate per call, and the instance holds the key privately.
 *
 * @param {{
 *   baseUrl: string,
 *   apiKey: string,
 *   model?: string,
 *   fetchImpl?: typeof fetch,
 *   signal?: AbortSignal | null,
 *   perRequestMs?: number,
 *   maxRetries?: number,
 *   maxBackoffMs?: number,
 *   maxRequestChars?: number,
 *   maxResponseBytes?: number,
 *   now?: () => number,
 *   sleep?: (ms: number, signal?: AbortSignal | null) => Promise<void>,
 * }} config
 */
export function createJevClient(config) {
  const baseUrl = String(config.baseUrl ?? '').trim().replace(/\/+$/, '')
  const apiKey = String(config.apiKey ?? '').trim()
  if (!baseUrl || !apiKey) throw new JevError(JEV_ERROR_KINDS.notConfigured)
  const endpoint = jevEndpoint(baseUrl)
  const model = String(config.model ?? '').trim() || JEV_DEFAULT_MODEL
  const fetchImpl = config.fetchImpl ?? ipv4Fetch
  const perRequestMs = config.perRequestMs ?? 20_000
  const maxRetries = config.maxRetries ?? 2
  const maxBackoffMs = config.maxBackoffMs ?? 4_000
  const maxRequestChars = config.maxRequestChars ?? 60_000
  const maxResponseBytes = config.maxResponseBytes ?? 4_000_000
  const now = config.now ?? (() => Date.now())
  const sleep = config.sleep ?? sleepAbortable
  const expectedOrigin = originOf(endpoint)

  const usage = { calls: 0, httpAttempts: 0, inputTokens: 0, outputTokens: 0, serverUsageCalls: 0, retries: 0, backoffMs: 0 }
  let lastModel = null

  const withTimeouts = (signal) => (signal ? mergeSignals(signal, perRequestMs) : AbortSignal.timeout(perRequestMs))

  async function postOnce(body, signal, phase) {
    const text = JSON.stringify(body)
    usage.httpAttempts++
    let res
    try {
      res = await fetchImpl(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}`, accept: 'application/json' },
        body: text,
        redirect: 'manual',
        signal: withTimeouts(signal),
      })
    } catch (err) {
      if (signal?.aborted) throw new JevError(JEV_ERROR_KINDS.cancelled, { phase, attempts: usage.httpAttempts, detail: 'aborted' })
      const name = err instanceof Error ? err.name : ''
      const kind = name === 'TimeoutError' || name === 'AbortError' ? JEV_ERROR_KINDS.timeout : JEV_ERROR_KINDS.network
      throw new JevError(kind, { retryable: true, phase, attempts: usage.httpAttempts, detail: name || 'fetch_failed' })
    }
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location')
      const target = location ? originOf(new URL(location, endpoint).toString()) : null
      // A credential-bearing request may only continue on the same origin.
      throw new JevError(JEV_ERROR_KINDS.redirectBlocked, {
        status: res.status, phase, attempts: usage.httpAttempts,
        detail: target && target === expectedOrigin ? 'same_origin_redirect_not_followed' : 'cross_origin_redirect_blocked',
      })
    }
    if (!res.ok) {
      let body = ''
      try {
        body = await readLimited(res, 20_000)
      } catch { /* body is optional */ }
      const { kind, retryable } = classifyStatus(res.status)
      throw new JevError(kind, {
        status: res.status, retryable, phase, attempts: usage.httpAttempts,
        detail: safeServerDetail(body, res.status),
        retryAfter: retryAfterMs(res.headers, now()),
      })
    }
    let raw = ''
    try {
      raw = await readLimited(res, maxResponseBytes)
    } catch (err) {
      throw new JevError(JEV_ERROR_KINDS.malformedResponse, { status: res.status, phase, attempts: usage.httpAttempts, detail: 'body_read_failed' })
    }
    if (!raw.trim()) {
      throw new JevError(JEV_ERROR_KINDS.malformedResponse, { status: res.status, phase, attempts: usage.httpAttempts, detail: 'empty_body' })
    }
    if (/^\s*</.test(raw)) {
      // A gateway/CDN HTML page instead of JSON — retryable because it is usually transient.
      throw new JevError(JEV_ERROR_KINDS.gatewayResponse, { status: res.status, retryable: true, phase, attempts: usage.httpAttempts, detail: 'html_body' })
    }
    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw new JevError(JEV_ERROR_KINDS.malformedResponse, { status: res.status, phase, attempts: usage.httpAttempts, detail: 'not_json' })
    }
    return { parsed, retryAfter: retryAfterMs(res.headers, now()) }
  }

  return {
    /** Explicitly safe projection for logs/capability. Never includes the key. */
    describe() {
      return { endpointOrigin: expectedOrigin, model, configured: true }
    },
    usage: () => ({ ...usage, model: lastModel }),

    /**
     * Ask one batched set of typed questions.
     * @param {{ state: unknown, questions: Record<string, unknown>, signal?: AbortSignal | null, phase?: string }} request
     */
    async ask(request) {
      const phase = request.phase ?? 'unknown'
      const questions = request.questions ?? {}
      if (!questions || typeof questions !== 'object' || Object.keys(questions).length === 0) {
        throw new JevError(JEV_ERROR_KINDS.invalidRequest, { phase, detail: 'no_questions' })
      }
      const body = { state: request.state ?? null, model, questions }
      const requestChars = JSON.stringify(body).length
      if (requestChars > maxRequestChars) {
        throw new JevError(JEV_ERROR_KINDS.requestTooLarge, { phase, detail: `chars_${requestChars}` })
      }
      const signal = request.signal ?? config.signal ?? null
      throwIfAborted(signal)
      const started = now()
      let lastError = null
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        // A late abort during backoff must not start another HTTP request.
        if (signal?.aborted) throw new JevError(JEV_ERROR_KINDS.cancelled, { phase, detail: 'aborted', attempts: usage.httpAttempts })
        try {
          const { parsed, retryAfter } = await postOnce(body, signal, phase)
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !('answers' in parsed)) {
            throw new JevError(JEV_ERROR_KINDS.malformedResponse, { phase, attempts: usage.httpAttempts, detail: 'missing_answers' })
          }
          const validated = validateJevAnswers(parsed.answers, questions)
          usage.calls++
          const reported = readUsage(parsed.usage)
          if (reported.inputTokens !== null || reported.outputTokens !== null) {
            usage.serverUsageCalls++
            usage.inputTokens += reported.inputTokens ?? 0
            usage.outputTokens += reported.outputTokens ?? 0
          }
          lastModel = typeof parsed.model === 'string' && parsed.model.trim() ? parsed.model.trim() : model
          return {
            model: lastModel,
            entries: validated.entries,
            invalidIds: validated.invalidIds,
            unknownIds: validated.unknownIds,
            missingIds: validated.missingIds,
            shapeError: validated.shapeError,
            usage: reported,
            attempts: usage.httpAttempts,
            requestChars,
            tookMs: now() - started,
            phase,
          }
        } catch (err) {
          const error = err instanceof JevError ? err : new JevError(JEV_ERROR_KINDS.network, { phase, detail: 'unexpected' })
          lastError = error
          if (signal?.aborted) throw new JevError(JEV_ERROR_KINDS.cancelled, { phase, detail: 'aborted', attempts: usage.httpAttempts })
          const budgetLeft = attempt < maxRetries
          if (!error.retryable || !budgetLeft) throw error
          const wait = Math.min(maxBackoffMs, Math.max(error.retryAfter ?? 0, 300 * 2 ** attempt))
          usage.retries++
          usage.backoffMs += wait
          await sleep(wait, signal)
        }
      }
      throw lastError ?? new JevError(JEV_ERROR_KINDS.network, { phase })
    },
  }
}
