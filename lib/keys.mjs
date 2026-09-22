import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  configFlatPath,
  configLegacyPath,
  configNestedPath,
  configWritePath,
  isStoreInitialized,
  keysDocHasConfig,
  markStoreInitialized,
  prepareConfigWrite,
  readFirstExistingJson,
} from './config-paths.mjs'
import { readJsonStore, withFileLock, writeFileAtomicPrivate } from './private-file.mjs'

export const KEY_NAMES = ['tavily', 'brave', 'exa', 'anysearch']
export const KEYED_ENGINE_COUNT = KEY_NAMES.length

/**
 * Engine credentials the config layer accepts before their adapter exists.
 * They are stored, masked and shown by the keys wizard exactly like the keyed
 * engines, but they never join KEY_NAMES: no `enabledEngines` entry, no
 * per-engine routing flag, no `engineRegistry` entry, no api-pool weight. A
 * stored pending key therefore changes no search behaviour — move the name into
 * KEY_NAMES when its adapter and pool wiring land.
 */
export const PENDING_ENGINE_KEY_NAMES = []

/** Every key slot the keys file understands: routable engines plus stored-only slots. */
export const CONFIG_KEY_NAMES = [...KEY_NAMES, ...PENDING_ENGINE_KEY_NAMES]

/** Shown when fewer than three keyed engines are configured or enabled. */
export const RECOMMEND_ALL_KEYED_ENGINES =
  'Recommend configuring multiple keyed engines (tavily, brave, exa, anysearch) for broader retrieval on the api layer.'

export function keysFilePath() {
  return configWritePath('keys')
}

export const ENV_MAP = {
  tavily: 'TAVILY_API_KEY',
  brave: 'BRAVE_API_KEY',
  exa: 'EXA_API_KEY',
  // AnySearch's documented env name (api.anysearch.com; key optional in its own
  // API, but search-boost only stores a real key here).
  anysearch: 'ANYSEARCH_API_KEY',
}

/** Legacy Pi installers used these environment names; never rewrite shell profiles. */
export const LEGACY_ENV_MAP = { tavily: 'PI_SEARCH_TAVILY_KEY', brave: 'PI_SEARCH_BRAVE_KEY', exa: 'PI_SEARCH_EXA_KEY' }
function envKeyName(name) {
  if (process.env[ENV_MAP[name]]?.trim()) return ENV_MAP[name]
  return LEGACY_ENV_MAP[name]
}
function envKey(name) {
  const envName = envKeyName(name)
  return envName ? process.env[envName]?.trim() : undefined
}

let legacyKeysMigrationNoticeShown = false

/** @param {string} legacyPath @param {string} primaryPath */
function maybePrintLegacyKeysMigrationNotice(legacyPath, primaryPath) {
  if (legacyKeysMigrationNoticeShown) return
  legacyKeysMigrationNoticeShown = true
  const home = homedir()
  const tilde = (p) => (p.startsWith(home) ? `~${p.slice(home.length)}` : p)
  console.warn(
    `Note: Reading API keys from ${tilde(legacyPath)} (legacy). Migrate to ${tilde(primaryPath)} with \`search-boost config keys\`.`,
  )
}

/** Test hook — reset one-time legacy migration notice. */
export function resetLegacyKeysMigrationNotice() {
  legacyKeysMigrationNoticeShown = false
}

/** @param {{ homeDir?: string }} [options] */
function keysReadCandidates(options = {}) {
  const cwdPrimary = join(process.cwd(), '.search-boost-keys.json')
  const nested = configNestedPath('keys', options)
  const flat = configFlatPath('keys', options)
  const legacy = configLegacyPath('keys', options)
  const envPath = process.env.SEARCH_BOOST_KEYS_FILE

  /** @type {string[]} */
  const candidates = []
  if (envPath) candidates.push(envPath)
  candidates.push(nested, flat)
  // A compatibility copy is only consulted while the canonical store has never
  // been initialized. An initialized (possibly empty) store is authoritative, so
  // a deleted key cannot come back from an older file.
  if (legacy && !existsSync(flat) && !keysStoreAuthoritative(nested) && !(envPath && existsSync(envPath))) {
    candidates.push(legacy)
  }
  if (!candidates.includes(cwdPrimary)) candidates.push(cwdPrimary)
  return candidates
}

