import { resolve } from 'node:path'
import { runUpgrade } from './index.mjs'
import { handleCancel, loadClack } from '../installer/ui.mjs'

export async function runUpgradeCli(args, { command = 'search-boost upgrade', confirmMessage = 'Upgrade search-boost and migrate existing integrations, keeping credentials and permission choices?', run, log } = {}) {
  const opts = {}
  let yes = false
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '-y' || arg === '--yes') yes = true
    else if (arg === '--dry-run') opts.dryRun = true
    else if (arg === '--sync-only') opts.syncOnly = true
    else if (arg === '--workspace') {
      if (!args[i + 1] || args[i + 1].startsWith('-')) throw new Error('--workspace requires a path')
      opts.workspace = resolve(args[++i])
    } else if (arg === '-h' || arg === '--help') {
      console.log(`${command} [-y] [--dry-run] [--sync-only] [--workspace PATH]\nChecks npm latest and refreshes existing integrations (including legacy Pi/DSH).\n--sync-only: keep this package version; migrate assets after npm update or while offline.\nCredentials, search layer, permissions, and disabled hooks are preserved. Restart hosts afterward.`)
      return
    } else throw new Error(`Unknown ${command} argument: ${arg}`)
  }
  if (!yes && !opts.dryRun) {
    const clack = await loadClack()
    const confirmed = await clack.confirm({ message: confirmMessage, initialValue: true })
    handleCancel(confirmed, clack)
    if (!confirmed) return
  }
  const result = await runUpgrade({ ...opts, ...(run ? { run } : {}), ...(log ? { log } : {}) })
  if (!result.ok) process.exitCode = 1
  return result
}
