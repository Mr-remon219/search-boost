/** Owned upgrade receipts/project discovery. Never store credentials in receipts. */
import { mkdir, readFile, writeFile, copyFile, lstat, unlink, chmod } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { searchBoostHome } from '../config-paths.mjs'
import { strictJson } from './config.mjs'

const projectsPath = () => join(searchBoostHome(), 'state', 'upgrade-projects.json')
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
export async function backupFiles(files) {
  const root = join(searchBoostHome(), 'backups', `upgrade-${Date.now()}-${randomUUID()}`)
  await mkdir(root, { recursive: true, mode: 0o700 })
  await chmod(root, 0o700)
  const entries = []
  for (const path of [...new Set(files)]) {
    try {
      const info = await lstat(path)
      if (!info.isFile()) throw new Error(`Not a regular upgrade file: ${path}`)
      const backup = join(root, String(entries.length))
      await copyFile(path, backup)
      await chmod(backup, 0o600)
      entries.push({ path, backup, mode: info.mode & 0o777 })
    } catch (err) {
      if (err.code !== 'ENOENT') throw err
      entries.push({ path, absent: true })
    }
  }
  await writeFile(join(root, 'manifest.json'), JSON.stringify(entries, null, 2), { mode: 0o600 })
  return {
    root,
    async rollback() {
      for (const entry of entries) {
        if (entry.absent) { try { await unlink(entry.path) } catch (err) { if (err.code !== 'ENOENT') throw err } }
        else { await mkdir(dirname(entry.path), { recursive: true }); await copyFile(entry.backup, entry.path); await chmod(entry.path, entry.mode) }
      }
    },
  }
}
