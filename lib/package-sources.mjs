/** Durable ownership evidence for local host registrations, not an install list.
 * Only exact managed paths or verified retired global-package entries are recorded. Discovery still requires
 * a live host registration; receipts alone never reinstall an uninstalled host.
 */
import { readFileSync, mkdirSync, writeFileSync, renameSync, rmSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { searchBoostHome } from './config-paths.mjs'

export const packageSourcesPath = () => join(searchBoostHome(), 'state', 'package-sources.json')

function validEntry(entry, name) {
  return entry?.name === name && typeof entry.version === 'string'
    && typeof entry.root === 'string' && isAbsolute(entry.root)
    && Array.isArray(entry.sources) && entry.sources.every((source) => typeof source === 'string' && isAbsolute(source))
}

function readSources() {
  let raw
  try { raw = readFileSync(packageSourcesPath(), 'utf8') } catch (err) {
    if (err.code === 'ENOENT') return { schema: 1, scopes: {} }
    throw err
  }
  let data
  try { data = JSON.parse(raw) } catch { throw new Error('Invalid managed package-source receipt; repair it before upgrading') }
  if (data?.schema !== 1 || !data.scopes || typeof data.scopes !== 'object' || Array.isArray(data.scopes)
    || Object.entries(data.scopes).some(([scope, entry]) => !isAbsolute(scope) || !validEntry(entry, 'search-boost'))
    || (data.retired !== undefined && (!Array.isArray(data.retired) || data.retired.some((entry) => !validEntry(entry, 'search-boost-mcp'))))) {
    throw new Error('Unsupported managed package-source receipt; refusing to guess ownership')
  }
  return data
}

export function recordedPackageSource(path, settingsDir) {
  const data = readSources(), source = resolve(path)
  const scoped = data.scopes[resolve(settingsDir)]
  const entry = scoped?.sources.includes(source) ? scoped : data.retired?.find((item) => item.sources.includes(source))
  return entry ? { name: entry.name, root: entry.root, version: entry.version, recorded: true } : null
}

/** Record the identity of a VERIFIED global legacy package before npm removes
 * it. No host configuration is changed. Exact roots/declared entries remain
 * recognizable when the user later selects TUI Update, in any project scope.
 */
export function recordRetiredPackage(root, version, sources) {
  const data = readSources()
  const entry = { name: 'search-boost-mcp', root: resolve(root), version, sources: [...new Set([root, ...sources].map((p) => resolve(p)))] }
  data.retired = [...(data.retired ?? []).filter((item) => item.root !== entry.root), entry]
  writeSources(data)
}

/** Called only after validating the replacement, inside the registration transaction. */
export function recordPackageSources(settingsDir, sources, { root, version }) {
  const data = readSources()
  data.scopes[resolve(settingsDir)] = { name: 'search-boost', root: resolve(root), version, sources: [...new Set(sources.map((p) => resolve(p)))] }
  writeSources(data)
}

function writeSources(data) {
  const file = packageSourcesPath()
  mkdirSync(dirname(file), { recursive: true })
  const temp = `${file}.${randomUUID()}.tmp`
  try {
    writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 })
    renameSync(temp, file)
  } finally { rmSync(temp, { force: true }) }
}
