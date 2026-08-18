import { computeExitCode } from './exit.mjs'

/**
 * @param {import('./types.mjs').CheckResult[]} checks
 * @param {Record<string, unknown>} meta
 * @returns {import('./types.mjs').DoctorReport}
 */
export function computeReport(checks, meta) {
  /** @type {import('./types.mjs').DoctorSummary} */
  const summary = { pass: 0, warn: 0, fail: 0, skip: 0, exitCode: 0 }
  for (const check of checks) {
    if (check.status in summary && check.status !== 'exitCode') {
      summary[check.status]++
    }
  }
  const strict = /** @type {boolean} */ (meta.strict ?? false)
  summary.exitCode = computeExitCode(summary, { strict })
  return /** @type {import('./types.mjs').DoctorReport} */ ({
    version: 1,
    command: 'search-boost doctor',
    mode: meta.mode ?? 'quick',
    timestamp: new Date().toISOString(),
    packageVersion: meta.packageVersion ?? '0.0.0',
    summary,
    checks,
    environment: meta.environment ?? {},
    engines: meta.engines ?? {},
    agents: meta.agents ?? null,
    probe: meta.probe ?? null,
  })
}
