#!/usr/bin/env node
// search-boost: startup-hook
/** Antigravity PreInvocation hook — inject only before the first model call. */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// A workspace copy defers to our enabled global hook, avoiding duplicate reminders.
function globalHookActive() {
  const dir = join(homedir(), '.gemini', 'config')
  const script = join(dir, 'hooks', 'search-boost-pre-invocation.mjs')
  if (resolve(fileURLToPath(import.meta.url)) === resolve(script)) return false
  try {
    const entry = JSON.parse(readFileSync(join(dir, 'hooks.json'), 'utf8'))['search-boost-reminder']
    return entry?.enabled !== false && existsSync(script)
      && readFileSync(join(dir, 'hooks', 'search-boost-inject.md'), 'utf8').trim().length > 0
      && entry?.PreInvocation?.some((h) => h.type === 'command'
        && h.command?.includes(`"${script.replace(/\\/g, '/')}"`))
  } catch { return false }
}

let injectSteps = []
try {
  const input = JSON.parse(readFileSync(0, 'utf8'))
  if (input?.invocationNum === 0 && !globalHookActive()) {
    const text = readFileSync(new URL('./search-boost-inject.md', import.meta.url), 'utf8').trim()
    if (text) injectSteps = [{ ephemeralMessage: text }]
  }
} catch { /* Invalid input or missing policy: do not interrupt the agent. */ }
process.stdout.write(`${JSON.stringify({ injectSteps })}\n`)
