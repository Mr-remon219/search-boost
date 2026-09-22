#!/usr/bin/env node
// Config authority + credential storage regressions (B1 / B2 / B4).
//
// These exercise the real modules through their public entry points. Where the
// contract is about what the runtime would actually call, the assertion uses the
// same engine registry the api layer builds — not UI text.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

// Isolate before importing the modules under test.
const home = mkdtempSync(join(tmpdir(), `sb-keys-authority-${process.pid}-`))
process.env.HOME = home
process.env.USERPROFILE = home
delete process.env.SEARCH_BOOST_HOME
delete process.env.SEARCH_BOOST_KEYS_FILE
for (const name of ['TAVILY_API_KEY', 'BRAVE_API_KEY', 'EXA_API_KEY', 'ANYSEARCH_API_KEY', 'PI_SEARCH_TAVILY_KEY', 'PI_SEARCH_BRAVE_KEY', 'PI_SEARCH_EXA_KEY']) {
  delete process.env[name]
}

const keys = await import('../lib/keys.mjs')
const { engineRegistry } = await import('../lib/search/engines.js')
const { configFlatPath, configNestedPath, configLegacyPath, isStoreInitialized, markStoreInitialized, prepareConfigWrite } = await import('../lib/config-paths.mjs')

let count = 0
const test = (name, fn) => {
  try {
    fn()
    count++
    console.log(`ok: ${name}`)
  } catch (err) {
    console.error(`FAIL: ${name}\n${err instanceof Error ? err.stack : err}`)
    process.exitCode = 1
  }
}

const canonical = () => configNestedPath('keys')
const flat = () => configFlatPath('keys')
const legacy = () => configLegacyPath('keys')
const readCanonical = () => JSON.parse(readFileSync(canonical(), 'utf8'))
const writeRaw = (file, text) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, text) }
const resetStore = () => {
  rmSync(canonical(), { force: true })
  rmSync(`${canonical()}.initialized`, { force: true })
  rmSync(`${canonical()}.lock`, { force: true })
  rmSync(flat(), { force: true })
  if (legacy()) rmSync(legacy(), { force: true })
  for (const name of ['TAVILY_API_KEY', 'BRAVE_API_KEY', 'EXA_API_KEY']) delete process.env[name]
}
/** The api-layer engine registry exactly as the runtime/doctor build it. */
const apiRegistry = () => {
  const { keys: readKeysValue, routing, enabledSet, summary } = keys.readKeysRouting()
  const explicit = summary.hasExplicitRouting || summary.enabled < summary.configured
  return { registry: engineRegistry(readKeysValue, explicit ? enabledSet : null), summary }
}

// ---------------------------------------------------------------------------
// B1 · engine enable/disable semantics
// ---------------------------------------------------------------------------

test('B1: an empty enabledEngines list is persisted and disables every keyed engine', () => {
  resetStore()
  keys.writeKeysFile({ tavily: 'tvly-fixture-123456', exa: 'exa-fixture-123456' })
  keys.setEnabledEngines([])
  assert.deepEqual(readCanonical().enabledEngines, [], 'the empty list must be on disk, not deleted')
  const routing = keys.readEngineRouting()
  assert.deepEqual(routing.enabledEngines, [], 'reading must see the explicit empty list')
  assert.deepEqual(keys.readKeysRouting().enabledNames, [], 'no keyed engine may be enabled')
})

test('B1: the api-layer registry really exposes no paid engine for an empty list', () => {
  resetStore()
  keys.writeKeysFile({ tavily: 'tvly-fixture-123456', exa: 'exa-fixture-123456' })
  keys.setEnabledEngines([])
  const { registry, summary } = apiRegistry()
  assert.equal(summary.hasExplicitRouting, true)
  assert.equal(registry.tavily.available(), false, 'tavily must not be callable')
  assert.equal(registry.exa.available(), false, 'exa must not be callable')
})

test('B1: clearing the restriction restores all configured engines', () => {
  resetStore()
  keys.writeKeysFile({ tavily: 'tvly-fixture-123456', exa: 'exa-fixture-123456' })
  keys.setEnabledEngines([])
  keys.setEnabledEngines(null)
  assert.equal('enabledEngines' in readCanonical(), false, 'null clears the field')
  assert.deepEqual(keys.readKeysRouting().enabledNames, ['tavily', 'exa'])
})

