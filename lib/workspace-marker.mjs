import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { readJsonFile, writeJsonFile } from './json-config.mjs'

function markerPath() {
  return process.env.SEARCH_BOOST_WORKSPACES_FILE
    ?? `${homedir()}/.search-boost-antigravity-workspaces.json`
}

/** @returns {Promise<string[]>} */
export async function listAntigravityWorkspaces() {
  const data = await readJsonFile(markerPath(), { workspaces: [] })
  return Array.isArray(data.workspaces) ? data.workspaces.map((p) => resolve(String(p))) : []
}

/** @param {string} root @param {boolean} [dryRun] */
export async function recordAntigravityWorkspace(root, dryRun = false) {
  const abs = resolve(root)
  const data = await readJsonFile(markerPath(), { workspaces: [] })
  const set = new Set(Array.isArray(data.workspaces) ? data.workspaces.map((p) => resolve(String(p))) : [])
  set.add(abs)
  data.workspaces = [...set]
  if (!dryRun) await writeJsonFile(markerPath(), data)
}

/** @param {string} root @param {boolean} [dryRun] */
export async function forgetAntigravityWorkspace(root, dryRun = false) {
  const abs = resolve(root)
  const data = await readJsonFile(markerPath(), { workspaces: [] })
  const before = Array.isArray(data.workspaces) ? data.workspaces : []
  const next = before.filter((p) => resolve(String(p)) !== abs)
  if (next.length === before.length) return
  data.workspaces = next
  if (!dryRun) await writeJsonFile(markerPath(), data)
}
