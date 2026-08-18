import { existsSync } from 'node:fs'
import { mkdir, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { readJsonFile, writeJsonFile } from './json-config.mjs'

/** @returns {string} */
export function cursorInstallStatePath() {
  return process.env.SEARCH_BOOST_CURSOR_INSTALL_STATE
    ?? resolve(homedir(), '.search-boost', 'state', 'cursor-install.json')
}

/** @returns {Promise<{ createdFiles: string[] }>} */
async function readState() {
  const data = await readJsonFile(cursorInstallStatePath(), { createdFiles: [] })
  return {
    createdFiles: Array.isArray(data.createdFiles)
      ? data.createdFiles.map((p) => resolve(String(p)))
      : [],
  }
}

/** @param {string} path @param {boolean} [dryRun] */
export async function recordCursorCreatedFile(path, dryRun = false) {
  const abs = resolve(path)
  const state = await readState()
  if (state.createdFiles.includes(abs)) return
  state.createdFiles.push(abs)
  if (!dryRun) {
    await mkdir(dirname(cursorInstallStatePath()), { recursive: true })
    await writeJsonFile(cursorInstallStatePath(), state)
  }
}

/** @param {string} path */
export async function wasCursorCreatedFile(path) {
  const abs = resolve(path)
  const state = await readState()
  return state.createdFiles.includes(abs)
}

/** @param {string} path @param {boolean} [dryRun] */
export async function forgetCursorCreatedFile(path, dryRun = false) {
  const abs = resolve(path)
  const state = await readState()
  const next = state.createdFiles.filter((p) => p !== abs)
  if (next.length === state.createdFiles.length) return
  if (!dryRun) {
    if (next.length === 0) {
      try {
        if (existsSync(cursorInstallStatePath())) await unlink(cursorInstallStatePath())
      } catch { /* best effort */ }
    } else {
      await writeJsonFile(cursorInstallStatePath(), { createdFiles: next })
    }
  }
}

/** @param {boolean} [dryRun] */
export async function clearCursorInstallState(dryRun = false) {
  if (dryRun || !existsSync(cursorInstallStatePath())) return
  try {
    await unlink(cursorInstallStatePath())
  } catch { /* best effort */ }
}
