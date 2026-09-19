#!/usr/bin/env node
/** Future releases, not today's version: v1 → v2 → v3 at different roots.
 * Host package-manager HTTP/process calls are injected. Installed modules are
 * real symlinks, and fresh Node processes verify the active adapter payload.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync, existsSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'

const temp = mkdtempSync(join(tmpdir(), 'sb future upgrade '))
const home = join(temp, 'home'), workspace = join(temp, 'workspace')
mkdirSync(home); mkdirSync(workspace)
process.env.HOME = process.env.USERPROFILE = home
process.env.PI_CODING_AGENT_DIR = join(home, '.pi', 'agent')
process.env.DSH_HOME = join(home, '.dsh')
process.env.SEARCH_BOOST_HOME = join(home, '.search-boost')
for (const key of Object.keys(process.env)) {
  if (/^SEARCH_BOOST_.*_FILE$/.test(key) || key === 'SEARCH_BOOST_UPGRADE_HANDOFF') delete process.env[key]
}
const cwd = process.cwd()
process.chdir(workspace)
const { PKG_ROOT } = await import('../lib/pkg.mjs')
const { PATHS, agentConfigured } = await import('../lib/paths.mjs')
const { packageIdentity, inspectPackageSource } = await import('../lib/package-identity.mjs')
const { packageSourcesPath } = await import('../lib/package-sources.mjs')
const { discoverIntegrations, refreshIntegration } = await import('../lib/upgrade/integrations.mjs')
const { recordUpgradeProject } = await import('../lib/upgrade/state.mjs')
const { piSubagentTemplatePaths, piWorkflowPromptPaths } = await import('../agents/router.mjs')
const { installPiExtension, uninstallPiExtension } = await import('../lib/agents/host-runtime.mjs')
const write = (file, data) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, typeof data === 'string' ? data : JSON.stringify(data, null, 2)) }
const json = (file) => JSON.parse(readFileSync(file, 'utf8'))
const bytes = (file) => readFileSync(file, 'utf8')
const piEntry = (root) => join(root, 'adapters', 'pi', 'index.js')
const dshEntry = (root) => join(root, 'adapters', 'dsh', 'index.js')
const link = (root, dest) => {
  mkdirSync(dirname(dest), { recursive: true })
  rmSync(dest, { recursive: true, force: true })
  symlinkSync(root, dest, process.platform === 'win32' ? 'junction' : 'dir')
}
function release(version, suffix = version) {
  const root = join(temp, 'releases', `release-${suffix}`)
  write(join(root, 'package.json'), { name: 'search-boost', version, type: 'module', pi: { extensions: ['./adapters/pi/index.js'] }, dsh: { bundle: { patch: './adapters/dsh/cordis.patch.yml' } } })
  write(join(root, 'cli.mjs'), '// fixture cli')
  for (const entry of [piEntry(root), dshEntry(root)]) write(entry, `export default () => ${JSON.stringify(version)}\n`)
  write(join(root, 'adapters', 'dsh', 'cordis.patch.yml'), '# fixture bundle')
  for (const src of [...piSubagentTemplatePaths(), ...piWorkflowPromptPaths()]) write(join(root, relative(PKG_ROOT, src)), `${bytes(src)}\n<!-- release ${version} -->\n`)
  return root
}
function loadedVersion(entry) {
  return execFileSync(process.execPath, ['--input-type=module', '-e', `console.log((await import(${JSON.stringify(pathToFileURL(entry).href)})).default())`], { encoding: 'utf8', timeout: 10_000 }).trim()
}
const calls = []
let noOp = false, staleLink = false, failRemove = false
async function run(command, args) {
  calls.push({ command, args })
  assert.equal(command, 'dsh')
  const [, , profile, verb, source] = args
  const dir = join(PATHS.dsh.profiles, profile)
  const file = join(dir, 'package.json')
  const pkg = json(file)
  if (noOp) return { code: 0, stdout: '' }
  if (verb === 'add') {
    const existed = !!pkg.dependencies['search-boost']
    pkg.dependencies['search-boost'] = `link:${source}`
    // Current DSH does not re-enable already installed/disabled bundles.
    if (!existed) pkg.dsh.profile.bundles.push('search-boost')
    write(file, pkg)
    write(join(dir, 'pnpm-lock.yaml'), `fixture-source: ${source}\n`)
    if (!staleLink) link(source, join(dir, 'node_modules', 'search-boost'))
    return { code: 0, stdout: '' }
  }
  assert.equal(verb, 'remove')
  if (failRemove) return { code: 1, stdout: '', stderr: 'fixture failure' }
  delete pkg.dependencies[source]
  pkg.dsh.profile.bundles = pkg.dsh.profile.bundles.filter((name) => name !== source)
  write(file, pkg)
  return { code: 0, stdout: '' }
}
let tests = 0
async function test(name, fn) { await fn(); tests++; console.log(`ok: ${name}`) }
try {
  const v1 = release('1.0.0'), v2 = release('2.0.0'), v3 = release('3.0.0')
  const scopes = []
  for (const name of ['global-extension', 'package', 'relative', 'file-url', 'disabled', 'shim', 'manual']) {
    const agentDir = name === 'global-extension' ? PATHS.pi.agentDir : join(workspace, name, '.pi')
    if (name !== 'global-extension') await recordUpgradeProject(dirname(agentDir))
    const settings = { userSetting: { unchanged: true }, packages: ['npm:unrelated-tools'] }
    if (name === 'package') settings.packages.push({ source: v1, extensions: [], skills: [], autoload: false })
    else if (name === 'relative') settings.extensions = [relative(agentDir, piEntry(v1))]
    else if (name === 'file-url') settings.extensions = [pathToFileURL(piEntry(v1)).href]
    else if (name === 'disabled') settings.extensions = [`-${piEntry(v1)}`]
    else if (name === 'shim') write(join(agentDir, 'extensions', 'search-boost.js'), `// search-boost pi extension shim\nexport { default } from ${JSON.stringify(pathToFileURL(piEntry(v1)).href)}\n`)
    else if (name === 'manual') {
      const manual = join(agentDir, 'extensions', 'search-boost')
      write(join(manual, 'package.json'), { name: 'search-boost', version: '1.0.0', pi: { extensions: ['index.js'] } })
      write(join(manual, 'index.js'), 'export default () => "1.0.0"')
      write(join(manual, 'user-notes.txt'), 'keep this when archiving')
    } else settings.extensions = [piEntry(v1)]
    write(join(agentDir, 'settings.json'), settings)
    scopes.push({ name, agentDir })
  }
  for (const profile of ['enabled', 'disabled']) {
    const dir = join(PATHS.dsh.profiles, profile)
    write(join(dir, 'package.json'), { dependencies: { 'search-boost': `link:${v1}`, 'user-bundle': '1.0.0' }, dsh: { profile: { bundles: profile === 'disabled' ? ['user-bundle'] : ['user-bundle', 'search-boost'], custom: { enabled: false } } } })
    write(join(dir, 'cordis.patch.yml'), 'custom: unchanged\n')
    link(v1, join(dir, 'node_modules', 'search-boost'))
  }
  async function plan() {
    const value = await discoverIntegrations({ workspace })
    assert.deepEqual(value.warnings, [])
    return value.targets.filter((target) => ['pi', 'dsh'].includes(target.kind))
  }
  async function checkRelease(root, version) {
    const targets = await plan()
    assert.equal(targets.length, scopes.length + 2, 'every migrated scope must remain discoverable')
    for (const { name, agentDir } of scopes) {
      const settings = json(join(agentDir, 'settings.json'))
      assert.deepEqual(settings.userSetting, { unchanged: true })
      assert.equal(settings.packages[0], 'npm:unrelated-tools')
      if (name === 'package') assert.deepEqual(settings.packages[1], { source: root, extensions: [], skills: [], autoload: false })
      else if (settings.extensions) assert.deepEqual(settings.extensions, [(name === 'disabled' ? '-' : '') + piEntry(root)])
      else assert.equal(loadedVersion(join(agentDir, 'extensions', 'search-boost.js')), version)
      assert.ok(bytes(join(agentDir, 'agents', 'searcher.md')).includes(`release ${version}`))
      assert.equal(loadedVersion(piEntry(root)), version)
    }
    for (const profile of ['enabled', 'disabled']) {
      const dir = join(PATHS.dsh.profiles, profile)
      const pkg = json(join(dir, 'package.json'))
      assert.equal(pkg.dependencies['search-boost'], `link:${root}`)
      assert.equal(pkg.dependencies['user-bundle'], '1.0.0')
      assert.deepEqual(pkg.dsh.profile.bundles, profile === 'disabled' ? ['user-bundle'] : ['user-bundle', 'search-boost'])
      assert.deepEqual(pkg.dsh.profile.custom, { enabled: false })
      assert.equal(bytes(join(dir, 'cordis.patch.yml')), 'custom: unchanged\n')
      assert.equal(loadedVersion(dshEntry(join(dir, 'node_modules', 'search-boost'))), version)
    }
  }
  await test('source identity follows package metadata, not current root/version or filename', () => {
    assert.equal(packageIdentity(piEntry(v1), PATHS.pi.agentDir), 'search-boost')
    assert.equal(packageIdentity(`-${piEntry(v1)}`, PATHS.pi.agentDir), 'search-boost')
    assert.equal(packageIdentity(pathToFileURL(piEntry(v1)).href, PATHS.pi.agentDir), 'search-boost')
    const arbitrary = join(v1, 'user', 'extension.js')
    write(arbitrary, 'export default () => {}')
    assert.equal(packageIdentity(arbitrary, PATHS.pi.agentDir), null, 'not every file inside our repo is a managed entry')
    const foreign = join(v1, 'node_modules', 'foreign')
    write(join(foreign, 'package.json'), { name: 'foreign' })
    write(join(foreign, 'index.js'), 'export default () => {}')
    assert.equal(packageIdentity(join(foreign, 'index.js'), PATHS.pi.agentDir), null)
    assert.equal(packageIdentity(join(temp, 'unowned', 'search-boost', 'adapters', 'pi', 'index.js'), PATHS.pi.agentDir), null)
    assert.equal(packageIdentity('git:git@github.com:Mr-remon219/search-boost.git@v2', PATHS.pi.agentDir), 'search-boost')
  })
  await test('v1 → v2 refreshes every Pi source shape and active/disabled DSH profiles', async () => {
    const targets = await plan()
    assert.equal(targets.length, scopes.length + 2)
    for (const target of targets) await refreshIntegration(target, { packageRoot: v2, run })
    await checkRelease(v2, '2.0.0')
    assert.ok(agentConfigured('pi'))
    assert.equal(json(packageSourcesPath()).schema, 1)
  })
  await test('second upgrade survives deletion of ALL previous release directories', async () => {
    rmSync(v1, { recursive: true })
    rmSync(v2, { recursive: true })
    const downgrade = release('1.9.0')
    for (const target of await plan()) await assert.rejects(refreshIntegration(target, { packageRoot: downgrade, run }), /refusing downgrade/)
    // Resolve in another process as well: no warm in-memory ownership cache.
    const resolver = pathToFileURL(join(PKG_ROOT, 'lib', 'package-identity.mjs')).href
    assert.equal(execFileSync(process.execPath, ['--input-type=module', '-e', `const {packageIdentity}=await import(${JSON.stringify(resolver)}); console.log(packageIdentity(${JSON.stringify(piEntry(v2))},${JSON.stringify(PATHS.pi.agentDir)}));`], { encoding: 'utf8' }).trim(), 'search-boost')
    for (const target of await plan()) await refreshIntegration(target, { packageRoot: v3, run })
    await checkRelease(v3, '3.0.0')
  })
  await test('replacement aliases resolve to the canonical package without broken shim checks', async () => {
    const alias = join(temp, 'replacement-alias')
    link(v3, alias)
    for (const target of await plan()) await refreshIntegration(target, { packageRoot: alias, run })
    await checkRelease(v3, '3.0.0')
  })
  await test('same-version refresh remains idempotent and disabled DSH stays disabled', async () => {
    const file = join(PATHS.pi.agentDir, 'settings.json')
    const before = bytes(file)
    for (const target of await plan()) await refreshIntegration(target, { packageRoot: v3, run })
    assert.equal(bytes(file), before)
    await checkRelease(v3, '3.0.0')
  })
  await test('dry-run and downgrade guards cover active local Pi sources and DSH payloads', async () => {
    const older = release('2.9.0')
    const beforeCalls = calls.length, receipt = bytes(packageSourcesPath())
    for (const target of await plan()) {
      await refreshIntegration(target, { packageRoot: v3, dryRun: true, run })
      await assert.rejects(refreshIntegration(target, { packageRoot: older, run }), /refusing downgrade/)
    }
    assert.equal(calls.length, beforeCalls)
    assert.equal(bytes(packageSourcesPath()), receipt)
  })
  await test('npm and git Pi sources guard their own installed versions, not a stale unrelated cache', async () => {
    const scope = join(temp, 'source-scope')
    for (const [source, root] of [
      ['npm:search-boost', join(scope, 'npm', 'node_modules', 'search-boost')],
      ['git:github.com/Mr-remon219/search-boost', join(scope, 'git', 'github.com', 'Mr-remon219', 'search-boost')],
    ]) {
      write(join(root, 'package.json'), { name: 'search-boost', version: '99.0.0' })
      assert.equal(inspectPackageSource(source, scope).version, '99.0.0')
    }
  })
  await test('DSH successful no-op/stale same-version link is rejected and config bytes restored', async () => {
    const target = (await plan()).find((t) => t.kind === 'dsh')
    const file = join(target.dir, 'package.json'), before = bytes(file)
    const copy = release('3.0.0', 'same-version-different-root')
    noOp = true
    await assert.rejects(refreshIntegration(target, { packageRoot: copy, run }), /did not switch/)
    noOp = false; staleLink = true
    await assert.rejects(refreshIntegration(target, { packageRoot: copy, run }), /different installation/)
    staleLink = false
    assert.equal(bytes(file), before)
    assert.equal(realpathSync(join(target.dir, 'node_modules', 'search-boost')), realpathSync(v3))
    await refreshIntegration(target, { packageRoot: copy, run })
    assert.equal(realpathSync(join(target.dir, 'node_modules', 'search-boost')), realpathSync(copy))
  })
  await test('DSH partial legacy cleanup can be retried without deleting the new registration', async () => {
    const target = (await plan()).find((t) => t.kind === 'dsh')
    const file = join(target.dir, 'package.json'), pkg = json(file)
    pkg.dependencies['dsh-search-boost'] = '0.1.3'
    write(file, pkg)
    failRemove = true
    await assert.rejects(refreshIntegration(target, { packageRoot: v3, run }), /legacy cleanup failed/)
    assert.equal(json(file).dependencies['search-boost'], `link:${v3}`)
    failRemove = false
    await refreshIntegration(target, { packageRoot: v3, run })
    assert.ok(!json(file).dependencies['dsh-search-boost'])
  })
  await test('stale discovery cannot recreate a removed DSH registration', async () => {
    const target = (await plan()).find((t) => t.kind === 'dsh')
    const file = join(target.dir, 'package.json'), original = bytes(file), pkg = json(file)
    delete pkg.dependencies['search-boost']
    pkg.dsh.profile.bundles = pkg.dsh.profile.bundles.filter((name) => name !== 'search-boost')
    write(file, pkg)
    const beforeCalls = calls.length
    await assert.rejects(refreshIntegration(target, { packageRoot: v3, run }), /registration disappeared/)
    assert.equal(calls.length, beforeCalls)
    assert.ok(!json(file).dependencies['search-boost'])
    write(file, original)
  })
  await test('owned path receipts cannot claim existing foreign replacements', () => {
    const foreign = join(v3, 'package.json')
    const original = bytes(foreign)
    write(foreign, { name: 'user-owned', version: '3.0.0' })
    assert.equal(packageIdentity(piEntry(v3), PATHS.pi.agentDir), null)
    write(foreign, original)
  })
  await test('future Pi installs remain manageable; no duplicate shim and no resurrection after uninstall', async () => {
    await installPiExtension({ dryRun: false })
    assert.ok(!existsSync(PATHS.pi.extension))
    await uninstallPiExtension({ dryRun: false })
    assert.equal(agentConfigured('pi'), false)
    assert.deepEqual(json(join(PATHS.pi.agentDir, 'settings.json')).extensions, [])
    assert.ok(!(await plan()).some((target) => target.kind === 'pi' && target.agentDir === PATHS.pi.agentDir))
  })
  console.log(`\n${tests} future host-upgrade tests passed.`)
} finally {
  process.chdir(cwd)
  rmSync(temp, { recursive: true, force: true })
}
