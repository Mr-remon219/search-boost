#!/usr/bin/env node
import './isolate-tests.mjs'
// Real npm global + npm-exec (npx) installs of the packed artifact. Network is
// used only by npm to obtain declared dependencies. No real HOME/config writes.
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, existsSync, cpSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { runCommand } from '../lib/upgrade/process.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const temp = mkdtempSync(join(tmpdir(), 'sb dsh package '))
const home = join(temp, 'home')
const prefix = join(temp, 'npm global')
const cache = join(temp, 'npx cache')
mkdirSync(home, { recursive: true })
const env = { ...process.env, HOME: home, USERPROFILE: home, SEARCH_BOOST_HOME: join(home, '.search-boost'), DSH_HOME: join(home, '.dsh'),
  npm_config_cache: cache, npm_config_userconfig: join(temp, 'npmrc'), npm_config_prefix: prefix, npm_config_audit: 'false', npm_config_fund: 'false' }
for (const name of Object.keys(env)) {
  if (/^(SEARCH_BOOST_(KEYS|LAYER|XAUTH|XGUEST|JEV)_FILE|PI_SEARCH_|TYPESAFE_API_KEY|AI_GATEWAY_API_KEY|XAI_API_KEY|TAVILY_API_KEY|BRAVE_API_KEY|EXA_API_KEY|ANYSEARCH_API_KEY|DEEPSEEK_API_KEY)/i.test(name)) delete env[name]
}
async function run(command, args, cwd = temp) {
  const result = await runCommand(command, args, { cwd, env, timeoutMs: 240000 })
  assert.equal(result.code, 0, `${command} ${args[0]} failed: ${result.stderr}\n${result.stdout}`)
  return result.stdout
}
try {
  // Pack the declared payload in a clean cwd: npm must not read a developer's
  // project .npmrc (which can carry registry auth), even with an isolated HOME.
  const payload = join(temp, 'payload')
  mkdirSync(payload)
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  writeFileSync(join(payload, 'package.json'), JSON.stringify(manifest))
  for (const file of manifest.files) cpSync(join(root, file), join(payload, file), { recursive: true })
  const packed = JSON.parse(await run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', temp], payload))[0]
  for (const name of ['adapters/dsh/schema.js', 'adapters/dsh/index.js', 'adapters/dsh/cordis.patch.yml']) {
    assert(packed.files.some((entry) => entry.path === name), `missing tarball file ${name}`)
  }
  const tarball = join(temp, packed.filename)
  await run('npm', ['install', '--global', '--ignore-scripts', '--prefix', prefix, tarball])
  const modules = process.platform === 'win32' ? join(prefix, 'node_modules') : join(prefix, 'lib', 'node_modules')
  const installed = join(modules, 'search-boost')
  assert(existsSync(join(prefix, process.platform === 'win32' ? 'search-boost.cmd' : 'bin/search-boost')))
  assert.match(await run(process.execPath, [join(installed, 'cli.mjs'), 'print', 'dsh']), /search-boost/)
  await run(process.execPath, [join(root, 'scripts/test-dsh-schema.mjs'), join(installed, 'adapters/dsh/index.js')])
  console.log(`ok: npm global packed artifact loads all DSH tools (${process.platform})`)

  // Invoke the real npx-equivalent entry, not node on the repository checkout.
  assert.match(await run('npm', ['exec', '--yes', '--package', tarball, '--', 'search-boost', 'print', 'dsh']), /search-boost/)
  const npxRoot = join(cache, '_npx')
  const npxPackage = readdirSync(npxRoot).map((entry) => join(npxRoot, entry, 'node_modules', 'search-boost')).find((dir) => existsSync(join(dir, 'package.json')))
  assert(npxPackage, 'npm exec must materialize a real cached package')
  await run(process.execPath, [join(root, 'scripts/test-dsh-schema.mjs'), join(npxPackage, 'adapters/dsh/index.js')])
  // Published installs must give DSH a registry spec, never a cache path that
  // disappears after npx cleanup. The installer then persists it in the profile.
  for (const dir of [installed, npxPackage]) {
    const body = `const host = await import(${JSON.stringify(pathToFileURL(join(dir, 'lib/agents/host-runtime.mjs')).href)}); console.log(JSON.stringify(host.dshPluginArgs('add', 'web')))`
    const output = await run(process.execPath, ['--input-type=module', '-e', body])
    assert.deepEqual(JSON.parse(output), ['plugin', '--profile', 'web', 'add', `search-boost@${packed.version}`])
    assert.equal(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version, packed.version)
  }
  console.log(`ok: npx packed artifact loads all DSH tools; both install modes use durable profile specs (${process.platform})`)
} finally {
  rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}
