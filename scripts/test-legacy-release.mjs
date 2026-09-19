#!/usr/bin/env node
/** Real npm bin ownership test, offline and in a disposable prefix. */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, cpSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { PKG_ROOT, getVersion } from '../lib/pkg.mjs'
import { runCommand } from '../lib/upgrade/process.mjs'
import { buildLegacyRelease } from './build-legacy-release.mjs'

const temp = mkdtempSync(join(tmpdir(), 'sb separate bins '))
const home = join(temp, 'home'), prefix = join(temp, 'prefix'), cwd = join(temp, 'workspace')
for (const path of [home, prefix, cwd]) mkdirSync(path)
const env = { ...process.env, HOME: home, USERPROFILE: home, SEARCH_BOOST_HOME: join(home, '.search-boost'), PI_CODING_AGENT_DIR: join(home, '.pi', 'agent'), DSH_HOME: join(home, '.dsh'), npm_config_prefix: prefix, npm_config_cache: join(temp, 'cache'), npm_config_offline: 'true' }
for (const key of Object.keys(env)) if (/^SEARCH_BOOST_.*_FILE$/.test(key) || key === 'SEARCH_BOOST_UPGRADE_HANDOFF') delete env[key]
const write = (path, value) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value, null, 2)) }
const json = (path) => JSON.parse(readFileSync(path, 'utf8'))
async function checked(command, args, options = {}) {
  const result = await runCommand(command, args, { env, cwd, ...options })
  assert.equal(result.code, 0, `${command} ${args[0]}: ${result.stdout}\n${result.stderr}`)
  return result.stdout
}
async function pack(dir) {
  const result = JSON.parse(await checked('npm', ['pack', '--ignore-scripts', '--json'], { cwd: dir }))
  return join(dir, (Array.isArray(result) ? result[0] : Object.values(result)[0]).filename)
}
async function install(tar) {
  await checked('npm', ['install', '--global', '--ignore-scripts', '--force=false', '--no-audit', '--no-fund', tar])
}
try {
  const original = join(temp, 'original')
  write(join(original, 'package.json'), { name: 'search-boost-mcp', version: '0.1.7', bin: { 'search-boost': './cli.mjs', 'search-boost-mcp': './cli.mjs' } })
  write(join(original, 'cli.mjs'), '#!/usr/bin/env node\nconsole.log("old fixture")\n')
  await install(await pack(original))
  const bin = (name) => process.platform === 'win32' ? join(prefix, `${name}.cmd`) : join(prefix, 'bin', name)
  assert(existsSync(bin('search-boost')) && existsSync(bin('search-boost-mcp')))

  const tokenPath = join(home, '.search-boost', 'config', 'xauth.json')
  const settingsPath = join(home, '.claude.json')
  write(tokenPath, { token: 'offline-fixture-secret' })
  write(settingsPath, { mcpServers: { 'search-boost': { command: 'search-boost-mcp', args: ['serve'] } }, custom: true })
  const tokenBytes = readFileSync(tokenPath, 'utf8'), settingsBytes = readFileSync(settingsPath, 'utf8')

  const legacyDir = await buildLegacyRelease({ version: '0.1.8', outDir: join(temp, 'transition') })
  const legacy = json(join(legacyDir, 'package.json'))
  assert.deepEqual(legacy.bin, { 'search-boost-mcp': './cli.mjs' })
  assert.equal(legacy.name, 'search-boost-mcp')
  assert.equal(legacy.pi.extensions[0], './adapters/pi/index.js')
  assert.equal(legacy.dsh.bundle.patch, './adapters/dsh/cordis.patch.yml')
  assert(readFileSync(join(legacyDir, legacy.dsh.bundle.patch), 'utf8').includes('name: search-boost-mcp/dsh'))
  assert(json(join(legacyDir, 'grok-plugin', '.mcp.json')).mcpServers['search-boost'].args.includes('search-boost-mcp'))
  await assert.rejects(buildLegacyRelease({ version: '0.1.8', outDir: legacyDir }), /already exists/)
  // CLI-only offline fixtures omit third-party dependencies; this test exercises
  // real npm ownership/replacement, not authenticated MCP/Pi/DSH host execution.
  delete legacy.dependencies
  write(join(legacyDir, 'package.json'), legacy)
  await install(await pack(legacyDir))
  assert(!existsSync(bin('search-boost')), 'updating the old package must release its obsolete shared command')
  assert(existsSync(bin('search-boost-mcp')))

  const newDir = join(temp, 'new-package')
  const current = json(join(PKG_ROOT, 'package.json'))
  mkdirSync(newDir)
  for (const path of current.files) cpSync(join(PKG_ROOT, path), join(newDir, path), { recursive: true })
  delete current.dependencies
  delete current.scripts
  write(join(newDir, 'package.json'), current)
  const newTar = await pack(newDir)
  await install(newTar)
  const root = (await checked('npm', ['root', '--global'])).trim()
  assert(existsSync(join(root, 'search-boost-mcp')) && existsSync(join(root, 'search-boost')), 'both packages must remain installed')
  assert(existsSync(bin('search-boost')) && existsSync(bin('search-boost-mcp')))
  assert.equal((await checked(process.execPath, [join(root, 'search-boost-mcp', 'cli.mjs'), '--version'])).trim(), '0.1.8')
  assert.equal((await checked(process.execPath, [join(root, 'search-boost', 'cli.mjs'), '--version'])).trim(), getVersion())
  if (process.platform !== 'win32') {
    assert.equal((await checked(bin('search-boost-mcp'), ['--version'])).trim(), '0.1.8')
    assert.equal((await checked(bin('search-boost'), ['--version'])).trim(), getVersion())
  }
  assert.equal(readFileSync(tokenPath, 'utf8'), tokenBytes)
  assert.equal(readFileSync(settingsPath, 'utf8'), settingsBytes)

  // Distinct npm names have independent version streams: legacy 0.1.8 must
  // still offer new search-boost 0.1.7, without interpreting it as a downgrade.
  const moduleUrl = pathToFileURL(join(root, 'search-boost-mcp', 'lib', 'upgrade', 'index.mjs')).href
  const script = `import {runUpgrade} from ${JSON.stringify(moduleUrl)};
    const calls=[]; const result=await runUpgrade({dryRun:true,run:async(command,args)=>{
      calls.push(args); if(command==='npm'&&args[0]==='view') return {code:0,stdout:JSON.stringify(${JSON.stringify(getVersion())})};
      throw Error('unexpected mutation');
    }}); if(!result.ok || calls.length!==1) process.exitCode=1;`
  const preview = await checked(process.execPath, ['--input-type=module', '-e', script])
  assert(preview.includes(`Would install search-boost@${getVersion()}`))
  assert(!readFileSync(join(root, 'search-boost-mcp', 'lib', 'upgrade', 'index.mjs'), 'utf8').includes('retireGlobalPackages'))
  console.log('ok: real npm update releases the old shared bin; old/new packages coexist under separate commands without force, routing plugin, automatic uninstall, or credential/config changes')

  // Shipped entrypoints work independently of shell aliases and reject unsafe modes.
  const legacyRoot = join(root, 'search-boost-mcp')
  assert(existsSync(join(legacyRoot, 'migrate.mjs')))
  for (const args of [[join(legacyRoot, 'cli.mjs'), 'migrate', '--help'], [join(legacyRoot, 'migrate.mjs'), '--help']]) {
    assert((await checked(process.execPath, args)).includes('search-boost-mcp migrate'))
  }
  const unsafe = await runCommand(process.execPath, [join(legacyRoot, 'migrate.mjs'), '--sync-only', '-y'], { env, cwd })
  assert.equal(unsafe.code, 1)
  assert(unsafe.stderr.includes('--sync-only is not supported'))

  // Remove only the disposable fixture's new package, to exercise a true first migration.
  await checked('npm', ['uninstall', '--global', '--ignore-scripts', '--no-audit', '--no-fund', 'search-boost'])
  const migrationUrl = pathToFileURL(join(legacyRoot, 'lib', 'upgrade', 'migrate.mjs')).href
  const processUrl = pathToFileURL(join(legacyRoot, 'lib', 'upgrade', 'process.mjs')).href
  const unavailableScript = `import {runMigrationCli} from ${JSON.stringify(migrationUrl)};
    let calls=0;
    try { await runMigrationCli(['-y'], {run:async(command,args)=>{
      if(command!=='npm'||args[0]!=='view') throw Error('unexpected mutation');
      calls++; return {code:1,stdout:'',stderr:'offline-fixture-secret'};
    }}); process.exitCode=2; }
    catch(err) { console.error(err.message); process.exitCode=calls===1 ? 1 : 2; }`;
  const unavailable = await runCommand(process.execPath, ['--input-type=module', '-e', unavailableScript], { env, cwd })
  assert.equal(unavailable.code, 1)
  assert(unavailable.stderr.includes('may not be published yet'))
  assert(!unavailable.stderr.includes('offline-fixture-secret'))
  assert(!existsSync(join(root, 'search-boost')))
  assert.equal(readFileSync(settingsPath, 'utf8'), settingsBytes)
  assert.equal(readFileSync(tokenPath, 'utf8'), tokenBytes)

  // Only registry discovery/specification is substituted with a local tarball.
  // npm installation, replacement verification, new-process handoff and config migration are real.
  const migrateScript = `import {runMigrationCli} from ${JSON.stringify(migrationUrl)};
    import {runCommand} from ${JSON.stringify(processUrl)};
    let installs=0, handoffs=0;
    const result=await runMigrationCli(['-y'], {run:async(command,args,options)=>{
      if(command==='npm'&&args[0]==='view') return {code:0,stdout:JSON.stringify(${JSON.stringify(getVersion())})};
      if(command==='npm'&&args[0]==='install') {
        if(!args.includes(${JSON.stringify('search-boost@' + getVersion())})) throw Error('unexpected package');
        installs++; args=args.map(a=>a===${JSON.stringify('search-boost@' + getVersion())}?${JSON.stringify(newTar)}:a);
      }
      if(command===process.execPath) {
        if(args[0]!==${JSON.stringify(join(root, 'search-boost', 'cli.mjs'))}) throw Error('stale handoff');
        handoffs++;
      }
      return runCommand(command,args,options);
    }});
    if(!result.ok||installs!==1||handoffs!==1) process.exitCode=2;`;
  const foreignSkill = join(home, '.claude', 'skills', 'search-boost', 'SKILL.md')
  write(foreignSkill, '# User-owned skill\n')
  const partial = await runCommand(process.execPath, ['--input-type=module', '-e', migrateScript], { env, cwd })
  assert.equal(partial.code, 1)
  assert(partial.stdout.includes('Upgrade incomplete'))
  assert(existsSync(join(root, 'search-boost')) && existsSync(legacyRoot))
  assert.equal(readFileSync(settingsPath, 'utf8'), settingsBytes)
  assert.equal(readFileSync(tokenPath, 'utf8'), tokenBytes)
  rmSync(foreignSkill)

  const migrated = await checked(process.execPath, ['--input-type=module', '-e', migrateScript])
  assert(migrated.includes('Upgrade complete'))
  const migratedSettings = json(settingsPath)
  assert.equal(migratedSettings.mcpServers['search-boost'].args[0], join(root, 'search-boost', 'cli.mjs'))
  assert.equal(migratedSettings.custom, true)
  assert.equal(readFileSync(tokenPath, 'utf8'), tokenBytes)
  assert(existsSync(bin('search-boost-mcp')) && existsSync(bin('search-boost')))
  assert(!migrated.includes('offline-fixture-secret'))
  console.log('ok: shipped one-click migration fails safely before publication, reports partial failure, and retries through real npm install/new-code handoff without deleting the old global package or credentials')

} finally { rmSync(temp, { recursive: true, force: true }) }
