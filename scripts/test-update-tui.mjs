#!/usr/bin/env node
import './isolate-tests.mjs'
/** Exercise the flat home Update entry: scope preview, explicit start/back, and replacement/failure exit. */
import assert from 'node:assert/strict'
import { runTui } from '../lib/installer/tui.mjs'
import { saveTuiLanguage } from '../lib/installer/i18n.mjs'

saveTuiLanguage('en')
const savedExit = process.exitCode
const FLAT_VALUES = ['setup', 'install', 'upgrade', 'status', 'keys', 'layer', 'tools', 'x', 'jev', 'search', 'print', 'uninstall', 'settings', 'exit']
async function scenario(result, actions) {
  const logs = [], menus = [], updates = []
  const clack = {
    intro: (text) => logs.push(text), outro: (text) => logs.push(text), isCancel: () => false,
    note: (text, title) => logs.push(`${title}\n${text}`),
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
  assert.deepEqual(menus[0].options.map((o) => o.value), FLAT_VALUES, 'Update is reached from the flat home')
  const entry = menus[0].options.find((o) => o.value === 'upgrade')
  assert.equal(entry.label, 'Update SearchBoost')
  assert.match(entry.hint, /all installed agents/)
  assert.ok(!menus.some((menu) => menu.options.some((o) => o.value === 'migrate')), 'one-time npm rename is not a TUI update action')
  assert.ok(menus.every((menu) => menu.options.every((o) => !/[\u4e00-\u9fff]/.test(o.label))), 'English keeps the existing Clack style')
  assert.equal(actions.length, 0)
  return { menus, logs, updates, exitCode: process.exitCode }
}
try {
  // Selecting Update shows the scope first; Back leaves the machine untouched.
  let out = await scenario({ ok: true, reloaded: false }, ['upgrade', 'back', 'exit'])
  assert.equal(out.updates.length, 0, 'backing out of the preview never runs the update')
  assert.equal(out.menus[1].message, 'Start the update now?')
  assert.deepEqual(out.menus[1].options.map((o) => o.value), ['start', 'back'])
  const preview = out.logs.join('\n')
  assert.match(preview, /Update scope/)
  assert.match(preview, /Current package: v/)
  assert.match(preview, /every installed agent integration/)
  assert.match(preview, /Preserved: user configuration, credentials and permission choices\./)
  assert.match(preview, /must be restarted/)
  assert.match(preview, /Update cancelled; nothing was changed/)
  assert.equal(out.menus[2].message, 'What do you want to do?')
  assert.equal(out.menus[2].initialValue, 'upgrade', 'the flat home returns with Update selected')
  assert.ok(!out.exitCode)

  // An explicit start runs the real update once, with the caller's workspace and dry-run.
  out = await scenario({ ok: true, reloaded: false }, ['upgrade', 'start', 'exit'])
  assert.equal(out.updates.length, 1)
  assert.equal(out.updates[0].workspace, '/fixture/project')
  assert.equal(out.updates[0].dryRun, true)
  assert.ok(!('target' in out.updates[0]), 'Update does not restrict to one selected agent')
  assert.ok(out.logs.some((line) => line.includes('pi-search-boost') && line.includes('dsh-search-boost')))
  assert.equal(out.menus.length, 3, 'a completed update returns to the flat home')

  out = await scenario({ ok: true, reloaded: true }, ['upgrade', 'start'])
  assert.equal(out.menus.length, 2, 'a replaced package ends the stale TUI')

  out = await scenario({ ok: false, reloaded: false }, ['upgrade', 'start', 'exit'])
  assert.equal(out.exitCode, 1)

  out = await scenario(new Error('fixture update failure'), ['upgrade', 'start'])
  assert.equal(out.exitCode, 1)
  assert.ok(out.logs.includes('error: fixture update failure'))
  console.log('ok: flat Update previews its scope, waits for an explicit start and stops after replacement/failure')
} finally { process.exitCode = savedExit }
