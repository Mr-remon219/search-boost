/** Package delivery shared by normal updates and the one-time npm-name migration. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { PKG_ROOT } from '../pkg.mjs'
import { checkedCommand, compareVersions } from './process.mjs'

export const cachedRuntime = () => /[\\/]_npx[\\/]/.test(PKG_ROOT)

export function restoreCallerCwd() {
  const cwd = process.env.SEARCH_BOOST_UPGRADE_CWD
  if (cwd && cachedRuntime()) {
    if (!isAbsolute(cwd)) throw new Error('Invalid cached updater working directory')
    process.chdir(cwd)
  }
}

export async function latestVersion(run) {
  let raw
  try { raw = await checkedCommand(run, 'npm', ['view', 'search-boost@latest', 'version', '--json'], { timeoutMs: 30_000 }) }
  catch { throw new Error('npm version check failed: search-boost@latest may not be published yet, or the registry/network is unavailable. No package or integration was changed.') }
  let version
  try { version = JSON.parse(raw) } catch { throw new Error('npm returned invalid version metadata; no integrations changed') }
  // npm versions differ: an exact dist-tag may be a scalar or singleton array.
  if (Array.isArray(version) && version.length === 1) version = version[0]
  if (typeof version !== 'string') throw new Error('npm returned ambiguous version metadata; no integrations changed')
  compareVersions(version, version)
  return version
}

export async function globalPackagePaths(run) {
  const root = (await checkedCommand(run, 'npm', ['root', '--global'])).trim()
  const prefix = (await checkedCommand(run, 'npm', ['prefix', '--global'])).trim()
  if (![root, prefix].every((path) => isAbsolute(path) && !/[\r\n]/.test(path))) throw new Error('Cannot resolve the global npm root/prefix')
  return { root, prefix, current: join(root, 'search-boost'), legacy: join(root, 'search-boost-mcp') }
}

/** npm exec is npx's implementation. An empty cwd prevents a project package
 * or local binary from shadowing the exact requested cache package. The worker
 * restores the real project cwd before discovering integrations.
 */
export async function runCachedCommand(command, { version, workspace, run, log, token }) {
  const cwd = await mkdtemp(join(tmpdir(), 'search-boost-updater-'))
  try {
    const result = await run('npm', [
      'exec', '--yes', '--ignore-scripts', '--bin-links=true', `--package=search-boost@${version}`, '--',
      'search-boost', command, '--yes', ...(workspace ? ['--workspace', workspace] : []),
    ], {
      cwd, timeoutMs: 900_000,
      env: { ...process.env, SEARCH_BOOST_UPGRADE_CWD: process.cwd(), SEARCH_BOOST_UPGRADE_HANDOFF: token },
    })
    if (result.stdout) log(result.stdout.trim())
    if (result.code !== 0) throw new Error(`Cached ${command} failed or was partial. Retry npx --yes --package=search-boost@latest -- search-boost ${command} -y after resolving the reported blockers.`)
  } finally { await rm(cwd, { recursive: true, force: true }) }
}

export function installGlobal(run, version) {
  return checkedCommand(run, 'npm', ['install', '--global', '--ignore-scripts', '--bin-links=true', '--force=false', '--no-audit', '--no-fund', `search-boost@${version}`], { timeoutMs: 300_000 })
}

export async function syncInstalled(root, { workspace, run, log, token }) {
  const result = await run(process.execPath, [join(root, 'cli.mjs'), 'upgrade', '--sync-only', '--yes', ...(workspace ? ['--workspace', workspace] : [])], {
    timeoutMs: 900_000, env: { ...process.env, SEARCH_BOOST_UPGRADE_HANDOFF: token },
  })
  if (result.stdout) log(result.stdout.trim())
  if (result.code !== 0) throw new Error(`Integration refresh failed or was partial. Retry using the TUI Update option or ${JSON.stringify(process.execPath)} ${JSON.stringify(join(root, 'cli.mjs'))} upgrade --sync-only -y.`)
}
