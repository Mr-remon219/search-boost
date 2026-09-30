#!/usr/bin/env node
import './isolate-tests.mjs'
// Poisoned-caller regression for all automated tests, not just their temp HOME.
// No real credentials or user files are used. Live eval/probe commands are not tests.
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, lstatSync, readlinkSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'

const scripts = fileURLToPath(new URL('.', import.meta.url))
const repo = resolve(scripts, '..')
const tests = readdirSync(scripts).filter(name => /^test-.*\.mjs$/.test(name) && name !== 'test-environment.mjs')
  .concat(['smoke.mjs', 'ci-doctor-smoke.mjs', 'cursor-roundtrip-fixture.mjs']).sort()
const installTests = ['test-dsh-install.mjs', 'test-dsh-desktop.mjs', 'test-install.mjs', 'test-startup-hooks.mjs', 'test-skill-bundles.mjs']
const firstImport = /^import ['"]\.\/isolate-tests\.mjs['"]\s*$/
for (const name of tests) {
  const first = readFileSync(join(scripts, name), 'utf8').replace(/^#![^\n]*\n/, '').split('\n')[0]
  assert.match(first, firstImport, `${name}: isolation must run before every application/static import`)
}
const pkg = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'))
for (const [name, command] of Object.entries(pkg.scripts)) {
  if (!name.startsWith('test:') && name !== 'smoke' && name !== 'prepublishOnly') continue
  assert(!/jev-probe|eval-adaptive-search/.test(command), `${name}: live user-credential probes must not be test gates`)
  for (const [, file] of command.matchAll(/node scripts\/([^\s;&]+)/g)) {
    assert(file === 'test-environment.mjs' || tests.includes(file), `${name}: unknown unaudited entrypoint ${file}`)
  }
}
const ci = readFileSync(join(repo, '.github/workflows/ci.yml'), 'utf8')
for (const [, file] of ci.matchAll(/node scripts\/([^\s;&]+)/g)) {
  assert(tests.includes(file) || file === 'test-environment.mjs', `CI: unknown unaudited entrypoint ${file}`)
}
assert(ci.includes('npm run test:isolation'), 'CI must run the full isolation gate')
assert(pkg.scripts.prepublishOnly.includes('npm run test:isolation'), 'publishing must run the full isolation gate')
console.log(`ok: ${tests.length} automated entrypoints bootstrap before application imports; live probes excluded`)

const temp = mkdtempSync(join(tmpdir(), 'poisoned-caller-'))
const write = (file, data) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, typeof data === 'string' ? data : JSON.stringify(data), { mode: 0o600 }) }
function snapshot(root) {
  return Object.fromEntries(readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry => {
    const file = join(root, entry.name), stat = lstatSync(file)
    const value = stat.isSymbolicLink() ? `link:${readlinkSync(file)}` : stat.isDirectory() ? 'dir' : createHash('sha256').update(readFileSync(file)).digest('hex')
    return [[relative(root, file), `${stat.mode & 0o777}:${value}`], ...(stat.isDirectory() ? Object.entries(snapshot(file)).map(([path, body]) => [join(entry.name, path), body]) : [])]
  }))
}
try {
  const user = join(temp, 'user'), store = join(user, 'relocated-state'), project = join(user, 'project')
  mkdirSync(project, { recursive: true })
  const secret = 'caller-credential-do-not-log-79df8631'
  const env = { ...process.env, HOME: user, USERPROFILE: user, SEARCH_BOOST_HOME: store,
    TMPDIR: join(user, 'tmp'), TMP: join(user, 'tmp'), TEMP: join(user, 'tmp'),
    PI_CODING_AGENT_DIR: join(user, 'pi-agent'), DSH_HOME: join(user, 'dsh'),
    XDG_CONFIG_HOME: join(user, 'xdg-config'), XDG_CACHE_HOME: join(user, 'xdg-cache'), XDG_DATA_HOME: join(user, 'xdg-data'), XDG_STATE_HOME: join(user, 'xdg-state'),
    APPDATA: join(user, 'appdata'), LOCALAPPDATA: join(user, 'local-appdata'), CURL_HOME: join(user, 'curl'),
    npm_config_userconfig: join(user, 'user.npmrc'), NPM_CONFIG_GLOBALCONFIG: join(user, 'global.npmrc'),
    npm_config_cache: join(user, 'npm-cache'), NPM_CONFIG_PREFIX: join(user, 'npm-prefix'),
    PNPM_HOME: join(user, 'pnpm'), COREPACK_HOME: join(user, 'corepack'),
    // Fake credentials/settings must neither affect tests nor reach child commands.
    TAVILY_API_KEY: secret, BRAVE_API_KEY: secret, EXA_API_KEY: secret, ANYSEARCH_API_KEY: secret,
    XAI_API_KEY: `xai-${secret}`, TYPESAFE_API_KEY: secret, AI_GATEWAY_API_KEY: secret, DEEPSEEK_API_KEY: secret,
    PI_SEARCH_TAVILY_KEY: secret, NPM_TOKEN: secret, GITHUB_TOKEN: secret,
    SEARCH_BOOST_LAYER: 'api', SEARCH_BOOST_UPGRADE_CWD: project, SEARCH_BOOST_UPGRADE_HANDOFF: 'sentinel-lock',
    SEARCH_BOOST_FUTURE_SETTING: 'sentinel', PI_SESSION_FILE: join(user, 'session.jsonl'),
    SEARCH_BOOST_DSH_DESKTOP_COMMAND: join(user, 'desktop-command'),
    HTTPS_PROXY: 'http://user:sentinel@127.0.0.1:1', https_proxy: 'http://user:sentinel@127.0.0.1:1',
  }
  for (const [kind, data] of Object.entries({ KEYS: { tavily: 'sentinel', jev: { apiKey: 'sentinel', baseUrl: 'https://jev.invalid/v1' } }, LAYER: { layer: 'api' }, XAUTH: { kind: 'api-key', key: 'xai-sentinel' }, XGUEST: { token: 'sentinel' }, WORKSPACES: { workspaces: [project] } })) {
    const file = join(store, `${kind.toLowerCase()}.json`)
    write(file, data); env[`SEARCH_BOOST_${kind}_FILE`] = file
  }
  env.SEARCH_BOOST_CURSOR_INSTALL_STATE = join(store, 'cursor-install.json')
  write(env.SEARCH_BOOST_CURSOR_INSTALL_STATE, { sentinel: true })
  for (const root of [store, join(user, '.search-boost')]) write(join(root, 'state/upgrade-projects.json'), { projects: [project] })
  write(join(env.PI_CODING_AGENT_DIR, 'settings.json'), { packages: ['npm:foreign'] })
  write(join(env.DSH_HOME, 'profiles/web/package.json'), { dependencies: { 'search-boost': 'sentinel-version' } })
  write(join(env.DSH_HOME, 'profiles/desktop/package.json'), { dependencies: { 'search-boost': 'sentinel-version' } })
  write(env.SEARCH_BOOST_DSH_DESKTOP_COMMAND, 'caller Desktop command must never execute')
  write(join(user, '.grok/auth.json'), { accessToken: 'sentinel' })
  write(join(project, '.search-boost-keys.json'), { tavily: 'sentinel-project-key' })
  for (const path of [env.npm_config_userconfig, env.NPM_CONFIG_GLOBALCONFIG]) write(path, '//registry.npmjs.org/:_authToken=sentinel\n')
  for (const key of ['TMPDIR', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'APPDATA', 'LOCALAPPDATA', 'CURL_HOME', 'npm_config_cache', 'NPM_CONFIG_PREFIX', 'PNPM_HOME', 'COREPACK_HOME']) write(join(env[key], 'sentinel'), 'must remain unchanged')
  for (const file of ['.search-boost/config/keys.json', '.search-boost-keys.json', '.dsh-search-boost-keys.json']) write(join(user, file), { tavily: secret })
  const before = snapshot(user)
  const sourceRoots = ['lib', 'adapters', 'agents', 'scripts', 'templates', 'docs', 'grok-plugin', '.github']
  const sourceFiles = ['cli.mjs', 'migrate.mjs', 'server.mjs', 'package.json', 'package-lock.json']
  const sourceSnapshot = () => Object.fromEntries([
    ...sourceRoots.flatMap(root => Object.entries(snapshot(join(repo, root))).map(([path, value]) => [join(root, path), value])),
    ...sourceFiles.map(file => [file, createHash('sha256').update(readFileSync(join(repo, file))).digest('hex')]),
    ['root-entries', readdirSync(repo).sort().join('\n')],
  ])
  const sourceBefore = sourceSnapshot()
  // Negative control: omit isolation in THIS synthetic child only. Prove the
  // external snapshot detects the original receipt leak; no production bypass.
  const receipt = join(store, 'state/upgrade-projects.json'), savedReceipt = readFileSync(receipt)
  const negative = spawnSync(process.execPath, ['--input-type=module', '-e', `import { recordUpgradeProject } from ${JSON.stringify(new URL('../lib/upgrade/state.mjs', import.meta.url).href)}; await recordUpgradeProject('negative-control-project');`], { env, cwd: project, encoding: 'utf8', timeout: 20_000 })
  assert.equal(negative.status, 0, negative.stderr)
  assert.notDeepEqual(snapshot(user), before, 'the observer must detect an unisolated receipt write')
  writeFileSync(receipt, savedReceipt)
  assert.deepEqual(snapshot(user), before)
  console.log('ok: negative control detects the original external receipt leak')
  const probe = join(temp, 'probe.mjs')
  write(probe, `
import { testRoot } from ${JSON.stringify(new URL('./isolate-tests.mjs', import.meta.url).href)};
import { PATHS } from ${JSON.stringify(new URL('../lib/paths.mjs', import.meta.url).href)};
import { readKeysFile } from ${JSON.stringify(new URL('../lib/keys.mjs', import.meta.url).href)};
import { readJevConfig } from ${JSON.stringify(new URL('../lib/jev-config.mjs', import.meta.url).href)};
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
for (const key of ['SEARCH_BOOST_HOME','SEARCH_BOOST_KEYS_FILE','SEARCH_BOOST_FUTURE_SETTING','PI_CODING_AGENT_DIR','DSH_HOME','TAVILY_API_KEY','XAI_API_KEY','TYPESAFE_API_KEY','AI_GATEWAY_API_KEY','DEEPSEEK_API_KEY','NPM_TOKEN','GITHUB_TOKEN','HTTPS_PROXY','https_proxy']) assert.equal(process.env[key], undefined, key);
assert.equal(readKeysFile().tavily, undefined);
assert.ok(!readJevConfig().apiKey);
for (const command of ['grok','dsh','pi','claude','codex','cursor','antigravity']) {
  const blocked = spawnSync(command, [], { shell: process.platform === 'win32', encoding: 'utf8' });
  assert.equal(blocked.status, 97, command + ': real host must be blocked');
}
assert.deepEqual(Object.keys(process.env).filter(key => key.toLowerCase() === 'path'), ['PATH']);
assert.ok(process.env.SEARCH_BOOST_DSH_DESKTOP_COMMAND.startsWith(testRoot));
console.log(JSON.stringify({ testRoot, desktopCommand: process.env.SEARCH_BOOST_DSH_DESKTOP_COMMAND, home: process.env.HOME, cwd: process.cwd(), pi: PATHS.pi.agentDir, dsh: PATHS.dsh.home, npmCache: process.env.npm_config_cache, npmPrefix: process.env.npm_config_prefix }));
`)
  const checked = spawnSync(process.execPath, [probe], { env, cwd: project, encoding: 'utf8', timeout: 20_000 })
  assert.equal(checked.status, 0, checked.stderr)
  const values = JSON.parse(checked.stdout)
  for (const [key, value] of Object.entries(values)) assert(value.startsWith(values.testRoot), `${key} escapes the owned sandbox`)
  assert(!existsSync(values.testRoot), 'bootstrap cleans up its entire sandbox at exit')
  assert.deepEqual(snapshot(user), before)
  console.log('ok: poisoned credentials, cached import paths, project cwd, host homes and npm settings are isolated')
  const failureProbe = join(temp, 'failure-probe.mjs')
  write(failureProbe, `import { testRoot } from ${JSON.stringify(new URL('./isolate-tests.mjs', import.meta.url).href)}; console.log(testRoot); process.exit(7);`)
  const failure = spawnSync(process.execPath, [failureProbe], { env, cwd: project, encoding: 'utf8', timeout: 20_000 })
  assert.equal(failure.status, 7)
  assert(failure.stdout.trim(), 'failure probe must report its sandbox')
  assert(!existsSync(failure.stdout.trim()), 'failed tests must also clean up their sandbox')
  assert.deepEqual(snapshot(user), before)
  console.log('ok: real host commands are blocked and failed test exits clean up')

  const selected = process.argv.includes('--install') ? installTests : tests
  const failures = []
  for (const name of selected) {
    const args = name === 'test-codex-uninstall-integration.mjs' ? ['round-trip'] : []
    const result = spawnSync(process.execPath, [join(scripts, name), ...args], { env, cwd: project, encoding: 'utf8', timeout: 600_000, maxBuffer: 16 * 1024 * 1024 })
    try { assert.deepEqual(snapshot(user), before) } catch { failures.push(`${name}: modified simulated user files`); console.error(`FAIL: ${name} modified simulated user files`) }
    if ((result.stdout ?? '').includes(secret) || (result.stderr ?? '').includes(secret)) {
      failures.push(`${name}: exposed a caller credential`)
      console.error(`FAIL: ${name} exposed a caller credential (output suppressed)`)
      continue
    }
    try { assert.deepEqual(sourceSnapshot(), sourceBefore) } catch { failures.push(`${name}: modified source tree`); console.error(`FAIL: ${name} modified source tree`) }
    if (result.status !== 0) {
      failures.push(`${name}: ${result.error?.message ?? `exit ${result.status}, signal ${result.signal}`}`)
      console.error(`FAIL: ${name}\n${(result.stdout ?? '').slice(-4000)}\n${(result.stderr ?? '').slice(-4000)}`)
    } else {
      console.log(`ok: ${name} passed without changing simulated user files`)
      for (const line of (result.stdout ?? '').split('\n').filter(line => /^skip(?:ped)?:/i.test(line))) console.log(`  ${name}: ${line}`)
    }
  }
  assert.deepEqual(failures, [], 'all test entrypoints must pass under a poisoned caller environment')
  console.log(`All ${selected.length} isolated test entrypoints passed; simulated user state and source tree unchanged.`)
} finally { rmSync(temp, { recursive: true, force: true }) }