/** @param {Record<string, unknown>} doc */
export function keysDocHasValues(doc) {
  for (const name of CONFIG_KEY_NAMES) {
    if (typeof doc[name] === 'string' && doc[name].trim()) return true
  }
  return jevBlockHasValues(readJevFromDoc(doc))
}

/**
 * Is this the user's real configuration store? True when it carries any
 * recognized configuration (engine keys, routing metadata, Jev block) or when
 * SearchBoost itself initialized it — an unreadable/corrupt store counts too, so
 * it is reported instead of being skipped in favour of an older copy.
 * @param {string} file
 */
function keysStoreAuthoritative(file) {
  if (!existsSync(file)) return false
  if (isStoreInitialized(file)) return true
  const { doc, error } = readJsonStore(file)
  if (error) return true
  return keysDocHasConfig(doc)
}

/** Flat/env/cwd paths are terminal when present (even empty); nested is terminal when authoritative. */
/** @param {{ homeDir?: string }} [options] */
function keysTerminalWhenExists(options = {}) {
  const set = new Set([configFlatPath('keys', options), join(process.cwd(), '.search-boost-keys.json')])
  if (process.env.SEARCH_BOOST_KEYS_FILE) set.add(process.env.SEARCH_BOOST_KEYS_FILE)
  const nested = configNestedPath('keys', options)
  if (keysStoreAuthoritative(nested)) set.add(nested)
  return set
}

/** @returns {Record<string, string | undefined>} */
export function emptyKeys() {
  /** @type {Record<string, string | undefined>} */
  const keys = {}
  for (const name of CONFIG_KEY_NAMES) keys[name] = undefined
  return keys
}

/**
 * @typedef {{ enabledEngines?: string[], engines?: Record<string, { enabled?: boolean }> }} KeysFileMeta
 */

/**
 * Read the first matching keys JSON document (includes routing meta, not env overrides).
 * @param {{ homeDir?: string }} [options]
 * @returns {{ file: string | null, doc: KeysFileMeta & Record<string, unknown> }}
 */
export function readKeysFileDocument(options = {}) {
  const candidates = keysReadCandidates(options)
  const terminalWhenExists = keysTerminalWhenExists(options)
  const nested = configNestedPath('keys', options)
  const flat = configFlatPath('keys', options)
  const legacy = configLegacyPath('keys', options)

  for (const file of candidates) {
    if (!existsSync(file)) continue
    const { doc, error } = readJsonStore(file)
    if (error) {
      // A terminal store is the user's configuration: report a corrupt/unreadable
      // file instead of silently reading an older copy (and never overwrite it).
      if (terminalWhenExists.has(file)) throw error
      continue
    }
    const keys = emptyKeys()
    for (const name of CONFIG_KEY_NAMES) {
      if (typeof doc?.[name] === 'string' && doc[name].trim()) {
        keys[name] = doc[name].trim()
      }
    }
    if (terminalWhenExists.has(file) || Object.values(keys).some(Boolean)) {
      if (file === legacy && !keysStoreAuthoritative(nested) && !existsSync(flat)) {
        maybePrintLegacyKeysMigrationNotice(legacy, configWritePath('keys', options))
      }
      return { file, doc: doc ?? {} }
    }
  }
  return { file: null, doc: {} }
}

/** @param {KeysFileMeta & Record<string, unknown>} doc */
export function readEngineRoutingFromDoc(doc) {
  /** @type {string[] | undefined} */
  let enabledEngines
  if (Array.isArray(doc.enabledEngines)) {
    enabledEngines = doc.enabledEngines
      .filter((name) => typeof name === 'string' && KEY_NAMES.includes(name))
  }
  /** @type {Record<string, boolean>} */
  const engineFlags = {}
  const enginesMeta = doc.engines
  if (enginesMeta && typeof enginesMeta === 'object' && !Array.isArray(enginesMeta)) {
    for (const name of KEY_NAMES) {
      const entry = enginesMeta[name]
      if (entry && typeof entry === 'object' && typeof entry.enabled === 'boolean') {
        engineFlags[name] = entry.enabled
      }
    }
  }
  return { enabledEngines, engineFlags }
}

