import './isolate-tests.mjs'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync, readlinkSync, statSync, chmodSync, linkSync } from 'node:fs'
import { dirname, join, relative, delimiter } from 'node:path'
import { spawnSync } from 'node:child_process'
import fsPromises from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { PKG_ROOT } from '../lib/pkg.mjs'
import { PATHS, agentConfigured, grokScopeConfigured, grokScopeHasArtifacts } from '../lib/paths.mjs'
import { checkCodexWebSearchConfig } from '../lib/doctor/checks/codex.mjs'
import { upsertTomlSection, removeTomlSection } from '../lib/toml.mjs'
import { backupFiles } from '../lib/upgrade/state.mjs'
import { refreshAntigravityMcp } from '../lib/antigravity-mcp.mjs'
import { runInstallerWithOptions } from '../lib/installer/index.mjs'
import { antigravityPreferencePath } from '../lib/antigravity-config.mjs'

const write = (p, value) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, typeof value === 'string' ? value : JSON.stringify(value)) }
const json = p => JSON.parse(readFileSync(p, 'utf8'))
const cli = (...args) => {
  const out = spawnSync(process.execPath, [join(PKG_ROOT, 'cli.mjs'), ...args], { env: process.env, encoding: 'utf8', timeout: 120_000 })
  assert.equal(out.status, 0, `${out.error?.message ?? ''}; ${out.stderr}; ${out.stdout}`)
  return out
}
const parse = path => {
  const out = spawnSync(process.platform === 'win32' ? 'python' : 'python3', ['-c', 'import tomllib,json,sys; print(json.dumps(tomllib.load(open(sys.argv[1],"rb"))))', path], { encoding: 'utf8' })
  assert.equal(out.status, 0, out.stderr)
  return JSON.parse(out.stdout)
}
const bin = join(process.env.HOME, 'fixture-bin'), grokMain = join(bin, 'grok.mjs')
write(grokMain, `if (process.argv.slice(2).join(' ') !== 'plugin list --json') throw Error('unexpected host command'); console.log('[]')`)
const grok = join(bin, process.platform === 'win32' ? 'grok.cmd' : 'grok')
write(grok, process.platform === 'win32' ? `@"${process.execPath}" "${grokMain}" %*\r\n` : `#!/bin/sh\nexec "${process.execPath}" "${grokMain}" "$@"\n`)
chmodSync(grok, 0o700); process.env.PATH = bin + delimiter + process.env.PATH
for (const host of ['codex', 'grok']) {
  const path = PATHS[host].config
  for (const id of ['search-boost', '"search-boost"', "'search-boost'"]) {
    const original = `root_unknown = "keep"\n[mcp_servers.${id}]\ncommand = "node"\nargs = ["old", "serve"]\nenabled = false\nstartup_timeout_sec = 97\ncustom = "keep"\n[mcp_servers.other]\ncommand = "user-server"\n[mcp_servers.${id}.env]\nSYNTHETIC_API_KEY = "NOT-A-REAL-KEY"\n[mcp_servers.other.env]\nOTHER = "keep"\n`
    write(path, original)
    const args = ['-t', host, '-y', '--keep-native', ...(host === 'grok' ? ['--skip-grok-plugin'] : [])]
    cli('install', ...args)
    cli('install', ...args)
    assert.equal(agentConfigured(host), true, `${host}: quoted table must count as configured`)
    const statusLine = cli('status').stdout.split('\n').find(line => line.startsWith(host.padEnd(15)))
    assert.equal(statusLine.slice(25,37).trim(), 'yes', 'public status must agree with installed quoted configuration')
    if(host === 'codex') assert.doesNotMatch(checkCodexWebSearchConfig({}).message, /not configured/)
    else assert.equal(grokScopeConfigured('user'), true)
    let doc = parse(path)
    assert.equal(doc.mcp_servers['search-boost'].enabled, false)
    assert.equal(doc.mcp_servers['search-boost'].startup_timeout_sec, 97)
    assert.equal(doc.mcp_servers['search-boost'].custom, 'keep')
    assert.equal(doc.mcp_servers['search-boost'].env.SYNTHETIC_API_KEY, 'NOT-A-REAL-KEY')
    assert.equal(doc.root_unknown, 'keep')
    // Do not invoke an installed Grok plugin; these are MCP-only upgrade fixtures.
    cli('refresh', '-y')
    doc = parse(path)
    assert.equal(doc.mcp_servers['search-boost'].custom, 'keep')
    cli('uninstall', ...args)
    doc = parse(path)
    assert.equal(doc.mcp_servers['search-boost'], undefined)
    assert.deepEqual(doc.mcp_servers.other, { command: 'user-server', env: { OTHER: 'keep' } })
  }
  console.log(`ok: public ${host} install/upgrade/uninstall preserves quoted tables/preferences and removes all owned subtables`)
  if (host === 'grok') {
    rmSync(PATHS.grok.rule,{force:true}); rmSync(dirname(PATHS.grok.skill),{recursive:true,force:true})
    for (const id of ['"search-boost"', "'search-boost'"]) {
      for (const parent of [true, false]) {
        write(path, `${parent ? `[mcp_servers.${id}]\ncommand="node"\nargs=[]\n` : ''}[mcp_servers.${id}.env]\nTOKEN="fixture"\n[mcp_servers.other]\ncommand="keep"\n`)
        assert.equal(grokScopeHasArtifacts('user'),true,'quoted config alone must trigger uninstall, even an orphan child')
        assert.equal(grokScopeConfigured('user'),parent,'orphan child is not a configured server')
        cli('uninstall','-t','grok','-y')
        assert.equal(parse(path).mcp_servers['search-boost'],undefined)
      }
    }
    console.log('ok: Grok scope uninstall cleans quoted config-only/child-only artifacts without relying on rule/skill files')
  }

}
const trick = `note = '''\n[mcp_servers.search-boost]\nnot a real table\n'''\n[mcp_servers."search\\u002dboost"] # quoted escape\ncommand="old"\n[mcp_servers.'search-boost'.env]\nTOKEN="fixture"\n[mcp_servers.'search-boost-other']\ncommand="keep"\n`
const removed = removeTomlSection(trick, 'search-boost')
assert.match(removed, /not a real table/)
assert.match(removed, /search-boost-other/)
assert.doesNotMatch(removed, /TOKEN=/)
assert.throws(() => upsertTomlSection('[mcp_servers.search-boost]\ncommand="a"\n[mcp_servers."search-boost"]\ncommand="b"\n', 'search-boost', 'command="new"'), /Duplicate/)
console.log('ok: table identity is decoded; multiline text and similarly named servers are not owned')
const trickyBody = `[mcp_servers.search-boost]
custom = """
command = "example only"
args = ["example"]
"""
"command" = "old"
'args' = ["old"]
`
const changed = upsertTomlSection(trickyBody, 'search-boost', 'command="new"\nargs=[]')
assert.match(changed, /command = "example only"/)
assert.doesNotMatch(changed, /"command" = "old"/)
assert.match(changed, /command="new"/)
assert.doesNotMatch(changed, /'args' = \["old"\]/)
write(PATHS.codex.config, changed); assert.deepEqual(parse(PATHS.codex.config).mcp_servers['search-boost'].args, [])
write(PATHS.codex.config, '[mcp_servers.search-boost.env]\nTOKEN="orphan-fixture"\n')
cli('refresh', '-y')
assert.equal(parse(PATHS.codex.config).mcp_servers['search-boost'].command, undefined, 'refresh cannot re-register an orphan left by uninstall')


