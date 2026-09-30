/** Runs inside the owning DSH runtime, holding its official manifest lock throughout. */
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { dshDependencies } from './dsh-manifest.mjs'
import { verifyDshPayload } from './dsh-payload.mjs'
import { dshRecoveryPending } from './dsh-recovery.mjs'

const FILES = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'cordis.yml', 'cordis.yaml', 'cordis.patch.yml']
const info = path => { try { return lstatSync(path) } catch (error) { if (error.code === 'ENOENT') return null; throw error } }

export async function runDshInstallTransaction({ boot, atomic, operations, dir, profile, anchor, spec, sourceRoot, version, enable, desktop, packageManager, backupHome }) {
  if (typeof operations.runProfilePnpm !== 'function' || typeof atomic.writeFileAtomic !== 'function'
    || typeof atomic.withFileLock !== 'function' || typeof boot.resolveBundleDir !== 'function') throw new Error('transaction unavailable')
  if (desktop && !existsSync(join(dir, 'package.json'))) throw new Error('Desktop must initialize its profile')
  mkdirSync(dir, { recursive: true })
  return atomic.withFileLock(join(dir, 'package.json'), async () => {
    if (desktop && existsSync(join(dir, 'lock'))) throw new Error('Desktop running')
    const pending = join(dir, '.search-boost-install-pending.json')
    if (dshRecoveryPending(dir)) return { error: 'install-recovery-pending' }
    const nodes = join(dir, 'node_modules')
    const nodeInfo = info(nodes)
    // An externally shared node_modules cannot be rolled back without changing
    // another owner. Refuse before invoking pnpm, never rewrite that alias.
    if (nodeInfo && (!nodeInfo.isDirectory() || nodeInfo.isSymbolicLink())) throw new Error('unsupported node_modules ownership')
    let files, backup
    try {
      files = FILES.map(name => {
        const path = join(dir, name), stat = info(path)
        if (stat && (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1)) throw new Error('unsupported profile file ownership')
        return { name, bytes: stat ? readFileSync(path) : null, mode: stat ? stat.mode & 0o777 : 0o600 }
      })
      backup = join(backupHome, `dsh-install-${randomUUID()}`)
      mkdirSync(backup, { recursive: true, mode: 0o700 })
      writeFileSync(join(backup, 'meta.json'), JSON.stringify({ dir: realpathSync(dir), profile, anchor, version, at: new Date().toISOString() }), { mode: 0o600 })
      writeFileSync(join(backup, 'files.json'), JSON.stringify(files.map(file => ({ ...file, bytes: file.bytes?.toString('base64') ?? null }))), { mode: 0o600 })
      if (nodeInfo) cpSync(nodes, join(backup, 'node_modules'), { recursive: true, dereference: false, verbatimSymlinks: true })
    } catch { return { error: 'install-backup-failed' } }
    const restore = async () => {
      if (nodeInfo) {
        const stage = join(dir, `.search-boost-restore-${randomUUID()}`)
        const trash = join(dir, `.search-boost-rejected-${randomUUID()}`)
        await atomic.writeFileAtomic(pending, JSON.stringify({ backup, state: 'restoring', stage, trash }), { mode: 0o600 })
        cpSync(join(backup, 'node_modules'), stage, { recursive: true, dereference: false, verbatimSymlinks: true })
        const hadNodes = existsSync(nodes)
        if (hadNodes) renameSync(nodes, trash)
        try { renameSync(stage, nodes) } catch (error) {
          if (hadNodes) renameSync(trash, nodes)
          throw error
        }
        rmSync(trash, { recursive: true, force: true })
      } else rmSync(nodes, { recursive: true, force: true })
      for (const file of files) {
        if (file.bytes === null) rmSync(join(dir, file.name), { force: true })
        else await atomic.writeFileAtomic(join(dir, file.name), file.bytes, { mode: file.mode })
      }
    }
    let operationExitCode
    let failure = 'operation'
    await atomic.writeFileAtomic(pending, JSON.stringify({ backup, state: 'installing' }), { mode: 0o600 })
    try {
      if (!existsSync(join(dir, 'package.json'))) {
        if (typeof boot.initProfile !== 'function') throw new Error('profile initialization unavailable')
        boot.initProfile(dir, boot.PROFILE_TEMPLATES?.[profile]?.bundles ?? boot.DEFAULT_PROFILE_BUNDLES ?? [])
      }
      const env = { ...process.env, ...packageManager?.env }
      for (const key of Object.keys(env)) if (key.startsWith('SEARCH_BOOST_DSH_PROBE_')) delete env[key]
      const operation = await operations.runProfilePnpm({ profile, dir, installAnchor: anchor, cwd: process.cwd() }, ['add', spec], {
        ...packageManager, env, execution: 'service', outputBytes: 0,
        idleTimeoutMs: 120_000, lookupTimeoutMs: 30_000,
      })
      operationExitCode = operation.exitCode
      if (operation.exitCode !== 0 || operation.timedOut) { failure = operation.timedOut ? 'timeout' : 'operation'; throw new Error('package operation failed') }
      failure = 'source'
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
      const selected = boot.resolveBundleDir('dsh', 'search-boost', anchor, dir)
      const root = realpathSync(selected)
      const expected = realpathSync(join(dir, 'node_modules', 'search-boost'))
      const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
      if (root !== expected || manifest.name !== 'search-boost' || manifest.version !== version
        || manifest.dsh?.bundle?.patch !== './adapters/dsh/cordis.patch.yml'
        || !['index.js', 'schema.js', 'cordis.patch.yml'].every(name => existsSync(join(root, 'adapters/dsh', name)))) throw new Error('source mismatch')
      failure = 'payload'
      verifyDshPayload(root, sourceRoot)
      failure = 'registration'
      const bundles = pkg.dsh?.profile?.bundles
      if (typeof dshDependencies(pkg)['search-boost'] !== 'string' || !Array.isArray(bundles) || bundles.some(name => typeof name !== 'string')) throw new Error('invalid registration')
      failure = 'activation'
      if (enable && !bundles.includes('search-boost')) {
        boot.loadOverlayPatches('dsh', join(root, manifest.dsh.bundle.patch))
        bundles.push('search-boost')
        await operations.saveManifest(dir, pkg)
      }
      rmSync(pending, { force: true })
      // A verified success no longer needs a full module-tree backup. Failure
      // backups stay private and identifiable for deliberate recovery.
      try { rmSync(backup, { recursive: true, force: true }) } catch { /* retained private backup; not an install failure */ }
      return { root, name: manifest.name, version, patch: manifest.dsh.bundle.patch, files: true, enabled: bundles.includes('search-boost') }
    } catch {
      try { await restore(); rmSync(pending, { force: true }) } catch { return { error: 'install-rollback-incomplete', backup } }
      return { error: 'install-failed-restored', backup, failure, ...(Number.isInteger(operationExitCode) ? { exitCode: operationExitCode } : {}) }
    }
  }, { waitMs: 0 })
}
