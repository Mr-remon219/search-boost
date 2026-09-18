#!/usr/bin/env node
/**
 * Antigravity PreInvocation hook — soft reminder to search before external edits.
 * stdin: JSON { invocationNum, initialNumSteps, ... }
 * stdout: JSON { injectSteps: [{ ephemeralMessage: "..." }] }
 */
import { readFileSync } from 'node:fs'

const REMINDER =
  'External API/SDK/cloud change? Search first via MCP search-boost (fused_search) — prefer over search_web. Max ~3 rounds.'

let input = ''
try {
  input = readFileSync(0, 'utf8')
} catch {
  input = ''
}

/** Only remind on early invocations to limit token noise. */
let invocationNum = 0
try {
  if (input.trim()) {
    const parsed = JSON.parse(input)
    invocationNum = typeof parsed.invocationNum === 'number' ? parsed.invocationNum : 0
  }
} catch {
  invocationNum = 0
}

if (invocationNum > 2) {
  process.stdout.write(JSON.stringify({ injectSteps: [] }))
} else {
  process.stdout.write(JSON.stringify({ injectSteps: [{ ephemeralMessage: REMINDER }] }))
}
