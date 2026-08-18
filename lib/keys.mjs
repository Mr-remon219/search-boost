import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { configWritePath, readFirstExistingJson } from './config-paths.mjs'

export const KEY_NAMES = ['tavily', 'brave', 'exa']

export function keysFilePath() {
  return configWritePath('keys')
}

const ENV_MAP = {
  tavily: 'TAVILY_API_KEY',
  brave: 'BRAVE_API_KEY',
  exa: 'EXA_API_KEY',
}

/** @returns {Record<string, string | undefined>} */
export function emptyKeys() {
  return { tavily: undefined, brave: undefined, exa: undefined }
}

/**
 * Read keys from disk only (no env).
 * Primary path wins when present (even if empty); legacy is only used when primary is missing.
 * @param {{ homeDir?: string }} [options] — test hook for isolated home paths
 */
export function readKeysFile(options = {}) {
  const homeDir = options.homeDir ?? homedir()
  const envPath = process.env.SEARCH_BOOST_KEYS_FILE
  const homePrimary = join(homeDir, '.search-boost-keys.json')
  const homeLegacy = join(homeDir, '.dsh-search-boost-keys.json')
  const cwdPrimary = join(process.cwd(), '.search-boost-keys.json')

  /** @type {string[]} */
  const candidates = []
  if (envPath) candidates.push(envPath)
  candidates.push(homePrimary)
  if (!existsSync(homePrimary) && !(envPath && existsSync(envPath))) {
    candidates.push(homeLegacy)
  }
  if (!candidates.includes(cwdPrimary)) candidates.push(cwdPrimary)

  const terminalWhenExists = new Set([homePrimary, cwdPrimary])
  if (envPath) terminalWhenExists.add(envPath)

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
      if (terminalWhenExists.has(file) || Object.values(keys).some(Boolean)) return keys
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

/** @param {Partial<Record<string, string | undefined>>} patch */
export function writeKeysFile(patch) {
  const current = readKeysFile()
  for (const name of KEY_NAMES) {
    if (name in patch) {
      const v = patch[name]
      if (v === undefined || v === '') delete current[name]
      else current[name] = v.trim()
    }
  }
  const body = {}
  for (const name of KEY_NAMES) {
    if (current[name]) body[name] = current[name]
  }
  const file = keysFilePath()
  const tmp = `${file}.tmp`
  writeFileSync(tmp, `${JSON.stringify(body, null, 2)}\n`, 'utf8')
  renameSync(tmp, file)
  return body
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