const modern = PATHS.antigravity.mcp, legacy = PATHS.antigravity.legacyMcp
write(modern, { custom: 'modern', mcpServers: { other: { command: 'keep' } } })
write(legacy, { custom: 'legacy', mcpServers: { legacyOther: { command: 'keep' } } })
cli('install', '-t', 'antigravity', '-y', '--antigravity-config', 'legacy')
assert.ok(json(legacy).mcpServers['search-boost'])
assert.equal(json(modern).mcpServers['search-boost'], undefined)
cli('refresh', '-y')
assert.ok(json(legacy).mcpServers['search-boost'])
cli('install', '-t', 'antigravity', '-y', '--antigravity-config', 'modern', '--dry-run')
assert.ok(json(legacy).mcpServers['search-boost'])
assert.equal(json(antigravityPreferencePath()).mode, 'legacy')
assert.ok(cli('print', 'antigravity', '--antigravity-config', 'modern').stdout.includes(modern))
assert.ok(cli('print', 'antigravity', '--antigravity-config', 'legacy').stdout.includes(legacy))
assert.equal(json(antigravityPreferencePath()).mode, 'legacy', 'print must not persist its explicit override')
cli('install', '-t', 'antigravity', '-y', '--antigravity-config', 'modern')
assert.ok(json(modern).mcpServers['search-boost'])
assert.equal(json(legacy).mcpServers['search-boost'], undefined)
assert.equal(json(modern).custom, 'modern'); assert.equal(json(legacy).custom, 'legacy')
const noop = () => {}
const clack = { log: { info: noop, warn: noop, error: noop, success: noop }, isCancel: () => false, spinner: () => ({ start: noop, stop: noop }), note: noop }
cli('install', '-t', 'codex', '-y', '--keep-native')
assert.equal(parse(PATHS.codex.config).mcp_servers['search-boost'].default_tools_approval_mode, 'auto')
const decline = { ...clack, confirm: async () => false }
await runInstallerWithOptions({ clack: decline, target: 'codex', skipKeys: true, skipLayer: true, replaceNative: false })
assert.equal(parse(PATHS.codex.config).mcp_servers['search-boost'].default_tools_approval_mode, undefined, 'declining the permission prompt revokes auto approval')
for (const mode of ['ask', 'never']) {
  write(PATHS.codex.config, `[mcp_servers.search-boost]\ncommand="old"\nargs=[]\ndefault_tools_approval_mode="${mode}"\n`)
  await runInstallerWithOptions({ clack: decline, target: 'codex', skipKeys: true, skipLayer: true, replaceNative: false })
  assert.equal(parse(PATHS.codex.config).mcp_servers['search-boost'].default_tools_approval_mode, mode)
}
cli('uninstall', '-t', 'codex', '-y')
console.log('ok: declining Codex auto approval revokes its prior auto grant, while ask/never policies remain unchanged')

