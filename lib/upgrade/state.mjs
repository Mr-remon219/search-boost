/** Owned upgrade receipts/project discovery. Never store credentials in receipts. */
import { mkdir, readFile, writeFile, copyFile, lstat, unlink, chmod, realpath, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { searchBoostHome } from '../config-paths.mjs'
import { strictJson } from './config.mjs'

const projectsPath = () => join(searchBoostHome(), 'state', 'upgrade-projects.json')
/** Receipt location for user review; discovery never deletes entries from it. */
export const recordedProjectsPath = () => projectsPath()
export async function recordedProjects() {
  const data = await strictJson(projectsPath())
  return Array.isArray(data.projects) ? data.projects.filter((p) => typeof p === 'string').map((p) => resolve(p)) : []
}
export async function recordUpgradeProject(root) {
  const file = projectsPath()
  const projects = [...new Set([...await recordedProjects(), resolve(root)])]
  await mkdir(join(searchBoostHome(), 'state'), { recursive: true })
  await writeFile(file, `${JSON.stringify({ projects }, null, 2)}\n`, { mode: 0o600 })
}

/** Private backups plus per-target rollback; raw config bytes never enter logs/results. */
export async function backupFiles(files, { symlinkFiles = [] } = {}) {
  const allowed = new Set(symlinkFiles)
  const entries = [], identities = new Set(), targets = new Set()
  for (const path of [...new Set(files)]) {
    let info
    try { info = await lstat(path, { bigint: true }) } catch (err) {
      if (err.code !== 'ENOENT') throw err
      entries.push({ path, absent: true }); continue
    }
    // ENOENT after lstat is a dangling link, not an absent configuration.
    const target = info.isSymbolicLink() && allowed.has(path) ? await realpath(path) : path
    const targetInfo = info.isSymbolicLink() && allowed.has(path) ? await stat(target, { bigint: true }) : info
    if (!targetInfo.isFile()) throw new Error(`Not a regular upgrade file: ${path}`)
    // Windows file IDs can exceed Number.MAX_SAFE_INTEGER. Never round them;
    // zero inode values cannot establish identity on virtual filesystems.
    const canonical = await realpath(target)
    const identity = targetInfo.ino === 0n ? null : `${targetInfo.dev}:${targetInfo.ino}`
    if (targets.has(canonical) || (identity && identities.has(identity))) {
      throw new Error(`Upgrade file paths alias one file: ${path}; left unchanged`)
    }
    if (!identity && targetInfo.nlink > 1n) throw new Error(`Upgrade file identity unavailable: ${path}; left unchanged`)
    targets.add(canonical)
    if (identity) identities.add(identity)
    entries.push({ path, target, mode: Number(targetInfo.mode & 0o777n), linked: info.isSymbolicLink() })
  }
  const root = join(searchBoostHome(), 'backups', `upgrade-${Date.now()}-${randomUUID()}`)
  await mkdir(root, { recursive: true, mode: 0o700 })
  await chmod(root, 0o700)
  for (const [index, entry] of entries.entries()) {
    if (entry.absent) continue
    entry.backup = join(root, String(index))
    await copyFile(entry.target, entry.backup)
    await chmod(entry.backup, 0o600)
  }
  const unchangedLink = async entry => {
    if (entry.linked && (!((await lstat(entry.path)).isSymbolicLink()) || await realpath(entry.path) !== entry.target)) {
      throw new Error('Upgrade configuration link changed; manual recovery required')
    }
  }
  await writeFile(join(root, 'manifest.json'), JSON.stringify(entries, null, 2), { mode: 0o600 })
  return {
    root,
    async preserveModes() {
      for (const entry of entries) {
        if (entry.absent) continue
        await unchangedLink(entry)
        try { await chmod(entry.target, entry.mode) } catch (err) { if (err.code !== 'ENOENT') throw err }
      }
    },
    async rollback() {
      for (const entry of entries) {
        if (entry.absent) { try { await unlink(entry.path) } catch (err) { if (err.code !== 'ENOENT') throw err } }
        else {
          await unchangedLink(entry)
          await mkdir(dirname(entry.target), { recursive: true })
          await copyFile(entry.backup, entry.target)
          await chmod(entry.target, entry.mode)
        }
      }
    },
  }
}
