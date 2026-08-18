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

/** Plain-console markers that render on Windows cp936 terminals. */
export const OK = '[ok]'
export const FAIL = '[fail]'
export const ARROW = '->'
export const RULE = '-'.repeat(56)
export const RULE_WIDE = '-'.repeat(96)
