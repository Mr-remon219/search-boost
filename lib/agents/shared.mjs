import { existsSync } from 'node:fs'
import { unlink } from 'node:fs/promises'
import { PKG_ROOT } from '../pkg.mjs'
import {
  injectBlock,
  removeBlock,
} from '../inject.mjs'
import { readTextFile, writeTextFile } from '../json-config.mjs'
import {
  getRoute,
  openaiYamlPath,
  promptPath,
  skillPath,
  mcpServerInstructionsPath,
} from '../../agents/router.mjs'

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
  if (!existsSync(path)) return
  const next = removeBlock(await readTextFile(path))
  if (!next.trim()) {
    await removeFileIfExists(path)
    return
  }
  await writeTextFile(path, next)
}

/** True when skill content was installed by search-boost (safe to remove on uninstall). */
export function isOwnedSearchBoostSkill(content) {
  return content.includes('SEARCH_BOOST') || content.includes('mcp__search-boost__')
}

/**
 * Remove skill file only when it carries our fingerprint — preserves foreign skills.
 * @param {string} path
 * @returns {Promise<boolean>} true when file was removed
 */
export async function removeSkillIfOwned(path) {
  if (!existsSync(path)) return false
  const content = await readTextFile(path)
  if (!isOwnedSearchBoostSkill(content)) return false
  return removeFileIfExists(path)
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

/** @param {string} path */
export async function removeFileIfExists(path) {
  try {
    await unlink(path)
    return true
  } catch {
    return false
  }
}

/** @param {string} path */
export async function removeEmptyFileIfExists(path) {
  try {
    const content = await readTextFile(path)
    if (content.trim() !== '') return false
    return removeFileIfExists(path)
  } catch {
    return false
  }
}

/** @param {string} path */
export async function removeEmptyDirIfExists(path) {
  try {
    const { readdir, rmdir } = await import('node:fs/promises')
    const entries = await readdir(path)
    if (entries.length === 0) {
      await rmdir(path)
      return true
    }
  } catch {
    /* missing or not empty */
  }
  return false
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

export { PKG_ROOT }
