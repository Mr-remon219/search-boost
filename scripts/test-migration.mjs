#!/usr/bin/env node
/** Real npm/npx, a loopback fixture registry, and an isolated HOME/global prefix.
 * No transition release, --force, real credentials, or developer installations.
 * DSH alone is a protocol fixture; npm install/uninstall/bin handoff are real.
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, existsSync, cpSync, rmSync } from 'node:fs'
import { join, dirname, isAbsolute } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { PKG_ROOT } from '../lib/pkg.mjs'
import { runCommand, npmCliEntry } from '../lib/upgrade/process.mjs'

const temp = mkdtempSync(join(tmpdir(), 'sb npm migration '))
const home = join(temp, 'home'), prefix = join(temp, 'prefix'), cwd = join(temp, 'workspace'), tools = join(temp, 'tools')
for (const path of [home, prefix, cwd, tools]) mkdirSync(path)
const env = { ...process.env, HOME: home, USERPROFILE: home, SEARCH_BOOST_HOME: join(home, '.search-boost'), PI_CODING_AGENT_DIR: join(home, '.pi', 'agent'), DSH_HOME: join(home, '.dsh'), npm_config_prefix: prefix, npm_config_cache: join(temp, 'cache'), npm_config_offline: 'false', npm_config_fetch_retries: '0', npm_config_update_notifier: 'false', npm_config_audit: 'false', npm_config_prefer_online: 'true', NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' }
for (const key of Object.keys(env)) if (/^SEARCH_BOOST_.*_FILE$/.test(key) || /^SEARCH_BOOST_UPGRADE_/.test(key)) delete env[key]
const write = (path, value) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value, null, 2)) }
const json = (path) => JSON.parse(readFileSync(path, 'utf8'))
const bytes = (path) => readFileSync(path, 'utf8')
async function checked(command, args, options = {}) {
  const result = await runCommand(command, args, { env, cwd, ...options })
  assert.equal(result.code, 0, `${command} ${args[0]}:\n${result.stdout}\n${result.stderr}`)
  return result.stdout
}
// Drive npm through its own CLI entry instead of the PATH shim: on Windows the
// npm.cmd shim resolves node_modules\npm\bin\npm-*.js relative to itself, which
// cannot work from inside fixture directories. npm_execpath is set whenever npm
// runs this script; running the file directly still falls back to the shim.
const npmCli = process.env.npm_execpath
const checkedNpm = (args, options = {}) => (
  npmCli ? checked(process.execPath, [npmCli, ...args], options) : checked('npm', args, options)
)
async function pack(dir) {
  const result = JSON.parse(await checkedNpm(['pack', '--ignore-scripts', '--json'], { cwd: dir }))
  return join(dir, (Array.isArray(result) ? result[0] : Object.values(result)[0]).filename)
}
const bin = (name) => process.platform === 'win32' ? join(prefix, `${name}.cmd`) : join(prefix, 'bin', name)
let latest = '2.0.0', available = true, registry
const releases = new Map()
const server = createServer((req, res) => {
  if (req.url === '/search-boost' && available) {
    const versions = Object.fromEntries([...releases].map(([version, release]) => [version, { ...release.pkg, dist: { tarball: `${registry}/search-boost/-/${version}.tgz`, shasum: createHash('sha1').update(release.tar).digest('hex') } }]))
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    res.end(JSON.stringify({ name: 'search-boost', 'dist-tags': { latest }, versions }))
  } else {
    const version = /^\/search-boost\/-\/(.+)\.tgz$/.exec(req.url)?.[1]
    const release = releases.get(version)
    if (release && available) { res.writeHead(200, { 'content-type': 'application/octet-stream' }); res.end(release.tar) }
    else { res.writeHead(404, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end('{"error":"fixture package unavailable"}') }
  }
})
try {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  registry = `http://127.0.0.1:${server.address().port}`
  env.npm_config_registry = registry
  const original = join(temp, 'original')
  write(join(original, 'package.json'), { name: 'search-boost-mcp', version: '9.0.0', bin: { 'search-boost': './cli.mjs', 'search-boost-mcp': './cli.mjs' } })
  write(join(original, 'cli.mjs'), '#!/usr/bin/env node\nconsole.log("old fixture")\n')
  await checkedNpm(['install', '--global', '--ignore-scripts', '--force=false', '--no-audit', '--no-fund', await pack(original)])
  const root = (await checkedNpm(['root', '--global'])).trim()
  const currentRoot = join(root, 'search-boost'), legacyRoot = join(root, 'search-boost-mcp')
  assert.ok(existsSync(bin('search-boost')) && existsSync(bin('search-boost-mcp')))

  for (const version of ['2.0.0', '2.1.0']) {
    const dir = join(temp, `new-${version}`), pkg = json(join(PKG_ROOT, 'package.json'))
    mkdirSync(dir)
    for (const path of pkg.files) cpSync(join(PKG_ROOT, path), join(dir, path), { recursive: true })
    // CLI-only fixtures don't need third-party packages. These tests do not
    // claim a real authenticated MCP/Pi/DSH process loaded its tool extensions.
    delete pkg.dependencies; delete pkg.scripts
    pkg.version = version
    write(join(dir, 'package.json'), pkg)
    const template = join(dir, 'agents', 'pi', 'agents', 'searcher.md')
    write(template, bytes(template) + `\n<!-- fixture-release ${version} -->\n`)
    releases.set(version, { pkg, tar: readFileSync(await pack(dir)) })
  }

  // Lightweight DSH profile manager, exercised through the real updater process.
  const dsh = join(tools, 'dsh.mjs')
  write(dsh, `#!/usr/bin/env node
import {readFileSync,writeFileSync,mkdirSync,rmSync,symlinkSync} from 'node:fs'; import {join,dirname} from 'node:path';
const [command,flag,profile,verb,source]=process.argv.slice(2); if(command!=='plugin'||flag!=='--profile') process.exit(2);
const dir=join(process.env.DSH_HOME,'profiles',profile),file=join(dir,'package.json'),pkg=JSON.parse(readFileSync(file,'utf8'));
if(verb==='add'){ const existed=!!pkg.dependencies['search-boost']; pkg.dependencies['search-boost']='link:'+source;
 if(!existed) pkg.dsh.profile.bundles.push('search-boost'); const dest=join(dir,'node_modules','search-boost');mkdirSync(dirname(dest),{recursive:true});rmSync(dest,{recursive:true,force:true});symlinkSync(source,dest,process.platform==='win32'?'junction':'dir');
}else if(verb==='remove'){delete pkg.dependencies[source];pkg.dsh.profile.bundles=pkg.dsh.profile.bundles.filter(x=>x!==source);}else process.exit(2);
writeFileSync(file,JSON.stringify(pkg,null,2));`)
  if (process.platform === 'win32') write(join(tools, 'dsh.cmd'), `@"${process.execPath}" "${dsh}" %*\r\n`)
  else { write(join(tools, 'dsh'), `#!/bin/sh\nexec "${process.execPath}" "${dsh}" "$@"\n`); const { chmodSync } = await import('node:fs'); chmodSync(join(tools, 'dsh'), 0o755) }
  const sep = process.platform === 'win32' ? ';' : ':'
  // Windows stores the variable as `Path`, so `env.PATH` is undefined there and
  // this rewrite used to drop node itself: npm's generated bin shims start with
  // `"node" ...`, which then fails with "not recognized as an internal command".
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === 'path')
  if (!pathKey) throw new Error('migration fixture needs PATH in the environment')
  env[pathKey] = [tools, process.platform === 'win32' ? prefix : join(prefix, 'bin'), dirname(process.execPath), env[pathKey]].join(sep)

  const token = join(home, '.search-boost', 'config', 'xauth.json'), keys = join(home, '.dsh-search-boost-keys.json'), layer = join(home, '.search-boost', 'config', 'layer.json')
  write(token, { token: 'fixture-secret-not-real' }); write(keys, { tavily: 'fixture-key-not-real' }); write(layer, { layer: 'free' })
  const protectedBytes = [token, keys, layer].map((file) => [file, bytes(file)])
  const claude = join(home, '.claude.json'), codex = join(home, '.codex', 'config.toml'), cursor = join(home, '.cursor', 'mcp.json')
  write(claude, { mcpServers: { 'search-boost': { command: 'search-boost-mcp', args: ['serve'], disabled: true, env: { TOKEN: 'fixture-secret-not-real' } } }, custom: true })
  write(codex, '[mcp_servers.search-boost]\ncommand="search-boost-mcp"\nargs=["serve"]\nenabled=false\n')
  write(cursor, { mcpServers: { 'search-boost': { command: 'old', args: [], disabled: true } } })
  const piSettings = join(env.PI_CODING_AGENT_DIR, 'settings.json'), oldPi = join(temp, 'old-pi-package')
  write(join(oldPi, 'package.json'), { name: 'pi-search-boost', version: '0.1.3' })
  write(piSettings, { packages: [{ source: oldPi, extensions: [], autoload: false }], defaultModel: 'keep-model' })
  const projectPi = join(cwd, '.pi', 'settings.json')
  write(projectPi, { packages: [{ source: legacyRoot, extensions: [] }], userSetting: 'keep' })
  const dshProfile = join(env.DSH_HOME, 'profiles', 'web', 'package.json')
  write(dshProfile, { dependencies: { 'dsh-search-boost': '0.1.3' }, dsh: { profile: { bundles: [], custom: 'keep' } } })

  const initialAgents = [claude, codex, cursor, piSettings, projectPi, dshProfile].map((file) => [file, bytes(file)])

  // Precondition probe: the migration path resolves the global root/prefix through
  // npm itself and deliberately never echoes npm output (it may contain secrets),
  // so a broken child environment would only surface as a generic failure.
  if (process.platform === 'win32') {
    const entry = npmCliEntry(env)
    assert.ok(entry && isAbsolute(entry), `npm CLI entry must resolve absolutely, got: ${entry}`)
  }
  const npmResolution = () => {
    const where = spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', 'where npm'], { encoding: 'utf8', env, cwd })
    const shims = [
      join(cwd, 'npm.cmd'),
      join(cwd, 'node_modules', '.bin', 'npm.cmd'),
      join(prefix, 'npm.cmd'),
      join(prefix, 'node_modules', '.bin', 'npm.cmd'),
    ].filter((file) => existsSync(file))
    return [
      `where npm → ${(where.stdout ?? '').trim() || `(exit ${where.status}) ${(where.stderr ?? '').trim()}`}`,
      `fixture shims → ${shims.join(' | ') || '(none)'}`,
      ...shims.slice(0, 2).map((file) => `${file} → ${readFileSync(file, 'utf8').split('\n').slice(0, 4).join(' ⏎ ')}`),
    ].join('\n')
  }
  for (const args of [['--version'], ['root', '--global'], ['prefix', '--global']]) {
    const probe = await runCommand('npm', args, { env, cwd })
    assert.equal(probe.code, 0, `npm ${args.join(' ')} failed (exit ${probe.code})\n${probe.stdout}\n${probe.stderr}\nPATH=${env[pathKey]}\n${npmResolution()}`)
  }

  // Prewarm exactly as npx would, without requiring a transition version.
  const npx = (command, ...args) => ['exec', '--yes', '--ignore-scripts', '--package=search-boost@2.0.0', '--', 'search-boost', command, ...args]
  assert.equal((await checkedNpm(npx('--version'))).trim(), '2.0.0')
  const cacheDir = join(env.npm_config_cache, '_npx')
  const cachedRoot = readdirSync(cacheDir).map((name) => join(cacheDir, name, 'node_modules', 'search-boost')).find((dir) => existsSync(join(dir, 'cli.mjs')))
  assert.ok(cachedRoot)
  const initialClaude = bytes(claude)
  const preview = await checkedNpm(npx('migrate', '--dry-run'))
  assert.ok(preview.includes('uninstall global search-boost-mcp') && preview.includes('configuration and credentials remain unchanged'))
  assert.ok(!existsSync(currentRoot) && existsSync(legacyRoot))
  assert.equal(bytes(claude), initialClaude)

  available = false
  const unavailable = await runCommand(process.execPath, [join(cachedRoot, 'cli.mjs'), 'migrate', '-y'], { env, cwd })
  assert.equal(unavailable.code, 1)
  assert.match(unavailable.stderr, /may not be published/)
  assert.ok(!existsSync(currentRoot) && existsSync(legacyRoot))
  available = true
  console.log('ok: npx cache loads new migration code directly; dry-run/unpublished release preserve old package and configuration')

  // Validate ownership and rollback independently before the live npm takeover.
  const binsUrl = pathToFileURL(join(PKG_ROOT, 'lib', 'upgrade', 'bins.mjs')).href
  const paths = { prefix, legacy: legacyRoot, current: currentRoot }
  await checked(process.execPath, ['--input-type=module', '-e', `import{withLegacyBinParked}from ${JSON.stringify(binsUrl)};try{await withLegacyBinParked(${JSON.stringify(paths)},async()=>{throw Error('expected fixture failure')});process.exitCode=2}catch(e){if(e.message!=='expected fixture failure')throw e}`])
  assert.ok(existsSync(bin('search-boost')))
  if (process.platform !== 'win32') assert.equal((await checked(bin('search-boost'), [])).trim(), 'old fixture')
  const sharedBin = bin('search-boost')
  await checked(process.execPath, ['--input-type=module', '-e', `import{withLegacyBinParked}from ${JSON.stringify(binsUrl)};import{rename,writeFile,unlink}from'node:fs/promises';const file=${JSON.stringify(sharedBin)},backup=file+'.fixture';await rename(file,backup);try{await writeFile(file,'foreign user command');try{await withLegacyBinParked(${JSON.stringify(paths)},async()=>{throw Error('action must not run')});process.exitCode=2}catch(e){if(!e.message.includes('not owned'))throw e}}finally{await unlink(file);await rename(backup,file)}`])

  // An unrelated agent conflict must not turn npm rename into an agent updater.
  const foreign = join(home, '.claude', 'skills', 'search-boost', 'SKILL.md')
  write(foreign, '# User-owned skill\n')
  const migrated = await checkedNpm(npx('migrate', '-y'))
  assert.match(migrated, /Migration complete/)
  assert.ok(!existsSync(legacyRoot) && !existsSync(bin('search-boost-mcp')))
  assert.ok(existsSync(bin('search-boost')))
  for (const [file, text] of [...protectedBytes, ...initialAgents]) assert.equal(bytes(file), text, `migrate must not edit ${file}`)
  if (process.platform !== 'win32') assert.equal((await checked(bin('search-boost'), ['--version'])).trim(), '2.0.0')
  assert.ok(!migrated.includes('fixture-secret-not-real'))
  console.log('ok: real npm migration installs new, removes old and repairs the shared bin WITHOUT editing any agent configuration')

  // Same-version Update is the actual integration upgrade, including native
  // references to the now-deleted global legacy root. Partial failure is retryable.
  const partial = await runCommand(process.execPath, [join(currentRoot, 'cli.mjs'), 'upgrade', '-y'], { env, cwd })
  assert.equal(partial.code, 1)
  assert.match(partial.stdout, /Upgrade incomplete/)
  assert.equal(bytes(claude), initialClaude)
  assert.ok(!existsSync(legacyRoot))
  rmSync(foreign)
  const refreshed = await checked(process.execPath, [join(currentRoot, 'cli.mjs'), 'upgrade', '-y'])
  assert.match(refreshed, /Upgrade complete/)
  assert.equal(json(claude).mcpServers['search-boost'].args[0], join(currentRoot, 'cli.mjs'))
  assert.equal(json(claude).mcpServers['search-boost'].disabled, true)
  assert.equal(json(claude).custom, true)
  assert.ok(bytes(codex).includes(currentRoot) && bytes(codex).includes('enabled=false'))
  assert.equal(json(cursor).mcpServers['search-boost'].disabled, true)
  assert.deepEqual(json(piSettings).packages[0], { source: currentRoot, extensions: [], autoload: false })
  assert.equal(json(piSettings).defaultModel, 'keep-model')
  assert.deepEqual(json(projectPi).packages, [{ source: currentRoot, extensions: [] }])
  assert.equal(json(projectPi).userSetting, 'keep')
  assert.equal(json(dshProfile).dependencies['search-boost'], `link:${currentRoot}`)
  assert.ok(!json(dshProfile).dependencies['dsh-search-boost'])
  assert.deepEqual(json(dshProfile).dsh.profile.bundles, [])
  for (const [file, text] of protectedBytes) assert.equal(bytes(file), text)
  console.log('ok: Update then refreshes ALL configured MCP/Pi/DSH agents, recovers retired local paths and preserves filters/disabled state; failures remain retryable')

  latest = '2.1.0'
  const again = await checked(process.execPath, [join(cachedRoot, 'cli.mjs'), 'migrate', '-y'])
  assert.match(again, /Already migrated/)
  assert.equal(json(join(currentRoot, 'package.json')).version, '2.0.0', 'migrate is not the normal updater')
  const updated = await checked(process.execPath, [join(currentRoot, 'cli.mjs'), 'upgrade', '-y'])
  assert.equal(json(join(currentRoot, 'package.json')).version, '2.1.0')
  assert.match(updated, /Upgrade complete/)
  assert.ok(bytes(join(env.PI_CODING_AGENT_DIR, 'agents', 'searcher.md')).includes('fixture-release 2.1.0'))
  assert.equal(json(dshProfile).dependencies['search-boost'], `link:${currentRoot}`)
  assert.deepEqual(json(dshProfile).dsh.profile.bundles, [])
  for (const [file, text] of protectedBytes) assert.equal(bytes(file), text)
  assert.ok(!existsSync(join(home, '.grok', 'config.toml')), 'detected/unconfigured agents must not be newly installed')
  console.log('ok: later Update runs a fresh npx release and refreshes all installed agents; migrate stays rename-only')
} finally {
  await new Promise((resolve) => server.close(resolve))
  rmSync(temp, { recursive: true, force: true })
}
