/**
 * Agent asset router — single registry for per-agent inject surfaces.
 *
 * Each subfolder under agents/ holds that agent's exploration artifacts:
 *   inject.md              → prompt block injected into the agent's rules file
 *   skill.md               → optional skill template (frontmatter added at install)
 *   server-instructions.md → optional MCP server instructions (cursor only today)
 *
 * Install adapters in lib/agents/index.mjs read paths through here — do not hard-code filenames.
 */
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

export const AGENTS_ROOT = join(dirname(fileURLToPath(import.meta.url)))

/** @typedef {'agents-block'|'rule-file'} InjectKind */

/**
 * @typedef {Object} AgentRoute
 * @property {string} label
 * @property {string} dir           Folder under agents/
 * @property {InjectKind} injectKind
 * @property {string} prompt        Filename for inject body (usually inject.md)
 * @property {string|null} skill    Skill template filename, or null
 * @property {string|null} serverInstructions MCP instructions file, or null
 * @property {string|null} hookScript Session-start hook script filename, or null
 * @property {string[]|null} mergeWith Other agent ids merged into this prompt on install
 * @property {{ serverUseInstructions?: string, skillDescription?: string }|null} mcp MCP entry extras
 */

/** @type {Record<string, AgentRoute>} */
export const ROUTES = {
  cursor: {
    label: 'Cursor IDE',
    dir: 'cursor',
    injectKind: 'agents-block',
    prompt: 'inject.md',
    skill: 'skill.md',
    serverInstructions: 'server-instructions.md',
    mergeWith: ['cursor-cli'],
    mcp: {
      serverUseInstructions: 'Multi-engine web search when you need verifiable external facts. Use at your discretion.',
      skillDescription: 'Multi-engine web search MCP for verifiable external facts (versions, APIs, docs). Use when you judge it helps — not required every turn.',
    },
  },
  'cursor-cli': {
    label: 'Cursor CLI (terminal agent)',
    dir: 'cursor-cli',
    injectKind: 'agents-block',
    prompt: 'inject.md',
    skill: 'skill.md',
    serverInstructions: 'server-instructions.md',
    hookScript: 'session-start.mjs',
    mergeWith: null,
    mcp: {
      serverUseInstructions: 'Multi-engine web search when you need verifiable external facts. Use at your discretion.',
      skillDescription: 'Terminal-agent web search MCP when external facts need verification. Your call whether to search; prefer over WebSearch when you do.',
    },
  },
  codex: {
    label: 'Codex CLI',
    dir: 'codex',
    injectKind: 'agents-block',
    prompt: 'inject.md',
    skill: null,
    serverInstructions: null,
    mergeWith: null,
    mcp: null,
  },
  claude: {
    label: 'Claude Code',
    dir: 'claude',
    injectKind: 'agents-block',
    prompt: 'inject.md',
    skill: 'skill.md',
    serverInstructions: null,
    mergeWith: null,
    mcp: null,
  },
  grok: {
    label: 'Grok Build',
    dir: 'grok',
    injectKind: 'rule-file',
    prompt: 'inject.md',
    skill: 'skill.md',
    serverInstructions: null,
    mergeWith: null,
    mcp: null,
  },
  antigravity: {
    label: 'Antigravity CLI / IDE',
    dir: 'antigravity',
    injectKind: 'agents-block',
    prompt: 'inject.md',
    skill: 'skill.md',
    serverInstructions: null,
    mergeWith: null,
    mcp: null,
  },
}

export const ROUTE_IDS = Object.keys(ROUTES)

/** @param {string} id */
export function getRoute(id) {
  const route = ROUTES[id]
  if (!route) throw new Error(`Unknown agent route: ${id}`)
  return route
}

/** @param {string} id @param {string} filename */
export function assetPath(id, filename) {
  return join(AGENTS_ROOT, getRoute(id).dir, filename)
}

/** @param {string} id */
export function promptPath(id) {
  const route = getRoute(id)
  return assetPath(id, route.prompt)
}

/** @param {string} id */
export function skillPath(id) {
  const route = getRoute(id)
  if (!route.skill) return null
  return assetPath(id, route.skill)
}

/** MCP stdio server instructions — first route that defines serverInstructions. */
export function mcpServerInstructionsPath() {
  for (const id of ROUTE_IDS) {
    const file = ROUTES[id].serverInstructions
    if (file) return assetPath(id, file)
  }
  return null
}

/** @param {string} id */
export function hookScriptPath(id) {
  const route = getRoute(id)
  if (!route.hookScript) return null
  return assetPath(id, route.hookScript)
}

export const CURSOR_HOOK_SCRIPT_NAME = 'search-boost-session.mjs'
export const CURSOR_HOOK_INJECT_NAME = 'search-boost-inject.md'
export const CURSOR_HOOK_COMMAND_MARKER = 'search-boost-session.mjs'
