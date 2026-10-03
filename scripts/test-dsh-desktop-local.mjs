#!/usr/bin/env node
import './isolate-tests.mjs'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { dshDesktopLocalSource, inspectDshDesktopLocal, waitForDshDesktopLocal } from '../lib/dsh-desktop-local.mjs'
import { desktopWaitCancellation, runDshDesktopLocalInstall } from '../lib/installer/dsh-desktop-local.mjs'
import { runDshDesktopMethodStep, executeAgentOps, planAgentOps, runInstallerWithOptions } from '../lib/installer/index.mjs'
import { withTuiContext } from '../lib/installer/i18n.mjs'
import { AGENTS } from '../lib/agents/index.mjs'
import { PKG_ROOT, getVersion } from '../lib/pkg.mjs'
import { writeDshHostFixture, writeDesktopProbeFixture } from './dsh-host-fixture.mjs'

const version = getVersion(), source = dshDesktopLocalSource()
const dir = join(process.env.HOME, '.dsh', 'profiles', 'desktop')
const write = (file, value) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value)) }
const manifestFile = join(dir, 'package.json')
function reset({ enabled = false, field = 'dependencies', spec = `link:${source}`, linked = true } = {}) {
  rmSync(dir, { recursive: true, force: true })
  write(manifestFile, { name: 'desktop-fixture', private: true, [field]: { 'search-boost': spec }, dsh: { profile: { bundles: enabled ? ['search-boost'] : [] } } })
  write(join(dir, 'cordis.patch.yml'), '# unrelated user configuration\n')
  if (linked) {
    mkdirSync(join(dir, 'node_modules'), { recursive: true })
    symlinkSync(source, join(dir, 'node_modules', 'search-boost'), process.platform === 'win32' ? 'junction' : 'dir')
  }
}
const inspect = options => inspectDshDesktopLocal({ dir, source, version, ...options })
assert.equal(source, dshDesktopLocalSource(PKG_ROOT, version))
const cache = join(process.env.HOME, '_npx', 'cache', 'node_modules', 'search-boost')
mkdirSync(cache, { recursive: true })
assert.throws(() => dshDesktopLocalSource(cache, version), /temporary npm-exec cache/)
assert.equal(inspect().ready, false)
assert.equal(existsSync(dir), false, 'inspection never creates Desktop profiles')
for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
  reset({ field })
  const snapshot = readFileSync(manifestFile, 'utf8')
  assert.equal(inspect().ready, true)
  assert.equal(inspect().enabled, false)
  assert.equal(inspect({ requireEnabled: true }).state, 'disabled')
  write(join(dir, 'lock'), 'Desktop is open for GUI installation')
  assert.equal(inspect().ready, true, 'application lock is allowed for read-only manual setup')
  assert.equal(readFileSync(manifestFile, 'utf8'), snapshot)
  for (const file of ['package.json.lock', '.plugin-manager/run.json', '.search-boost-install-pending.json']) {
    write(join(dir, file), 'ongoing/pending')
    assert.equal(inspect().state, 'busy')
    rmSync(join(dir, file))
  }
}
reset({ enabled: true })
assert.equal(inspect({ requireEnabled: true }).ready, true)
reset({ spec: '^0.2.4' })
assert.equal(inspect().state, 'source', 'a registry package, even the same version, is not this local source')
reset({ spec: 'link:missing' })
assert.equal(inspect().ready, false)
reset({ linked: false })
write(join(dir, 'node_modules', 'search-boost', 'package.json'), { name: 'search-boost', version: '0.0.1', dsh: { bundle: { patch: './adapters/dsh/cordis.patch.yml' } } })
assert.equal(inspect().state, 'payload')
write(join(dir, 'node_modules', 'search-boost', 'package.json'), { name: 'search-boost', version, dsh: { bundle: { patch: './adapters/dsh/cordis.patch.yml' } } })
for (const file of ['index.js', 'schema.js', 'cordis.patch.yml']) write(join(dir, 'node_modules', 'search-boost', 'adapters', 'dsh', file), 'same version, wrong code')
assert.equal(inspect().ready, false, 'same-version stale copied payload must not pass')
reset()
write(manifestFile, '{half written')
assert.equal(inspect().ready, false)
console.log('ok: local source identity, durable path requirement, direct dependency fields, application/write locks, disabled state and stale payload rejection')

