#!/usr/bin/env node
// Run the installer-helper suite with deliberately inherited user state. The
// suite's early isolation import must keep all receipts/config writes elsewhere.
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const temp = mkdtempSync(join(tmpdir(), 'sb install isolation sentinel '))
const home = join(temp, 'user'), relocated = join(temp, 'relocated')
const write = (file, data) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, JSON.stringify(data)) }
const snapshot = (root) => Object.fromEntries(readdirSync(root, { withFileTypes: true }).flatMap(entry => {
  const file = join(root, entry.name)
  return entry.isDirectory() ? Object.entries(snapshot(file)) : [[file, readFileSync(file, 'hex')]]
}))
try {
  const env = { ...process.env, HOME: home, USERPROFILE: home, SEARCH_BOOST_HOME: relocated, PI_CODING_AGENT_DIR: join(home, 'custom-pi'), DSH_HOME: join(home, 'custom-dsh') }
  for (const root of [join(home, '.search-boost'), relocated]) {
    write(join(root, 'state/upgrade-projects.json'), { projects: [join(home, 'real-project')] })
  }
  for (const [kind, data] of Object.entries({ KEYS: {}, LAYER: { layer: 'free' }, XAUTH: {}, XGUEST: {}, JEV: {}, WORKSPACES: { workspaces: [join(home, 'real-project')] } })) {
    const file = join(relocated, `${kind.toLowerCase()}.json`)
    write(file, data)
    env[`SEARCH_BOOST_${kind}_FILE`] = file
  }
  write(join(env.PI_CODING_AGENT_DIR, 'settings.json'), { packages: ['npm:user-owned'] })
  write(join(env.DSH_HOME, 'profiles/web/package.json'), { dependencies: { 'user-owned': '1.0.0' } })
  const before = snapshot(temp)
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('./test-install.mjs', import.meta.url))], { env, encoding: 'utf8', timeout: 120_000, maxBuffer: 8 * 1024 * 1024 })
  if (result.stdout) process.stdout.write(result.stdout)
  if (result.stderr) process.stderr.write(result.stderr)
  assert.deepEqual(snapshot(temp), before, 'installer tests must not alter inherited HOME, relocated state, or host configuration')
  assert.equal(result.status, 0, result.error?.message ?? 'installer suite failed')
  console.log('ok: installer-helper suite leaves inherited user HOME and relocated upgrade receipts untouched')
} finally {
  rmSync(temp, { recursive: true, force: true })
}
