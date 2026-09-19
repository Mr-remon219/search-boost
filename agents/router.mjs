/**
 * Agent asset router — single registry for per-agent inject surfaces.
 *
 * Each subfolder under agents/ holds that agent's exploration artifacts:
 *   inject.md              → prompt block injected into the agent's rules file
 *   skill.md               → lightweight router skill template; frontmatter comes from the route's
 *                            skillFrontmatter unless the template declares its own
 *   openai.yaml            → optional Codex skill manifest
 *   rule.md                → workspace Always-on rule body (antigravity)
 *   gemini-snippet.md      → GEMINI.md override snippet (antigravity)
 *   hooks/                 → PreInvocation hook (antigravity)
 *   agents/*.md            → pi subagent templates (install → ~/.pi/agent/agents)
 *   prompts/*.md           → pi slash-prompt templates (install → ~/.pi/agent/prompts)
 *
 * The stdio server's own instructions are agent-neutral and live in
 * agents/shared/server-instructions.md — one server process serves every agent.
 *
 * Host-runtime agents (pi, dsh) do not go through MCP: their adapters under
 * adapters/pi and adapters/dsh register tools in-process and read their
 * host-level prompt policy from here (injectKind 'host-runtime').
 *
 * Install adapters in lib/agents/index.mjs read paths through here — do not hard-code filenames.
 */
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

export const AGENTS_ROOT = join(dirname(fileURLToPath(import.meta.url)))

/** Agent-neutral MCP handshake instructions (single stdio server for all agents). */
export const SHARED_SERVER_INSTRUCTIONS = join(AGENTS_ROOT, 'shared', 'server-instructions.md')
export const STARTUP_SEARCH_POLICY = join(AGENTS_ROOT, 'shared', 'startup-search.md')
export const SESSION_START_SCRIPT = join(AGENTS_ROOT, 'shared', 'session-start.mjs')

/** Retired tool-manual skills: retained only for owned-file migration/cleanup. */
export const RETIRED_SKILL_NAMES = [
  'search-boost-search', 'search-boost-fetch', 'search-boost-x', 'search-boost-diagnostics',
]

/**
 * Optional workflows beyond individual MCP calls; registered once for all install surfaces.
 * Entries: { name, description, path: absolute SKILL.md path, agents?: MCP host ids[] }.
 * The installer, plugins, and router links all use this registry.
 */
export const SKILL_EXTENSIONS = [{
  name: 'search-boost-parallel-research',
  description: 'Bounded parallel web research via authorized host subagents, with a disclosed serial fallback when unavailable.',
  path: join(AGENTS_ROOT, 'shared', 'skills', 'search-boost-parallel-research', 'SKILL.md'),
}]

/** Cursor IDE/CLI share installed skills, so use the same capability-gated notes. */
export function parallelHostPath(id) {
  return join(AGENTS_ROOT, id === 'cursor-cli' ? 'cursor' : id, 'parallel.md')
}

export function extensionSkills(id) {
  if (!getRoute(id).skill) return []
  const seen = new Set(['search-boost', ...RETIRED_SKILL_NAMES])
  return SKILL_EXTENSIONS.filter((entry) => !entry.agents || entry.agents.includes(id)).map((entry) => {
    if (!/^search-boost-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(entry.name)
      || seen.has(entry.name) || !entry.description?.trim() || !entry.path) {
      throw new Error(`Invalid or duplicate extension skill: ${entry.name}`)
    }
    seen.add(entry.name)
    return entry
  })
}

export function extensionSkillRoutes(id) {
  const entries = extensionSkills(id)
  return entries.length
    ? entries.map(({ name, description }) => `- [${name}](../${name}/SKILL.md): ${description}`).join('\n')
    : 'No extension workflows are bundled yet. Use the MCP tools directly; no subagent workflow is provided.'
}