await runInstallerWithOptions({ clack, target: 'antigravity', yes: true, skipKeys: true, skipLayer: true, antigravityConfig: 'legacy' })
assert.ok(json(legacy).mcpServers['search-boost'])
cli('install', '-t', 'antigravity', '-y', '--antigravity-config', 'modern')
console.log('ok: public plain CLI and interactive wrapper forward sticky Antigravity mode; dry run never persists it')

const dot = join(process.env.HOME, 'dotfiles'), target = join(dot, 'mcp.json')
mkdirSync(dot, { recursive: true })
const stale = json(modern); stale.mcpServers['search-boost'].command = 'old-launch'; stale.mcpServers['search-boost'].args = ['old-cli']
const content = Buffer.from(JSON.stringify(stale))
let symlinks = true
try { symlinkSync(target, join(dot, 'permission-probe')) } catch (err) {
  if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'UNKNOWN'].includes(err.code)) throw err
  symlinks = false; console.log(`skip: file symlink privileges unavailable (${err.code})`)
}
if (symlinks) {
  rmSync(join(dot, 'permission-probe'))
  for (const kind of ['absolute', 'relative', 'chain']) {
    rmSync(modern, { force: true }); writeFileSync(target, content); chmodSync(target, 0o640)
    const chain = join(dot, 'chain')
    rmSync(chain, { force: true })
    if (kind === 'chain') symlinkSync('mcp.json', chain)
    const link = kind === 'absolute' ? target : relative(dirname(modern), kind === 'chain' ? chain : target)
    symlinkSync(link, modern)
    cli('refresh', '-y')
    assert.equal(readlinkSync(modern), link)
    if (process.platform !== 'win32') assert.equal(statSync(target).mode & 0o777, 0o640)
    assert.equal(json(modern).mcpServers['search-boost'].command, process.execPath, 'must actually rewrite a stale launch through the symlink')
    const before = readFileSync(target), mode = statSync(target).mode & 0o777
    const backup = await backupFiles([modern], { symlinkFiles: [modern] })
    writeFileSync(target, 'changed')
    await backup.rollback()
    assert.ok(before.equals(readFileSync(target))); assert.equal(readlinkSync(modern), link)
    if (process.platform !== 'win32') assert.equal(statSync(target).mode & 0o777, mode)
    write(legacy, { mcpServers: { 'search-boost': { command: 'old' }, other: { command: 'keep' } } })
    const legacyBefore = readFileSync(legacy)
    let writes = 0
    await assert.rejects(() => refreshAntigravityMcp({ command: 'new', args: [] }, { write: async (p, value) => {
      if (++writes === 2) throw Error('injected second write failure')
      write(p, value)
    } }), /previous configurations restored/)
    assert.ok(before.equals(readFileSync(target))); assert.ok(legacyBefore.equals(readFileSync(legacy)))
    assert.equal(readlinkSync(modern), link)
    rmSync(legacy, { force: true })
  }
  const invalid = join(dot, 'invalid')
  for (const kind of ['dangling', 'cycle', 'directory', 'alias']) {
    rmSync(invalid, { force: true })
    symlinkSync(kind === 'cycle' ? invalid : kind === 'directory' ? dot : kind === 'alias' ? target : join(dot, 'absent'), invalid, kind === 'directory' && process.platform === 'win32' ? 'junction' : undefined)
    const before = readFileSync(target)
    await assert.rejects(() => backupFiles(kind === 'alias' ? [modern, invalid] : [invalid], { symlinkFiles: [modern, invalid] }))
    assert.ok(before.equals(readFileSync(target)))
  }
  console.log('ok: public upgrade supports absolute/relative/chained file links and exact byte/mode rollback; invalid/aliased links fail closed')
}

