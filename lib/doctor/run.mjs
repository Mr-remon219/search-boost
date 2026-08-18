import { join } from 'node:path'
import { AGENT_IDS, agentStatus } from '../agents/index.mjs'
import { getLayer, layerFilePath } from '../layer-config.mjs'
import { keysFilePath } from '../keys.mjs'
import { getVersion } from '../pkg.mjs'
import { isDoctorCategory } from './categories.mjs'
import { staticEngineMap } from './checks/engines.mjs'
import { computeReport } from './report.mjs'
import { renderHuman, renderJson } from './render.mjs'
import { buildChecks } from './registry.mjs'

/**
 * @param {Record<string, string|undefined>} env
 * @returns {() => void}
 */
function withEnv(env) {
  /** @type {Record<string, string|undefined>} */
  const saved = {}
  for (const [key, value] of Object.entries(env)) {
    saved[key] = process.env[key]
    if (value === undefined || value === null) delete process.env[key]
    else process.env[key] = value
  }
  return () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

/**
 * @param {string} [homeDir]
 * @returns {Record<string, string|undefined>}
 */
function homeEnvOverrides(homeDir) {
  if (!homeDir) return {}
  return {
    SEARCH_BOOST_KEYS_FILE: join(homeDir, '.search-boost-keys.json'),
    SEARCH_BOOST_LAYER_FILE: join(homeDir, '.search-boost-layer.json'),
  }
}

/**
 * @param {{
 *   quick?: boolean,
 *   probe?: boolean,
 *   json?: boolean,
 *   strict?: boolean,
 *   category?: string | string[],
 *   verbose?: boolean,
 *   homeDir?: string,
 *   env?: Record<string, string|undefined>,
 *   silent?: boolean,
 * }} [opts]
 * @returns {Promise<{ report: import('./types.mjs').DoctorReport, exitCode: number, text?: string }>}
 */
export async function runDoctor(opts = {}) {
  const {
    quick = true,
    probe = false,
    json = false,
    strict = false,
    category,
    verbose = false,
    homeDir,
    env = {},
    silent = false,
  } = opts

  if (probe && !quick) {
    throw new Error('doctor --probe requires quick checks (use both flags or default --quick)')
  }

  /** @type {string[]|null} */
  let categories = null
  if (category) {
    const raw = Array.isArray(category) ? category : [category]
    categories = raw.filter((c) => {
      if (!isDoctorCategory(c)) throw new Error(`Unknown doctor category: ${c}`)
      return true
    })
  }

  const restore = withEnv({
    ...homeEnvOverrides(homeDir),
    ...env,
  })

  try {
    /** @type {import('./types.mjs').DoctorContext} */
    const ctx = {
      quick: quick !== false,
      probe: !!probe,
      verbose: !!verbose,
      categories,
      homeDir,
    }

    const registry = buildChecks()
    const selected = categories
      ? registry.filter((check) => categories.includes(check.category))
      : registry

    /** @type {import('./types.mjs').CheckResult[]} */
    const results = []
    for (const check of selected) {
      const result = await check.run(ctx)
      results.push({
        id: check.id,
        category: check.category,
        status: result.status,
        message: result.message,
        fix_hint: result.fix_hint,
        details: result.details,
      })
    }

    const report = computeReport(results, {
      mode: probe ? 'probe' : 'quick',
      packageVersion: getVersion(),
      strict,
      environment: {
        node: process.versions.node,
        platform: process.platform,
        layer: getLayer(),
        layerFile: layerFilePath(),
        keysFile: keysFilePath(),
      },
      engines: { static: staticEngineMap() },
      agents: AGENT_IDS.map((id) => {
        const s = agentStatus(id)
        return { id, detected: s.detected, configured: s.configured }
      }),
      probe: probe ? { pending: true } : null,
    })

    const text = json ? renderJson(report) : renderHuman(report, { verbose })
    if (!silent) {
      if (json) process.stdout.write(text)
      else console.log(text)
    }

    return { report, exitCode: report.summary.exitCode, text }
  } finally {
    restore()
  }
}