/** Routing meta from disk (no env). */
export function readEngineRouting(options = {}) {
  return readEngineRoutingFromDoc(readKeysFileDocument(options).doc)
}

/**
 * Keyed engines that will participate in api-layer routing.
 * No enabledEngines field → all configured keys; per-engine enabled:false opts out.
 * @param {Record<string, string | undefined>} keys
 * @param {ReturnType<typeof readEngineRoutingFromDoc>} routing
 */
export function resolveKeyedEngines(keys, routing) {
  /** @type {string[]} */
  let names = KEY_NAMES.filter((name) => Boolean(keys[name]))
  if (routing.enabledEngines !== undefined) {
    const allow = new Set(routing.enabledEngines)
    names = names.filter((name) => allow.has(name))
  }
  return names.filter((name) => routing.engineFlags[name] !== false)
}

/**
 * @param {Record<string, string | undefined>} keys
 * @param {ReturnType<typeof readEngineRoutingFromDoc>} [routing]
 */
export function keyedPoolSummary(keys, routing = readEngineRouting()) {
  const configured = KEY_NAMES.filter((name) => Boolean(keys[name]))
  const enabled = resolveKeyedEngines(keys, routing)
  const hasExplicitRouting = routing.enabledEngines !== undefined
    || Object.values(routing.engineFlags).some((v) => v === false)
  return {
    configured: configured.length,
    enabled: enabled.length,
    total: KEYED_ENGINE_COUNT,
    configuredNames: configured,
    enabledNames: enabled,
    hasExplicitRouting,
    intentionalSingle: enabled.length === 1 && (hasExplicitRouting || configured.length === 1),
  }
}

/** @returns {string | null} */
export function partialKeyedPoolWarning(summary) {
  if (summary.enabled === 0) return null
  if (summary.enabled >= summary.total) return null
  return `api layer using ${summary.enabled}/${summary.total} keyed engine(s) (${summary.enabledNames.join(', ')}) — ${RECOMMEND_ALL_KEYED_ENGINES}`
}

/** Keys + routing for engine registry and runtime. */
export function readKeysRouting(options = {}) {
  const keys = readKeys()
  const routing = readEngineRouting(options)
  const enabledNames = resolveKeyedEngines(keys, routing)
  return {
    keys,
    routing,
    enabledNames,
    enabledSet: new Set([...enabledNames, ...(routing.engineFlags.anysearch !== false && (routing.enabledEngines === undefined || routing.enabledEngines.includes('anysearch')) ? ['anysearch'] : [])]),
    summary: keyedPoolSummary(keys, routing),
  }
}

/**
 * Read keys from disk only (no env).
 * Primary path wins when present (even if empty); legacy is only used when primary is missing.
 * @param {{ homeDir?: string }} [options] — test hook for isolated home paths
 */
export function readKeysFile(options = {}) {
  const candidates = keysReadCandidates(options)
  const terminalWhenExists = keysTerminalWhenExists(options)
  const nested = configNestedPath('keys', options)
  const flat = configFlatPath('keys', options)
  const legacy = configLegacyPath('keys', options)

  const keys = emptyKeys()
  for (const file of candidates) {
    if (!existsSync(file)) continue
    const { doc, error } = readJsonStore(file)
    if (error) {
      if (terminalWhenExists.has(file)) throw error
      continue
    }
    for (const name of CONFIG_KEY_NAMES) {
      if (typeof doc?.[name] === 'string' && doc[name].trim()) {
        keys[name] = doc[name].trim()
      }
    }
    if (terminalWhenExists.has(file) || Object.values(keys).some(Boolean)) {
      if (file === legacy && !keysStoreAuthoritative(nested) && !existsSync(flat)) {
        maybePrintLegacyKeysMigrationNotice(legacy, configWritePath('keys', options))
      }
      return keys
    }
  }
  return keys
}

/** Merge file keys with env overrides. */
export function readKeys() {
  const keys = readKeysFile()
  for (const name of CONFIG_KEY_NAMES) {
    if (!keys[name] && envKey(name)) {
      keys[name] = envKey(name)
    }
  }
  return keys
}

/** @param {string} key */
export function maskKey(key) {
  if (!key || key.length < 8) return '****'
  return `${key.slice(0, 4)}****${key.slice(-4)}`
}

/**
 * @returns {Record<string, { source: 'file'|'env'|'missing', masked?: string }>}
 */
