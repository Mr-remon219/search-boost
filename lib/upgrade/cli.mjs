import { resolve } from 'node:path'
import { runRefresh } from './index.mjs'
import { handleCancel, loadClack } from '../installer/ui.mjs'

export function parseUpgradeArgs(args, { command = 'search-boost refresh', allowSyncOnly = true } = {}) {
  const options = {}
  let yes = false, help = false
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '-y' || arg === '--yes') yes = true
    else if (arg === '--dry-run') options.dryRun = true
    else if (arg === '--sync-only') throw new Error('--sync-only was removed; use search-boost refresh for current-version synchronization')
    else if (arg === '--repair-grok-cache' && allowSyncOnly) options.repairGrokCache = true
    else if (arg === '--workspace') {
      if (!args[i + 1] || args[i + 1].startsWith('-')) throw new Error('--workspace requires a path')
      options.workspace = resolve(args[++i])
    } else if (arg === '-h' || arg === '--help') help = true
    else throw new Error(`Unknown ${command} argument: ${arg}`)
  }
  return { options, yes, help }
}

export async function runRefreshCli(args, { run, log } = {}) {
  const { options, yes, help } = parseUpgradeArgs(args)
  if (help) {
    console.log('search-boost refresh [-y] [--dry-run] [--workspace PATH] [--repair-grok-cache]\nRefresh ALL existing integrations from the current package; no npm version check or SearchBoost software update.\n--repair-grok-cache: explicitly approve native uninstall --keep-data and reinstall --trust when a same-source Grok cache remains stale. Disabled plugins remain disabled/skipped. Without this flag, cache reconstruction requires interactive confirmation.\nCredentials, search layer, permissions and disabled state are preserved. Restart hosts afterward. Software updates: npm install -g search-boost@beta --prefer-online.')
    return
  }
  if (!yes && !options.dryRun) {
    const clack = await loadClack()
    const confirmed = await clack.confirm({ message: 'Refresh existing agent integrations from the current SearchBoost package, preserving configuration and credentials?', initialValue: true })
    handleCancel(confirmed, clack)
    if (!confirmed) return
  }
  const result = await runRefresh({ ...options, ...(!yes && !options.dryRun ? { confirmGrokRepair: async plan => {
    const clack = await loadClack()
    clack.note(`Plugin: ${plan.name}\nSource: ${plan.source}\nCache: ${plan.path}\nData will be retained by --keep-data. Reinstallation explicitly trusts this source. Fully quit Grok first.`, 'Rebuild Grok plugin cache')
    const choice = await clack.confirm({ message: 'Approve native cache reconstruction and trust this source?', initialValue: false })
    handleCancel(choice, clack)
    return choice === true
  } } : {}), ...(run ? { run } : {}), ...(log ? { log } : {}) })
  if (!result.ok) process.exitCode = 1
  return result
}
