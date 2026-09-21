/** Group intersecting write/backup sets before starting any transaction. */
import { realpathSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

/** Resolve aliases even when the file (or some parent directories) is absent. */
export function fileResource(file) {
  let path = resolve(file)
  const missing = []
  for (;;) {
    try {
      path = join(realpathSync(path), ...missing)
      break
    } catch (err) {
      if (err.code !== 'ENOENT' || dirname(path) === path) throw err
      missing.unshift(basename(path))
      path = dirname(path)
    }
  }
  return `file:${process.platform === 'win32' ? path.toLowerCase() : path}`
}

/** Connected components, not just equal primary paths: A∩B and B∩C also
 * serialize A/B/C. Preserve discovery order within each component. */
export function groupUpgradeJobs(jobs) {
  const parents = jobs.map((_, i) => i)
  const owners = new Map()
  function root(i) {
    while (parents[i] !== i) { parents[i] = parents[parents[i]]; i = parents[i] }
    return i
  }
  jobs.forEach((job, i) => {
    for (const resource of job.resources) {
      if (owners.has(resource)) parents[root(i)] = root(owners.get(resource))
      else owners.set(resource, i)
    }
  })
  const groups = new Map()
  jobs.forEach((job, index) => {
    const key = root(index)
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push({ ...job, index })
  })
  return [...groups.values()]
}
