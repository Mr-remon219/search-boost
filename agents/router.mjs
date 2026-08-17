/**
 * Agent asset router — single registry for per-agent inject surfaces.
 *
 * Each subfolder under agents/ holds that agent's exploration artifacts:
 *   inject.md              → prompt block injected into the agent's rules file
 *   skill.md               → optional skill template; frontmatter comes from the route's
 *                            skillFrontmatter unless the template declares its own
 *   openai.yaml            → optional Codex skill manifest
 *
 * The stdio server's own instructions are agent-neutral and live in
 * agents/shared/server-instructions.md — one server process serves every agent.
 *
 * Install adapters in lib/agents/index.mjs read paths through here — do not hard-code filenames.
 */
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

export const AGENTS_ROOT = join(dirname(fileURLToPath(import.meta.url)))

/** Agent-neutral MCP handshake instructions (single stdio server for all agents). */
export const SHARED_SERVER_INSTRUCTIONS = join(AGENTS_ROOT, 'shared', 'server-instructions.md')

/** @typedef {{ description?: string, allowedTools?: string[] }} SkillFrontmatter */

/** @typedef {'agents-block'|'rule-file'} InjectKind */

/**
 * @typedef {Object} AgentRoute
 * @property {string} label
 * @property {string} dir           Folder under agents/
 * @property {InjectKind} injectKind
 * @property {string} prompt        Filename for inject body (usually inject.md)
 * @property {string|null} skill    Skill template filename, or null
 * @property {string|null} openaiYaml agents/openai.yaml template filename, or null
 * @property {string|null} serverInstructions MCP instructions file, or null
 * @property {string[]|null} mergeWith Other agent ids merged into this prompt on install
 * @property {{ serverUseInstructions?: string }|null} mcp MCP entry extras
 * @property {SkillFrontmatter|null} skillFrontmatter Optional SKILL.md frontmatter overrides
 */

/** @type {Record<string, AgentRoute>} */
export const ROUTES = {
  cursor: {
    label: 'Cursor IDE',
    dir: 'cursor',
    injectKind: 'agents-block',
    prompt: 'inject.md',
    skill: 'skill.md',
    serverInstructions: null,
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
    skill: 'skill.md',
    openaiYaml: 'openai.yaml',
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
    skillFrontmatter: {
      description:
        'Multi-engine web search when external facts need verification. Optional — use your judgment for versions, APIs, comparisons, or niche tech. Tools: fused_search, fetch_page, x_search, deep_research.',
      allowedTools: [
        'mcp__search-boost__fused_search',
        'mcp__search-boost__fetch_page',
        'mcp__search-boost__deep_research',
        'mcp__search-boost__x_search',
        'mcp__search-boost__search_layer',
        'mcp__search-boost__search_stats',
      ],
    },
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

/** @param {string} id */
export function openaiYamlPath(id) {
  const route = getRoute(id)
  if (!route.openaiYaml) return null
  return assetPath(id, route.openaiYaml)
}

/** MCP stdio server instructions — shared across all agents (single server process). */
export function mcpServerInstructionsPath() {
  return SHARED_SERVER_INSTRUCTIONS
}
