// First import of EVERY automated test/fixture, before application modules bind
// HOME/cwd. This is process-environment isolation, not an OS security sandbox.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, parse, dirname, delimiter } from 'node:path'

const originalCwd = process.cwd()
export const testRoot = realpathSync(mkdtempSync(join(tmpdir(), 'sb-test-')))
const home = join(testRoot, 'home')
const workspace = join(testRoot, 'workspace')
const temp = join(testRoot, 'tmp')
const bin = join(testRoot, 'host-guards')
for (const dir of [home, workspace, temp, bin]) mkdirSync(dir, { recursive: true, mode: 0o700 })

// An allowlist prevents new credential/path overrides from silently escaping the
// sandbox. Keep only OS/toolchain discovery and harmless presentation settings.
// In particular do not inherit SEARCH_BOOST_*, PI_*, DSH_*, provider credentials,
// npm config/auth, proxies, NODE_OPTIONS, shell startup files or Python config.
const keep = /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|SYSTEMDRIVE|OS|PROCESSOR_ARCHITECTURE|NUMBER_OF_PROCESSORS|LANG|LANGUAGE|LC_[A-Z_]+|TZ|TERM|COLORTERM|NO_COLOR|FORCE_COLOR|CI|GITHUB_ACTIONS|npm_execpath|npm_node_execpath)$/i
for (const key of Object.keys(process.env)) if (!keep.test(key)) delete process.env[key]
Object.assign(process.env, {
  HOME: home, USERPROFILE: home,
  HOMEDRIVE: parse(home).root.replace(/[\\/]$/, ''), HOMEPATH: home.slice(parse(home).root.length - 1),
  TMPDIR: temp, TMP: temp, TEMP: temp,
  XDG_CONFIG_HOME: join(home, '.config'), XDG_CACHE_HOME: join(home, '.cache'), XDG_DATA_HOME: join(home, '.local', 'share'), XDG_STATE_HOME: join(home, '.local', 'state'),
  APPDATA: join(home, 'AppData', 'Roaming'), LOCALAPPDATA: join(home, 'AppData', 'Local'),
  CURL_HOME: home, COREPACK_HOME: join(home, '.cache', 'corepack'), PNPM_HOME: join(home, '.local', 'share', 'pnpm'),
  npm_config_userconfig: join(home, '.npmrc'), npm_config_globalconfig: join(home, 'global.npmrc'),
  npm_config_cache: join(home, '.npm'), npm_config_prefix: join(home, 'npm-prefix'),
  npm_config_update_notifier: 'false', npm_config_audit: 'false', npm_config_fund: 'false',
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(home, '.gitconfig'),
})
for (const file of ['.npmrc', 'global.npmrc', '.gitconfig']) writeFileSync(join(home, file), '', { mode: 0o600 })

// Accidental host execution must fail, not touch an installed CLI's databases or
// credentials. Tests of host execution explicitly prepend their own fixtures.
for (const command of ['grok', 'dsh', 'pi', 'claude', 'codex', 'cursor', 'antigravity']) {
  writeFileSync(join(bin, command + (process.platform === 'win32' ? '.cmd' : '')), process.platform === 'win32'
    ? `@echo Test isolation blocked real ${command} execution 1>&2\r\n@exit /b 97\r\n`
    : `#!/bin/sh\necho 'Test isolation blocked real ${command} execution' >&2\nexit 97\n`, { mode: 0o700 })
}
const pathKeys = Object.keys(process.env).filter(key => key.toLowerCase() === 'path')
const inheritedPath = process.env.PATH ?? process.env.Path ?? process.env[pathKeys[0]] ?? ''
for (const key of pathKeys) delete process.env[key]
process.env.PATH = [bin, inheritedPath].join(delimiter)
process.chdir(workspace)

// Tests may leak their own temporary files on failures. All tmpdir() descendants
// belong to this root, so cleanup never needs broad /tmp or real-HOME deletion.
process.on('exit', () => {
  try { process.chdir(originalCwd) } catch { process.chdir(dirname(testRoot)) }
  rmSync(testRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})
