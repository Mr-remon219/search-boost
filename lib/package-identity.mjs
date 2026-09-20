/** Version-independent package identity shared by discovery, upgrade and uninstall.
 * Local paths stop at their nearest package boundary; names in a filename alone
 * are never ownership evidence. Exact managed paths can survive a retired root.
 */
import { existsSync, readFileSync, statSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { recordedPackageSource } from './package-sources.mjs'
export const PACKAGE_NAME = 'search-boost'
export const LEGACY_PACKAGE_NAMES = ['search-boost-mcp', 'pi-search-boost', 'dsh-search-boost']
export const PI_PACKAGE_NAMES = [PACKAGE_NAME, 'search-boost-mcp', 'pi-search-boost']
export const DSH_PACKAGE_NAMES = [PACKAGE_NAME, 'search-boost-mcp', 'dsh-search-boost']
const names = [PACKAGE_NAME, ...LEGACY_PACKAGE_NAMES]
const PI_SHIM_MARKER = 'search-boost pi extension shim'

/** Pi exact include/exclude prefixes must survive source replacement. */
export function splitSourceModifier(source) {
  if (typeof source !== 'string') return { modifier: '', source }
  return /^[+!-]/.test(source) ? { modifier: source[0], source: source.slice(1) } : { modifier: '', source }
}

export function localPackagePath(source, settingsDir) {
  if (typeof source !== 'string') return null
  try {
    if (source.startsWith('file:')) return fileURLToPath(source)
    if (/^[a-z][a-z\d+.-]*:/i.test(source) && !/^[a-z]:[\\/]/i.test(source)) return null
    return resolve(settingsDir, source.replace(/^~(?=$|[\\/])/, homedir()))
  } catch { return null }
}

function metadata(root, sourcePath) {
  const file = join(root, 'package.json')
  if (!existsSync(file)) return undefined
  try {
    const pkg = JSON.parse(readFileSync(file, 'utf8'))
    if (!names.includes(pkg.name)) return null
    if (sourcePath && sourcePath !== root) {
      const entries = Array.isArray(pkg.pi?.extensions) ? pkg.pi.extensions : []
      const declared = entries.some((entry) => typeof entry === 'string' && !/[*!?\[]/.test(entry)
        && (resolve(root, entry) === sourcePath || (existsSync(resolve(root, entry)) && statSync(resolve(root, entry)).isDirectory() && sourcePath.startsWith(resolve(root, entry) + sep))))
      const legacyEntry = pkg.name !== PACKAGE_NAME && ['index.js', 'index.ts'].some((entry) => join(root, entry) === sourcePath)
      if (!declared && !legacyEntry) return null
    }
    return { name: pkg.name, root, version: pkg.version }
  } catch { return null } // malformed/foreign packages are a boundary, not ours
}

/** Return the installed root/version as well as identity when evidence exists. */
export function inspectPackageSource(value, settingsDir, seen = new Set()) {
  const { source } = splitSourceModifier(value)
  if (typeof source !== 'string' || !source || seen.has(source)) return null
  seen.add(source)
  for (const name of names) {
    if (new RegExp(`^(?:npm:)?${name}(?:@[^\\s]+)?$`).test(source)) {
      const root = join(settingsDir, 'npm', 'node_modules', name)
      return metadata(root) ?? { name, root }
    }
    const git = new RegExp(`^(?:git:)?(?:https?://|git@|ssh://git@|git://)?github\\.com[:/](Mr-remon219)/(${name})(?:\\.git)?(?:@[^\\s]+)?/?$`, 'i').exec(source)
    if (git) {
      const root = join(settingsDir, 'git', 'github.com', git[1], git[2])
      return metadata(root) ?? { name, root }
    }
  }
  if (/^(?:https?:|git:|npm:)/.test(source)) return null
  const path = localPackagePath(source, settingsDir)
  if (!path) return null
  if (!existsSync(path)) {
    const recorded = recordedPackageSource(path, settingsDir)
    if (recorded) {
      if (!existsSync(recorded.root)) return recorded
      const installed = metadata(recorded.root)
      if (installed?.name === recorded.name) return { ...recorded, ...installed }
    }
  }
  let text
  try { if (statSync(path).isFile()) text = readFileSync(path, 'utf8') } catch { /* absent path can have a managed receipt */ }
  if (text?.includes(PI_SHIM_MARKER)) {
    const imported = /^export\s*\{\s*default\s*\}\s*from\s*['"]([^'"]+)['"]/m.exec(text)?.[1]
    const linked = imported && inspectPackageSource(imported, dirname(path), seen)
    return linked?.name === PACKAGE_NAME ? linked : recordedPackageSource(path, settingsDir) ?? { name: PACKAGE_NAME }
  }
  // Standalone legacy copies shipped without a package.json.
  if (text?.includes('export default function searchBoostExtension') && text.includes('PI_SEARCH_TAVILY_KEY') && text.includes('<search_balance>')) return { name: 'pi-search-boost', root: dirname(path) }
  const physical = existsSync(path) ? realpathSync(path) : path
  for (let root = physical; ; root = dirname(root)) {
    const found = metadata(root, physical)
    if (found !== undefined) return found
    if (dirname(root) === root) break
  }
  // A receipt cannot claim an existing foreign file/directory reused by a user.
  return existsSync(path) ? null : recordedPackageSource(path, settingsDir)
}

export function packageIdentity(source, settingsDir) {
  return inspectPackageSource(source, settingsDir)?.name ?? null
}