export const SKILL_HOST_CONTEXT = {
  claude: 'Claude Code: use the search-boost MCP tools (mcp__search-boost__*), not shell commands. Connection configuration is in ~/.claude.json; inspect /mcp if tools are missing.',
  codex: 'Codex: use the native MCP channel for server search-boost, configured in ~/.codex/config.toml. Tool names below use the mcp__search-boost__ prefix; follow the actual registered name if your client presents it differently.',
  cursor: 'Cursor IDE: discover tools from MCP server search-boost in ~/.cursor/mcp.json. Names below are server-local; call the actual registered MCP tool, not WebSearch. IDE and CLI share this skill set.',
  'cursor-cli': 'Cursor CLI: discover tools from MCP server search-boost in ~/.cursor/mcp.json. Names below are server-local MCP calls, not shell commands. CLI and IDE share this skill set.',
  grok: 'Grok Build: use MCP server search-boost from the active user or project config.toml. Native browse remains valid; do not duplicate the same query across both paths. Read the session spill file if a tool result is truncated.',
  antigravity: 'Antigravity: use MCP server search-boost from global or workspace mcp_config.json, rather than search_web/read_url_content for these workflows. Use authorized cloud tools, not web search, for live account state.',
}

/** @typedef {{ description?: string, allowedTools?: string[] }} SkillFrontmatter */

/** @typedef {'agents-block'|'rule-file'|'host-runtime'} InjectKind */

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
 * @property {string[]|null} subagentTemplates Relative md paths under agents/<dir>/ (pi)
 * @property {string[]|null} workflowPrompts Relative slash-prompt md paths under agents/<dir>/ (pi)
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
      serverUseInstructions: 'Web search, page reading, and X/Twitter via MCP. The search-boost skill routes task-specific workflows.',
    },
    skillFrontmatter: {
      description:
        'Discover optional search-boost workflow extensions when a task needs more than direct MCP tool calls.',
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
      serverUseInstructions: 'Web search, page reading, and X/Twitter via MCP. The search-boost skill routes task-specific workflows.',
    },
    skillFrontmatter: {
      description:
        'Discover optional search-boost workflow extensions when a task needs more than direct MCP tool calls.',
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
        'Discover optional search-boost workflow extensions when a task needs more than direct MCP tool calls.',
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
        'Discover optional search-boost workflow extensions when a task needs more than direct MCP tool calls.',
    },
  },
  pi: {
    label: 'pi coding agent (extension)',
    dir: 'pi',
    injectKind: 'host-runtime',
    // <search_balance> block appended to pi's system prompt by adapters/pi on before_agent_start
    prompt: 'inject.md',
    skill: null,
    mergeWith: null,
    mcp: null,
    subagentTemplates: ['agents/searcher.md', 'agents/summarizer.md'],
    workflowPrompts: ['prompts/fast-parallel.md', 'prompts/complex-parallel.md'],
  },
  dsh: {
    label: 'DeepSeek Harness (bundle plugin)',
    dir: 'dsh',
    injectKind: 'host-runtime',
    // systemPrompt.section('search:policy') body registered by adapters/dsh
    prompt: 'policy.md',
    skill: null,
    mergeWith: null,
    mcp: null,
  },
}

export const ROUTE_IDS = Object.keys(ROUTES)

/** Agents whose search tools run in the host process (no MCP server). */
export const HOST_RUNTIME_IDS = ROUTE_IDS.filter((id) => ROUTES[id].injectKind === 'host-runtime')

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

/** Router first, followed by shared specialist templates. Host runtimes have no MCP skills. */
export function skillBundleSources(id) {
  const router = skillPath(id)
  if (!router) return []
  return [
    { name: 'search-boost', path: router },
    ...extensionSkills(id).map(({ name, path }) => ({ name, path })),
  ]
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

/** @param {string} id @param {'subagentTemplates'|'workflowPrompts'} field */
export function assetList(id, field) {
  const list = getRoute(id)[field]
  if (!Array.isArray(list)) return []
  return list.map((filename) => assetPath(id, filename))
}

export function piSubagentTemplatePaths() {
  return assetList('pi', 'subagentTemplates')
}

export function piWorkflowPromptPaths() {
  return assetList('pi', 'workflowPrompts')
}

export const CURSOR_HOOK_SCRIPT_NAME = 'search-boost-session.mjs'
export const CURSOR_HOOK_INJECT_NAME = 'search-boost-inject.md'
export const CURSOR_HOOK_COMMAND_MARKER = 'search-boost-session.mjs'
