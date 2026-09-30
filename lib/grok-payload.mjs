/** Disk payload evidence is stronger than a Grok command's success/name/version. */
import { lstatSync, readFileSync, readdirSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

export function grokPluginPayloadMatches(plugin, source) {
  if (typeof plugin?.path !== 'string' || !isAbsolute(plugin.path)) return false
  try {
    if (JSON.parse(readFileSync(join(plugin.path, 'plugin.json'), 'utf8')).name !== 'search-boost') return false
    let entries = 0
    const walk = (dir, relative = '') => readdirSync(dir).filter(name => name !== '.git').flatMap(name => {
      if (++entries > 2048) throw new Error('oversized payload tree')
      const path = join(dir, name), rel = join(relative, name), stat = lstatSync(path)
      if (stat.isSymbolicLink()) throw new Error('unsupported payload alias')
      if (stat.isDirectory()) return walk(path, rel)
      if (!stat.isFile()) throw new Error('unsupported payload entry')
      return [rel]
    })
    const expected = walk(source)
    if (!expected.includes('plugin.json')) return false
    entries = 0
    const actual = walk(plugin.path)
    if (actual.length !== expected.length || actual.some(file => !expected.includes(file))) return false
    return expected.every(file => {
      const target = join(plugin.path, file)
      // Do not accept a cache symlink as file-content verification.
      const stat = lstatSync(target)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024 * 1024) return false
      return readFileSync(join(source, file)).equals(readFileSync(target))
    })
  } catch { return false }
}
