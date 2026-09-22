import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { ensurePrivateDir, readJsonStore, writeFileAtomicPrivate } from './private-file.mjs'

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

/**
 * Marker recording that SearchBoost itself initialized (or emptied) a store.
 * Without it, an empty canonical file is indistinguishable from "never
 * initialized", and reading would fall back to an older copy — which is how a
 * deleted key used to come back.
 * @param {string} file
 */
export function storeInitializedMarkerPath(file) {
  return `${file}.initialized`
}

/** @param {string} file */
export function isStoreInitialized(file) {
  return existsSync(storeInitializedMarkerPath(file))
}

/**
 * @param {string} file
 * @param {{ tightenDir?: boolean }} [options]
 */
export function markStoreInitialized(file, options = {}) {
  const marker = storeInitializedMarkerPath(file)
  writeFileAtomicPrivate(marker, `${new Date().toISOString()}\n`, { tightenDir: options.tightenDir !== false })
  return marker
}

/** Is this store the canonical (not env-overridden) one? */
export function isCanonicalStorePath(kind, file, options = {}) {
  return file === configNestedPath(kind, options)
}

/**
 * Content check for a keys document: engine secrets, routing metadata and the
 * Jev block all count. Routing-only configuration is real configuration, so a
 * file that carries it must not be skipped just because the keys live in the
 * environment.
 * @param {any} doc
 */
export function keysDocHasConfig(doc) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return false
  // Mirrors CONFIG_KEY_NAMES in keys.mjs (this module cannot import it without a
  // cycle): a store holding only an optional-key engine key is still the user's
  // real configuration, so it stays authoritative instead of being treated as empty.
  if (['tavily', 'brave', 'exa', 'anysearch'].some((name) => typeof doc[name] === 'string' && doc[name].trim())) return true
  if (Array.isArray(doc.enabledEngines)) return true
  const engines = doc.engines
  if (engines && typeof engines === 'object' && !Array.isArray(engines)) {
    if (Object.values(engines).some((entry) => entry && typeof entry === 'object' && typeof entry.enabled === 'boolean')) return true
  }
  const jev = doc.jev
  if (jev && typeof jev === 'object' && !Array.isArray(jev)) {
    return ['baseUrl', 'apiKey'].some((field) => typeof jev[field] === 'string' && jev[field].trim())
  }
  return false
}

/**
 * @param {string} file
 * @param {ConfigKind} kind
 * @returns {'missing'|'empty'|'configured'}
 * @throws {import('./private-file.mjs').PrivateFileError} when the file exists but is corrupt/unreadable
 */
export function configStoreState(file, kind) {
  const { exists, doc, error } = readJsonStore(file)
  if (!exists) return 'missing'
  // A corrupt/unreadable main store must be reported, never treated as empty:
  // treating it as empty is what let a write overwrite the user's file.
  if (error) throw error
  if (kind === 'keys') return keysDocHasConfig(doc) ? 'configured' : 'empty'
  return Object.keys(doc ?? {}).length > 0 ? 'configured' : 'empty'
}

/** Tolerant content probe for compatibility candidates (a broken copy is skipped). */
function configCandidateHasContent(file, kind) {
  if (!existsSync(file)) return false
  try {
    return configStoreState(file, kind) === 'configured'
  } catch {
    return false
  }
}

/**
 * Copy flat/legacy config to the nested write path when the canonical store has
 * not been initialized yet; warn once per kind.
 *
 * An initialized store is authoritative even when it is empty: that is how a
 * deleted key stays deleted instead of coming back from an older copy. A corrupt
 * canonical store is never overwritten.
 * @param {ConfigKind} kind
 * @param {{ homeDir?: string }} [options]
 */
export function prepareConfigWrite(kind, options = {}) {
  const writePath = configWritePath(kind, options)
  const hasEnvOverride = Boolean(process.env[SPECS[kind].env])
  const state = configStoreState(writePath, kind)
  const initialized = isStoreInitialized(writePath)
  const tightenDir = writePath === configNestedPath(kind, options)
  if (!hasEnvOverride && !initialized && (state === 'missing' || state === 'empty')) {
    for (const file of configReadCandidates(kind, options)) {
      if (file === writePath || !existsSync(file)) continue
      if (!configCandidateHasContent(file, kind)) continue
      ensurePrivateDir(dirname(writePath), { tighten: tightenDir })
      if (kind === 'keys') {
        // Never adopt a Jev block from a compatibility copy: the Jev endpoint and
        // key are only ever read from / written to the canonical store.
        const { doc } = readJsonStore(file)
        const migrated = { ...(doc ?? {}) }
        const hadJev = 'jev' in migrated
        if (hadJev) delete migrated.jev
        writeFileAtomicPrivate(writePath, `${JSON.stringify(migrated, null, 2)}\n`, { tightenDir })
        if (hadJev) {
          console.warn('Note: the legacy keys file\u2019s Jev block was not migrated — re-enter it with `search-boost config jev`.')
        }
      } else {
        copyFileSync(file, writePath)
      }
      markStoreInitialized(writePath, { tightenDir })
      if (!migrationNoticesShown.has(kind)) {
        migrationNoticesShown.add(kind)
        console.warn(
          `Note: Migrated ${kind} config from ${tilde(file, options)} → ${tilde(writePath, options)}. Old file kept.`,
        )
      }
      break
    }
  }
  ensurePrivateDir(dirname(writePath), { tighten: tightenDir })
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
