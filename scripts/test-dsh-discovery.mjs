#!/usr/bin/env node
import './isolate-tests.mjs'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { desktopRegistryInstallDirectories, windowsDesktopInstallDirectories } from '../lib/dsh-windows-registry.mjs'
import { desktopCommandCandidates, dshDesktopStatus, desktopLaunchCommand, DESKTOP_COMMAND_ENV } from '../lib/dsh-desktop.mjs'

const product = values => ({ DisplayName: 'DeepSeek Harness 0.2.0-rc.2', ...values })
const env = { SystemRoot: 'C:\\Windows', LOCALAPPDATA: 'C:\\Users\\tester\\AppData\\Local', Apps: 'D:\\自定义 应用 & tools' }
assert.deepEqual(desktopRegistryInstallDirectories([
  product({ InstallLocation: 'D:\\自定义 应用 & tools\\DeepSeek Harness' }),
  product({ InstallLocation: '"E:\\桌面程序\\DeepSeek Harness\\"' }),
  product({ DisplayIcon: '"F:\\Other Apps\\DeepSeek Harness\\DeepSeek Harness.exe",0' }),
  product({ DisplayIcon: 'G:\\Other Apps, tools\\DeepSeek Harness\\DeepSeek Harness.exe,-1' }),
  product({ UninstallString: '"H:\\Other Apps\\DeepSeek Harness\\Uninstall DeepSeek Harness.exe" /currentuser' }),
  product({ UninstallString: 'I:\\Other Apps\\DeepSeek Harness\\Uninstall DeepSeek Harness.exe /allusers' }),
  product({ InstallLocation: '%apps%\\DeepSeek Harness' }),
  product({ InstallLocation: 'd:\\自定义 应用 & tools\\deepseek harness' }),
  product({ InstallLocation: 'relative', DisplayIcon: 'J:\\fallback\\DeepSeek Harness.exe,0' }),
  product({ UninstallString: 'K:\\custom.exe folder\\DeepSeek Harness\\Uninstall DeepSeek Harness.exe /currentuser' }),
], { env }), [
  'D:\\自定义 应用 & tools\\DeepSeek Harness', 'E:\\桌面程序\\DeepSeek Harness\\',
  'F:\\Other Apps\\DeepSeek Harness', 'G:\\Other Apps, tools\\DeepSeek Harness',
  'H:\\Other Apps\\DeepSeek Harness', 'I:\\Other Apps\\DeepSeek Harness', 'J:\\fallback',
  'K:\\custom.exe folder\\DeepSeek Harness',
])
assert.deepEqual(desktopRegistryInstallDirectories([
  null, 'not an entry', { DisplayName: 'DeepSeek', InstallLocation: 'D:\\wrong' },
  { DisplayName: 'DeepSeek Harness Helper', InstallLocation: 'D:\\wrong' },
  product({ InstallLocation: 'relative' }), product({ InstallLocation: 'D:relative' }),
  product({ InstallLocation: '\\root-relative' }), product({ InstallLocation: '%MISSING%\\DeepSeek Harness' }),
  product({ InstallLocation: 'D:\\bad\npath' }), product({ InstallLocation: 123 }),
  product({ DisplayIcon: 'D:\\wrong\\Other.exe,0' }),
  product({ UninstallString: 'cmd.exe /c "D:\\app\\Uninstall DeepSeek Harness.exe"' }),
]), [])
assert.deepEqual(desktopRegistryInstallDirectories({}, { env }), [])
assert.deepEqual(desktopRegistryInstallDirectories([product({ InstallLocation: 'D:\\100% tools\\DeepSeek Harness' })]), ['D:\\100% tools\\DeepSeek Harness'])
assert.deepEqual(desktopRegistryInstallDirectories([product({ InstallLocation: '%APPS%\\DeepSeek Harness' })], { env: { APPS: 'D:\\100% tools' } }), ['D:\\100% tools\\DeepSeek Harness'])
assert.deepEqual(desktopRegistryInstallDirectories([product({ InstallLocation: '\\\\server\\share\\DeepSeek Harness' })]), [], 'automatic registry discovery must not probe remote UNC shares')
console.log('ok: Windows installer metadata handles custom drives, Unicode/spaces, icon/uninstall fallbacks and rejects unrelated/invalid entries')

