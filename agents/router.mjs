/**
 * Agent asset router — single registry for per-agent inject surfaces.
 *
 * Each subfolder under agents/ holds that agent's exploration artifacts:
 *   inject.md              → prompt block injected into the agent's rules file
 *   skill.md               → optional skill template; frontmatter comes from the route's
 *                            skillFrontmatter unless the template declares its own
 *   openai.yaml            → optional Codex skill manifest
 *   rule.md                → workspace Always-on rule body (antigravity)
 *   gemini-snippet.md      → GEMINI.md override snippet (antigravity)
 *   hooks/                 → PreInvocation hook (antigravity)
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
 * @property {string|null} rule     Workspace rule template filename, or null
 * @property {string|null} geminiSnippet GEMINI.md snippet filename, or null
 * @property {{ config: string, script: string }|null} hooks Hook assets, or null
 * @property {string|null} hookScript Session-start hook script filename, or null
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
    mergeWith: ['cursor-cli'],
    mcp: {
      serverUseInstructions: 'Multi-engine web search when you need verifiable external facts. Use at your discretion.',
    },
    skillFrontmatter: {
      description:
        'Multi-engine web search MCP for verifiable external facts (versions, APIs, docs). Use when you judge it helps — not required every turn.',
    },
  },
  'cursor-cli': {
    label: 'Cursor CLI (terminal agent)',
    dir: 'cursor-cli',
    injectKind: 'agents-block',
    prompt: 'inject.md',
    skill: 'skill.md',
    hookScript: 'session-start.mjs',
    mergeWith: null,
    mcp: {
      serverUseInstructions: 'Multi-engine web search when you need verifiable external facts. Use at your discretion.',
    },
    skillFrontmatter: {
      description:
        'Terminal-agent web search MCP when external facts need verification. Your call whether to search; prefer over WebSearch when you do.',
    },
  },
  codex: {
    label: 'Codex CLI',
    dir: 'codex',
    injectKind: 'agents-block',
    prompt: 'inject.md',
    skill: 'skill.md',
    openaiYaml: 'openai.yaml',
    mergeWith: null,
    mcp: null,
  },
  claude: {
    label: 'Claude Code',
    dir: 'claude',
    injectKind: 'agents-block',
    prompt: 'inject.md',
    skill: 'skill.md',
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
    mergeWith: null,
    mcp: null,
    skillFrontmatter: {
      description:
        'Multi-engine web search before external API/integration work. Use when verifying versions, SDK signatures, cloud quotas, or comparing libraries. Prefer over built-in search_web.',
    },
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

/** MCP stdio server instructions — shared across all agents (single server process). */
export function mcpServerInstructionsPath() {
  return SHARED_SERVER_INSTRUCTIONS
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
