import { configNestedPath } from './config-paths.mjs'
import { maskKey, readJevFromDoc, writeCanonicalKeysFile } from './keys.mjs'
import { readJsonStore } from './private-file.mjs'

/**
 * Jev (TypeSafe AI "System One") — experimental integration credentials.
 *
 * Jev is a decision model (typed choices, scores and probabilities instead of
 * prose), not a search engine, so it is deliberately absent from KEY_NAMES,
 * engine routing and the api-layer pool.
 *
 * Trust boundary: the endpoint and the key are read from — and written to — the
 * canonical user-level store only (`~/.search-boost/config/keys.json`). A
 * project-local file, a legacy DSH/Pi file, an env-relocated keys path or
 * TYPESAFE_API_KEY can never supply either half of the pair, so a low-trust file
 * cannot redirect a global credential to its own endpoint.
 */
export const JEV_DEFAULT_BASE_URL = 'https://api.typesafe.ai/v1'
/** Kept for diagnostics only: this variable is deliberately never consumed. */
export const JEV_ENV_API_KEY = 'TYPESAFE_API_KEY'
export const JEV_KEY_URL = 'https://console.typesafe.ai/settings/keys'
/** Official System One alias; the response `model` field carries the real version. */
export const JEV_DEFAULT_MODEL = 'jev-latest'
export const JEV_VERCEL_MODEL = 'typesafe-ai/jev'
export function jevProvider(baseUrl) {
  try { return new URL(normalizeJevBaseUrl(baseUrl)).hostname === 'ai-gateway.vercel.sh' ? 'vercel' : 'typesafe' }
  catch { return 'typesafe' }
}

/** Canonical user-level keys file that carries the `jev` block. */
export function jevFilePath() {
  return configNestedPath('keys')
}

/**
 * Stored base URL + key from the canonical store.
 * @returns {{ baseUrl: string, baseUrlStored: boolean, apiKey?: string, source: 'file'|'missing' }}
 */
export function readJevConfig() {
  const { doc, error } = readJsonStore(jevFilePath())
  // A corrupt/unreadable canonical store is reported, never read as "no Jev".
  if (error) throw error
  const block = readJevFromDoc(doc)
  return {
    baseUrl: block.baseUrl || JEV_DEFAULT_BASE_URL,
    baseUrlStored: Boolean(block.baseUrl),
    apiKey: block.apiKey || undefined,
    source: block.apiKey ? 'file' : 'missing',
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
    throw new Error('Not a valid URL for Jev')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Jev base URL must start with http:// or https://')
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('Jev base URL cannot contain credentials, query parameters or a fragment')
  }
  if (url.hostname === 'ai-gateway.vercel.sh' && (url.protocol !== 'https:' || url.port || !['/', '/v1', '/v1/'].includes(url.pathname))) {
    throw new Error('Vercel Jev base URL must be https://ai-gateway.vercel.sh or https://ai-gateway.vercel.sh/v1')
  }
  return url.href.replace(/\/+$/, '')
}

/**
 * Replace the stored block (missing fields keep their current value).
 * The key can only be reused from the canonical store or supplied explicitly:
 * an environment variable is never absorbed into the file.
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
  writeCanonicalKeysFile({ jev: { baseUrl, apiKey } })
  return { baseUrl, apiKey }
}

/** Remove the stored Jev block from the canonical store (env cannot revive it). */
export function clearJevConfig() {
  writeCanonicalKeysFile({ jev: null })
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
  let cfg
  try {
    cfg = readJevConfig()
  } catch (err) {
    // Capability output must never crash a host; report the problem instead.
    return {
      tool: 'adaptive_search',
      configured: false,
      source: 'unreadable',
      model: JEV_DEFAULT_MODEL,
      gateway: 'unknown',
      destination: 'the Jev service configured by the user',
      sends: 'question text and the evidence fragments required for each judgement are sent to that service',
      note: `Jev configuration could not be read: ${err?.message ?? err}`,
    }
  }
  const configured = cfg.source !== 'missing'
  return {
    tool: 'adaptive_search',
    configured,
    source: configured ? cfg.source : 'missing',
    model: jevProvider(cfg.baseUrl) === 'vercel' ? JEV_VERCEL_MODEL : JEV_DEFAULT_MODEL,
    provider: jevProvider(cfg.baseUrl),
    gateway: cfg.baseUrlStored ? 'custom' : 'default',
    destination: cfg.baseUrlStored
      ? 'the Jev service configured by the user (custom base URL)'
      : `TypeSafe Jev (${JEV_DEFAULT_BASE_URL})`,
    sends: 'question text and the evidence fragments required for each judgement are sent to that service',
    note: 'Configuration readiness only; this block never contains credentials.',
  }
}
