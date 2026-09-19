/** TUI/CLI upgrade orchestration. Never writes key/layer/auth files or enables permissions. */
import { existsSync } from 'node:fs'
import { mkdir, open, unlink, writeFile } from 'node:fs/promises'
import { dirname, join, isAbsolute } from 'node:path'
import { randomUUID } from 'node:crypto'
import { PATHS } from '../paths.mjs'
import { PKG_ROOT, getVersion, getPackageName } from '../pkg.mjs'
import { searchBoostHome } from '../config-paths.mjs'
import { discoverIntegrations, refreshIntegration, refreshGrokPlugin } from './integrations.mjs'
import { runCommand, checkedCommand, compareVersions } from './process.mjs'
import { strictJson } from './config.mjs'
import { verifyReplacement } from './packages.mjs'

const PACKAGE = 'search-boost'

async function acquireLock() {
  const path = join(searchBoostHome(), 'state', 'upgrade.lock')
  await mkdir(join(searchBoostHome(), 'state'), { recursive: true })
  const inherited = process.env.SEARCH_BOOST_UPGRADE_HANDOFF
  if (inherited) {
    const lock = await strictJson(path)
    if (lock.token !== inherited) throw new Error('Invalid upgrade handoff; refusing concurrent migration')
    await writeFile(path, JSON.stringify({ pid: process.pid, token: inherited }), { mode: 0o600 })
    return { token: inherited, release: async () => {} }
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(path, 'wx', 0o600)
      const token = randomUUID()
      await handle.writeFile(JSON.stringify({ pid: process.pid, token }))
      await handle.close()
      return { token, release: () => unlink(path) }
    } catch (err) {
      if (err.code !== 'EEXIST') throw err
      const lock = await strictJson(path)
      if (!Number.isSafeInteger(lock.pid) || lock.pid <= 0) throw new Error(`Invalid upgrade lock: ${path}`)
      try { process.kill(lock.pid, 0) } catch (err) {
        if (err.code === 'ESRCH') { await unlink(path); continue }
      }
      throw new Error('Another upgrade is running; wait for it to finish')
    }
  }
  throw new Error('Cannot acquire upgrade lock')
}

