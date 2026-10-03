#!/usr/bin/env node
// search-boost: startup-hook
// Claude Code / Codex SessionStart transport. Standalone after installation.
// Delivers the adjacent authored policy only; no probing, search or authorization.
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
