/**
 * Agent asset router — single registry for per-agent inject surfaces.
 *
 * Each subfolder under agents/ holds that agent's exploration artifacts:
 *   inject.md              → prompt block injected into the agent's rules file
 *   skill.md               → optional skill template (frontmatter added at install)
 *   rule.md                → workspace Always-on rule body (antigravity)
 *   gemini-snippet.md      → GEMINI.md override snippet (antigravity)
 *   hooks/                 → PreInvocation hook (antigravity)
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
 * @property {string|null} rule     Workspace rule template filename, or null
 * @property {string|null} geminiSnippet GEMINI.md snippet filename, or null
 * @property {{ config: string, script: string }|null} hooks Hook assets, or null
 * @property {string|null} serverInstructions MCP instructions file, or null
 * @property {string[]|null} mergeWith Other agent ids merged into this prompt on install
 * @property {{ serverUseInstructions?: string }|null} mcp MCP entry extras
 * @property {string|null} [skillDescription] Skill frontmatter description override
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
    mcp: { serverUseInstructions: 'Prefer search-boost MCP over WebSearch for factual lookups.' },
  },
  'cursor-cli': {
    label: 'Cursor CLI (terminal agent)',
    dir: 'cursor-cli',
    injectKind: 'agents-block',
    prompt: 'inject.md',
    skill: null,
    serverInstructions: null,
    mergeWith: null,
    mcp: null,
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
    rule: 'rule.md',
    geminiSnippet: 'gemini-snippet.md',
    hooks: { config: 'hooks/hooks.json', script: 'hooks/pre-invocation.mjs' },
    serverInstructions: null,
    mergeWith: null,
    mcp: null,
    skillDescription:
      'Multi-engine web search before external API/integration work. Use when verifying versions, SDK signatures, cloud quotas, or comparing libraries. Prefer over built-in search_web.',
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

/** @param {string} id */
export function rulePath(id) {
  const route = getRoute(id)
  if (!route.rule) return null
  return assetPath(id, route.rule)
}

/** @param {string} id */
export function geminiSnippetPath(id) {
  const route = getRoute(id)
  if (!route.geminiSnippet) return null
  return assetPath(id, route.geminiSnippet)
}

/** @param {string} id */
export function hooksConfigPath(id) {
  const route = getRoute(id)
  if (!route.hooks) return null
  return assetPath(id, route.hooks.config)
}

/** @param {string} id */
export function hooksScriptPath(id) {
  const route = getRoute(id)
  if (!route.hooks) return null
  return assetPath(id, route.hooks.script)
}

/** MCP stdio server instructions — currently defined on the cursor route. */
export function mcpServerInstructionsPath() {
  for (const id of ROUTE_IDS) {
    const file = ROUTES[id].serverInstructions
    if (file) return assetPath(id, file)
  }
  return null
}
