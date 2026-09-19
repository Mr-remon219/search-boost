/** Known search-boost package identities; local files require package metadata or legacy fingerprints. */
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
export const PACKAGE_NAME = 'search-boost'
export const LEGACY_PACKAGE_NAMES = ['search-boost-mcp', 'pi-search-boost', 'dsh-search-boost']
export const PI_PACKAGE_NAMES = [PACKAGE_NAME, 'search-boost-mcp', 'pi-search-boost']
export const DSH_PACKAGE_NAMES = [PACKAGE_NAME, 'search-boost-mcp', 'dsh-search-boost']
const PACKAGE = PACKAGE_NAME, LEGACY_PI = 'pi-search-boost'
const names = [PACKAGE_NAME, ...LEGACY_PACKAGE_NAMES]
const PI_SHIM_MARKER = 'search-boost pi extension shim'

export function packageIdentity(source, settingsDir) {
  if (typeof source !== 'string') return null
  for (const name of names) {
    if (new RegExp(`^(?:npm:)?${name}(?:@[^\\s]+)?$`).test(source)) return name
    if (new RegExp(`^(?:git:)?(?:https?://|git@|ssh://git@)?github\\.com[:/]Mr-remon219/${name === PACKAGE ? 'search-boost' : name}(?:\\.git)?(?:@[^\\s]+)?/?$`, 'i').test(source)) return name
  }
  if (/^(?:https?:|git:|npm:)/.test(source)) return null
  let path
  try { path = source.startsWith('file:') ? fileURLToPath(source) : resolve(settingsDir, source) } catch { return null }
  for (const root of [path, dirname(path)]) {
    try {
      const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
      if (names.includes(pkg.name)) return pkg.name
    } catch { /* inspect only known extension fingerprints next */ }
  }
  let text = null
  try { text = readFileSync(path, 'utf8') } catch { /* missing or not a file */ }
  if (text?.includes(PI_SHIM_MARKER)) return PACKAGE
  if (text?.includes('export default function searchBoostExtension') && text.includes('PI_SEARCH_TAVILY_KEY') && text.includes('<search_balance>')) return LEGACY_PI
  return null
}