test('B1: a whitelist entry clears a stale per-engine disable flag', () => {
  resetStore()
  keys.writeKeysFile({ tavily: 'tvly-fixture-123456', exa: 'exa-fixture-123456' })
  keys.writeKeysFile({ engineFlags: { tavily: false } })
  assert.deepEqual(keys.readKeysRouting().enabledNames, ['exa'], 'the flag disables tavily first')
  keys.setEnabledEngines(['tavily'])
  assert.deepEqual(keys.readKeysRouting().enabledNames, ['tavily'], 'an explicit enable must not be cancelled by the stale flag')
})

test('B1: unknown engine names are rejected and nothing is written', () => {
  resetStore()
  keys.writeKeysFile({ tavily: 'tvly-fixture-123456' })
  const before = readFileSync(canonical(), 'utf8')
  assert.throws(() => keys.setEnabledEngines(['bogus-engine']), /Unknown engine name/)
  assert.throws(() => keys.writeKeysFile({ enabledEngines: ['tavily', 'nope'] }), /Unknown engine name/)
  assert.equal(readFileSync(canonical(), 'utf8'), before, 'a rejected patch must not touch the file')
})

test('B1: engine keys from the environment still respect an empty whitelist', () => {
  resetStore()
  process.env.TAVILY_API_KEY = 'tvly-env-fixture-123456'
  process.env.BRAVE_API_KEY = 'brave-env-fixture-123456'
  keys.writeKeysFile({ enabledEngines: [] })
  assert.deepEqual(keys.readKeysRouting().enabledNames, [], 'env keys must not bypass the whitelist')
  const { registry } = apiRegistry()
  assert.equal(registry.tavily.available(), false)
  assert.equal(registry.brave.available(), false)
})

test('B1: a fresh process reads the empty list instead of the default', () => {
  resetStore()
  keys.writeKeysFile({ tavily: 'tvly-fixture-123456', exa: 'exa-fixture-123456' })
  keys.setEnabledEngines([])
  const reader = join(home, 'reader.mjs')
  // A file:// URL, not a raw path: Windows rejects absolute paths as ESM specifiers.
  writeFileSync(reader, `const k = await import(${JSON.stringify(pathToFileURL(join(root, 'lib/keys.mjs')).href)})\nconsole.log(JSON.stringify(k.readKeysRouting().enabledNames))\n`)
  const out = execFileSync(process.execPath, [reader], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home, USERPROFILE: home },
  })
  assert.deepEqual(JSON.parse(out.trim()), [], 'a restart must not restore the default')
})

// ---------------------------------------------------------------------------
// B2 · configuration authority
// ---------------------------------------------------------------------------

test('B2: deleting the last key does not resurrect it from a flat copy', () => {
  resetStore()
  writeRaw(flat(), JSON.stringify({ tavily: 'tvly-flat-old-123456' }))
  keys.writeKeysFile({ exa: 'exa-fixture-123456' })
  assert.equal(keys.readKeysFile().tavily, 'tvly-flat-old-123456', 'the first write adopts the older copy once')
  keys.writeKeysFile({ tavily: undefined, exa: undefined })
  assert.deepEqual(readCanonical(), {}, 'the canonical store is empty after the delete')
  assert.equal(keys.readKeysFile().tavily, undefined, 'the older flat copy must not come back')
  assert.equal(keys.readKeysFile().exa, undefined)
})

test('B2: a legacy copy cannot resurrect a deleted key either', () => {
  resetStore()
  writeRaw(legacy(), JSON.stringify({ tavily: 'tvly-legacy-old-123456' }))
  keys.writeKeysFile({ exa: 'exa-fixture-123456' })
  assert.equal(keys.readKeysFile().tavily, 'tvly-legacy-old-123456', 'the legacy copy is adopted once')
  keys.writeKeysFile({ tavily: undefined, exa: undefined })
  assert.equal(keys.readKeysFile().tavily, undefined, 'the legacy copy must not come back')
})