if (symlinks) {
  for (const host of ['codex', 'cursor']) {
    const path = host === 'codex' ? PATHS.codex.config : PATHS.cursor.mcp
    rmSync(path, {force:true})
    const dest = join(dot, host + '-config')
    write(dest, host === 'codex' ? '[mcp_servers.search-boost]\ncommand="node"\nargs=[]\n' : {mcpServers:{'search-boost':{command:'node',args:[]}}})
    mkdirSync(dirname(path), {recursive:true}); symlinkSync(dest, path)
    cli('uninstall','-t',host,'-y')
    assert.equal(readlinkSync(path), dest)
    if(host === 'codex') assert.equal(readFileSync(dest,'utf8'), '')
    else assert.deepEqual(json(dest), {})
    cli('install','-t',host,'-y','--keep-native')
    assert.equal(readlinkSync(path), dest)
    assert.ok(host === 'codex' ? parse(dest).mcp_servers['search-boost'] : json(dest).mcpServers['search-boost'])
  }
  console.log('ok: empty linked JSON/TOML config targets are cleared on uninstall, not abandoned; reinstall retains links')
}

// Independent files with adjacent 64-bit IDs collide when represented as Number.
// Simulate that filesystem boundary, not the backup implementation.
const identityA = join(dot,'identity-a'), identityB = join(dot,'identity-b'), hard = join(dot,'identity-hard')
write(identityA,'a'); write(identityB,'b')
const originalLstat = fsPromises.lstat
let zeroIdentity = false
try {
  fsPromises.lstat = async (path, options) => {
    const info = await originalLstat(path, options)
    if (path !== identityA && path !== identityB) return info
    const precise = zeroIdentity ? 0n : path === identityA ? 9007199254740992n : 9007199254740993n
    return Object.create(info, { ino: { value: options?.bigint ? precise : Number(precise) } })
  }
  syncBuiltinESMExports()
  const precise = await backupFiles([identityA,identityB]); await precise.rollback()
  zeroIdentity = true
  const zero = await backupFiles([identityA,identityB]); await zero.rollback()
  assert.equal(readFileSync(identityA,'utf8'),'a'); assert.equal(readFileSync(identityB,'utf8'),'b')
  linkSync(identityA,hard)
  await assert.rejects(() => backupFiles([identityA,hard]), /identity unavailable/)
} finally {
  fsPromises.lstat = originalLstat; syncBuiltinESMExports()
}
await assert.rejects(() => backupFiles([identityA,hard]), /alias one file/)
console.log('ok: adjacent 64-bit file IDs remain distinct; zero IDs use realpaths, real hardlink aliases and unknown hardlink identities fail closed')