function clock(onDelay = () => {}) {
  let time = 0, delays = 0
  return { now: () => time, delay: async ms => { time += ms; onDelay(++delays) } }
}
const noLauncher = () => ({ command: null })
reset()
let timeline = clock()
let result = await waitForDshDesktopLocal({ dir, source, version, timeoutMs: 100, intervalMs: 10 }, { ...timeline, desktopStatus: noLauncher })
assert.equal(result.ok, true)
assert.equal(result.dsh.verification, 'disk')
assert.equal(result.dsh.enabled, false)
reset({ linked: false })
const states = []
timeline = clock(tick => {
  if (tick === 1) { reset(); write(join(dir, 'package.json.lock'), 'pnpm/applying') }
  if (tick === 2) rmSync(join(dir, 'package.json.lock'))
})
let probes = 0
result = await waitForDshDesktopLocal({ dir, source, version, timeoutMs: 100, intervalMs: 10, onState: state => states.push(state) }, {
  ...timeline, desktopStatus: () => ({ command: '/fake/resources/runtime/cli/bin/dsh' }),
  verifyRuntime: async (profile, launch, options) => {
    probes++
    assert.equal(profile, dir)
    assert.equal(launch.args.at(-1), source)
    assert.equal(options.desktop, true)
    assert.equal(options.enable, undefined, 'manual observation must never activate anything')
    assert.equal(options.installSpec, undefined, 'manual observation must never start package operations')
    return { root: source, version, installAnchor: '/fake/host/package.json' }
  },
})
assert.equal(result.ok, true)
assert.equal(result.dsh.verification, 'runtime')
assert.equal(probes, 1)
assert.ok(states.includes('busy'))
assert.ok(timeline.now() >= 30, 'completion waits for two stable observations after the writer releases its lock')

reset()
const changing = clock(tick => {
  const profile = JSON.parse(readFileSync(manifestFile, 'utf8'))
  profile.unrelated = tick
  write(manifestFile, profile)
})
result = await waitForDshDesktopLocal({ dir, source, version, timeoutMs: 40, intervalMs: 10 }, { ...changing, desktopStatus: noLauncher })
assert.equal(result.timedOut, true, 'changing records cannot be called stable/completed')
assert.equal(result.ok, false)
timeline = clock()
result = await waitForDshDesktopLocal({ dir, source, version, requireEnabled: true, timeoutMs: 30, intervalMs: 10 }, { ...timeline, desktopStatus: noLauncher })
assert.equal(result.pending, true)
assert.equal(result.timedOut, true)
const abort = new AbortController()
timeline = clock(() => abort.abort())
result = await waitForDshDesktopLocal({ dir, source, version, signal: abort.signal, timeoutMs: 100, intervalMs: 10 }, { ...timeline, desktopStatus: noLauncher })
assert.equal(result.cancelled, true)
timeline = clock()
result = await waitForDshDesktopLocal({ dir, source, version, timeoutMs: 40, intervalMs: 10 }, {
  ...timeline, desktopStatus: () => ({ command: '/fake/desktop' }),
  verifyRuntime: async () => { throw Error('resolver shadow mismatch; diagnostic-secret-not-to-log') },
})
assert.equal(result.ok, false, 'known runtime verification failure cannot degrade to disk-only success')
assert.equal(result.timedOut, true)
const changedDuringProbe = clock()
result = await waitForDshDesktopLocal({ dir, source, version, timeoutMs: 40, intervalMs: 10 }, {
  ...changedDuringProbe, desktopStatus: () => ({ command: '/fake/desktop' }),
  verifyRuntime: async () => { write(manifestFile, '{changed during probe'); return { root: source, version } },
})
assert.equal(result.ok, false, 're-read profile after runtime verification')
const abortProbe = new AbortController()
reset()
result = await waitForDshDesktopLocal({ dir, source, version, signal: abortProbe.signal, timeoutMs: 40, intervalMs: 10 }, {
  ...clock(), desktopStatus: () => ({ command: '/fake/desktop' }),
  verifyRuntime: async (_dir, _launch, options) => { assert.equal(options.signal, abortProbe.signal); abortProbe.abort(); return {} },
})
assert.equal(result.cancelled, true)
console.log('ok: staged GUI installation, two stable reads, read-only owning-runtime probe, disk-only disclosure, mismatch/timeout/cancellation and post-probe recheck')

