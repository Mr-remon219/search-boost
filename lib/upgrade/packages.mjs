/** Verify a replacement before handing configuration migration to its own code. */
import { existsSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { PACKAGE_NAME } from '../package-identity.mjs'
import { strictJson } from './config.mjs'
import { compareVersions } from './process.mjs'

export async function verifyReplacement(root, version, { linkedTo } = {}) {
  compareVersions(version, version)
  const pkg = await strictJson(join(root, 'package.json'))
  if (linkedTo && realpathSync(root) !== realpathSync(linkedTo)) throw new Error('Host package still resolves to a different installation; refusing to report an upgrade')
  if (pkg.name !== PACKAGE_NAME || pkg.version !== version) throw new Error('Replacement package identity/version mismatch; legacy installation retained')
  for (const file of ['cli.mjs', 'adapters/pi/index.js', 'adapters/dsh/index.js', 'adapters/dsh/cordis.patch.yml']) {
    if (!existsSync(join(root, file))) throw new Error('Replacement package is missing a required adapter; legacy installation retained')
  }
}
