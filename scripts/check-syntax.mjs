#!/usr/bin/env node
/**
 * Syntax-check shipped source — .mjs tree-wide plus vendored lib/search/*.js.
 */
import { execFileSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SKIP_DIRS = new Set(['node_modules', '.git', '.codegraph', '.agent-html'])

/** @param {string} dir @returns {string[]} */
function collect(dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      out.push(...collect(join(dir, entry.name)))
    } else if (entry.name.endsWith('.mjs')) {
      out.push(join(dir, entry.name))
    } else if (entry.name.endsWith('.js') && relative(ROOT, dir).replace(/\\/g, '/') === 'lib/search') {
      out.push(join(dir, entry.name))
    }
  }
  return out
}

const files = collect(ROOT).sort()
let failed = 0

for (const file of files) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: ['ignore', 'ignore', 'pipe'] })
  } catch (err) {
    failed++
    console.error(`FAIL ${relative(ROOT, file)}`)
    const stderr = err instanceof Error && 'stderr' in err ? String(err.stderr) : ''
    if (stderr) console.error(stderr.trim())
  }
}

if (failed) {
  console.error(`\n${failed} of ${files.length} file(s) failed syntax check`)
  process.exit(1)
}
console.log(`Syntax OK — ${files.length} files`)