let calls = 0
const run = (command, args, options) => {
  calls++
  assert.equal(command, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
  assert.deepEqual(args.slice(0, 4), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command'])
  for (const root of ['HKCU:', 'HKLM:', 'WOW6432Node']) assert.ok(args[4].includes(root))
  assert.ok(!args[4].includes('自定义'), 'registry values never become PowerShell source')
  assert.equal(options.shell, false)
  assert.equal(options.windowsHide, true)
  assert.equal(options.encoding, 'utf8')
  assert.equal(options.timeout, 5_000)
  assert.ok(options.maxBuffer <= 1_048_576)
  return { status: 0, stdout: '\uFEFF' + JSON.stringify([product({ InstallLocation: 'D:\\自定义 应用 & tools\\DeepSeek Harness' })]) }
}
assert.deepEqual(windowsDesktopInstallDirectories({ platform: 'win32', env, run, now: () => 1_000 }), ['D:\\自定义 应用 & tools\\DeepSeek Harness'])
assert.deepEqual(windowsDesktopInstallDirectories({ platform: 'win32', env, run, now: () => 1_001 }), ['D:\\自定义 应用 & tools\\DeepSeek Harness'])
assert.equal(calls, 1, 'hot discovery reuses a short-lived registry snapshot')
assert.deepEqual(windowsDesktopInstallDirectories({ platform: 'win32', env, run, now: () => 11_000 }), ['D:\\自定义 应用 & tools\\DeepSeek Harness'])
assert.equal(calls, 2, 'expired registry snapshot permits a newly installed/moved Desktop to be discovered')
let failedCalls = 0
const failedRun = () => { failedCalls++; return { status: 1, stdout: '' } }
assert.deepEqual(windowsDesktopInstallDirectories({ platform: 'win32', env, run: failedRun, now: () => 1_000 }), [])
assert.deepEqual(windowsDesktopInstallDirectories({ platform: 'win32', env, run: failedRun, now: () => 1_001 }), [])
assert.equal(failedCalls, 1, 'unavailable registry query is not spawned for every status row')
assert.deepEqual(windowsDesktopInstallDirectories({ platform: 'win32', env, run: failedRun, now: () => 11_000 }), [])
assert.equal(failedCalls, 2, 'failed discovery can recover after the bounded cache expires')
const variableRun = () => ({ status: 0, stdout: JSON.stringify([product({ InstallLocation: '%APPS%\\DeepSeek Harness' })]) })
assert.deepEqual(windowsDesktopInstallDirectories({ platform: 'win32', env: { ...env, APPS: 'D:\\one' }, run: variableRun, now: () => 1_000 }), ['D:\\one\\DeepSeek Harness'])
assert.deepEqual(windowsDesktopInstallDirectories({ platform: 'win32', env: { ...env, APPS: 'E:\\two' }, run: variableRun, now: () => 1_001 }), ['E:\\two\\DeepSeek Harness'], 'cached raw metadata does not freeze environment expansion')
assert.deepEqual(windowsDesktopInstallDirectories({ platform: 'win32', env, run: () => ({ status: 0, stdout: JSON.stringify(product({ InstallLocation: 'D:\\single' })) }) }), ['D:\\single'])
for (const result of [
  { status: 1, stdout: '[]' }, { status: 0, stdout: 'not JSON' }, { status: 0, stdout: '' },
  { status: null, error: new Error('timeout') }, { status: 0, stdout: 'null' },
]) assert.deepEqual(windowsDesktopInstallDirectories({ platform: 'win32', env, run: () => result }), [])
assert.deepEqual(windowsDesktopInstallDirectories({ platform: 'win32', env, run: () => { throw Error('denied') } }), [])
for (const platform of ['linux', 'darwin']) assert.deepEqual(windowsDesktopInstallDirectories({ platform, env, run }), [])
assert.deepEqual(windowsDesktopInstallDirectories({ platform: 'win32', env: {}, run }), [])
assert.equal(calls, 2, 'non-Windows/WSL and missing system paths must not query Windows registry')
console.log('ok: bounded read-only registry query, safe JSON transport, timeout/denial/absence and native-platform gating')

// Integration uses actual sandbox files, not mere candidate strings. No registry
// mutation or real Desktop launch is needed to discover a custom install.
const custom = join(process.env.HOME, '另一个磁盘 & 自定义目录', 'DeepSeek Harness')
const stale = join(process.env.HOME, 'removed installation')
const launcher = dir => join(dir, 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd')
mkdirSync(dirname(launcher(custom)), { recursive: true })
writeFileSync(launcher(custom), '@echo discovery-only fixture\r\n')
assert.equal(dshDesktopStatus({ platform: 'win32', env: {}, readRegistry: () => [custom] }).command, null,
  'a registry launcher without its sibling application is not an automatic execution source')
writeFileSync(join(custom, 'DeepSeek Harness.exe'), 'application discovery fixture')
const readRegistry = () => [stale, custom]
const status = dshDesktopStatus({ platform: 'win32', home: process.env.HOME, env: {}, readRegistry })
assert.equal(status.command, launcher(custom), 'skip stale metadata and find the custom install without PATH/default directories')
assert.equal(status.detected, true)
assert.equal(status.initialized, false)
assert.throws(() => desktopLaunchCommand(['plugin'], { status }), /initialize/)
assert.equal(existsSync(status.profileDir), false, 'discovery/preflight does not create profiles')
const defaultBase = join(process.env.HOME, 'Local')
const defaultCommand = launcher(join(defaultBase, 'Programs', 'DeepSeek Harness'))
mkdirSync(dirname(defaultCommand), { recursive: true })
writeFileSync(defaultCommand, 'default fixture')
assert.equal(dshDesktopStatus({ platform: 'win32', env: { LOCALAPPDATA: defaultBase }, readRegistry }).command, launcher(custom), 'registered destination precedes guessed default')
assert.equal(dshDesktopStatus({ platform: 'win32', env: { LOCALAPPDATA: defaultBase }, readRegistry: () => [] }).command, defaultCommand, 'registry absence retains default discovery')
assert.equal(dshDesktopStatus({ platform: 'win32', env: {}, readRegistry: () => [stale] }).command, null)
const mustNotRead = () => { throw Error('registry must not be queried') }
assert.deepEqual(desktopCommandCandidates({ platform: 'win32', env: { [DESKTOP_COMMAND_ENV]: launcher(stale) }, readRegistry: mustNotRead }), [launcher(stale)])
assert.equal(dshDesktopStatus({ platform: 'win32', env: { [DESKTOP_COMMAND_ENV]: launcher(stale) }, readRegistry: mustNotRead }).command, null, 'invalid explicit override never falls back')
for (const platform of ['darwin', 'linux']) desktopCommandCandidates({ platform, env: {}, readRegistry: mustNotRead })
console.log('ok: custom installed Desktop discovery, stale/default precedence, authoritative override and no profile writes or cross-platform probing')