// Real subprocess and actual SearchBoost runtime probe, not a stubbed verdict.
// The synthetic ASAR carrier is Node (not live Electron); its main must never run.
const carrierBase = join(process.env.HOME, 'manual Desktop carrier')
const carrierEntry = join(carrierBase, 'host', 'main.mjs')
writeDshHostFixture(carrierEntry, { desktopHost: true })
write(carrierEntry, 'throw Error("manual observation must never boot Desktop or run a package operation")\n')
const carrierCommand = join(carrierBase, 'resources', 'runtime', 'cli', 'bin', process.platform === 'win32' ? 'dsh.cmd' : 'dsh')
write(carrierCommand, 'manual observation bypasses this launcher script')
writeDesktopProbeFixture(carrierCommand, carrierEntry)
reset()
write(join(dir, 'lock'), 'running Desktop owns this profile')
const beforeProbe = readFileSync(manifestFile, 'utf8')
result = await waitForDshDesktopLocal({ dir, source, version, timeoutMs: 15_000, intervalMs: 10 }, {
  desktopStatus: () => ({ command: carrierCommand }),
})
assert.equal(result.ok, true)
assert.equal(result.dsh.verification, 'runtime')
assert.equal(result.dsh.root, source)
assert.equal(readFileSync(manifestFile, 'utf8'), beforeProbe)
assert.equal(readFileSync(join(dir, 'lock'), 'utf8'), 'running Desktop owns this profile')
assert.equal(existsSync(join(dir, 'package.json.lock')), false)
assert.equal(existsSync(join(dir, '.plugin-manager')), false, 'read-only probe starts no package run')
console.log('ok: actual runtime-probe subprocess observes a running Desktop profile without booting, installing, enabling or writing')

for (const interrupt of ['escape', 'ctrl-c', 'sigint', 'close']) {
  const input = new PassThrough(), events = new EventEmitter(), rawModes = []
  input.isTTY = true
  input.isRaw = false
  input.setRawMode = value => { rawModes.push(value); input.isRaw = value }
  input.pause()
  const control = desktopWaitCancellation(input, events)
  if (interrupt === 'escape') input.emit('keypress', '', { name: 'escape' })
  if (interrupt === 'ctrl-c') input.emit('keypress', '', { name: 'c', ctrl: true })
  if (interrupt === 'sigint') events.emit('SIGINT')
  if (interrupt === 'close') input.emit('close')
  assert.equal(control.signal.aborted, true)
  control.dispose()
  assert.deepEqual(rawModes, [true, false])
  assert.equal(input.isPaused(), true)
  assert.equal(input.listenerCount('keypress'), 0)
  assert.equal(events.listenerCount('SIGINT'), 0)
  input.destroy()
}
console.log('ok: Escape/Ctrl+C/closed input cancellation restores terminal mode, pauses and listener ownership')

function ui() {
  const notes = [], logs = [], menus = [], progress = []
  const clack = {
    note: (text, title) => notes.push([text, title]),
    log: Object.fromEntries(['info', 'warn', 'error', 'success', 'message'].map(name => [name, text => logs.push([name, text])])),
    isCancel: value => typeof value === 'symbol',
    cancel() {},
    spinner: () => ({ start: text => progress.push(['start', text]), stop: text => progress.push(['stop', text]), message: text => progress.push(['message', text]) }),
    select: async menu => { menus.push(menu); return menu.options.some(option => option.value === 'local') ? 'local' : 'user' },
    confirm: async () => false,
  }
  return { clack, notes, logs, menus, progress }
}
for (const language of ['en', 'zh-CN']) {
  const out = ui()
  await withTuiContext(async () => {
    assert.equal(await runDshDesktopMethodStep(out.clack, ['dsh'], { dshSurface: 'desktop' }), 'local')
    assert.equal(out.menus[0].initialValue, 'command', 'automatic bundled-command interface remains default')
    assert.deepEqual(out.menus[0].options.map(option => option.value), ['command', 'local'])
    assert.equal(await runDshDesktopMethodStep(out.clack, ['dsh'], { yes: true, dshSurface: 'desktop' }), 'command')
    assert.equal(await runDshDesktopMethodStep(out.clack, ['dsh'], { dshSurface: 'cli' }), 'command')
    assert.equal(await runDshDesktopMethodStep(out.clack, ['dsh'], { uninstall: true, dshSurface: 'desktop' }), 'command')
    await assert.rejects(() => runDshDesktopMethodStep(out.clack, ['dsh'], { yes: true, dshSurface: 'desktop', dshDesktopMethod: 'local' }), /interactive wait/)
    let disposed = 0, waits = 0
    const deps = {
      sourcePath: () => source, desktopStatus: () => ({ profileDir: dir, command: null }),
      cancellation: () => ({ signal: new AbortController().signal, dispose: () => disposed++ }),
      wait: async options => {
        waits++
        assert.equal(options.source, source)
        options.onState('busy')
        return { ok: true, files: [manifestFile], dsh: { version, root: source, enabled: false, verification: 'disk' } }
      },
    }
    const before = readFileSync(manifestFile, 'utf8')
    const oldSpinner = out.clack.spinner
    out.clack.spinner = () => { throw Error('manual wait must not use Clack spinner/block, which exits the process on Ctrl+C') }
    assert.equal((await runDshDesktopLocalInstall(out.clack, {}, deps)).ok, true)
    assert.equal(waits, 1)
    assert.equal(disposed, 1)
    assert.ok(out.logs.some(([, text]) => text === source), 'copyable path is absolute and unmodified')
    assert.ok(out.logs.some(([kind]) => kind === 'warn'), 'disk-only and disabled states are disclosed')
    assert.equal(readFileSync(manifestFile, 'utf8'), before)
    assert.equal((await runDshDesktopLocalInstall(out.clack, { dryRun: true }, deps)).planned, true)
    assert.equal(waits, 1, 'dry-run never waits or invokes runtime')
    const stopped = await runDshDesktopLocalInstall(out.clack, {}, { ...deps, wait: async () => ({ ok: false, pending: true, cancelled: true }) })
    assert.equal(stopped.pending, true)
    assert.equal(stopped.ok, false)
    await assert.rejects(() => runDshDesktopLocalInstall(out.clack, {}, { ...deps, wait: async () => { throw Error('unexpected failure') } }))
    assert.equal(disposed, 3, 'wait input disposed on success, cancellation and failure')
    out.clack.spinner = oldSpinner
  }, { language })
}
console.log('ok: bilingual method menu, default automatic interface, unchanged copyable source, manual-only wait and dry-run/cancel/error cleanup')