test('B2: a routing-only canonical store is honoured when keys come from the environment', () => {
  resetStore()
  process.env.TAVILY_API_KEY = 'tvly-env-fixture-123456'
  process.env.BRAVE_API_KEY = 'brave-env-fixture-123456'
  keys.writeKeysFile({ enabledEngines: ['brave'], engineFlags: { tavily: false } })
  const routing = keys.readEngineRouting()
  assert.deepEqual(routing.enabledEngines, ['brave'], 'routing metadata must be read even without secrets')
  assert.deepEqual(keys.readKeysRouting().enabledNames, ['brave'], 'tavily must stay disabled')
  const { registry } = apiRegistry()
  assert.equal(registry.tavily.available(), false)
  assert.equal(registry.brave.available(), true)
})

test('B2: a corrupt canonical store is reported, not replaced by an older copy', () => {
  resetStore()
  writeRaw(flat(), JSON.stringify({ tavily: 'tvly-flat-old-123456' }))
  writeRaw(canonical(), '{not-json\n')
  assert.throws(() => keys.readKeysFile(), (err) => err?.code === 'store_corrupt')
  assert.throws(() => keys.readKeysRouting(), (err) => err?.code === 'store_corrupt')
  assert.throws(() => keys.readKeysFileDocument(), (err) => err?.code === 'store_corrupt')
})

test('B2: a corrupt canonical store is never overwritten by a write', () => {
  resetStore()
  const corrupt = '{not-json\n'
  writeRaw(canonical(), corrupt)
  assert.throws(() => keys.writeKeysFile({ tavily: 'tvly-fixture-123456' }), (err) => err?.code === 'store_corrupt')
  assert.equal(readFileSync(canonical(), 'utf8'), corrupt, 'the user file must be left exactly as it was')
  assert.ok(!existsSync(`${canonical()}.lock`), 'no lock may be left behind')
})

test('B2: migration runs once and an initialized store blocks it afterwards', () => {
  resetStore()
  writeRaw(flat(), JSON.stringify({ tavily: 'tvly-flat-123456' }))
  assert.equal(prepareConfigWrite('keys'), canonical())
  assert.equal(JSON.parse(readFileSync(canonical(), 'utf8')).tavily, 'tvly-flat-123456', 'the first migration adopts the keys')
  assert.ok(isStoreInitialized(canonical()), 'the store is marked initialized')
  // A later change to the old copy must not be re-imported.
  writeRaw(flat(), JSON.stringify({ tavily: 'tvly-flat-123456', exa: 'exa-late-123456' }))
  prepareConfigWrite('keys')
  assert.equal(JSON.parse(readFileSync(canonical(), 'utf8')).exa, undefined, 'a repeated migration must be a no-op')
})

test('B2: an explicitly emptied store is not re-adopted from an older copy', () => {
  resetStore()
  keys.writeKeysFile({ tavily: 'tvly-fixture-123456' })   // initializes the canonical store
  keys.writeKeysFile({ tavily: undefined })                // the user deletes the last key
  writeRaw(flat(), JSON.stringify({ tavily: 'tvly-flat-123456' }))   // an older copy appears later
  prepareConfigWrite('keys')
  assert.deepEqual(readCanonical(), {}, 'the empty canonical store stays authoritative')
  assert.equal(keys.readKeysFile().tavily, undefined, 'the older copy must not be adopted')
})

// ---------------------------------------------------------------------------
// B4 · private, atomic credential writes
// ---------------------------------------------------------------------------

const savedUmask = process.umask(0o022)
const temps = (dir) => readdirSync(dir).filter((name) => name.includes('.tmp'))
const isWindows = process.platform === 'win32'
const skippedChecks = []
/**
 * POSIX mode bits have no Windows equivalent; ACL inheritance applies there.
 * Claiming 0600 equals a private ACL would be wrong, so those assertions are
 * reported as skipped on Windows instead of silently passing.
 */
const posixOnly = (name, fn) => {
  if (isWindows) {
    skippedChecks.push(name)
    console.log(`skip: ${name} — POSIX file modes are not a Windows ACL claim`)
    return
  }
  test(name, fn)
}

posixOnly('B4: new credential files are 0600 inside a 0700 directory under umask 022', () => {
  resetStore()
  keys.writeKeysFile({ tavily: 'tvly-fixture-123456' })
  const fileMode = statSync(canonical()).mode & 0o777
  const dirMode = statSync(dirname(canonical())).mode & 0o777
  assert.equal(fileMode, 0o600, `keys file mode was ${fileMode.toString(8)}`)
  assert.equal(dirMode, 0o700, `config dir mode was ${dirMode.toString(8)}`)
  assert.equal(statSync(`${canonical()}.initialized`).mode & 0o777, 0o600, 'the marker is private too')
  assert.deepEqual(temps(dirname(canonical())), [], 'no temp file may be left behind')
})

