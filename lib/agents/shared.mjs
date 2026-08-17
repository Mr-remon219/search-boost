import { unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { injectBlock, removeBlock } from '../inject.mjs'
import { readTextFile, writeTextFile } from '../json-config.mjs'

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** @param {string} agentId */
export async function loadAgentPrompt(agentId) {
  return readTextFile(join(PKG_ROOT, 'agents', `${agentId}.md`))
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

/** @param {string} agentId @param {string} skillPath */
export async function injectSkill(agentId, skillPath) {
  const skill = await readTextFile(join(PKG_ROOT, 'cursor', 'SKILL.md'))
  const header = `---\nname: search-boost\nagent: ${agentId}\n---\n\n`
  await writeTextFile(skillPath, `${header}${skill}`)
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
  const ide = await loadAgentPrompt('cursor')
  if (!includeCli) return ide
  const cli = await loadAgentPrompt('cursor-cli')
  return `${ide.trim()}\n\n---\n\n${cli.trim()}`
}

export { PKG_ROOT }
