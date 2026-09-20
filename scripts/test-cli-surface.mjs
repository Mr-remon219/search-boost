// CLI surface: the entry point must survive the paths a user meets first.
//
// `node --check` only validates syntax, and no suite ever printed help, so a
// missing import (getPackageName in lib/cli/args.mjs) shipped in v0.2.0 and made
// `--help`, `help` and every unknown command fail with "is not defined".
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const cli = join(root, 'cli.mjs')
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version

let count = 0
const test = (name, fn) => { fn(); count++; console.log(`ok: ${name}`) }
const CRASH = /is not defined|is not a function|Cannot read properties of undefined/

/** @param {string[]} args @returns {{ code: number, out: string }} */
function runCli(args) {
  try {
    const stdout = execFileSync(process.execPath, [cli, ...args], {
      encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { code: 0, out: stdout }
  } catch (err) {
    return { code: err.status ?? 1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` }
  }
}

for (const args of [['--help'], ['help']]) {
  test(`cli ${args[0]} prints usage and exits 0`, () => {
    const { code, out } = runCli(args)
    assert.equal(code, 0, `exit ${code}:\n${out.slice(0, 400)}`)
    assert.match(out, /Usage:/)
    assert.doesNotMatch(out, CRASH)
  })
}

test('cli with no arguments starts without crashing', () => {
  const { code, out } = runCli([])
  assert.equal(code, 0, `exit ${code}:\n${out.slice(0, 400)}`)
  assert.doesNotMatch(out, CRASH)
})

test('unknown command reports usage instead of crashing', () => {
  const { code, out } = runCli(['definitely-not-a-command'])
  assert.notEqual(code, 0, 'an unknown command must not report success')
  assert.match(out, /Usage:/)
  assert.doesNotMatch(out, CRASH)
})

test('--version prints the package version', () => {
  const { code, out } = runCli(['--version'])
  assert.equal(code, 0, `exit ${code}:\n${out.slice(0, 400)}`)
  assert.equal(out.trim(), version)
})

console.log(`\n${count} CLI surface tests passed.`)
