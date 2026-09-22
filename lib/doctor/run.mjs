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
 * Engine map for the report environment. A corrupt/unreadable config store is a
 * finding for the checks to report — it must not crash the doctor itself.
 */
function safeStaticEngineMap() {
  try {
    return staticEngineMap()
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err), code: err?.code ?? null }
  }
}

/**
 * Report environment. Every field here reads configuration, so a corrupt store
 * would otherwise crash the doctor before it can report the corruption.
 */
function safeEnvironment() {
  const base = { node: process.versions.node, platform: process.platform }
  try {
    return { ...base, layer: getLayer(), layerFile: layerFilePath(), keysFile: keysFilePath() }
  } catch (err) {
    return {
      ...base,
      layer: 'unknown',
      layerFile: null,
      keysFile: null,
      error: err instanceof Error ? err.message : String(err),
      code: err?.code ?? null,
    }
  }
}

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

    if (selected.length === 0) {
      const cats = categories?.join(', ') ?? '(none)'
      const message = `No checks registered for categor${categories?.length === 1 ? 'y' : 'ies'}: ${cats}`
      const report = computeReport([], {
        mode: probe ? 'probe' : 'quick',
        packageVersion: getVersion(),
        strict,
        environment: safeEnvironment(),
        engines: { static: safeStaticEngineMap() },
        agents: AGENT_IDS.map((id) => {
          const s = agentStatus(id)
          return { id, detected: s.detected, configured: s.configured }
        }),
        probe: probe ? { pending: true } : null,
      })
      report.summary.exitCode = 2 // empty selection is an operational error, not a healthy run
      // --json must stay machine-readable on stdout even for an empty selection.
      const text = json ? renderJson(report) : message
      if (!silent) {
        if (json) process.stdout.write(text)
        else {
          console.error(message)
          if (categories?.includes('probe')) {
            console.error('Note: probe checks are Phase 2 — not yet implemented.')
          }
        }
      }
      return { report, exitCode: 2, text }
    }

    /** @type {import('./types.mjs').CheckResult[]} */
    const results = []
    for (const check of selected) {
      let result
      try {
        result = await check.run(ctx)
      } catch (err) {
        // A check reports a problem; it must never crash the whole doctor run. A
        // corrupt config store or a broken host integration is itself a finding.
        result = {
          status: 'fail',
          message: `check could not run: ${err instanceof Error ? err.message : String(err)}`,
          fix_hint: err?.code === 'store_corrupt' || err?.code === 'store_unreadable'
            ? 'Fix or remove the corrupt keys file; run search-boost config keys'
            : null,
          details: { error: err instanceof Error ? err.message : String(err), code: err?.code ?? null },
        }
      }
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
      environment: safeEnvironment(),
      engines: { static: safeStaticEngineMap() },
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
