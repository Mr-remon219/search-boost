import { resolve } from 'node:path'
import { runUpgrade } from './index.mjs'
import { handleCancel, loadClack } from '../installer/ui.mjs'

export function parseUpgradeArgs(args, { command = 'search-boost upgrade', allowSyncOnly = true } = {}) {
  const options = {}
  let yes = false, help = false
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '-y' || arg === '--yes') yes = true
    else if (arg === '--dry-run') options.dryRun = true
    else if (arg === '--sync-only') {
      if (!allowSyncOnly) throw new Error('--sync-only is not supported by migrate; use the TUI Update option for normal updates')
      options.syncOnly = true
    } else if (arg === '--workspace') {
      if (!args[i + 1] || args[i + 1].startsWith('-')) throw new Error('--workspace requires a path')
      options.workspace = resolve(args[++i])
    } else if (arg === '-h' || arg === '--help') help = true
    else throw new Error(`Unknown ${command} argument: ${arg}`)
  }
  return { options, yes, help }
}

export async function runUpgradeCli(args, { run, log } = {}) {
  const { options, yes, help } = parseUpgradeArgs(args)
  if (help) {
    console.log('search-boost upgrade [-y] [--dry-run] [--sync-only] [--workspace PATH]\nEquivalent to TUI Update: checks npm latest and refreshes ALL installed agents, including Pi/DSH legacy adapters.\n--sync-only: keep this package version; refresh assets after npm update or while offline.\nFor the global search-boost-mcp npm rename only, use npx --yes --package=search-boost@latest -- search-boost migrate -y.\nCredentials, search layer, permissions and disabled state are preserved. Restart hosts afterward.')
    return
  }
  if (!yes && !options.dryRun) {
    const clack = await loadClack()
    const confirmed = await clack.confirm({ message: 'Update search-boost and all installed agents, keeping user configuration and credentials?', initialValue: true })
    handleCancel(confirmed, clack)
    if (!confirmed) return
  }
  const result = await runUpgrade({ ...options, ...(run ? { run } : {}), ...(log ? { log } : {}) })
  if (!result.ok) process.exitCode = 1
  return result
}
