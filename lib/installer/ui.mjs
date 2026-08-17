import { homedir } from 'node:os'
import { sep } from 'node:path'
import { getVersion } from '../pkg.mjs'

export { getVersion }

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
