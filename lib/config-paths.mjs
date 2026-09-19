import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** @typedef {'keys'|'layer'|'xauth'|'xguest'|'workspaces'} ConfigKind */

/**
 * `legacy` — the dsh-search-boost flat file in $HOME (first legacy candidate).
 * `piLegacy` — the pi-search-boost state file under pi's agent dir
 * (PI_CODING_AGENT_DIR, else ~/.pi/agent). Both are read-only compatibility
 * paths: writes always go to the nested ~/.search-boost/ layout.
 */
const SPECS = {
  keys: {
    env: 'SEARCH_BOOST_KEYS_FILE',
    nested: 'config/keys.json',
    flat: '.search-boost-keys.json',
    legacy: '.dsh-search-boost-keys.json',
    piLegacy: null,
  },
  layer: {
    env: 'SEARCH_BOOST_LAYER_FILE',
    nested: 'config/layer.json',
    flat: '.search-boost-layer.json',
    legacy: '.dsh-search-boost-layer.json',
    piLegacy: 'search-boost-layer.json',
  },
  xauth: {
    env: 'SEARCH_BOOST_XAUTH_FILE',
    nested: 'config/xauth.json',
    flat: '.search-boost-xauth.json',
    legacy: '.dsh-search-boost-xauth.json',
    piLegacy: 'xsearch-auth.json',
  },
  xguest: {
    env: 'SEARCH_BOOST_XGUEST_FILE',
    nested: 'cache/xguest.json',
    flat: '.search-boost-xguest.json',
    legacy: '.dsh-search-boost-xguest.json',
    piLegacy: 'xsearch-guest.json',
  },
  workspaces: {
    env: 'SEARCH_BOOST_WORKSPACES_FILE',
    nested: 'state/antigravity-workspaces.json',
    flat: '.search-boost-antigravity-workspaces.json',
    legacy: null,
  },
}

/** @param {{ homeDir?: string }} [options] */
export function searchBoostHome(options = {}) {
  if (process.env.SEARCH_BOOST_HOME) return process.env.SEARCH_BOOST_HOME
  const homeDir = options.homeDir ?? homedir()
  return join(homeDir, '.search-boost')
}

/** @param {string} p @param {{ homeDir?: string }} [options] */
function tilde(p, options = {}) {
  const homeDir = options.homeDir ?? homedir()
  if (p.startsWith(homeDir)) return `~${p.slice(homeDir.length)}`
  return p
}

/** @param {ConfigKind} kind @param {{ homeDir?: string }} [options] */
export function configNestedPath(kind, options = {}) {
  return join(searchBoostHome(options), SPECS[kind].nested)
}

/** @param {ConfigKind} kind @param {{ homeDir?: string }} [options] */
export function configFlatPath(kind, options = {}) {
  const homeDir = options.homeDir ?? homedir()
  return join(homeDir, SPECS[kind].flat)
}

/** @param {ConfigKind} kind @param {{ homeDir?: string }} [options] */
export function configLegacyPath(kind, options = {}) {
  const spec = SPECS[kind]
  if (!spec.legacy) return null
  const homeDir = options.homeDir ?? homedir()
  return join(homeDir, spec.legacy)
}

/** pi's agent dir — same resolution as pi's getAgentDir(): env override, else ~/.pi/agent. */
export function piAgentDir(options = {}) {
  const homeDir = options.homeDir ?? homedir()
  const envDir = process.env.PI_CODING_AGENT_DIR
  if (envDir) return envDir.replace(/^~(?=$|[\\/])/, homeDir)
  return join(homeDir, '.pi', 'agent')
}

/** pi-search-boost state file for this kind (read-only compatibility), or null. */
export function configPiLegacyPath(kind, options = {}) {
  const spec = SPECS[kind]
  if (!spec.piLegacy) return null
  return join(piAgentDir(options), spec.piLegacy)
}

/** Path used for writes (nested under ~/.search-boost/ or env override). */
export function configWritePath(kind, options = {}) {
  const spec = SPECS[kind]
  if (process.env[spec.env]) return process.env[spec.env]
  return configNestedPath(kind, options)
}

