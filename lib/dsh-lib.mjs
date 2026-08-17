/**
 * Resolve imports from dsh-search-boost (read-only).
 * Order: SEARCH_BOOST_DSH_ROOT → sibling → node_modules/dsh-search-boost
 */
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function dshLibCandidates() {
  const roots = [
    process.env.SEARCH_BOOST_DSH_ROOT,
    join(PKG_ROOT, '..', 'dsh-search-boost'),
    join(PKG_ROOT, 'node_modules', 'dsh-search-boost'),
  ].filter(Boolean)
  return roots.filter((r) => existsSync(join(r, 'lib', 'engines.js')))
}

export function dshRepoRoot() {
  const hit = dshLibCandidates()[0]
  if (hit) return resolve(hit)
  throw new Error(
    'dsh-search-boost lib not found.\n' +
      '  • npm (future): install package `dsh-search-boost` as dependency\n' +
      '  • dev: clone dsh-search-boost next to search-boost-mcp\n' +
      '  • or set SEARCH_BOOST_DSH_ROOT=/path/to/dsh-search-boost',
  )
}

export function dshLib(subpath) {
  return join(dshRepoRoot(), 'lib', subpath)
}

/** @param {string} subpath */
export async function importDsh(subpath) {
  return import(pathToFileURL(dshLib(subpath)).href)
}

export { PKG_ROOT }
