#!/usr/bin/env node
/**
 * Cursor sessionStart hook — inject optional search-boost capability summary.
 * Reads search-boost-inject.md from the same directory as this script.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const INJECT_FILE = 'search-boost-inject.md'

function failOpen() {
  process.stdout.write(JSON.stringify({ continue: true }) + '\n')
  process.exit(0)
}

try {
  const dir = dirname(fileURLToPath(import.meta.url))
  const text = readFileSync(join(dir, INJECT_FILE), 'utf8').trim()
  if (!text) failOpen()
  process.stdout.write(JSON.stringify({
    additional_context: text,
    continue: true,
  }) + '\n')
} catch {
  failOpen()
}
