/** Explicit old-client compatibility; file existence does not prove a legacy host. */
import { join } from 'node:path'
import { searchBoostHome } from './config-paths.mjs'
import { readJsonStore, withFileLock, writeFileAtomicPrivate } from './private-file.mjs'

export const antigravityPreferencePath = () => join(searchBoostHome(), 'config', 'antigravity.json')
export function antigravityConfigMode(override) {
  if (override !== undefined && override !== null) {
    if (!['modern', 'legacy'].includes(override)) throw new Error('Antigravity config mode must be modern or legacy')
    return override
  }
  const state = readJsonStore(antigravityPreferencePath())
  if (state.error) throw state.error
  const mode = state.doc?.mode ?? 'modern'
  if (!['modern', 'legacy'].includes(mode)) throw new Error('Invalid Antigravity compatibility preference; left unchanged')
  return mode
}
export function setAntigravityConfigMode(mode) {
  antigravityConfigMode(mode)
  const file = antigravityPreferencePath()
  withFileLock(file, () => {
    const state = readJsonStore(file)
    if (state.error) throw state.error
    writeFileAtomicPrivate(file, JSON.stringify({ ...state.doc, mode }, null, 2) + '\n')
  }, { waitMs: 5000 })
}
