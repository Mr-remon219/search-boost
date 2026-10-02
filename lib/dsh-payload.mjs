/** Compare shipped payloads, not merely a version shared by unpublished builds. */
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

function stable(value) {
  if (Array.isArray(value)) return value.map(stable)
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]))
  return value
}

function digest(root, files) {
  const hash = createHash('sha256')
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  for (const key of ['name', 'version', 'type', 'main', 'bin', 'exports', 'dsh', 'dependencies', 'optionalDependencies', 'peerDependencies', 'peerDependenciesMeta']) {
    hash.update(`${key}\0${JSON.stringify(stable(pkg[key]))}\0`)
  }
  function visit(relative) {
    const file = join(root, relative)
    const info = lstatSync(file)
    if (info.isDirectory()) {
      for (const entry of readdirSync(file).sort()) visit(join(relative, entry))
    } else if (info.isFile()) {
      const data = readFileSync(file)
      hash.update(`${relative.replaceAll('\\', '/')}\0${data.length}\0`)
      hash.update(data)
    } else throw new Error('unsupported payload file type')
  }
  for (const file of files) visit(file)
  return hash.digest('hex')
}

export function verifyDshPayload(installed, source) {
  if (realpathSync(installed) === realpathSync(source)) return
  try {
    const pkg = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'))
    const files = pkg.files ?? ['cli.mjs', 'server.mjs', 'lib', 'adapters', 'agents', 'grok-plugin', 'templates'].filter(file => existsSync(join(source, file)))
    if (!Array.isArray(files) || !files.length || files.some(file => typeof file !== 'string' || isAbsolute(file)
      || /(?:^|[\\/])\.\.(?:[\\/]|$)|[*?\[\]\0]/.test(file))) throw new Error('unsupported payload file list')
    if (digest(installed, files) === digest(source, files)) return
  } catch { /* missing files/unsupported manifests are not proof of matching code */ }
  throw new Error('DSH installed payload differs from the running SearchBoost package, even if versions match; installation was not verified. Install from a durable current package path/tarball, or publish a new version.')
}
