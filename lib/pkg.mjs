import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

export function getVersion() {
  try {
    return JSON.parse(readFileSync(join(PKG_ROOT, 'package.json'), 'utf8')).version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
}
