import { DOCTOR_CATEGORIES } from './categories.mjs'

const STATUS_ICON = {
  pass: '✓',
  warn: '⚠',
  fail: '✗',
  skip: 'ℹ',
}

/**
 * @param {import('./types.mjs').DoctorReport} report
 * @param {{ verbose?: boolean, strict?: boolean }} [opts]
 */
export function renderHuman(report, opts = {}) {
  const lines = []
  lines.push(`search-boost doctor v${report.packageVersion} · ${report.mode} · ${report.timestamp}`)
  lines.push('')
  lines.push(`SUMMARY  pass ${report.summary.pass}  warn ${report.summary.warn}  fail ${report.summary.fail}  skip ${report.summary.skip}`)
  lines.push('')

  const byCategory = groupByCategory(report.checks)
  for (const category of DOCTOR_CATEGORIES) {
    const checks = byCategory.get(category)
    if (!checks?.length) continue
    lines.push(`[${category}]`)
    for (const check of checks) {
      const icon = STATUS_ICON[check.status] ?? '?'
      lines.push(`  ${icon} ${check.id.padEnd(24)} ${check.message}`)
      if (check.fix_hint) lines.push(`      → ${check.fix_hint}`)
      if (opts.verbose && check.details && Object.keys(check.details).length) {
        lines.push(`      details: ${JSON.stringify(check.details)}`)
      }
    }
    lines.push('')
  }

  const hints = [...new Set(report.checks.filter((c) => c.fix_hint).map((c) => c.fix_hint))]
  if (hints.length) {
    lines.push(`Next: ${hints.slice(0, 3).join('  ·  ')}`)
  }

  const exitNote = report.summary.exitCode === 0
    ? 'Exit: 0 (healthy)'
    : report.summary.fail > 0
      ? 'Exit: 1 (failures present)'
      : report.summary.exitCode === 2
        ? 'Exit: 2 (warnings present; use --strict to fail)'
        : 'Exit: 1 (--strict: warnings treated as failures)'

  lines.push(exitNote)
  return lines.join('\n')
}

/** @param {import('./types.mjs').DoctorReport} report */
export function renderJson(report) {
  return `${JSON.stringify(report, null, 2)}\n`
}

/** @param {import('./types.mjs').CheckReport[]} checks */
function groupByCategory(checks) {
  /** @type {Map<string, import('./types.mjs').CheckReport[]>} */
  const map = new Map()
  for (const check of checks) {
    const list = map.get(check.category) ?? []
    list.push(check)
    map.set(check.category, list)
  }
  return map
}