/** Injectable command runner is used by hermetic tests; production never mocks host execution. */
export async function runUpgrade({ dryRun = false, syncOnly = false, workspace, run = runCommand, log = console.log } = {}) {
  const current = getVersion()
  compareVersions(current, current)
  if (syncOnly && getPackageName() !== PACKAGE) throw new Error('Run search-boost-mcp upgrade without --sync-only to move to the new package first')
  let latest = current
  const lock = dryRun ? { token: '', release: async () => {} } : await acquireLock()
  try {
    if (!syncOnly) {
      log(`Checking npm ${PACKAGE}@latest (running ${current})…`)
      const raw = await checkedCommand(run, 'npm', ['view', `${PACKAGE}@latest`, 'version', '--json'], { timeoutMs: 30_000 })
      try { latest = JSON.parse(raw) } catch { throw new Error('npm returned invalid version metadata; no integrations changed') }
      if (typeof latest !== 'string') throw new Error('npm returned ambiguous version metadata; no integrations changed')
      compareVersions(latest, latest)
      const renamedPackage = getPackageName() !== PACKAGE
      const older = !renamedPackage && compareVersions(current, latest) < 0
      const ephemeral = /[\\/]_npx[\\/]/.test(PKG_ROOT)
      if (older || ephemeral || renamedPackage) {
        // Old and new npm package versions are different release streams.
        const version = older || renamedPackage ? latest : current
        if (dryRun) log(`Would install ${PACKAGE}@${version} globally, then use its migration code. Old global packages are not uninstalled.`)
        else {
          const root = (await checkedCommand(run, 'npm', ['root', '--global'])).trim()
          if (!isAbsolute(root) || /[\r\n]/.test(root)) throw new Error('Cannot resolve the global npm package root')
          const oldPackage = await strictJson(join(root, 'search-boost-mcp', 'package.json'))
          if (oldPackage.bin?.['search-boost']) throw new Error('The old package still owns the search-boost command. First update it with npm install -g search-boost-mcp@latest (the command-renaming transition release), then retry. Nothing was uninstalled or force-overwritten.')
          log(`Installing ${PACKAGE}@${version} globally (no --force or old-package removal)…`)
          await checkedCommand(run, 'npm', ['install', '--global', '--ignore-scripts', '--force=false', '--no-audit', '--no-fund', `${PACKAGE}@${version}`], { timeoutMs: 300_000 })
          const pkgRoot = join(root, PACKAGE)
          await verifyReplacement(pkgRoot, version)
          // Use the NEW package's code, not old modules already imported in this process.
          const args = [join(pkgRoot, 'cli.mjs'), 'upgrade', '--sync-only', '--yes', ...(workspace ? ['--workspace', workspace] : [])]
          const result = await run(process.execPath, args, { timeoutMs: 900_000, env: { ...process.env, SEARCH_BOOST_UPGRADE_HANDOFF: lock.token } })
          if (result.stdout) log(result.stdout.trim())
          if (result.code !== 0) throw new Error('Package updated, but integration migration failed or was partial. Run the new TUI/`search-boost upgrade --sync-only` to retry; do not assume completion.')
          return { ok: true, reloaded: true, version, results: [] }
        }
      } else log(compareVersions(current, latest) > 0 ? `Running ${current} is newer than npm ${latest}; not downgrading. Refreshing existing integrations.` : `Already ${current}; refreshing existing integrations anyway.`)
    } else {
      if (/[\\/]_npx[\\/]/.test(PKG_ROOT)) throw new Error('Install search-boost globally before --sync-only; temporary npx paths are not durable integration targets')
      log(`Refreshing existing integrations from ${current} without downloading or changing credentials.`)
    }

    if (getPackageName() === PACKAGE) await verifyReplacement(PKG_ROOT, current)
    const plan = await discoverIntegrations({ workspace })
    for (const warning of plan.warnings) log(`[blocked] ${warning}`)
    const results = []
    for (const target of plan.targets) {
      log(`${dryRun ? '[plan]' : '[upgrade]'} ${target.label}${target.legacy ? ' (legacy package migration)' : ''}`)
      try {
        const backup = await refreshIntegration(target, { dryRun, run })
        results.push({ target: target.label, ok: true, ...(backup ? { backup } : {}) })
        log(`[${dryRun ? 'planned' : 'ok'}] ${target.label}`)
      } catch (err) {
        const error = err instanceof Error ? err.message : 'Upgrade failed'
        results.push({ target: target.label, ok: false, error })
        log(`[failed] ${target.label}: ${error}`)
      }
    }
    if (plan.targets.some((t) => t.id === 'grok') || existsSync(dirname(PATHS.grok.config))) {
      try {
        const plugin = await refreshGrokPlugin({ dryRun, run })
        const ok = !['failed', 'unavailable'].includes(plugin.status)
        results.push({ target: 'grok plugin', ok, status: plugin.status })
        log(`[${plugin.status}] ${plugin.message}`)
      } catch (err) {
        results.push({ target: 'grok plugin', ok: false })
        log(`[failed] ${err.message}`)
      }
    }
    const ok = !plan.warnings.length && results.every((r) => r.ok)
    if (!results.length) log('No existing supported integrations found; use Install for a new host.')
    if (!ok) log(`Resume safely with: ${JSON.stringify(process.execPath)} ${JSON.stringify(join(PKG_ROOT, 'cli.mjs'))} upgrade --sync-only -y`)
    if (!dryRun) {
      await writeFile(join(searchBoostHome(), 'state', 'last-upgrade.json'), `${JSON.stringify({ version: current, checkedLatest: latest, at: new Date().toISOString(), ok, results }, null, 2)}\n`, { mode: 0o600 })
    }
    log(dryRun ? 'Dry-run only: no package, integration, or credential files changed.' : ok ? 'Upgrade complete. Restart/reload affected hosts; disabled hooks and permission decisions remain unchanged.' : 'Upgrade incomplete: see failed/blocked targets above. Successful targets are retained; retry after resolving blockers.')
    return { ok, version: current, results, warnings: plan.warnings }
  } finally { await lock.release() }
}