posixOnly('B4: rewriting keeps the file private and tightens a wider existing file', () => {
  resetStore()
  keys.writeKeysFile({ tavily: 'tvly-fixture-123456' })
  chmodSync(canonical(), 0o644)
  keys.writeKeysFile({ exa: 'exa-fixture-123456' })
  assert.equal(statSync(canonical()).mode & 0o777, 0o600, 'a rewrite must not leave the file world-readable')
  assert.equal(JSON.parse(readFileSync(canonical(), 'utf8')).tavily, 'tvly-fixture-123456', 'existing values survive')
})

test('B4: a failed write leaves the previous file intact and no temp file behind', () => {
  resetStore()
  keys.writeKeysFile({ tavily: 'tvly-fixture-123456' })
  const before = readFileSync(canonical(), 'utf8')
  // A leftover lock makes the next writer fail before touching the store.
  writeFileSync(`${canonical()}.lock`, 'stale\n')
  assert.throws(() => keys.writeKeysFile({ exa: 'exa-fixture-123456' }), (err) => err?.code === 'write_conflict')
  assert.equal(readFileSync(canonical(), 'utf8'), before)
  rmSync(`${canonical()}.lock`, { force: true })
})

test('B4: a stale lock is reclaimed instead of blocking forever', () => {
  resetStore()
  keys.writeKeysFile({ tavily: 'tvly-fixture-123456' })
  const lock = `${canonical()}.lock`
  writeFileSync(lock, 'stale\n')
  const old = new Date(Date.now() - 60_000)
  chmodSync(lock, 0o600)
  // Backdate the lock so the reclaim is deterministic instead of waiting it out.
  utimesSync(lock, old, old)
  keys.writeKeysFile({ exa: 'exa-fixture-123456' })
  assert.equal(JSON.parse(readFileSync(canonical(), 'utf8')).exa, 'exa-fixture-123456')
  assert.ok(!existsSync(lock), 'the lock is released after the write')
})

test('B4: writing through a symlink is refused and the target is untouched', () => {
  resetStore()
  const target = join(home, 'attacker-target.json')
  writeRaw(target, JSON.stringify({ untouched: true }))
  mkdirSync(dirname(canonical()), { recursive: true })
  try {
    symlinkSync(target, canonical())
  } catch {
    // Symlink creation needs privileges on Windows; report it instead of
    // pretending the check ran.
    skippedChecks.push('symlink target refused')
    console.log('skip: symlink target refused — symlinks unavailable on this platform')
    return
  }
  assert.throws(() => keys.writeKeysFile({ tavily: 'tvly-fixture-123456' }), (err) => err?.code === 'symlink_target')
  assert.deepEqual(JSON.parse(readFileSync(target, 'utf8')), { untouched: true })
  assert.ok(!existsSync(`${canonical()}.lock`), 'no lock may be left behind')
})

test('B4: error messages never contain credential material', () => {
  resetStore()
  const secret = 'tvly-super-secret-value-987654'
  keys.writeKeysFile({ tavily: secret })
  writeFileSync(`${canonical()}.lock`, 'stale\n')
  try {
    keys.writeKeysFile({ exa: 'exa-fixture-123456' })
    assert.fail('expected a conflict')
  } catch (err) {
    assert.ok(!String(err.message).includes(secret), 'the error must not echo a credential')
  }
  rmSync(`${canonical()}.lock`, { force: true })
  // A corrupt store error must not dump file contents either.
  writeRaw(canonical(), `{ "tavily": "${secret}", broken`)
  try {
    keys.readKeysFile()
    assert.fail('expected a corrupt-store error')
  } catch (err) {
    assert.ok(!String(err.message).includes(secret), 'the error must not echo a credential')
  }
})

process.umask(savedUmask)

console.log(`\n${count} config authority tests passed.${skippedChecks.length ? `\nskipped: ${skippedChecks.join('; ')}` : ''}`)
if (process.exitCode) console.error('FAILURES PRESENT')