export function keyStatus() {
  const fileKeys = readKeysFile()
  const out = /** @type {Record<string, { source: 'file'|'env'|'missing', masked?: string }>} */ ({})
  for (const name of CONFIG_KEY_NAMES) {
    if (fileKeys[name]) {
      out[name] = { source: 'file', masked: maskKey(fileKeys[name]) }
    } else if (envKey(name)) {
      out[name] = { source: 'env', masked: maskKey(envKey(name)) }
    } else {
      out[name] = { source: 'missing' }
    }
  }
  return out
}

/**
 * Non-engine provider credentials kept in this same file so every secret has one
 * home. `jev` is TypeSafe's System One decision model (experimental) — it is not
 * a search engine: it never joins KEY_NAMES, engine routing, or the api pool.
 * @typedef {{ baseUrl?: string, apiKey?: string }} JevBlock
 */

/** @param {Record<string, unknown> | undefined} [doc] @returns {JevBlock} */
export function readJevFromDoc(doc) {
  const raw = doc?.jev
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const block = /** @type {Record<string, unknown>} */ (raw)
  /** @type {JevBlock} */
  const out = {}
  if (typeof block.baseUrl === 'string' && block.baseUrl.trim()) out.baseUrl = block.baseUrl.trim()
  if (typeof block.apiKey === 'string' && block.apiKey.trim()) out.apiKey = block.apiKey.trim()
  return out
}

/** @param {JevBlock} jev */
export function jevBlockHasValues(jev) {
  return Boolean(jev.baseUrl || jev.apiKey)
}

/**
 * Known engine names only: an unknown name is a caller error and must be
 * rejected explicitly — silently dropping it would turn "enable engine X" into
 * "clear the restriction", which is the opposite of what the user asked for.
 * @param {string[]} names
 * @param {string} [context]
 * @returns {string[]} de-duplicated names
 */
export function assertEngineNames(names, context = 'enabledEngines') {
  if (!Array.isArray(names)) throw new Error(`${context} must be an array of engine names`)
  const unknown = names.filter((name) => !KEY_NAMES.includes(name))
  if (unknown.length) {
    throw new Error(`Unknown engine name for ${context}: ${unknown.join(', ')} (known engines: ${KEY_NAMES.join(', ')})`)
  }
  return [...new Set(names)]
}

/**
 * Validate key-slot names for storage commands (--set / --unset).
 * Pending engines are storable — their key is kept for the adapter that will
 * consume it — but they are not routing engine names, so routing flags keep
 * using assertEngineNames and reject them.
 * @param {string[]} names
 * @param {string} [context]
 * @returns {string[]} de-duplicated names
 */
export function assertKeySlotNames(names, context = 'key names') {
  if (!Array.isArray(names)) throw new Error(`${context} must be an array of key names`)
  const unknown = names.filter((name) => !CONFIG_KEY_NAMES.includes(name))
  if (unknown.length) {
    throw new Error(`Unknown key name for ${context}: ${unknown.join(', ')} (known keys: ${CONFIG_KEY_NAMES.join(', ')})`)
  }
  return [...new Set(names)]
}

/**
 * Drop a stale `enabled: false` for engines the user just whitelisted. Naming an
 * engine in `enabledEngines` is an explicit enable, so a leftover per-engine
 * disable flag must not silently cancel it.
 * @param {KeysFileMeta & Record<string, unknown>} doc
 * @param {string[]} names
 */
function clearEngineDisableFlags(doc, names) {
  const enginesMeta = doc.engines
  if (!enginesMeta || typeof enginesMeta !== 'object' || Array.isArray(enginesMeta)) return
  for (const name of names) {
    const entry = enginesMeta[name]
    if (!entry || typeof entry !== 'object') continue
    if (entry.enabled !== false) continue
    delete entry.enabled
    if (Object.keys(entry).length === 0) delete enginesMeta[name]
  }
  if (Object.keys(enginesMeta).length === 0) delete doc.engines
}

/**
 * @param {KeysFileMeta & Record<string, unknown>} doc
 * @param {{ enabledEngines?: string[] | null, engineFlags?: Partial<Record<string, boolean | null>> }} routingPatch
 */
