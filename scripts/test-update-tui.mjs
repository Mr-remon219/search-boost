#!/usr/bin/env node
import './isolate-tests.mjs'
/** Exercise grouped Clack menus with an injected Update operation. */
import assert from 'node:assert/strict'
import { runTui } from '../lib/installer/tui.mjs'
import { saveTuiLanguage } from '../lib/installer/i18n.mjs'

saveTuiLanguage('en')
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
  assert.deepEqual(menus[0].options.map((o) => o.value), ['integration', 'search-tools', 'credentials', 'maintenance', 'settings', 'exit'])
  const options = menus[1].options
  assert.equal(options.find((o) => o.value === 'upgrade').label, 'Update')
  assert.match(options.find((o) => o.value === 'upgrade').hint, /all installed agents/)
  assert.ok(!options.some((o) => o.value === 'migrate'), 'one-time npm rename is not a TUI update action')
  assert.ok(menus.every((menu) => menu.options.every((o) => !/[\u4e00-\u9fff]/.test(o.label))), 'English keeps the existing Clack style')
  assert.equal(actions.length, 0)
  return { menus, logs, exitCode: process.exitCode }
}
try {
  let out = await scenario({ ok: true, reloaded: false }, ['maintenance', 'upgrade', 'back', 'exit'])
  assert.equal(out.menus.length, 4)
  assert.equal(out.menus[2].message, 'Update & status', 'completed actions stay in the submenu')
  assert.ok(!out.exitCode)
  assert.ok(out.logs.some((line) => line.includes('pi-search-boost') && line.includes('dsh-search-boost')))
  out = await scenario({ ok: true, reloaded: true }, ['maintenance', 'upgrade'])
  assert.equal(out.menus.length, 2)
  out = await scenario({ ok: false, reloaded: false }, ['maintenance', 'upgrade', 'back', 'exit'])
  assert.equal(out.exitCode, 1)
  out = await scenario(new Error('fixture update failure'), ['maintenance', 'upgrade'])
  assert.equal(out.exitCode, 1)
  assert.ok(out.logs.includes('error: fixture update failure'))
  console.log('ok: grouped TUI Update refreshes all agents, returns to its submenu and stops after replacement/failure')
} finally { process.exitCode = savedExit }
