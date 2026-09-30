/** One-shot --import probe in the selected DSH launcher's own Node/Electron runtime.
 * Never boot a profile, import SearchBoost, or print upstream diagnostics.
 * Non-DSH processes (notably npm exec's parent) simply continue to their entry.
 */
import { existsSync, lstatSync, readFileSync, realpathSync, writeSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { dshDependencies } from './dsh-manifest.mjs'
import { runDshInstallTransaction } from './dsh-profile-transaction.mjs'
import { assertDshRecoveryReady } from './dsh-recovery.mjs'

const nonce = process.env.SEARCH_BOOST_DSH_PROBE_NONCE
if (nonce && process.argv[1]) {
  let anchor
  try {
    let dir = dirname(realpathSync(process.argv[1]))
    for (;;) {
      const file = join(dir, 'package.json')
      if (existsSync(file)) {
        const pkg = JSON.parse(readFileSync(file, 'utf8'))
        if (pkg.name === '@deepseek-ai/dsh') anchor = file
        if (pkg.name === '@deepseek-ai/dsh-desktop-host') {
          // Desktop's CLI calls @deepseek-ai/dsh/runCli. Its INSTALL_ANCHOR
          // belongs to that CLI package, not to the carrier's package.json.
          const require = createRequire(file)
          const entry = require.resolve('@deepseek-ai/dsh/lib/bin.js')
          anchor = join(dirname(dirname(realpathSync(entry))), 'package.json')
        }
        break // never claim a foreign package's enclosing directory
      }
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  } catch { /* absent/unsupported carrier: parent fails closed */ }
  if (anchor) {
    let result = { error: 'resolver-unavailable' }
    try {
      const require = createRequire(anchor)
      const boot = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-app-boot')).href)
      const dir = process.env.SEARCH_BOOST_DSH_PROBE_PROFILE
      if (process.env.SEARCH_BOOST_DSH_PROBE_INSTALL || process.env.SEARCH_BOOST_DSH_PROBE_CLEANUP === '1' || process.env.SEARCH_BOOST_DSH_PROBE_ENABLE === '1') {
        try { assertDshRecoveryReady(dir) } catch {
          throw Object.assign(new Error('recovery pending'), { recoveryPending: true })
        }
      }
      const resolveBundle = () => realpathSync(boot.resolveBundleDir('dsh', 'search-boost', anchor, dir))
      const inspect = () => {
        const root = resolveBundle()
        const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
        return { root, name: pkg.name, version: pkg.version, patch: pkg.dsh?.bundle?.patch,
          files: ['index.js', 'schema.js', 'cordis.patch.yml'].every(file => existsSync(join(root, 'adapters', 'dsh', file))) }
      }
      const installing = Boolean(process.env.SEARCH_BOOST_DSH_PROBE_INSTALL)
      if (installing) {
        const atomic = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-atomic-write')).href)
        const operations = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-plugin-manager/operations')).href)
        const packageManager = process.env.SEARCH_BOOST_DSH_PROBE_PNPM ? JSON.parse(process.env.SEARCH_BOOST_DSH_PROBE_PNPM) : {}
        result = await runDshInstallTransaction({ boot, atomic, operations, dir, anchor,
          profile: process.env.SEARCH_BOOST_DSH_PROBE_PROFILE_NAME,
          spec: process.env.SEARCH_BOOST_DSH_PROBE_INSTALL, sourceRoot: process.env.SEARCH_BOOST_DSH_PROBE_SOURCE,
          version: process.env.SEARCH_BOOST_DSH_PROBE_VERSION, enable: process.env.SEARCH_BOOST_DSH_PROBE_ENABLE === '1',
          desktop: process.env.SEARCH_BOOST_DSH_PROBE_DESKTOP === '1', packageManager,
          backupHome: process.env.SEARCH_BOOST_DSH_PROBE_BACKUPS })
      } else if (process.env.SEARCH_BOOST_DSH_PROBE_CLEANUP === '1') {
        const { withFileLock } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-atomic-write')).href)
        const { saveManifest } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-plugin-manager/operations')).href)
        await withFileLock(join(dir, 'package.json'), async () => {
          if (process.env.SEARCH_BOOST_DSH_PROBE_DESKTOP === '1' && existsSync(join(dir, 'lock'))) throw new Error('Desktop running')
          const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
          if (['dependencies', 'devDependencies', 'optionalDependencies'].some(field => Object.hasOwn(pkg[field] ?? {}, 'search-boost'))) throw new Error('dependency remains')
          try { lstatSync(join(dir, 'node_modules', 'search-boost')); throw new Error('package link remains') } catch (error) { if (error.code !== 'ENOENT') throw error }
          const bundles = pkg.dsh?.profile?.bundles
          if (!Array.isArray(bundles) || bundles.some(name => typeof name !== 'string')) throw new Error('invalid bundle list')
          pkg.dsh.profile.bundles = bundles.filter(name => name !== 'search-boost')
          await saveManifest(dir, pkg)
        }, { waitMs: 0 })
        result = { removed: true }
      } else result = inspect()
      if (!installing && process.env.SEARCH_BOOST_DSH_PROBE_ENABLE === '1') {
        const expected = process.env.SEARCH_BOOST_DSH_PROBE_ROOT
        const version = process.env.SEARCH_BOOST_DSH_PROBE_VERSION
        const valid = value => value.root === expected && value.name === 'search-boost' && value.version === version
          && value.patch === './adapters/dsh/cordis.patch.yml' && value.files
        if (!valid(result)) throw new Error('source mismatch')
        const { withFileLock } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-atomic-write')).href)
        const { saveManifest } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-plugin-manager/operations')).href)
        await withFileLock(join(dir, 'package.json'), async () => {
          // Desktop's application lock is separate from the manifest write lock.
          if (process.env.SEARCH_BOOST_DSH_PROBE_DESKTOP === '1' && existsSync(join(dir, 'lock'))) throw new Error('Desktop running')
          if (!valid(inspect())) throw new Error('source changed')
          const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
          const bundles = pkg.dsh?.profile?.bundles
          if (!dshDependencies(pkg)['search-boost']
            || !Array.isArray(bundles) || bundles.some(name => typeof name !== 'string')) throw new Error('registration changed')
          if (!bundles.includes('search-boost')) {
            // Retained disabled dependencies were not validated by reconcile.
            // Parse the actual selected patch before opting into activation.
            boot.loadOverlayPatches('dsh', join(result.root, result.patch))
            bundles.push('search-boost')
            await saveManifest(dir, pkg)
          }
        }, { waitMs: 0 })
      }
      result.installAnchor = anchor
      result.hostVersion = JSON.parse(readFileSync(anchor, 'utf8')).version
      result.execPath = process.execPath
      result.electronVersion = process.versions.electron
      result.entry = process.argv[1]
    } catch (error) { result = { error: error.recoveryPending ? 'install-recovery-pending' : 'resolver-or-enable-failed' } }
    writeSync(1, `SEARCH_BOOST_DSH_RUNTIME:${nonce}:${JSON.stringify(result)}\n`)
    // --import awaits this module before main: exit before the host can boot or
    // mutate a profile. Only an explicit enable request above writes anything.
    process.exit(result.error ? 1 : 0)
  }
}
