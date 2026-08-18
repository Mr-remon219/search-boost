/**
 * @typedef {'pass'|'warn'|'fail'|'skip'} CheckStatus
 *
 * @typedef {Object} CheckResult
 * @property {string} id
 * @property {import('./categories.mjs').DoctorCategory} category
 * @property {CheckStatus} status
 * @property {string} message
 * @property {string} [fix_hint]
 * @property {Record<string, unknown>} [details]
 *
 * @typedef {Object} DoctorSummary
 * @property {number} pass
 * @property {number} warn
 * @property {number} fail
 * @property {number} skip
 * @property {number} exitCode
 *
 * @typedef {Object} DoctorReport
 * @property {number} version
 * @property {string} command
 * @property {'quick'|'probe'} mode
 * @property {string} timestamp
 * @property {string} packageVersion
 * @property {DoctorSummary} summary
 * @property {CheckResult[]} checks
 * @property {Record<string, unknown>} [environment]
 * @property {Record<string, unknown>} [engines]
 * @property {Record<string, unknown>[]|null} [agents]
 * @property {Record<string, unknown>|null} [probe]
 *
 * @typedef {Object} DoctorContext
 * @property {boolean} quick
 * @property {boolean} probe
 * @property {boolean} verbose
 * @property {string[]|null} categories
 * @property {string} [homeDir]
 *
 * @typedef {Object} DoctorCheck
 * @property {string} id
 * @property {import('./categories.mjs').DoctorCategory} category
 * @property {string} title
 * @property {(ctx: DoctorContext) => CheckResult | Promise<CheckResult>} run
 */

export {}
