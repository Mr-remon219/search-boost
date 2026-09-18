import { resolve } from 'node:path'
import { configReadCandidates, configWritePath, prepareConfigWrite, readFirstExistingJson } from './config-paths.mjs'
import { writeJsonFile } from './json-config.mjs'

function markerPath() {
  return configWritePath('workspaces')
}

function markerReadCandidates() {
  return configReadCandidates('workspaces')
}

/** @returns {Promise<string[]>} */
export async function listAntigravityWorkspaces() {
  const data = readFirstExistingJson(markerReadCandidates(), { workspaces: [] })
  return Array.isArray(data.workspaces) ? data.workspaces.map((p) => resolve(String(p))) : []
}

/** @param {string} root @param {boolean} [dryRun] */
export async function recordAntigravityWorkspace(root, dryRun = false) {
  const abs = resolve(root)
  const data = readFirstExistingJson(markerReadCandidates(), { workspaces: [] })
  const set = new Set(Array.isArray(data.workspaces) ? data.workspaces.map((p) => resolve(String(p))) : [])
  set.add(abs)
  data.workspaces = [...set]
  if (!dryRun) {
    const path = prepareConfigWrite('workspaces')
    await writeJsonFile(path, data)
  }
}

/** @param {string} root @param {boolean} [dryRun] */
export async function forgetAntigravityWorkspace(root, dryRun = false) {
  const abs = resolve(root)
  const data = readFirstExistingJson(markerReadCandidates(), { workspaces: [] })
  const before = Array.isArray(data.workspaces) ? data.workspaces : []
  const next = before.filter((p) => resolve(String(p)) !== abs)
  if (next.length === before.length) return
  data.workspaces = next
  if (!dryRun) {
    const path = prepareConfigWrite('workspaces')
    await writeJsonFile(path, data)
  }
}
