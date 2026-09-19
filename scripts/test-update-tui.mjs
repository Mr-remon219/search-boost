#!/usr/bin/env node
/** Exercise the existing Clack menu with an injected Update operation. */
import assert from 'node:assert/strict'
import { runTui } from '../lib/installer/tui.mjs'

const savedExit = process.exitCode
async function scenario(result, actions) {
  const logs = [], menus = [], updates = []
  const clack = {
    intro: (text) => logs.push(text), outro: (text) => logs.push(text), isCancel: () => false,
    select: async (menu) => { menus.push(menu); assert.ok(actions.length, 'must not continue stale TUI after replacement'); return actions.shift() },
    log: Object.fromEntries(['info', 'error', 'warn'].map((kind) => [kind, (text) => logs.push(`${kind}: ${text}`)])),
  }
  process.exitCode = undefined
  await runTui({ workspace: '/fixture/project', dryRun: true }, { clack, update: async (opts) => {
    updates.push(opts)
    if (result instanceof Error) throw result
    opts.log('Refreshed existing MCP, pi-search-boost and dsh-search-boost integrations')
    return result
  } })
  assert.equal(updates.length, 1)
  assert.equal(updates[0].workspace, '/fixture/project')
  assert.equal(updates[0].dryRun, true)
  assert.ok(!('target' in updates[0]), 'Update does not restrict to one selected agent')
  const options = menus[0].options
  assert.equal(options.find((o) => o.value === 'upgrade').label, 'Update')
  assert.match(options.find((o) => o.value === 'upgrade').hint, /all installed agents/)
  assert.ok(!options.some((o) => o.value === 'migrate'), 'one-time npm rename is not a TUI update action')
  assert.ok(options.every((o) => !/[\u4e00-\u9fff]/.test(o.label)), 'keep the existing English Clack style')
  for (const value of ['setup', 'install', 'uninstall', 'keys', 'layer', 'x', 'search', 'status', 'print', 'exit']) assert.ok(options.some((o) => o.value === value))
  return { menus, logs, exitCode: process.exitCode }
}
try {
  let out = await scenario({ ok: true, reloaded: false }, ['upgrade', 'exit'])
  assert.equal(out.menus.length, 2)
  assert.ok(!out.exitCode)
  assert.ok(out.logs.some((line) => line.includes('pi-search-boost') && line.includes('dsh-search-boost')))
  out = await scenario({ ok: true, reloaded: true }, ['upgrade'])
  assert.equal(out.menus.length, 1)
  out = await scenario({ ok: false, reloaded: false }, ['upgrade', 'exit'])
  assert.equal(out.exitCode, 1)
  out = await scenario(new Error('fixture update failure'), ['upgrade'])
  assert.equal(out.exitCode, 1)
  assert.ok(out.logs.includes('error: fixture update failure'))
  console.log('ok: TUI Update retains the existing style, updates all installed agents including legacy Pi/DSH, and stops after replacement/failure')
} finally { process.exitCode = savedExit }
