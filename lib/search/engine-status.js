// Transport outcome is independent of result count: domain/score filters can
// legitimately leave zero hits after successful requests. Shared by tool and
// native-provider boundaries so they cannot assign opposite empty semantics.
/** Stable short class for an engine failure. Response bodies are not included. */
export function classifyEngineError(err) {
  if (err?.kind === 'cancelled' || err?.name === 'AbortError') return 'cancelled'
  if (err?.name === 'TimeoutError' || err?.kind === 'timeout') return 'timeout'
  if (typeof err?.kind === 'string' && /^(?:http_\d{3}|invalid_request|invalid_response|missing_key|legacy_endpoint|response_too_large)$/.test(err.kind)) return err.kind
  const msg = err instanceof Error ? err.message : String(err ?? '')
  const http = /\bhttp[_ ](\d{3})\b/i.exec(msg)
  if (http) return `http_${http[1]}`
  if (/timeout/i.test(msg)) return 'timeout'
  if (/missing API key|missing key/i.test(msg)) return 'missing_key'
  return 'error'
}

/** True when every attempted engine failed. Legacy stats retain their fallback. */
export function allAttemptedEnginesFailed(engineStats) {
  if (!engineStats || typeof engineStats !== 'object') return false
  const attempted = Object.values(engineStats).filter((stat) => stat?.used)
  if (attempted.length === 0) return false
  return attempted.every((stat) => stat.successes !== undefined ? stat.successes === 0 : stat.errors > 0)
}
