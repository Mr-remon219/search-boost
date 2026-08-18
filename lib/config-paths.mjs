import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** @typedef {'keys'|'layer'|'xauth'|'xguest'} ConfigKind */

const SPECS = {
  keys: {
    env: 'SEARCH_BOOST_KEYS_FILE',
    primary: '.search-boost-keys.json',
    legacy: '.dsh-search-boost-keys.json',
  },
  layer: {
    env: 'SEARCH_BOOST_LAYER_FILE',
    primary: '.search-boost-layer.json',
    legacy: '.dsh-search-boost-layer.json',
  },
  xauth: {
    env: 'SEARCH_BOOST_XAUTH_FILE',
    primary: '.search-boost-xauth.json',
    legacy: '.dsh-search-boost-xauth.json',
  },
  xguest: {
    env: 'SEARCH_BOOST_XGUEST_FILE',
    primary: '.search-boost-xguest.json',
    legacy: '.dsh-search-boost-xguest.json',
  },
}

function home(file) {
  return join(homedir(), file)
}

/** Path used for writes (primary home file or env override). */
export function configWritePath(kind) {
  const spec = SPECS[kind]
  if (process.env[spec.env]) return process.env[spec.env]
  return home(spec.primary)
}

/** Ordered candidates for reads: env override, primary home, legacy home. */
export function configReadCandidates(kind) {
  const spec = SPECS[kind]
  const out = []
  if (process.env[spec.env]) out.push(process.env[spec.env])
  out.push(home(spec.primary), home(spec.legacy))
  return [...new Set(out)]
}

/** First existing candidate path, else the write path. */
export function configReadPath(kind) {
  for (const file of configReadCandidates(kind)) {
    if (existsSync(file)) return file
  }
  return configWritePath(kind)
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
