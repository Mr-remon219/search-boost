#!/usr/bin/env node
import './isolate-tests.mjs'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'

// Real installer/TUI control flow; only destructive agent calls are replaced.
// No host command, real credential, user config or network is touched.
process.env.SEARCH_BOOST_HOME = join(process.env.HOME, 'uninstall-confirmation-fixture')
process.env.DSH_HOME = join(process.env.SEARCH_BOOST_HOME, 'dsh')
const { AGENTS } = await import('../lib/agents/index.mjs')
const { runInstallerWithOptions } = await import('../lib/installer/index.mjs')
const { runTui } = await import('../lib/installer/tui.mjs')
const { saveTuiLayout, withTuiContext, TuiCancelled } = await import('../lib/installer/i18n.mjs')
const cancel = Symbol('cancel')
const calls = []
const originals = { cursor: AGENTS.cursor.uninstall, dsh: AGENTS.dsh.uninstall }
AGENTS.cursor.uninstall = async opts => { calls.push({ id: 'cursor', opts }) }
AGENTS.dsh.uninstall = async opts => { calls.push({ id: 'dsh', opts }) }

function prompts(answer, actions = null) {
  const notes = [], confirms = [], logs = [], spinners = []
  const clack = {
    intro() {}, outro() {}, note: (body, title) => notes.push({ body, title }),
    isCancel: value => value === cancel,
    cancel() { throw Error('navigation cancellation must not exit the process') },
    log: Object.fromEntries(['info', 'warn', 'error', 'success'].map(k => [k, text => logs.push(text)])),
    spinner: () => ({ start: text => spinners.push(text), stop() {} }),
    confirm: async options => { confirms.push(options); return answer },
    multiselect: async () => ['cursor'],
    select: async () => { assert(actions?.length, 'unexpected selection'); return actions.shift() },
  }
  return { clack, notes, confirms, logs, spinners }
}
const context = fn => withTuiContext(fn, { language: 'en', layout: 'flat', navigation: true })
try {
  for (const answer of [false, undefined, 'yes']) {
    const p = prompts(answer)
    await context(() => runInstallerWithOptions({ target: 'cursor', uninstall: true, clack: p.clack }))
    assert.equal(p.confirms.length, 1, 'interactive uninstall must explicitly ask before dispatch')
    assert.equal(p.confirms[0].initialValue, false, 'destructive confirmation defaults to cancellation')
    assert.equal(calls.length, 0, 'only literal boolean consent authorizes removal')
    assert.equal(p.spinners.length, 0, 'cancellation happens before the mutation/progress phase')
    assert(p.notes.some(n => n.body.includes('Cursor IDE')), 'the actual removal target is previewed')
  }
  const cancelled = prompts(cancel)
  await assert.rejects(context(() => runInstallerWithOptions({ target: 'cursor', uninstall: true, clack: cancelled.clack })), TuiCancelled)
  assert.equal(calls.length, 0)

  const approved = prompts(true)
  await context(() => runInstallerWithOptions({ target: 'cursor', uninstall: true, dryRun: true, clack: approved.clack }))
  assert.equal(calls.length, 1)
  assert.equal(calls[0].opts.dryRun, true, 'confirmation preserves dry-run semantics')
  assert(approved.notes.some(n => n.body.includes('dry-run')))

  const dsh = prompts(true)
  await context(() => runInstallerWithOptions({ target: 'dsh', uninstall: true, profile: 'approved-profile', dshSurface: 'cli', clack: dsh.clack }))
  assert.equal(calls.length, 2)
  assert.equal(calls[1].opts.profile, 'approved-profile')
  assert(dsh.notes.some(n => n.body.includes('approved-profile')), 'resolved DSH profile is shown before consent')

  const explicitYes = prompts(false)
  await context(() => runInstallerWithOptions({ target: 'cursor', uninstall: true, yes: true, clack: explicitYes.clack }))
  assert.equal(explicitYes.confirms.length, 0, 'explicit --yes remains non-interactive authorization')
  assert.equal(calls.length, 3)

  const addProfile = name => {
    const dir = join(process.env.DSH_HOME, 'profiles', name)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies: { 'search-boost': 'fixture' } }))
  }
  addProfile('before-consent')
  const frozen = prompts(true)
  frozen.clack.confirm = async options => {
    frozen.confirms.push(options)
    addProfile('after-consent') // a host change while the user considers the prompt
    return true
  }
  await context(() => runInstallerWithOptions({ target: 'dsh', uninstall: true, dshSurface: 'cli', clack: frozen.clack }))
  assert.equal(calls.length, 4, 'a new profile after preview is not silently added to removal')
  assert.equal(calls[3].opts.profile, 'before-consent')
  assert(frozen.notes.some(n => n.body.includes('before-consent') && !n.body.includes('after-consent')))

  for (const layout of ['flat', 'folder']) {
    saveTuiLayout(layout)
    const actions = layout === 'flat' ? ['uninstall', 'exit'] : ['integration', 'uninstall', 'back', 'exit']
    const p = prompts(false, actions)
    await runTui({}, { clack: p.clack })
    assert.equal(actions.length, 0, `${layout}: cancellation returns to its menu`)
    assert.equal(p.confirms.length, 1)
    assert.equal(p.confirms[0].initialValue, false)
    assert.equal(calls.length, 4, `${layout}: selecting a target is not removal consent`)
  }
  console.log('ok: uninstall previews targets/profiles, defaults to cancel, requires literal consent, preserves dry-run/explicit --yes and both-layout navigation')
} finally {
  AGENTS.cursor.uninstall = originals.cursor
  AGENTS.dsh.uninstall = originals.dsh
}
