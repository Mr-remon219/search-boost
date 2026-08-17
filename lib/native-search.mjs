/**
 * Per-agent built-in web search — what it is called, whether we can disable it,
 * and how. Prompt-only agents still get "prefer search-boost" wording in inject
 * templates; config/deny agents get a real switch when replaceNative is on.
 */
import { existsSync, readFileSync } from 'node:fs'
import { injectTomlSection, removeTomlSection } from './inject.mjs'
import { jsonDeepEqual, prunePermissions, readJsonFile, readTextFile, writeJsonFile, writeTextFile } from './json-config.mjs'
import { PATHS } from './paths.mjs'

/** @typedef {'config'|'deny'|'prompt'|'leave'} NativeSearchKind */

/**
 * @typedef {Object} NativeSearchCap
 * @property {NativeSearchKind} kind
 * @property {string} name          Built-in tool / setting the agent ships
 * @property {string} note
 */

/**
 * @typedef {Object} AgentCapability
 * @property {boolean} autoAllow
 * @property {NativeSearchCap} nativeSearch
 */

/** @type {Record<string, AgentCapability>} */
export const AGENT_CAPABILITIES = {
  cursor: {
    autoAllow: true,
    nativeSearch: {
      kind: 'prompt',
      name: 'WebSearch / @web',
      note: 'No config switch — hook + skill prefer search-boost when you do search.',
    },
  },
  'cursor-cli': {
    autoAllow: true,
    nativeSearch: {
      kind: 'prompt',
      name: 'WebSearch',
      note: 'No config switch — same hook/skill as Cursor IDE.',
    },
  },
  codex: {
    autoAllow: true,
    nativeSearch: {
      kind: 'config',
      name: 'web_search',
      note: 'Writes web_search = "disabled" in ~/.codex/config.toml (SEARCH_BOOST marker).',
    },
  },
  claude: {
    autoAllow: true,
    nativeSearch: {
      kind: 'deny',
      name: 'WebSearch',
      note: 'Adds WebSearch to ~/.claude/settings.json permissions.deny.',
    },
  },
  grok: {
    autoAllow: true,
    nativeSearch: {
      kind: 'leave',
      name: 'native browse',
      note: 'Left alone — Grok browse stays valid for open exploration.',
    },
  },
  antigravity: {
    autoAllow: true,
    nativeSearch: {
      kind: 'prompt',
      name: 'search_web',
      note: 'No config switch — inject prefers search-boost over search_web / read_url_content.',
    },
  },
}

export const CLAUDE_WEB_SEARCH_DENY = 'WebSearch'
export const CODEX_WEB_SEARCH_BODY = 'web_search = "disabled"'
export const CODEX_WEB_SEARCH_MARKER = 'SEARCH_BOOST_WEB_SEARCH_START'

/** Agents whose config can pre-approve search-boost tools. */
export function autoAllowAgentIds() {
  return Object.entries(AGENT_CAPABILITIES)
    .filter(([, cap]) => cap.autoAllow)
    .map(([id]) => id)
}

/** Agents that have a real config/deny switch for built-in web search. */
export function replaceableNativeIds(ids = Object.keys(AGENT_CAPABILITIES)) {
  return ids.filter((id) => {
    const kind = AGENT_CAPABILITIES[id]?.nativeSearch.kind
    return kind === 'config' || kind === 'deny'
  })
}

/** @param {string} toml @param {boolean} replace */
export function applyCodexNativeToml(toml, replace) {
  if (replace) return injectTomlSection(toml, 'WEB_SEARCH', CODEX_WEB_SEARCH_BODY)
  return removeTomlSection(toml, 'WEB_SEARCH')
}

/** @param {string} toml */
export function codexNativeReplaced(toml) {
  return toml.includes(CODEX_WEB_SEARCH_MARKER)
}

/**
 * @param {{ permissions?: { deny?: string[] } }} settings
 * @param {boolean} replace
 */
export function applyClaudeNativeSettings(settings, replace) {
  const next = { ...settings, permissions: { ...(settings.permissions ?? {}) } }
  const deny = [...(next.permissions.deny ?? [])].filter((p) => p !== CLAUDE_WEB_SEARCH_DENY)
  if (replace) deny.push(CLAUDE_WEB_SEARCH_DENY)
  if (deny.length) next.permissions.deny = deny
  else delete next.permissions.deny
  return prunePermissions(next)
}

/** @param {{ permissions?: { deny?: string[] } }} settings */
export function claudeNativeReplaced(settings) {
  return Array.isArray(settings.permissions?.deny)
    && settings.permissions.deny.includes(CLAUDE_WEB_SEARCH_DENY)
}

/**
 * @param {string} id
 * @returns {{ id: string, kind: NativeSearchKind, name: string, note: string, state: 'replaced'|'native'|'prompt'|'left'|'unknown' }}
 */
export function nativeSearchStatus(id) {
  const cap = AGENT_CAPABILITIES[id]
  if (!cap) {
    return { id, kind: 'leave', name: '—', note: '', state: 'unknown' }
  }
  const { kind, name, note } = cap.nativeSearch
  if (kind === 'leave') return { id, kind, name, note, state: 'left' }
  if (kind === 'prompt') return { id, kind, name, note, state: 'prompt' }
  if (id === 'codex') {
    try {
      const toml = existsSync(PATHS.codex.config) ? readFileSync(PATHS.codex.config, 'utf8') : ''
      return { id, kind, name, note, state: codexNativeReplaced(toml) ? 'replaced' : 'native' }
    } catch {
      return { id, kind, name, note, state: 'native' }
    }
  }
  if (id === 'claude') {
    try {
      const settings = existsSync(PATHS.claude.settings)
        ? JSON.parse(readFileSync(PATHS.claude.settings, 'utf8'))
        : {}
      return { id, kind, name, note, state: claudeNativeReplaced(settings) ? 'replaced' : 'native' }
    } catch {
      return { id, kind, name, note, state: 'native' }
    }
  }
  return { id, kind, name, note, state: 'unknown' }
}

/**
 * Apply or revert config-level native-search replacement for one agent.
 * Prompt/leave agents are no-ops (inject templates already cover wording).
 * @param {string} id
 * @param {{ replace: boolean, dryRun?: boolean }} opts
 * @returns {Promise<string[]>} files touched (or that would be)
 */
export async function applyNativeSearch(id, opts) {
  const cap = AGENT_CAPABILITIES[id]
  if (!cap) return []
  const { kind } = cap.nativeSearch

  if (kind === 'config' && id === 'codex') {
    const file = PATHS.codex.config
    if (!opts.dryRun) {
      const toml = await readTextFile(file)
      const next = applyCodexNativeToml(toml, opts.replace)
      if (next !== toml) await writeTextFile(file, next ? `${next.trim()}\n` : '')
    }
    return [file]
  }

  if (kind === 'deny' && id === 'claude') {
    const file = PATHS.claude.settings
    if (!opts.dryRun) {
      const settings = await readJsonFile(file, {})
      const next = applyClaudeNativeSettings(settings, opts.replace)
      if (!jsonDeepEqual(settings, next)) await writeJsonFile(file, next)
    }
    return [file]
  }

  return []
}
