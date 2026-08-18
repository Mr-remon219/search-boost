/**
 * @param {{ pass: number, warn: number, fail: number, skip: number }} summary
 * @param {{ strict?: boolean }} [opts]
 */
export function computeExitCode(summary, { strict = false } = {}) {
  if (summary.fail > 0) return 1
  if (strict && summary.warn > 0) return 1
  if (summary.warn > 0) return 2
  return 0
}
