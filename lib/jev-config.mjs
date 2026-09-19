import { configWritePath } from './config-paths.mjs'
import { maskKey, readJevFromDoc, readKeysFileDocument, writeKeysFile } from './keys.mjs'

/**
 * Jev (TypeSafe AI "System One") — experimental integration credentials.
 *
 * Jev is a decision model (typed choices, scores and probabilities instead of
 * prose), not a search engine, so it is deliberately absent from KEY_NAMES,
 * engine routing and the api-layer pool. Its endpoint + key live in the same
 * keys file as the engine keys so every secret has one home.
 */
export const JEV_DEFAULT_BASE_URL = 'https://api.typesafe.ai/v1'
export const JEV_ENV_API_KEY = 'TYPESAFE_API_KEY'
export const JEV_KEY_URL = 'https://console.typesafe.ai/settings/keys'

/** Keys file that also carries the `jev` block. */
export function jevFilePath() {
  return configWritePath('keys')
}

/**
 * Stored base URL + key. The key may come from the file or from TYPESAFE_API_KEY.
 * @returns {{ baseUrl: string, baseUrlStored: boolean, apiKey?: string, source: 'file'|'env'|'missing' }}
 */
export function readJevConfig() {
  const { doc } = readKeysFileDocument()
  const block = readJevFromDoc(doc)
  const envKey = process.env[JEV_ENV_API_KEY]?.trim()
  const apiKey = block.apiKey || envKey || undefined
  return {
    baseUrl: block.baseUrl || JEV_DEFAULT_BASE_URL,
    baseUrlStored: Boolean(block.baseUrl),
    apiKey,
    source: block.apiKey ? 'file' : envKey ? 'env' : 'missing',
  }
}

/**
 * @param {string} value
 * @returns {string} trimmed URL without a trailing slash
 */
export function normalizeJevBaseUrl(value) {
  const raw = String(value ?? '').trim()
  if (!raw) throw new Error('Jev base URL is required')
  let url
  try {
    url = new URL(raw)
  } catch {
    throw new Error(`Not a valid URL: ${raw}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Jev base URL must start with http:// or https://')
  }
  return raw.replace(/\/+$/, '')
}

/**
 * Replace the stored block (missing fields keep their current value).
 * @param {{ baseUrl?: string, apiKey?: string }} [patch]
 * @returns {{ baseUrl: string, apiKey: string }}
 */
export function saveJevConfig(patch = {}) {
  const current = readJevConfig()
  const baseUrl = normalizeJevBaseUrl(patch.baseUrl ?? current.baseUrl)
  const apiKey = String(patch.apiKey ?? current.apiKey ?? '').trim()
  if (!apiKey) {
    throw new Error('Jev API key is required — `search-boost config jev --jev-api-key <key>` or TUI → Jev credentials (experimental)')
  }
  writeKeysFile({ jev: { baseUrl, apiKey } })
  return { baseUrl, apiKey }
}

export function clearJevConfig() {
  writeKeysFile({ jev: null })
}

/** Masked view for status output. */
export function jevStatus() {
  const cfg = readJevConfig()
  return {
    configured: cfg.source !== 'missing',
    source: cfg.source,
    baseUrl: cfg.baseUrl,
    baseUrlStored: cfg.baseUrlStored,
    masked: cfg.apiKey ? maskKey(cfg.apiKey) : undefined,
  }
}
