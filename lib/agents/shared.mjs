import { unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { injectBlock, removeBlock } from '../inject.mjs'
import { readTextFile, writeTextFile } from '../json-config.mjs'
import {
  getRoute,
  promptPath,
  skillPath,
  mcpServerInstructionsPath,
} from '../../agents/router.mjs'

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

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

/** @param {string} path @param {string} body */
export async function injectAgentsBody(path, body) {
  const next = injectBlock(await readTextFile(path), body)
  await writeTextFile(path, next)
}

/** @param {string} path */
export async function removeAgentsBlock(path) {
  await writeTextFile(path, removeBlock(await readTextFile(path)))
}

/** @param {string} text */
function hasFrontmatter(text) {
  return text.trimStart().startsWith('---')
}

/** @param {string} agentId @param {string} destPath */
export async function injectSkill(agentId, destPath) {
  const skill = await loadAgentSkill(agentId)
  if (!skill) throw new Error(`No skill template for agent: ${agentId}`)
  if (hasFrontmatter(skill)) {
    await writeTextFile(destPath, `${skill.trim()}\n`)
    return
  }
  const header = `---\nname: search-boost\nagent: ${agentId}\n---\n\n`
  await writeTextFile(destPath, `${header}${skill}`)
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

export { PKG_ROOT }
