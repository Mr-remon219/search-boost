import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  configFlatPath,
  configLegacyPath,
  configNestedPath,
  configWritePath,
  prepareConfigWrite,
  readFirstExistingJson,
} from './config-paths.mjs'

export const KEY_NAMES = ['tavily', 'brave', 'exa']
export const KEYED_ENGINE_COUNT = KEY_NAMES.length

/** Shown when fewer than three keyed engines are configured or enabled. */
export const RECOMMEND_ALL_KEYED_ENGINES =
  'Recommend configuring all three keyed engines (tavily, brave, exa) for best multi-engine fusion on the api layer.'

export function keysFilePath() {
  return configWritePath('keys')
}

export const ENV_MAP = {
  tavily: 'TAVILY_API_KEY',
  brave: 'BRAVE_API_KEY',
  exa: 'EXA_API_KEY',
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
  if (legacy && !existsSync(nested) && !existsSync(flat) && !(envPath && existsSync(envPath))) {
    candidates.push(legacy)
  }
  if (!candidates.includes(cwdPrimary)) candidates.push(cwdPrimary)
  return candidates
}

/** @param {{ homeDir?: string }} [options] */
function keysTerminalWhenExists(options = {}) {
  const set = new Set([configNestedPath('keys', options), configFlatPath('keys', options), join(process.cwd(), '.search-boost-keys.json')])
  if (process.env.SEARCH_BOOST_KEYS_FILE) set.add(process.env.SEARCH_BOOST_KEYS_FILE)
  return set
}

/** @returns {Record<string, string | undefined>} */
export function emptyKeys() {
  return { tavily: undefined, brave: undefined, exa: undefined }
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
    try {
      const doc = JSON.parse(readFileSync(file, 'utf8'))
      const keys = emptyKeys()
      for (const name of KEY_NAMES) {
        if (typeof doc[name] === 'string' && doc[name].trim()) {
          keys[name] = doc[name].trim()
        }
      }
      if (terminalWhenExists.has(file) || Object.values(keys).some(Boolean)) {
        if (file === legacy && !existsSync(nested) && !existsSync(flat)) {
          maybePrintLegacyKeysMigrationNotice(legacy, configWritePath('keys', options))
        }
        return { file, doc }
      }
    } catch { /* try next */ }
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
    enabledSet: new Set(enabledNames),
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
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'))
      for (const name of KEY_NAMES) {
        if (typeof parsed[name] === 'string' && parsed[name].trim()) {
          keys[name] = parsed[name].trim()
        }
      }
      if (terminalWhenExists.has(file) || Object.values(keys).some(Boolean)) {
        if (file === legacy && !existsSync(nested) && !existsSync(flat)) {
          maybePrintLegacyKeysMigrationNotice(legacy, configWritePath('keys', options))
        }
        return keys
      }
    } catch { /* try next */ }
  }
  return keys
}

/** Merge file keys with env overrides. */
export function readKeys() {
  const keys = readKeysFile()
  for (const name of KEY_NAMES) {
    if (!keys[name] && process.env[ENV_MAP[name]]) {
      keys[name] = process.env[ENV_MAP[name]].trim()
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
  for (const name of KEY_NAMES) {
    if (fileKeys[name]) {
      out[name] = { source: 'file', masked: maskKey(fileKeys[name]) }
    } else if (process.env[ENV_MAP[name]]) {
      out[name] = { source: 'env', masked: maskKey(process.env[ENV_MAP[name]]) }
    } else {
      out[name] = { source: 'missing' }
    }
  }
  return out
}

/**
 * @param {KeysFileMeta & Record<string, unknown>} doc
 * @param {{ enabledEngines?: string[] | null, engineFlags?: Partial<Record<string, boolean | null>> }} routingPatch
 */
function applyRoutingPatch(doc, routingPatch) {
  if ('enabledEngines' in routingPatch) {
    const list = routingPatch.enabledEngines
    if (list === null || list === undefined || list.length === 0) {
      delete doc.enabledEngines
    } else {
      doc.enabledEngines = list.filter((name) => KEY_NAMES.includes(name))
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
  for (const name of KEY_NAMES) {
    if (typeof doc[name] === 'string' && doc[name].trim()) body[name] = doc[name].trim()
  }
  if (Array.isArray(doc.enabledEngines) && doc.enabledEngines.length > 0) {
    body.enabledEngines = doc.enabledEngines.filter((name) => KEY_NAMES.includes(name))
  }
  const enginesMeta = doc.engines
  if (enginesMeta && typeof enginesMeta === 'object' && !Array.isArray(enginesMeta)) {
    const engines = {}
    for (const name of KEY_NAMES) {
      const entry = enginesMeta[name]
      if (entry && typeof entry === 'object' && typeof entry.enabled === 'boolean') {
        engines[name] = { enabled: entry.enabled }
      }
    }
    if (Object.keys(engines).length > 0) body.engines = engines
  }
  return body
}

/**
 * @param {Partial<Record<string, string | undefined>> & {
 *   enabledEngines?: string[] | null,
 *   engineFlags?: Partial<Record<string, boolean | null>>,
 * }} patch
 */
export function writeKeysFile(patch) {
  const { doc } = readKeysFileDocument()
  const current = readKeysFile()
  const routingPatch = {}
  if ('enabledEngines' in patch) routingPatch.enabledEngines = patch.enabledEngines
  if ('engineFlags' in patch) routingPatch.engineFlags = patch.engineFlags

  for (const name of KEY_NAMES) {
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
  const body = serializeKeysBody(doc)
  const file = prepareConfigWrite('keys')
  const tmp = `${file}.tmp`
  writeFileSync(tmp, `${JSON.stringify(body, null, 2)}\n`, 'utf8')
  renameSync(tmp, file)
  const out = {}
  for (const name of KEY_NAMES) {
    if (current[name]) out[name] = current[name]
  }
  return out
}

/** @param {string[] | null} enabledEngines — null clears explicit routing */
export function setEnabledEngines(enabledEngines) {
  writeKeysFile({ enabledEngines })
}

/** @param {string} name */
export function envKeySet(name) {
  return !!(process.env[ENV_MAP[name]]?.trim())
}

/** @param {string} name @returns {string | null} */
export function envKeyHint(name) {
  if (!KEY_NAMES.includes(name)) return null
  if (!envKeySet(name)) return null
  return `${ENV_MAP[name]} still set in environment`
}

/** @param {string} name */
export function unsetKey(name) {
  if (!KEY_NAMES.includes(name)) throw new Error(`Unknown key: ${name}`)
  writeKeysFile({ [name]: undefined })
}

/** @param {string} name @param {string} value */
export function setKey(name, value) {
  if (!KEY_NAMES.includes(name)) throw new Error(`Unknown key: ${name}`)
  if (!value?.trim()) throw new Error(`Empty value for ${name}`)
  writeKeysFile({ [name]: value })
}

export function hasAnyKey() {
  return Object.values(readKeys()).some(Boolean)
}

/** @param {string[]} candidates @returns {Record<string, string | undefined>} */
export function readKeysFromCandidates(candidates) {
  const parsed = readFirstExistingJson(candidates, {})
  const keys = emptyKeys()
  for (const name of KEY_NAMES) {
    if (typeof parsed[name] === 'string' && parsed[name].trim()) {
      keys[name] = parsed[name].trim()
    }
  }
  return keys
}