assert.deepEqual(planAgentOps(['dsh', 'grok', 'pi'], { dshSurface: 'all' }).map(({ id, profile }) => [id, profile]), [
  ['dsh', 'web'], ['grok', undefined], ['pi', undefined], ['dsh', 'desktop'],
])
const savedGrok = AGENTS.grok.install, savedDsh = AGENTS.dsh.install
const savedExitCode = process.exitCode
try {
  for (const { cancelled, cliFails } of [
    { cancelled: false, cliFails: false }, { cancelled: true, cliFails: false }, { cancelled: false, cliFails: true },
  ]) {
    const steps = [], out = ui()
    AGENTS.dsh.install = async opts => {
      steps.push(`automatic:${opts.profile}`)
      if (cliFails) throw Error('old CLI is unsupported')
      return []
    }
    AGENTS.grok.install = async () => { steps.push('grok completed'); return [] }
    const executeOperations = (targets, opts, clack, plan) => executeAgentOps(targets, opts, clack, plan, {
      localInstall: async (_clack, localOpts) => {
        steps.push('Desktop path shown / waiting')
        assert.equal(localOpts.dshDesktopMethod, 'local')
        assert.ok(out.progress.some(([kind, text]) => kind === 'stop' && /Other integration|其他接入/.test(text)), 'outer spinner stops before manual wait')
        return cancelled ? { ok: false, pending: true, cancelled: true, files: [], error: 'wait stopped' }
          : { ok: true, files: [manifestFile], dsh: { root: source, version, enabled: false, verification: 'disk', manual: true } }
      },
    })
    const outcome = await withTuiContext(() => runInstallerWithOptions({
      clack: out.clack, target: 'dsh,grok', dshSurface: 'all', dshDesktopMethod: 'local',
      skipKeys: true, skipLayer: true, skipXAuth: true,
    }, { executeOperations }), { language: 'en' })
    assert.deepEqual(steps, ['automatic:web', 'grok completed', 'Desktop path shown / waiting'])
    assert.equal(outcome.ok, !cancelled && !cliFails)
    assert.deepEqual(outcome.results.slice(0, 2).map(({ ok }) => ok), [!cliFails, true], 'manual cancellation retains completed targets; an old CLI cannot block Grok/Desktop')
    assert.equal(outcome.results.at(-1).profile, 'desktop')
  }
  // Automatic mode still uses the agent's normal bundled-command install path.
  const automatic = []
  AGENTS.dsh.install = async opts => { automatic.push(opts.profile); return [] }
  await executeAgentOps(['dsh'], { dshSurface: 'all', dshDesktopMethod: 'command' }, null)
  assert.deepEqual(automatic, ['web', 'desktop'])
} finally {
  AGENTS.grok.install = savedGrok
  AGENTS.dsh.install = savedDsh
  process.exitCode = savedExitCode
}
console.log('ok: full installer orders Grok and CLI before Desktop, preserves earlier results on manual cancellation and retains the automatic interface')
