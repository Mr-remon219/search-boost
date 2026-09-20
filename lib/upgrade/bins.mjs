/** Transfer only npm bins whose ownership can be proved; never use --force. */
import { lstat, readFile, readlink, realpath, rename, unlink } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { strictJson } from './config.mjs'
import { checkedCommand } from './process.mjs'

async function info(file) {
  try { return await lstat(file) } catch (err) { if (err.code === 'ENOENT') return null; throw err }
}
const commandFiles = (prefix) => process.platform === 'win32'
  ? ['', '.cmd', '.ps1'].map((ext) => join(prefix, `search-boost${ext}`))
  : [join(prefix, 'bin', 'search-boost')]

function entryFor(root, pkg) {
  const bin = typeof pkg.bin === 'string' && pkg.name === 'search-boost' ? pkg.bin : pkg.bin?.['search-boost']
  if (typeof bin !== 'string') return null
  const entry = resolve(root, bin), path = relative(root, entry)
  return !path.startsWith('..') && !isAbsolute(path) ? entry : null
}

async function owns(file, root, pkg) {
  const entry = entryFor(root, pkg), stat = await info(file)
  if (!entry || !stat) return false
  if (stat.isSymbolicLink()) {
    const target = resolve(dirname(file), await readlink(file))
    if (target === entry) return true
    try { return await realpath(target) === await realpath(entry) } catch { return false }
  }
  if (process.platform !== 'win32' || !stat.isFile()) return false
  // npm-generated cmd / PowerShell / sh wrappers. Require a known header and
  // the exact quoted target rooted at the wrapper's own directory.
  const text = (await readFile(file, 'utf8')).replace(/\\/g, '/').toLowerCase()
  if (!/^(?:@echo off|@if exist|#!\/bin\/sh|#!\/usr\/bin\/env pwsh)/.test(text)) return false
  const target = relative(dirname(file), entry).replace(/\\/g, '/').toLowerCase()
  return [`%dp0%/${target}"`, `%~dp0/${target}"`, `$basedir/${target}"`].some((path) => text.includes(path))
}

export async function verifyGlobalCommand(paths, version, run) {
  const pkg = await strictJson(join(paths.current, 'package.json'))
  for (const file of commandFiles(paths.prefix)) {
    if (!await owns(file, paths.current, pkg)) throw new Error(`Cannot verify the new npm command: ${file}`)
  }
  const output = await checkedCommand(run, process.execPath, [entryFor(paths.current, pkg), '--version'], { timeoutMs: 30_000 })
  if (output.trim() !== version) throw new Error('New npm command returned an unexpected version')
}

/** Reserve an old-owned conflicting alias only while installing the replacement.
 * Other legacy aliases keep working. Failed installation restores parked bins;
 * integrations and the old package have not been removed at this point.
 */
export async function withLegacyBinParked(paths, action) {
  const legacy = await strictJson(join(paths.legacy, 'package.json'))
  const current = await strictJson(join(paths.current, 'package.json'))
  const candidates = []
  for (const file of commandFiles(paths.prefix)) {
    if (!await info(file)) continue
    if (await owns(file, paths.current, current)) continue
    if (!await owns(file, paths.legacy, legacy)) throw new Error(`The command is not owned by search-boost-mcp or search-boost; left unchanged: ${file}`)
    candidates.push(file)
  }
  const parked = []
  try {
    for (const file of candidates) {
      const backup = `${file}.search-boost-migrate-${randomUUID()}`
      await rename(file, backup)
      parked.push({ file, backup })
    }
    await action()
  } catch (err) {
    try {
      const replacement = await strictJson(join(paths.current, 'package.json'))
      for (const { file, backup } of parked.reverse()) {
        if (await info(file)) {
          if (!await owns(file, paths.current, replacement)) throw new Error('Command ownership changed during migration')
          await unlink(file)
        }
        await rename(backup, file)
      }
    } catch { throw new Error(`Migration failed and command restoration needs attention. Old package retained. Bin backups: ${parked.map((p) => p.backup).join(', ')}`) }
    throw err
  }
  for (const { backup } of parked) await unlink(backup)
}

export async function rebuildGlobalCommand(paths, version, run) {
  // Refuse to overwrite a foreign command even during cleanup/recovery.
  const pkg = await strictJson(join(paths.current, 'package.json'))
  for (const file of commandFiles(paths.prefix)) {
    if (await info(file) && !await owns(file, paths.current, pkg)) throw new Error(`Cannot repair a command owned by another installation: ${file}`)
  }
  await checkedCommand(run, 'npm', ['rebuild', '--global', '--ignore-scripts', '--bin-links=true', '--force=false', 'search-boost'], { timeoutMs: 180_000 })
  await verifyGlobalCommand(paths, version, run)
}
