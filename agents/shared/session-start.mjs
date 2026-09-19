#!/usr/bin/env node
// search-boost: startup-hook
// Claude Code / Codex SessionStart contract. Standalone after installation.
import { readFileSync } from 'node:fs'

let output = {}
try {
  const text = readFileSync(new URL('./search-boost-inject.md', import.meta.url), 'utf8').trim()
  if (text) {
    output = {
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text },
    }
  }
} catch { /* Missing policy must never prevent a session from starting. */ }
process.stdout.write(`${JSON.stringify(output)}\n`)
