#!/usr/bin/env node
/** Independent-review R1–R4: real upgrade/CLI writes in isolated homes.
 * TOML assertions use Python 3.11+ tomllib, not textual scope heuristics. */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const repo = resolve(import.meta.dirname, '..')
const temp = mkdtempSync(join(tmpdir(), 'sb-review-'))
const originalCwd = process.cwd()
for (const key of Object.keys(process.env)) {
  if (/^(SEARCH_BOOST_|PI_SEARCH_|PI_CODING_AGENT_DIR$|DSH_HOME$)/.test(key)) delete process.env[key]
}
function fixture(name) {
  const home = join(temp, name), cwd = join(home, 'workspace')
  mkdirSync(cwd, { recursive: true })
  return { home, cwd, env: { ...process.env, HOME: home, USERPROFILE: home,
    SEARCH_BOOST_HOME: join(home, '.search-boost'), PI_CODING_AGENT_DIR: join(home, '.pi', 'agent'), DSH_HOME: join(home, '.dsh') } }
}
const race = fixture('race')
Object.assign(process.env, race.env)
process.chdir(race.cwd)
const write = (path, value) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, value) }
const bytes = (path) => readFileSync(path, 'utf8')
function cli(args, f) {
  const out = spawnSync(process.execPath, [join(repo, 'cli.mjs'), ...args], { cwd: f.cwd, env: f.env, encoding: 'utf8', timeout: 20000 })
  if (out.error) throw out.error
  return { code: out.status, text: out.stdout + out.stderr, stdout: out.stdout }
}
const python = ['python3', 'python'].find(command => spawnSync(command, ['-c', 'import tomllib'], { encoding: 'utf8', timeout: 10000 }).status === 0)
function toml(text) {
  assert(python, 'TOML regression tests require Python 3.11+ (tomllib)')
  const out = spawnSync(python, ['-c', 'import json,sys,tomllib; print(json.dumps(tomllib.loads(sys.stdin.read())))'], { input: text, encoding: 'utf8', timeout: 10000 })
  assert.equal(out.status, 0, out.stderr)
  return JSON.parse(out.stdout)
}
let passed = 0, skipped = 0
async function test(name, fn) {
  await fn(); passed++; console.log(`ok: ${name}`)
}
// Windows without Developer Mode/admin cannot create file symlinks. Report the
// gap explicitly; the Linux CI job always exercises these cases.
function link(target, path, type = 'file') {
  try { symlinkSync(target, path, type); return true } catch (err) {
    if (process.platform !== 'win32' || !['EPERM', 'EACCES'].includes(err.code)) throw err
    console.log(`SKIP: file symlink unavailable (${err.code}): ${path}`); skipped++; return false
  }
}
try {
  const { groupUpgradeJobs, fileResource } = await import('../lib/upgrade/scheduler.mjs')
  await test('R1 transitive write conflicts serialize; unrelated targets remain independent', () => {
    const jobs = [{ resources: ['a'] }, { resources: ['b'] }, { resources: ['a', 'b'] }, { resources: ['c'] }]
    assert.deepEqual(groupUpgradeJobs(jobs).map(group => group.map(job => job.index)), [[0, 1, 2], [3]])
    const real = join(temp, 'real-dir'), alias = join(temp, 'alias-dir')
    mkdirSync(real)
    symlinkSync(real, alias, process.platform === 'win32' ? 'junction' : 'dir')
    assert.equal(fileResource(join(real, 'new', 'asset')), fileResource(join(alias, 'new', 'asset')))
  })
  await test('R1 failed legacy Antigravity transaction retains every successful shared asset', async () => {
    const { PATHS } = await import('../lib/paths.mjs')
    const { skillBundleFiles } = await import('../lib/agent-skills.mjs')
    const { runUpgrade } = await import('../lib/upgrade/index.mjs')
    const p = PATHS.antigravity
    const original = JSON.stringify({ mcpServers: { 'search-boost': { command: 'node', args: ['old.mjs'] } } })
    for (const config of [p.mcp, p.legacyMcp]) write(config, original)
    const shared = [...skillBundleFiles('antigravity', p.skill).map(file => file.path), p.hooks, p.hookScript, p.hookInject, p.agents, p.gemini]
    const beforeMkdir = fs.mkdir, beforeWrite = fs.writeFile
    let writers = 0, releaseWriters, releaseSuccess, failed = false, snapshot
    const twoWriters = new Promise(r => { releaseWriters = r })
    const success = new Promise(r => { releaseSuccess = r })
    async function bounded(promise, ms) {
      let timer
      try { await Promise.race([promise, new Promise(r => { timer = setTimeout(r, ms) })]) }
      finally { clearTimeout(timer) }
    }
    // In the broken scheduler both transactions back up the absent skills before
    // either writes. A serial scheduler simply waits out this bounded gate once.
    fs.mkdir = async function(path, ...args) {
      if (String(path) === dirname(p.skill)) {
        if (++writers >= 2) releaseWriters()
        await bounded(twoWriters, 300)
      }
      return beforeMkdir.call(this, path, ...args)
    }
    fs.writeFile = async function(path, ...args) {
      if (String(path) === p.legacyMcp && !failed) {
        await bounded(success, 3000)
        assert(snapshot, 'first target must complete before injecting rollback')
        failed = true
        throw Object.assign(new Error('injected second-config EACCES'), { code: 'EACCES' })
      }
      return beforeWrite.call(this, path, ...args)
    }
    syncBuiltinESMExports()
    try {
      const result = await runUpgrade({ syncOnly: true,
        run: async () => { throw new Error('Unexpected host command') },
        log(line) { if (line === '[ok] antigravity') { snapshot = shared.map(file => [file, bytes(file)]); releaseSuccess() } },
      })
      assert.equal(result.ok, false)
      assert.deepEqual(result.warnings, [])
      assert.deepEqual(result.results.map(item => item.ok), [true, false])
      assert(failed)
      assert(result.results[1].error.includes('injected second-config EACCES'))
      assert(bytes(p.mcp).includes('cli.mjs'))
      assert.equal(bytes(p.legacyMcp), original)
      for (const [file, content] of snapshot) assert.equal(bytes(file), content, `successful asset retained: ${file}`)
    } finally { fs.mkdir = beforeMkdir; fs.writeFile = beforeWrite; syncBuiltinESMExports() }
  })
  await test('R1 unresolvable asset blocks only its target, not other upgrades', () => {
    const f = fixture('blocked-asset'), cursor = join(f.home, '.cursor', 'mcp.json'), codex = join(f.home, '.codex', 'config.toml')
    write(cursor, '{"mcpServers":{"search-boost":{"command":"node","args":["old.mjs"]}}}\n')
    write(codex, '[mcp_servers.search-boost]\ncommand="node"\nargs=["old.mjs"]\n')
    const script = join(f.home, '.cursor', 'hooks', 'search-boost-session.mjs')
    mkdirSync(dirname(script), { recursive: true })
    if (!link(script, script)) return
    const out = cli(['upgrade', '--sync-only', '-y'], f)
    assert.notEqual(out.code, 0)
    assert.match(out.text, /\[failed\] cursor/)
    assert.match(out.text, /\[ok\] codex/)
    assert(bytes(codex).includes('cli.mjs'))
    assert(lstatSync(script).isSymbolicLink())
  })
  const managed = value => `# SEARCH_BOOST_WEB_SEARCH_START\nweb_search=${JSON.stringify(value)}\n# SEARCH_BOOST_WEB_SEARCH_END\n`
  const mcp = '[mcp_servers.search-boost]\ncommand="node"\nargs=["old.mjs"]\n'
  for (const value of ['live', 'cached', 'disabled']) {
    await test(`R2 real upgrade preserves marked root ${value}, including restoration receipt`, () => {
      const f = fixture(`codex-${value}`), path = join(f.home, '.codex', 'config.toml')
      const receipt = Buffer.from(JSON.stringify({ assignment: 'web_search="live"\n' })).toString('base64')
      const block = managed(value).replace('web_search=', `# search-boost-previous: ${receipt}\nweb_search=`)
      write(path, block + mcp)
      for (let i = 0; i < 2; i++) {
        const out = cli(['upgrade', '--sync-only', '-y'], f)
        assert.equal(out.code, 0, out.text)
        const after = bytes(path), parsed = toml(after)
        assert.equal(parsed.web_search, value)
        assert.equal(parsed.mcp_servers['search-boost'].web_search, undefined)
        assert.deepEqual(parsed.mcp_servers['search-boost'].args, [join(repo, 'cli.mjs'), 'serve'])
        assert(after.startsWith(block), 'root block and user/restoration bytes are untouched')
      }
    })
  }
  for (const value of [null, 'live', 'cached', 'disabled']) {
    await test(`R2 misplaced legacy disabled block migrates without overriding ${value ?? 'absent'} root`, () => {
      const f = fixture(`legacy-${value}`), path = join(f.home, '.codex', 'config.toml')
      write(path, (value ? `web_search=${JSON.stringify(value)}\n` : '') + mcp + managed('disabled'))
      const out = cli(['upgrade', '--sync-only', '-y'], f)
      assert.equal(out.code, 0, out.text)
      const parsed = toml(bytes(path))
      assert.equal(parsed.web_search, value ?? 'disabled')
      assert.equal(parsed.mcp_servers['search-boost'].web_search, undefined)
    })
  }
  await test('R2 misplaced receipt-bearing blocks are not mistaken for legacy output', () => {
    for (const assignment of [null, 'web_search="live"\n', 'web_search="cached"\n']) {
      const f = fixture(`nonlegacy-${assignment === null ? 'null' : assignment.includes('live') ? 'live' : 'cached'}`)
      const path = join(f.home, '.codex', 'config.toml')
      const receipt = Buffer.from(JSON.stringify({ assignment })).toString('base64')
      const block = managed('disabled').replace('web_search=', `# search-boost-previous: ${receipt}\nweb_search=`)
      write(path, mcp + block)
      const out = cli(['upgrade', '--sync-only', '-y'], f)
      assert.equal(out.code, 0, out.text)
      const after = bytes(path), parsed = toml(after)
      assert(after.endsWith(block), 'ambiguous nonlegacy block and restoration record are preserved')
      assert.equal(parsed.web_search, undefined)
      assert.equal(parsed.mcp_servers['search-boost'].web_search, 'disabled')
      assert.deepEqual(parsed.mcp_servers['search-boost'].args, [join(repo, 'cli.mjs'), 'serve'])
    }
  })
  await test('R2 modified/malformed blocks are not silently converted into disabled preferences', async () => {
    const { migrateCodexNativeSearch } = await import('../lib/codex-native.mjs')
    for (const value of ['live', 'cached']) assert.equal(migrateCodexNativeSearch(mcp + managed(value)), mcp + managed(value))
    assert.throws(() => migrateCodexNativeSearch(mcp + '# SEARCH_BOOST_WEB_SEARCH_START\n'), /marker/)
    assert.throws(() => migrateCodexNativeSearch(managed('live') + managed('cached') + mcp), /marker/)
    const literal = 'instructions="""\n' + managed('disabled') + '"""\n' + mcp
    assert.equal(migrateCodexNativeSearch(literal), literal)
  })
  for (const host of ['cursor', 'codex']) {
    await test(`R3 real ${host} install preserves relative chained dotfile symlinks and user fields`, () => {
      const f = fixture(`linked-${host}`), path = join(f.home, `.${host}`, host === 'cursor' ? 'mcp.json' : 'config.toml')
      const target = join(f.home, 'dotfiles', host), middle = join(f.home, 'dotfiles', `${host}-link`)
      write(target, host === 'cursor' ? '{"mcpServers":{"user":{"command":"custom"}},"user":true}\n' : 'web_search="live"\n[user]\nkeep=true\n')
      mkdirSync(dirname(path), { recursive: true })
      if (!link(relative(dirname(middle), target), middle)) return
      if (!link(relative(dirname(path), middle), path)) return
      const pathLink = readlinkSync(path), middleLink = readlinkSync(middle)
      const out = cli(['install', '-t', host, '-y', '--keep-native'], f)
      assert.equal(out.code, 0, out.text)
      assert(lstatSync(path).isSymbolicLink()); assert(lstatSync(middle).isSymbolicLink())
      assert.equal(readlinkSync(path), pathLink); assert.equal(readlinkSync(middle), middleLink)
      const parsed = host === 'cursor' ? JSON.parse(bytes(target)) : toml(bytes(target))
      if (host === 'cursor') { assert.equal(parsed.user, true); assert.equal(parsed.mcpServers.user.command, 'custom'); assert(parsed.mcpServers['search-boost']) }
      else { assert.equal(parsed.web_search, 'live'); assert.equal(parsed.user.keep, true); assert(parsed.mcp_servers['search-boost']) }
    })
  }
  await test('R3 broken/cyclic/non-file host links fail closed; private credential writes still reject links', async () => {
    const { writeTextFile } = await import('../lib/json-config.mjs')
    const { writeFileAtomicPrivate } = await import('../lib/private-file.mjs')
    const dir = join(temp, 'bad-links'); mkdirSync(dir)
    const target = join(dir, 'credentials'), privateLink = join(dir, 'keys.json')
    write(target, '{"tavily":"fixture"}\n')
    if (!link(target, privateLink)) return
    assert.throws(() => writeFileAtomicPrivate(privateLink, 'changed', { tightenDir: false }), err => err.code === 'symlink_target')
    assert.equal(bytes(target), '{"tavily":"fixture"}\n'); assert(lstatSync(privateLink).isSymbolicLink())
    for (const [name, dest] of [['dangling', join(dir, 'missing')], ['cycle', join(dir, 'cycle')], ['directory', dir]]) {
      const path = join(dir, name)
      if (!link(dest, path, name === 'directory' ? 'dir' : 'file')) continue
      const prior = readlinkSync(path)
      await assert.rejects(writeTextFile(path, 'changed'))
      assert.equal(readlinkSync(path), prior)
    }
    assert(!existsSync(join(dir, 'missing')))
  })
  await test('R4 real print codex output parses with root search setting and correct MCP table', () => {
    const f = fixture('print')
    const out = cli(['print', 'codex'], f)
    assert.equal(out.code, 0, out.text)
    const parsed = toml(out.stdout)
    assert.equal(parsed.web_search, 'disabled')
    assert.equal(parsed.mcp_servers['search-boost'].web_search, undefined)
    assert(parsed.mcp_servers['search-boost'].command)
    assert.match(out.stdout, /before every \[table\] header/)
    for (const args of [['print', 'codex', '--keep-native'], ['print', 'grok']]) {
      const kept = cli(args, f); assert.equal(kept.code, 0, kept.text)
      assert.equal(toml(kept.stdout).web_search, undefined)
    }
  })
} finally {
  process.chdir(originalCwd)
  rmSync(temp, { recursive: true, force: true })
}
console.log(`${passed} independent-review regressions passed; ${skipped} symlink checks skipped`)