function applyRoutingPatch(doc, routingPatch) {
  if ('enabledEngines' in routingPatch) {
    const list = routingPatch.enabledEngines
    if (list === null || list === undefined) {
      // Explicit "restore default": remove the restriction so every configured
      // engine that is not individually disabled is used again.
      delete doc.enabledEngines
    } else {
      // An empty array is a real user choice (use no keyed engine at all), not
      // "clear the field": it must be persisted, not deleted.
      const names = assertEngineNames(list)
      doc.enabledEngines = names
      clearEngineDisableFlags(doc, names)
    }
  }
  if (routingPatch.engineFlags) {
    /** @type {Record<string, { enabled?: boolean }>} */
    let enginesMeta = doc.engines && typeof doc.engines === 'object' && !Array.isArray(doc.engines)
      ? { ...doc.engines }
      : {}
    for (const name of KEY_NAMES) {
      if (!(name in routingPatch.engineFlags)) continue
      const flag = routingPatch.engineFlags[name]
      if (flag === null || flag === undefined) {
        if (enginesMeta[name]) {
          delete enginesMeta[name].enabled
          if (Object.keys(enginesMeta[name]).length === 0) delete enginesMeta[name]
        }
        continue
      }
      enginesMeta[name] = { ...enginesMeta[name], enabled: flag }
    }
    if (Object.keys(enginesMeta).length === 0) delete doc.engines
    else doc.engines = enginesMeta
  }
}

/** @param {KeysFileMeta & Record<string, unknown>} doc */
function serializeKeysBody(doc) {
  const body = {}
  // Every key slot is persisted, pending engines included: dropping a stored key
  // on the next unrelated write would silently discard the user's credential.
  for (const name of CONFIG_KEY_NAMES) {
    if (typeof doc[name] === 'string' && doc[name].trim()) body[name] = doc[name].trim()
  }
  if (Array.isArray(doc.enabledEngines)) {
    // Persist even an empty list: `[]` means "no keyed engine", which is a
    // different statement from a missing field ("use every configured engine").
    body.enabledEngines = doc.enabledEngines.filter((name) => KEY_NAMES.includes(name))
  }
  const enginesMeta = doc.engines
  if (enginesMeta && typeof enginesMeta === 'object' && !Array.isArray(enginesMeta)) {
    const engines = {}
    // Routing flags stay limited to routable engines; a pending engine never
    // gets one, so nothing here can select it for the api layer.
    for (const name of KEY_NAMES) {
      const entry = enginesMeta[name]
      if (entry && typeof entry === 'object' && typeof entry.enabled === 'boolean') {
        engines[name] = { enabled: entry.enabled }
      }
    }
    if (Object.keys(engines).length > 0) body.engines = engines
  }
  const jev = readJevFromDoc(doc)
  if (jevBlockHasValues(jev)) body.jev = jev
  return body
}

/**
 * Read one explicit keys file (no candidate fallback). Writers must modify
 * exactly the store they were pointed at, never a different one.
 * @param {string} file
 * @returns {{ file: string | null, doc: KeysFileMeta & Record<string, unknown> }}
 */
function readKeysFileDocumentAt(file) {
  const { exists, doc, error } = readJsonStore(file)
  if (error) throw error
  return { file: exists ? file : null, doc: doc ?? {} }
}

/** @param {string} file @returns {Record<string, string | undefined>} */
function readKeysFileAt(file) {
  const { doc } = readKeysFileDocumentAt(file)
  const keys = emptyKeys()
  for (const name of CONFIG_KEY_NAMES) {
    if (typeof doc?.[name] === 'string' && doc[name].trim()) keys[name] = doc[name].trim()
  }
  return keys
}

/**
 * Apply a keys patch to one explicit keys file.
 * The read-modify-write cycle runs under an exclusive lock, the replacement is
 * atomic and private, and the store is marked initialized so an emptied store
 * stays authoritative (a deleted key must not come back from an older copy).
 * @param {string} file
 * @param {Parameters<typeof writeKeysFile>[0]} patch
 * @param {{ tightenDir?: boolean }} [options]
 */
