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
/** Official System One alias; the response `model` field carries the real version. */
export const JEV_DEFAULT_MODEL = 'jev-latest'

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

/**
 * Credential-free capability block for runtime snapshots, prompts and MCP
 * resources. Deliberately contains no key, no masked key, no fingerprint and no
 * base URL — only whether Jev is configured, where the key came from, which
 * model alias is used, and whether a custom gateway is stored (so text about
 * the destination stays accurate instead of assuming the official address).
 */
export function describeJevForCapability() {
  const cfg = readJevConfig()
  const configured = cfg.source !== 'missing'
  return {
    tool: 'adaptive_search',
    configured,
    source: configured ? cfg.source : 'missing',
    model: JEV_DEFAULT_MODEL,
    gateway: cfg.baseUrlStored ? 'custom' : 'default',
    destination: cfg.baseUrlStored
      ? 'the Jev service configured by the user (custom base URL)'
      : `TypeSafe Jev (${JEV_DEFAULT_BASE_URL})`,
    sends: 'question text and the evidence fragments required for each judgement are sent to that service',
    note: 'Configuration readiness only; this block never contains credentials.',
  }
}
