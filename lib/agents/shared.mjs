import { copyFile, mkdir, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'
import { PKG_ROOT } from '../pkg.mjs'
import {
  injectBlock,
  injectGeminiBlock,
  removeBlock,
  removeGeminiBlock,
} from '../inject.mjs'
import { readJsonFile, readTextFile, writeJsonFile, writeTextFile } from '../json-config.mjs'
import { workspaceAgents } from '../paths.mjs'
import {
  geminiSnippetPath,
  getRoute,
  hooksConfigPath,
  hooksScriptPath,
  openaiYamlPath,
  promptPath,
  rulePath,
  skillPath,
  mcpServerInstructionsPath,
} from '../../agents/router.mjs'

const ANTIGRAVITY_RULE_DESCRIPTION =
  'Search before editing external APIs; prefer search-boost MCP over search_web.'

const HOOK_ENTRY_KEY = 'search-boost-reminder'

/** @param {string} agentId */
export async function loadAgentPrompt(agentId) {
  return readTextFile(promptPath(agentId))
}

/** @param {string} agentId */
export async function loadAgentSkill(agentId) {
  const path = skillPath(agentId)
  if (!path) return null
  return readTextFile(path)
}

/** @param {string} agentId */
export async function loadAgentRule(agentId) {
  const path = rulePath(agentId)
  if (!path) return null
  return readTextFile(path)
}

/** @param {string} agentId */
export async function loadGeminiSnippet(agentId) {
  const path = geminiSnippetPath(agentId)
  if (!path) return null
  return readTextFile(path)
}

export function loadMcpServerInstructionsPath() {
  return mcpServerInstructionsPath()
}

/** @param {string} path @param {string} agentId */
export async function injectAgentsFile(path, agentId) {
  const snippet = await loadAgentPrompt(agentId)
  const next = injectBlock(await readTextFile(path), snippet)
  await writeTextFile(path, next)
}

/** @param {string} path */
export async function removeAgentsBlock(path) {
  const next = removeBlock(await readTextFile(path))
  if (!next.trim()) {
    await removeFileIfExists(path)
  } else {
    await writeTextFile(path, next)
  }
}

/** @param {string} path @param {string} agentId */
export async function injectGeminiSnippetFile(path, agentId) {
  const snippet = await loadGeminiSnippet(agentId)
  if (!snippet) throw new Error(`No GEMINI snippet for agent: ${agentId}`)
  const next = injectGeminiBlock(await readTextFile(path), snippet)
  await writeTextFile(path, next)
}

/** @param {string} path */
export async function removeGeminiSnippetBlock(path) {
  const next = removeGeminiBlock(await readTextFile(path))
  if (!next.trim()) {
    await removeFileIfExists(path)
  } else {
    await writeTextFile(path, next)
  }
}

/** @param {string} agentId */
export async function loadAgentOpenaiYaml(agentId) {
  const path = openaiYamlPath(agentId)
  if (!path) return null
  return readTextFile(path)
}

/** Build YAML frontmatter for an installed skill file. */
export function buildSkillHeader(agentId) {
  const route = getRoute(agentId)
  const fm = route.skillFrontmatter
  const lines = ['---', 'name: search-boost']
  if (fm?.description) lines.push(`description: ${fm.description}`)
  if (fm?.allowedTools?.length) {
    lines.push(`allowed-tools: ${fm.allowedTools.join(' ')}`)
  }
  lines.push('---', '', '')
  return lines.join('\n')
}

/**
 * Templates that need richer YAML than `skillFrontmatter` can express ship their
 * own frontmatter and are copied verbatim.
 * @param {string} agentId @param {string} destPath
 */
export async function injectSkill(agentId, destPath) {
  const skill = await loadAgentSkill(agentId)
  if (!skill) throw new Error(`No skill template for agent: ${agentId}`)
  if (skill.trimStart().startsWith('---')) {
    await writeTextFile(destPath, `${skill.trim()}\n`)
    return
  }
  await writeTextFile(destPath, `${buildSkillHeader(agentId)}${skill}`)
}

/** @param {string} agentId @param {string} destPath */
export async function injectOpenaiYaml(agentId, destPath) {
  const yaml = await loadAgentOpenaiYaml(agentId)
  if (!yaml) return false
  await writeTextFile(destPath, `${yaml.trim()}\n`)
  return true
}

/** @param {string} destPath @param {string} [agentId] */
export async function injectAntigravityRule(destPath, agentId = 'antigravity') {
  const body = await loadAgentRule(agentId)
  if (!body) throw new Error(`No rule template for agent: ${agentId}`)
  const header = `---\ntrigger: always_on\ndescription: ${ANTIGRAVITY_RULE_DESCRIPTION}\n---\n\n`
  await writeTextFile(destPath, `${header}${body.trim()}\n`)
}

/**
 * @param {string} workspaceRoot
 * @param {boolean} dryRun
 */
export async function installAntigravityHook(workspaceRoot, dryRun) {
  const paths = workspaceAgents(workspaceRoot)
  const srcScript = hooksScriptPath('antigravity')
  const srcConfig = hooksConfigPath('antigravity')
  if (!srcScript || !srcConfig) throw new Error('Antigravity hook assets missing')

  if (!dryRun) {
    await mkdir(dirname(paths.hookScript), { recursive: true })
    await copyFile(srcScript, paths.hookScript)
    const incoming = await readJsonFile(srcConfig, {})
    const entry = incoming[HOOK_ENTRY_KEY]
    if (!entry) throw new Error(`Hook template missing key: ${HOOK_ENTRY_KEY}`)

    const merged = await readJsonFile(paths.hooks, {})
    merged[HOOK_ENTRY_KEY] = {
      ...entry,
      enabled: true,
      PreInvocation: entry.PreInvocation?.map((h) => ({
        ...h,
        command: 'node ./hooks/search-boost-pre-invocation.mjs',
      })) ?? entry.PreInvocation,
    }
    await writeJsonFile(paths.hooks, merged)
  }

  return [paths.hooks, paths.hookScript]
}

/**
 * @param {string} workspaceRoot
 * @param {boolean} dryRun
 */
export async function uninstallAntigravityHook(workspaceRoot, dryRun) {
  const paths = workspaceAgents(workspaceRoot)

  if (!dryRun) {
    await removeFileIfExists(paths.hookScript)
    const merged = await readJsonFile(paths.hooks, {})
    if (merged[HOOK_ENTRY_KEY]) {
      delete merged[HOOK_ENTRY_KEY]
      if (Object.keys(merged).length === 0) {
        await removeFileIfExists(paths.hooks)
      } else {
        await writeJsonFile(paths.hooks, merged)
      }
    }
  }
}

/** @param {string} path */
export async function removeFileIfExists(path) {
  try {
    await unlink(path)
    return true
  } catch {
    return false
  }
}

/** Merge Cursor IDE + CLI prompts when both targets are selected. */
export async function loadCursorMergedPrompt(includeCli) {
  const route = getRoute('cursor')
  const ide = await loadAgentPrompt('cursor')
  if (!includeCli) return ide
  const mergeId = route.mergeWith?.[0]
  if (!mergeId) return ide
  const cli = await loadAgentPrompt(mergeId)
  return `${ide.trim()}\n\n---\n\n${cli.trim()}`
}

export { PKG_ROOT, HOOK_ENTRY_KEY, ANTIGRAVITY_RULE_DESCRIPTION }
