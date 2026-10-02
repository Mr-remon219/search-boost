// Transport outcome is independent of result count: domain/score filters can
// legitimately leave zero hits after successful requests. Shared by tool and
// native-provider boundaries so they cannot assign opposite empty semantics.
/** True when every attempted engine failed. Legacy stats retain their fallback. */
export function allAttemptedEnginesFailed(engineStats) {
  if (!engineStats || typeof engineStats !== 'object') return false
  const attempted = Object.values(engineStats).filter((stat) => stat?.used)
  if (attempted.length === 0) return false
  return attempted.every((stat) => stat.successes !== undefined ? stat.successes === 0 : stat.errors > 0)
}
