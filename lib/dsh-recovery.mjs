import { lstatSync } from 'node:fs'
import { join } from 'node:path'

function present(path) {
  try { lstatSync(path); return true } catch (error) { if (error.code === 'ENOENT') return false; throw error }
}
/** Never snapshot/overwrite while a prior host-managed pnpm tree may still write. */
export function dshRecoveryPending(dir) {
  return present(join(dir, '.search-boost-install-pending.json')) || present(join(dir, '.plugin-manager', 'run.json'))
}
export function assertDshRecoveryReady(dir) {
  if (dshRecoveryPending(dir)) throw new Error(`DSH profile has an interrupted installation or earlier package run pending recovery: ${dir}. No new package operation or activation was started. Inspect its recovery marker/private backup and host run record; stop earlier package processes before recovering.`)
}
