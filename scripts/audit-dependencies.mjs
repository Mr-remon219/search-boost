#!/usr/bin/env node
import './isolate-tests.mjs'
// Audit the exact lock in an owned workspace, without caller npmrc/tokens or
// lifecycle scripts. A registry failure is a failed check, not "zero findings".
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { testRoot } from './isolate-tests.mjs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
const workspace = join(testRoot, 'dependency-audit')
mkdirSync(workspace)
for (const file of ['package.json', 'package-lock.json']) {
  writeFileSync(join(workspace, file), readFileSync(fileURLToPath(new URL(`../${file}`, import.meta.url))))
}
const result = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm',
  ['audit', '--audit-level=moderate', '--ignore-scripts'],
  { cwd: workspace, encoding: 'utf8', env: process.env, timeout: 120_000, shell: process.platform === 'win32' })
process.stdout.write(result.stdout ?? '')
process.stderr.write(result.stderr ?? '')
if (result.error) { console.error(result.error.message); process.exitCode = 1 }
else process.exitCode = result.status ?? 1