/**
 * Ordered candidates for reads: env override → nested → flat home → dsh legacy → pi legacy.
 * @param {ConfigKind} kind
 * @param {{ homeDir?: string }} [options]
 */
export function configReadCandidates(kind, options = {}) {
  const spec = SPECS[kind]
  /** @type {string[]} */
  const out = []
  if (process.env[spec.env]) out.push(process.env[spec.env])
  out.push(configNestedPath(kind, options))
  out.push(configFlatPath(kind, options))
  const legacy = configLegacyPath(kind, options)
  if (legacy) out.push(legacy)
  const piLegacy = configPiLegacyPath(kind, options)
  if (piLegacy) out.push(piLegacy)
  return [...new Set(out)]
}

/** First existing candidate path, else the write path. */
export function configReadPath(kind, options = {}) {
  for (const file of configReadCandidates(kind, options)) {
    if (existsSync(file)) return file
  }
  return configWritePath(kind, options)
}

/** @param {ConfigKind} kind @param {{ homeDir?: string }} [options] */
export function configLayoutPaths(kind, options = {}) {
  return {
    nested: configNestedPath(kind, options),
    flat: configFlatPath(kind, options),
    legacy: configLegacyPath(kind, options),
    write: configWritePath(kind, options),
  }
}

/** @type {Set<ConfigKind>} */
const migrationNoticesShown = new Set()

/** Test hook — reset one-time migration notices. */
export function resetConfigMigrationNotices() {
  migrationNoticesShown.clear()
}

/** @param {string} file @param {ConfigKind} kind */
function configFileHasContent(file, kind) {
  if (!existsSync(file)) return false
  try {
    const doc = JSON.parse(readFileSync(file, 'utf8'))
    if (kind === 'keys') {
      if (['tavily', 'brave', 'exa'].some(
        (name) => typeof doc[name] === 'string' && doc[name].trim(),
      )) return true
      // Provider credentials (the `jev` block, see lib/keys.mjs) count as content too:
      // a Jev-only keys.json must not look empty and let a flat/legacy file overwrite it.
      const jev = doc.jev
      if (jev && typeof jev === 'object' && !Array.isArray(jev)) {
        return ['baseUrl', 'apiKey'].some(
          (field) => typeof jev[field] === 'string' && jev[field].trim(),
        )
      }
      return false
    }
    return Object.keys(doc).length > 0
  } catch {
    return false
  }
}

/**
 * Copy flat/legacy config to nested write path when missing; warn once per kind.
 * Empty nested keys.json is treated as missing so flat/legacy can merge in.
 * Ensures parent directory exists. Returns the write path.
 * @param {ConfigKind} kind
 * @param {{ homeDir?: string }} [options]
 */
export function prepareConfigWrite(kind, options = {}) {
  const writePath = configWritePath(kind, options)
  const writeMissing = !existsSync(writePath)
  const writeEmpty = !writeMissing && kind === 'keys' && !configFileHasContent(writePath, kind)
  if (!process.env[SPECS[kind].env] && (writeMissing || writeEmpty)) {
    for (const file of configReadCandidates(kind, options)) {
      if (file === writePath || !existsSync(file)) continue
      if (kind === 'keys' && !configFileHasContent(file, kind)) continue
      mkdirSync(dirname(writePath), { recursive: true })
      copyFileSync(file, writePath)
      if (!migrationNoticesShown.has(kind)) {
        migrationNoticesShown.add(kind)
        console.warn(
          `Note: Migrated ${kind} config from ${tilde(file, options)} → ${tilde(writePath, options)}. Old file kept.`,
        )
      }
      break
    }
  }
  mkdirSync(dirname(writePath), { recursive: true })
  return writePath
}

/**
 * Read JSON from the first existing candidate file.
 * @template T
 * @param {string[]} candidates
 * @param {T} fallback
 * @returns {T}
 */
export function readFirstExistingJson(candidates, fallback) {
  for (const file of candidates) {
    if (!existsSync(file)) continue
    try {
      return JSON.parse(readFileSync(file, 'utf8'))
    } catch { /* try next */ }
  }
  return fallback
}
