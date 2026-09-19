#!/usr/bin/env node
/** Build the old npm-name transition release without changing the new package's manifest. */
import { cp, mkdir, readFile, writeFile, access } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { PKG_ROOT } from '../lib/pkg.mjs'
import { compareVersions } from '../lib/upgrade/process.mjs'

export async function buildLegacyRelease({ version, outDir }) {
  if (!version) throw new Error('Specify an unpublished legacy version with --version (e.g. --version 0.1.8)')
  compareVersions(version, version)
  const out = resolve(outDir ?? join(PKG_ROOT, 'dist', `search-boost-mcp-${version}`))
  try { await access(out); throw new Error(`Output already exists; refusing to overwrite: ${out}`) }
  catch (err) { if (err.code !== 'ENOENT') throw err }
  const pkg = JSON.parse(await readFile(join(PKG_ROOT, 'package.json'), 'utf8'))
  if (pkg.name !== 'search-boost') throw new Error('Build the legacy release from the new search-boost source tree')
  await mkdir(out, { recursive: true })
  for (const path of pkg.files) await cp(join(PKG_ROOT, path), join(out, path), { recursive: true })
  pkg.name = 'search-boost-mcp'
  pkg.version = version
  pkg.description = 'Legacy npm-name transition release. CLI: search-boost-mcp; the new search-boost package exclusively owns the search-boost command.'
  pkg.bin = { 'search-boost-mcp': './cli.mjs' }
  delete pkg.scripts // Release directory contains shipped files, not repository test/build scripts.
  await writeFile(join(out, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`)
  // Keep native adapter imports and portable plugins referring to THIS legacy
  // package. The explicit upgrade command still targets the new search-boost.
  const patch = join(out, 'adapters', 'dsh', 'cordis.patch.yml')
  await writeFile(patch, (await readFile(patch, 'utf8')).replace('name: search-boost/dsh', 'name: search-boost-mcp/dsh'))
  for (const file of ['grok-plugin/.mcp.json', 'agents/antigravity/plugin/mcp_config.json']) {
    const path = join(out, file)
    const config = JSON.parse(await readFile(path, 'utf8'))
    config.mcpServers['search-boost'].args = ['-y', 'search-boost-mcp', 'serve']
    await writeFile(path, `${JSON.stringify(config, null, 2)}\n`)
  }
  const notice = '# search-boost-mcp — transition release\n\nThis legacy npm package now exposes **only `search-boost-mcp`**, not `search-boost`. The new `search-boost` npm package owns the `search-boost` command. Both packages can coexist without a shared global bin.\n\nUpdate the old package first, then install the new one:\n\n```sh\nnpm install -g search-boost-mcp@latest\nnpm install -g search-boost@latest\nsearch-boost\n```\n\nAlternatively run `search-boost-mcp upgrade` to explicitly install the new package and migrate existing integrations. No forwarding plugin, postinstall migration, global legacy-package removal, or `--force` is used. Existing credentials/configuration are not deleted. Restart affected hosts after migration.\n\n'
  for (const file of ['README.md', 'README_zh.md']) {
    const path = join(out, file)
    await writeFile(path, notice + await readFile(path, 'utf8'))
  }
  return out
}

async function main(args) {
  const options = {}
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--version' && args[i + 1]) options.version = args[++i]
    else if (args[i] === '--out' && args[i + 1]) options.outDir = args[++i]
    else throw new Error('Usage: node scripts/build-legacy-release.mjs --version VERSION [--out DIRECTORY]')
  }
  console.log(await buildLegacyRelease(options))
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((err) => { console.error(err.message); process.exitCode = 1 })
}
