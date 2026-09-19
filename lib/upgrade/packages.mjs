/** Verify a replacement before handing configuration migration to its own code. */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { PACKAGE_NAME } from '../package-identity.mjs'
import { strictJson } from './config.mjs'

export async function verifyReplacement(root, version) {
  const pkg = await strictJson(join(root, 'package.json'))
  if (pkg.name !== PACKAGE_NAME || pkg.version !== version) throw new Error('Replacement package identity/version mismatch; legacy installation retained')
  for (const file of ['cli.mjs', 'adapters/pi/index.js', 'adapters/dsh/index.js', 'adapters/dsh/cordis.patch.yml']) {
    if (!existsSync(join(root, file))) throw new Error('Replacement package is missing a required adapter; legacy installation retained')
  }
}
