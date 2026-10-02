#!/usr/bin/env node
import './isolate-tests.mjs'
/** beta.6 upgrade repairs, all hermetic:
 * BUG-001 legacy Grok registration identity (source path + cached payload bytes),
 * BUG-002A stale recorded projects are skipped/disclosed without deleting state,
 * BUG-002B Codex marker refusal names the config path and marker lines,
 * BUG-002C DSH repeat sync verifies once and stops dispatching the host.
 * No real Grok/DSH/CLI, no network, no user state outside the isolated HOME.
 */
import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'

const temp = realpathSync(mkdtempSync(join(tmpdir(), 'sb beta6 upgrade ')))
const home = join(temp, 'home'), project = join(temp, 'project')
mkdirSync(home); mkdirSync(project)
process.env.HOME = home
process.env.USERPROFILE = home
process.env.SEARCH_BOOST_HOME = join(home, '.search-boost')
const write = (file, value) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`) }
const json = (file) => JSON.parse(readFileSync(file, 'utf8'))
const readIfExists = (file) => existsSync(file) ? readFileSync(file, 'utf8') : null
const backupsRoot = join(process.env.SEARCH_BOOST_HOME, 'backups')
const backupsSnapshot = () => existsSync(backupsRoot) ? readdirSync(backupsRoot).sort().join('\n') : ''
const originalCwd = process.cwd()
process.chdir(project)

const { PKG_ROOT, getVersion } = await import('../lib/pkg.mjs')
const { PATHS } = await import('../lib/paths.mjs')
const { discoverIntegrations, refreshIntegration, refreshGrokPlugin } = await import('../lib/upgrade/integrations.mjs')
const { runUpgrade } = await import('../lib/upgrade/index.mjs')
const { recordedProjectsPath } = await import('../lib/upgrade/state.mjs')
const { migrateCodexNativeSearch, setCodexNativeSearch, codexRootSearchDisabled } = await import('../lib/codex-native.mjs')

const pluginDir = join(PKG_ROOT, 'grok-plugin')
const legacyPluginName = 'grok-plugin-23a3506e'
const grokRefusal = /No uninstall\/reinstall was attempted and no trust was granted/

try {
  // ---------------------------------------------------------------- BUG-001
  // A refreshed cache under a legacy list name is a verified update: the list
  // name alone must not fail, while source path and payload bytes still must match.
  const freshCache = join(temp, 'grok-cache-fresh')
  cpSync(pluginDir, freshCache, { recursive: true })
  const listing = (path, extra = {}) => [{ name: legacyPluginName, repo_key: legacyPluginName, source: pluginDir, path, ...extra }]
  const grokCalls = []
  const grokRun = (payload) => async (command, args) => { grokCalls.push([command, ...args]); return { code: 0, stdout: JSON.stringify(payload) } }
  const updated = await refreshGrokPlugin({ dryRun: false, run: grokRun(listing(freshCache)) })
  assert.equal(updated.status, 'updated', 'a legacy list name with current source and refreshed cache is verified')
  assert.deepEqual(grokCalls, [
    ['grok', 'plugin', 'list', '--json'],
    ['grok', 'plugin', 'update', legacyPluginName],
    ['grok', 'plugin', 'list', '--json'],
  ])
  assert.ok(grokCalls.every((args) => !args.includes('--trust')), 'upgrade never grants trust')

  // The field case: legacy name, correct source path, cache still on the old bytes.
  const staleCache = join(temp, 'grok-cache-stale')
  cpSync(pluginDir, staleCache, { recursive: true })
  write(join(staleCache, 'plugin.json'), { ...json(join(pluginDir, 'plugin.json')), version: '0.2.0', author: 'search-boost' })
  const staleCalls = []
  await assert.rejects(() => refreshGrokPlugin({ dryRun: false, run: async (command, args) => {
    staleCalls.push([command, ...args])
    return { code: 0, stdout: JSON.stringify(listing(staleCache)) }
  } }), /cache payload was not updated or cannot be verified/)
  assert.ok(staleCalls.some((args) => args[2] === 'update'), 'the native update is still attempted for the same source')
  assert.ok(staleCalls.every((args) => !args.includes('--trust') && args[2] !== 'uninstall'), 'a stale cache never triggers uninstall or trust')

  // A different source path is not this installation, even with a valid manifest.
  const elsewhere = join(temp, 'grok-plugin-elsewhere')
  cpSync(pluginDir, elsewhere, { recursive: true })
  const foreignCalls = []
  await assert.rejects(() => refreshGrokPlugin({ dryRun: false, run: async (command, args) => {
    foreignCalls.push([command, ...args])
    return { code: 0, stdout: JSON.stringify([{ name: legacyPluginName, source: elsewhere, path: elsewhere }]) }
  } }), /Cannot verify the updated Grok plugin source/)
  assert.ok(foreignCalls.every((args) => !args.includes('--trust') && args[2] !== 'uninstall'))
  const unrelated = join(temp, 'grok-plugin-foreign')
  write(join(unrelated, 'plugin.json'), { name: 'other' })
  const absent = await refreshGrokPlugin({ dryRun: false, run: async () => ({ code: 0, stdout: JSON.stringify([{ name: 'other', source: unrelated }]) }) })
  assert.equal(absent.status, 'absent', 'a foreign plugin is not reported as an updated SearchBoost plugin')

  // Disabled plugins stay a host decision during upgrade.
  const disabledCalls = []
  const disabled = await refreshGrokPlugin({ dryRun: false, run: async (command, args) => {
    disabledCalls.push([command, ...args])
    return { code: 0, stdout: JSON.stringify(listing(freshCache, { disabled: true })) }
  } })
  assert.equal(disabled.status, 'disabled')
  assert.deepEqual(disabledCalls, [['grok', 'plugin', 'list', '--json']])
  console.log('ok: legacy Grok registration verifies source + cached bytes; stale/foreign/disabled stay unverified or untouched')

  // ---------------------------------------------------------------- BUG-002A
  // Historical test-fixture pollution inside the isolated HOME, never real state.
  const receipts = recordedProjectsPath()
  assert.ok(receipts.startsWith(home), 'this regression must run against the isolated HOME only')
  const polluted = [1, 2, 3, 4, 5].map((n) => join(temp, `sb-grok-fresh-${n}JjtpSG`))
  write(receipts, { projects: [...polluted, project] })
  write(PATHS.claude.config, { mcpServers: { 'search-boost': { command: 'node', args: [join(PKG_ROOT, 'cli.mjs'), 'serve'] } } })
  const noHostRun = async (command, args) => { throw new Error(`unexpected host command: ${command} ${args[0] ?? ''}`) }
  const logs = []
  const log = (line) => logs.push(line)
  const plan = await discoverIntegrations()
  assert.deepEqual(plan.warnings, [], 'stale receipts are not configuration failures')
  assert.equal(plan.skippedRecords.length, 5)
  assert.ok(plan.targets.some((target) => target.id === 'claude'), 'usable integrations are still discovered')
  const skipped = await runUpgrade({ dryRun: true, syncOnly: true, run: noHostRun, log })
  assert.equal(skipped.ok, true, logs.join('\n'))
  assert.equal(skipped.skippedRecords.length, 5)
  assert.equal(logs.filter((line) => line.startsWith('[skipped]')).length, 5, 'every stale record is disclosed')
  assert.ok(logs.some((line) => line.includes('nothing was deleted') && line.includes(receipts)), 'the review location is disclosed')
  assert.ok(logs.every((line) => !line.startsWith('[blocked]')))
  assert.deepEqual(json(receipts).projects.slice().sort(), [...polluted, project].sort(), 'stale receipts are never pruned automatically')

  // An explicit workspace stays an actionable failure, not a skipped receipt.
  const explicitLogs = []
  const explicit = await runUpgrade({ dryRun: true, syncOnly: true, run: noHostRun, log: (line) => explicitLogs.push(line), workspace: join(temp, 'missing-workspace') })
  assert.equal(explicit.ok, false)
  assert.ok(explicit.warnings.some((warning) => warning.startsWith('Workspace unavailable: ')))
  assert.ok(explicitLogs.some((line) => line.startsWith('[blocked]')))
  assert.deepEqual(json(receipts).projects.slice().sort(), [...polluted, project].sort())

  // Real failures still fail while stale receipts stay skipped.
  write(PATHS.claude.config, '{broken-json')
  const mixed = await runUpgrade({ dryRun: true, syncOnly: true, run: noHostRun, log: () => {} })
  assert.equal(mixed.ok, false, 'a real configuration failure must still block completion')
  assert.ok(mixed.warnings.some((warning) => warning.startsWith('claude:')))
  assert.equal(mixed.skippedRecords.length, 5)
  rmSync(PATHS.claude.config, { force: true })
  console.log('ok: stale recorded projects are skipped and disclosed without deleting state; explicit workspace and real failures still block')

  // ---------------------------------------------------------------- BUG-002B
  const codexConfig = join(home, '.codex', 'config.toml')
  const mcpSection = '[mcp_servers.search-boost]\ncommand = "node"\nargs = ["old.mjs"]\nenv.TOKEN = "fixture-secret-must-not-leak"\n'
  const start = '# SEARCH_BOOST_WEB_SEARCH_START\nweb_search = "disabled"\n'
  const end = '# SEARCH_BOOST_WEB_SEARCH_END\n'
  const refusal = (text, path = codexConfig) => {
    try { migrateCodexNativeSearch(text, path) } catch (err) { return err.message }
    throw new Error('marker refusal expected')
  }
  const missingEnd = refusal(start + mcpSection)
  assert.ok(missingEnd.includes(codexConfig), 'the refusal names the affected config path')
  assert.match(missingEnd, /the end marker # SEARCH_BOOST_WEB_SEARCH_END is missing/)
  assert.match(missingEnd, /# SEARCH_BOOST_WEB_SEARCH_START line 1/)
  assert.match(missingEnd, /no automatic repair/)
  const missingStart = refusal(mcpSection + end)
  assert.match(missingStart, /the start marker # SEARCH_BOOST_WEB_SEARCH_START is missing/)
  assert.match(missingStart, /# SEARCH_BOOST_WEB_SEARCH_END line 5/)
  const reversed = refusal(end + start + mcpSection)
  assert.match(reversed, /the end marker \(line 1\) precedes the start marker \(line 2\)/)
  const duplicated = refusal(start + end + start + end + mcpSection)
  assert.match(duplicated, /the start marker # SEARCH_BOOST_WEB_SEARCH_START appears 2 times \(lines 1, 4\)/)
  assert.match(duplicated, /the end marker # SEARCH_BOOST_WEB_SEARCH_END appears 2 times \(lines 3, 6\)/)
  for (const message of [missingEnd, missingStart, reversed, duplicated]) {
    assert.ok(!message.includes('fixture-secret-must-not-leak'), 'diagnostics never include config content')
  }
  const pseudo = `note = """\n${start}"""\nexample = "# SEARCH_BOOST_WEB_SEARCH_END"\n${mcpSection}`
  assert.equal(migrateCodexNativeSearch(pseudo, codexConfig), pseudo, 'pseudo markers inside strings are not statements')
  assert.equal(migrateCodexNativeSearch(mcpSection, codexConfig), mcpSection, 'an unmarked config passes through unchanged')

  const codexBefore = start + mcpSection
  write(codexConfig, codexBefore)
  await assert.rejects(() => refreshIntegration({ kind: 'mcp', id: 'codex', label: 'codex', paths: PATHS.codex }, { dryRun: false, run: noHostRun }), (err) =>
    err.message.includes(codexConfig) && /line 1/.test(err.message) && !err.message.includes('fixture-secret-must-not-leak'))
  assert.equal(readFileSync(codexConfig, 'utf8'), codexBefore, 'the refusal precedes every write')

  // Field shape from the Windows default config (C:\\Users\\Administrator\\.codex\\config.toml):
  // exactly one standalone END marker at line 594 and no START. The refusal must name
  // the missing START, the END line and the config path, and must never repair or delete it.
  const windowsConfig = 'C:\\Users\\Administrator\\.codex\\config.toml'
  const loneEndText = `${'# user configuration line\n'.repeat(593)}# SEARCH_BOOST_WEB_SEARCH_END\n`
  const loneEnd = refusal(loneEndText, windowsConfig)
  assert.match(loneEnd, /the start marker # SEARCH_BOOST_WEB_SEARCH_START is missing/)
  assert.ok(loneEnd.includes('# SEARCH_BOOST_WEB_SEARCH_END line 594'), loneEnd)
  assert.ok(loneEnd.includes(windowsConfig))
  assert.match(loneEnd, /no automatic repair/)
  assert.equal(codexRootSearchDisabled(loneEndText), false)
  for (const replace of [true, false]) {
    assert.throws(() => setCodexNativeSearch(loneEndText, replace), /Incomplete\/duplicate SearchBoost web_search marker/, 'no blind repair of a lone marker')
  }
  write(codexConfig, loneEndText)
  await assert.rejects(() => refreshIntegration({ kind: 'mcp', id: 'codex', label: 'codex', paths: PATHS.codex }, { dryRun: false, run: noHostRun }), (err) =>
    err.message.includes(codexConfig) && err.message.includes('line 594') && /the start marker/.test(err.message))
  assert.equal(readFileSync(codexConfig, 'utf8'), loneEndText, 'the lone END marker is neither deleted nor completed')
  console.log('ok: Codex marker refusals report path, marker lines, missing/duplicate/reversed shape and leave the file untouched')

  // ---------------------------------------------------------------- BUG-002C
  const version = '2.0.0'
  // An npm-exec-style root is registered by version spec instead of a local link.
  const dshSource = join(temp, '_npx', 'cache', 'node_modules', 'search-boost')
  write(join(dshSource, 'package.json'), { name: 'search-boost', version, dsh: { bundle: { patch: './adapters/dsh/cordis.patch.yml' } } })
  for (const file of ['cli.mjs', 'adapters/pi/index.js', 'adapters/dsh/index.js', 'adapters/dsh/schema.js', 'adapters/dsh/cordis.patch.yml']) write(join(dshSource, file), `// fixture ${file}\n`)
  rmSync(PATHS.dsh.profiles, { recursive: true, force: true })

  function setupProfile(name, { dependency = `^${version}`, bundles = ['user-plugin', 'search-boost'], legacy = false } = {}) {
    const dir = join(PATHS.dsh.profiles, name)
    const installed = join(dir, 'node_modules', 'search-boost')
    write(join(dir, 'package.json'), {
      dependencies: { 'user-plugin': '1.0.0', 'search-boost': dependency, ...(legacy ? { 'dsh-search-boost': '0.1.3' } : {}) },
      dsh: { profile: { bundles: legacy ? ['user-plugin', 'dsh-search-boost'] : bundles, custom: 'keep' } },
    })
    for (const file of ['pnpm-lock.yaml', 'pnpm-workspace.yaml', 'cordis.yml']) write(join(dir, file), `original ${file}\n`)
    mkdirSync(installed, { recursive: true })
    cpSync(dshSource, installed, { recursive: true })
    return { name, dir, installed, manifest: join(dir, 'package.json') }
  }
  function dshHost(profile, { add, remove } = {}) {
    const dispatches = []
    let probes = 0
    const run = async (command, args, options = {}) => {
      const nonce = options.env?.SEARCH_BOOST_DSH_PROBE_NONCE
      if (nonce) {
        probes++
        const manifest = json(join(profile.installed, 'package.json'))
        return { code: 0, stdout: `SEARCH_BOOST_DSH_RUNTIME:${nonce}:${JSON.stringify({
          root: realpathSync(profile.installed), name: manifest.name, version: manifest.version,
          patch: './adapters/dsh/cordis.patch.yml', files: true, installAnchor: join(profile.dir, 'package.json'),
        })}\n` }
      }
      const index = args.indexOf('plugin')
      const verb = args[index + 3], spec = args[index + 4]
      dispatches.push({ verb, spec })
      await (verb === 'add' ? add : remove)?.(verb, spec)
      return { code: 0, stdout: '' }
    }
    return { run, dispatches, probes: () => probes }
  }
  const target = (name) => ({ kind: 'dsh', id: 'dsh', label: `dsh (${name})`, profile: name, dir: join(PATHS.dsh.profiles, name) })

  // Already synced: verification passes and nothing is dispatched, backed up or rewritten.
  const synced = setupProfile('beta6-synced')
  const syncedFacts = []
  const syncedBackups = backupsSnapshot(), syncedManifest = readFileSync(synced.manifest, 'utf8'), syncedReceipt = readIfExists(join(process.env.SEARCH_BOOST_HOME, 'state', 'package-sources.json'))
  const syncedHost = dshHost(synced)
  await refreshIntegration(target(synced.name), { run: syncedHost.run, packageRoot: dshSource, report: (fact) => syncedFacts.push(fact) })
  assert.equal(syncedHost.dispatches.length, 0, 'an already-synced profile must not run a host package command')
  assert.equal(syncedHost.probes(), 1, 'source, version, payload and resolver are still verified once')
  assert.deepEqual(syncedFacts.map((fact) => [fact.stage, fact.action, fact.hostDispatches, fact.verifications]), [['dsh', 'already-synced', 0, 1]])
  assert.equal(typeof syncedFacts[0].verificationMs, 'number')
  assert.equal(readFileSync(synced.manifest, 'utf8'), syncedManifest)
  assert.equal(backupsSnapshot(), syncedBackups, 'a no-change sync writes no backup')
  assert.equal(readIfExists(join(process.env.SEARCH_BOOST_HOME, 'state', 'package-sources.json')), syncedReceipt)

  // Dry-run must not probe or dispatch either.
  const dryHost = dshHost(synced)
  await refreshIntegration(target(synced.name), { run: dryHost.run, packageRoot: dshSource, dryRun: true })
  assert.equal(dryHost.probes(), 0)
  assert.equal(dryHost.dispatches.length, 0)

  // Same version, different payload bytes cannot be skipped.
  const staleProfile = setupProfile('beta6-payload')
  write(join(staleProfile.installed, 'cli.mjs'), '// stale same-version payload\n')
  const staleHost = dshHost(staleProfile)
  const staleBefore = readFileSync(staleProfile.manifest, 'utf8')
  await assert.rejects(() => refreshIntegration(target(staleProfile.name), { run: staleHost.run, packageRoot: dshSource }), /payload differs/)
  assert.deepEqual(staleHost.dispatches, [{ verb: 'add', spec: `search-boost@${version}` }], 'stale payload still goes through the host install path')
  assert.equal(readFileSync(staleProfile.manifest, 'utf8'), staleBefore, 'a failed refresh restores the profile')

  // A stale registered version cannot be skipped; the real refresh still verifies once.
  const sourceProfile = setupProfile('beta6-source', { dependency: '^1.0.0' })
  const sourceFacts = []
  const repair = async () => { const pkg = json(sourceProfile.manifest); pkg.dependencies['search-boost'] = `^${version}`; write(sourceProfile.manifest, pkg) }
  const sourceHost = dshHost(sourceProfile, { add: repair })
  await refreshIntegration(target(sourceProfile.name), { run: sourceHost.run, packageRoot: dshSource, report: (fact) => sourceFacts.push(fact) })
  assert.deepEqual(sourceHost.dispatches, [{ verb: 'add', spec: `search-boost@${version}` }], 'a stale registered source is refreshed, never skipped')
  assert.deepEqual(sourceFacts.map((fact) => [fact.action, fact.hostDispatches, fact.verifications]), [['refreshed', 1, 1]], 'no host change after verification reuses that evidence')
  const repeatFacts = [], repeatHost = dshHost(sourceProfile)
  await refreshIntegration(target(sourceProfile.name), { run: repeatHost.run, packageRoot: dshSource, report: (fact) => repeatFacts.push(fact) })
  assert.equal(repeatHost.dispatches.length, 0, 'the repeat sync of the same version stops dispatching the host')
  assert.deepEqual(repeatFacts.map((fact) => fact.action), ['already-synced'])

  // Legacy registrations are real state changes: add, remove and a second verification.
  const legacyProfile = setupProfile('beta6-legacy', { dependency: '^1.0.0', legacy: true })
  const legacyFacts = []
  const legacyHost = dshHost(legacyProfile, {
    add: async () => { const pkg = json(legacyProfile.manifest); pkg.dependencies['search-boost'] = `^${version}`; write(legacyProfile.manifest, pkg) },
    remove: async (_verb, spec) => {
      const pkg = json(legacyProfile.manifest)
      delete pkg.dependencies[spec]
      pkg.dsh.profile.bundles = pkg.dsh.profile.bundles.filter((name) => name !== spec)
      write(legacyProfile.manifest, pkg)
    },
  })
  await refreshIntegration(target(legacyProfile.name), { run: legacyHost.run, packageRoot: dshSource, report: (fact) => legacyFacts.push(fact) })
  assert.deepEqual(legacyHost.dispatches, [{ verb: 'add', spec: `search-boost@${version}` }, { verb: 'remove', spec: 'dsh-search-boost' }])
  assert.equal(legacyHost.probes(), 2, 'legacy removal is a real host change: verification is not reused')
  assert.deepEqual(legacyFacts.map((fact) => [fact.action, fact.hostDispatches, fact.verifications]), [['migrated', 2, 2]])
  assert.deepEqual(json(legacyProfile.manifest).dsh.profile, { bundles: ['user-plugin', 'search-boost'], custom: 'keep' })

  // A disabled bundle stays disabled and is not re-enabled by a repeat sync.
  const disabledProfile = setupProfile('beta6-disabled', { bundles: ['user-plugin'] })
  const disabledHost = dshHost(disabledProfile)
  await refreshIntegration(target(disabledProfile.name), { run: disabledHost.run, packageRoot: dshSource })
  assert.equal(disabledHost.dispatches.length, 0)
  assert.deepEqual(json(disabledProfile.manifest).dsh.profile.bundles, ['user-plugin'])

  // End-to-end: the durable record carries per-target timing/dispatch facts.
  // This profile links the real running package, so a real runUpgrade can verify
  // and skip it without inventing a different installed version.
  rmSync(PATHS.dsh.profiles, { recursive: true, force: true })
  rmSync(codexConfig, { force: true })
  const repeatDir = join(PATHS.dsh.profiles, 'beta6-repeat')
  const repeatInstalled = join(repeatDir, 'node_modules', 'search-boost')
  write(join(repeatDir, 'package.json'), { dependencies: { 'user-plugin': '1.0.0', 'search-boost': PKG_ROOT }, dsh: { profile: { bundles: ['user-plugin', 'search-boost'], custom: 'keep' } } })
  for (const file of ['pnpm-lock.yaml', 'pnpm-workspace.yaml', 'cordis.yml']) write(join(repeatDir, file), `original ${file}\n`)
  mkdirSync(dirname(repeatInstalled), { recursive: true })
  // Windows junctions require a local-volume target; WSL UNC checkouts need
  // a directory symbolic link instead (no fixture follows/deletes its target).
  symlinkSync(PKG_ROOT, repeatInstalled, process.platform === 'win32' && !PKG_ROOT.startsWith('\\\\') ? 'junction' : 'dir')
  const repeat = { name: 'beta6-repeat', dir: repeatDir, installed: repeatInstalled, manifest: join(repeatDir, 'package.json') }
  const upgradeLogs = [], upgradeHost = dshHost(repeat)
  const upgrade = await runUpgrade({ syncOnly: true, run: upgradeHost.run, log: (line) => upgradeLogs.push(line) })
  assert.equal(upgrade.ok, true, upgradeLogs.join('\n'))
  assert.equal(upgradeHost.dispatches.length, 0)
  assert.ok(upgradeLogs.some((line) => line.startsWith('[timing]') && line.includes('already-synced')), 'timing/dispatch facts are reported without secrets')
  const dshResult = upgrade.results.find((result) => result.target.includes('beta6-repeat'))
  assert.equal(dshResult.facts[0].action, 'already-synced')
  assert.ok(Number.isInteger(dshResult.durationMs) && dshResult.durationMs >= 0)
  const record = json(join(process.env.SEARCH_BOOST_HOME, 'state', 'last-upgrade.json'))
  assert.equal(record.results.find((result) => result.target.includes('beta6-repeat')).facts[0].verifications, 1)
  assert.equal(record.skippedRecords.length, 5, 'the durable record also discloses the skipped stale receipts')
  assert.ok(!JSON.stringify(record).includes('fixture-secret-must-not-leak'))
  assert.ok(!upgradeLogs.join('\n').includes('fixture-secret-must-not-leak'))
  console.log(`ok: DSH repeat sync verifies once and stops dispatching; timing facts recorded for v${getVersion()} upgrade runs`)
} finally {
  process.chdir(originalCwd)
  rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}
console.log('All beta.6 upgrade regressions passed.')