function writeKeysDocAt(file, patch, options = {}) {
  const tightenDir = options.tightenDir !== false
  return withFileLock(file, () => {
    // Migration only happens for a never-initialized store; it never overwrites a
    // corrupt one (configStoreState throws first).
    if (file === configWritePath('keys')) prepareConfigWrite('keys')
    const { doc } = readKeysFileDocumentAt(file)
    const current = readKeysFileAt(file)
    const routingPatch = {}
    if ('enabledEngines' in patch) routingPatch.enabledEngines = patch.enabledEngines
    if ('engineFlags' in patch) routingPatch.engineFlags = patch.engineFlags

    for (const name of CONFIG_KEY_NAMES) {
      if (name in patch) {
        const v = patch[name]
        if (v === undefined || v === '') {
          delete current[name]
          delete doc[name]
        } else {
          current[name] = v.trim()
          doc[name] = current[name]
        }
      }
    }
    applyRoutingPatch(doc, routingPatch)
    if ('jev' in patch) {
      const jev = patch.jev ? readJevFromDoc({ jev: patch.jev }) : {}
      if (jevBlockHasValues(jev)) doc.jev = jev
      else delete doc.jev
    }
    const body = serializeKeysBody(doc)
    writeFileAtomicPrivate(file, `${JSON.stringify(body, null, 2)}\n`, { tightenDir })
    markStoreInitialized(file, { tightenDir })
    const out = {}
    for (const name of CONFIG_KEY_NAMES) {
      if (current[name]) out[name] = current[name]
    }
    return out
  }, { tightenDir })
}

/**
 * @param {Partial<Record<string, string | undefined>> & {
 *   enabledEngines?: string[] | null,
 *   engineFlags?: Partial<Record<string, boolean | null>>,
 *   jev?: { baseUrl?: string, apiKey?: string } | null,
 * }} patch
 */
export function writeKeysFile(patch) {
  const file = configWritePath('keys')
  return writeKeysDocAt(file, patch, { tightenDir: file === configNestedPath('keys') })
}

/**
 * Write the canonical user-level keys store (never an env-relocated or project
 * file). The Jev block is only ever read from and written to this store.
 * @param {Parameters<typeof writeKeysFile>[0]} patch
 */
export function writeCanonicalKeysFile(patch) {
  const file = configNestedPath('keys')
  return writeKeysDocAt(file, patch, { tightenDir: true })
}

/**
 * @param {string[] | null} enabledEngines — null clears the explicit restriction
 * (use every configured engine), `[]` disables every keyed engine, a non-empty
 * array is a whitelist of configured engines (unknown names are rejected).
 */
export function setEnabledEngines(enabledEngines) {
  writeKeysFile({ enabledEngines })
}

/** @param {string} name */
export function envKeySet(name) {
  return !!envKey(name)
}

/** @param {string} name @returns {string | null} */
export function envKeyHint(name) {
  if (!CONFIG_KEY_NAMES.includes(name)) return null
  if (!envKeySet(name)) return null
  return `${envKeyName(name)} still set in environment`
}

/** @param {string} name */
export function unsetKey(name) {
  if (!CONFIG_KEY_NAMES.includes(name)) throw new Error(`Unknown key: ${name}`)
  writeKeysFile({ [name]: undefined })
}

/** @param {string} name @param {string} value */
export function setKey(name, value) {
  if (!CONFIG_KEY_NAMES.includes(name)) throw new Error(`Unknown key: ${name}`)
  if (!value?.trim()) throw new Error(`Empty value for ${name}`)
  writeKeysFile({ [name]: value })
}

/**
 * Whether a keyed engine that can actually run is configured. A pending-engine
 * key alone must not flip the default layer to api or trip the api-layer key
 * warnings: it is a stored credential, not an available engine yet.
 */
export function hasAnyKey() {
  const keys = readKeys()
  return KEY_NAMES.some((name) => Boolean(keys[name]))
}

/** Any key slot stored at all, including engines still waiting for an adapter. */
export function hasStoredKey() {
  return Object.values(readKeys()).some(Boolean)
}

/** @param {string[]} candidates @returns {Record<string, string | undefined>} */
export function readKeysFromCandidates(candidates) {
  const parsed = readFirstExistingJson(candidates, {})
  const keys = emptyKeys()
  for (const name of CONFIG_KEY_NAMES) {
    if (typeof parsed[name] === 'string' && parsed[name].trim()) {
      keys[name] = parsed[name].trim()
    }
  }
  return keys
}
