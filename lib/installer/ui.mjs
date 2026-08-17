import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, sep } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const PKG_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..')

export function getVersion() {
  try {
    const pkg = JSON.parse(readFileSync(join(PKG_ROOT, 'package.json'), 'utf8'))
    return pkg.version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
}

/** @param {string} p */
export function tildify(p) {
  const home = homedir()
  if (p.startsWith(home + sep)) return `~${p.slice(home.length)}`
  return p
}

export async function loadClack() {
  return import('@clack/prompts')
}

/** @param {unknown} value @param {import('@clack/prompts').ClackPrompter} clack */
export function handleCancel(value, clack) {
  if (clack.isCancel(value)) {
    clack.cancel('Cancelled.')
    process.exit(0)
  }
}
