#!/usr/bin/env node
/**
 * CI-only doctor smoke, portable across runners.
 *
 * `doctor --quick --json` must actually run; exit 2 means "ran and found
 * problems", which CI tolerates. Any other non-zero status is a failure.
 */
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const wired = readFileSync(join(root, 'lib', 'cli', 'commands.mjs'), 'utf8').includes('runDoctor')
if (!wired) {
  console.log('doctor is not wired into the CLI yet — smoke skipped')
  process.exit(0)
}

const res = spawnSync(process.execPath, [join(root, 'cli.mjs'), 'doctor', '--quick', '--json'], {
  encoding: 'utf8',
  windowsHide: true,
})
const output = `${res.stdout ?? ''}${res.stderr ?? ''}`.trim()
if (output) console.log(output)

if (res.status === 0 || res.status === 2) {
  console.log(`doctor --quick --json ok (exit ${res.status})`)
  process.exit(0)
}
console.error(`doctor --quick --json failed (exit ${res.status ?? `signal ${res.signal}`})`)
process.exit(res.status ?? 1)
