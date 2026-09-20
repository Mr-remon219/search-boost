// Jev credentials (experimental) — storage round-trips, trust boundary and CLI surface.
//
// Trust boundary under test (B3): the `jev` block is read from and written to the
// canonical user-level store only. A project-local file, an env-relocated keys
// path, a legacy DSH/Pi file or TYPESAFE_API_KEY can never supply the endpoint or
// the key, so a low-trust file cannot redirect a global credential.
//
// The `jev` block shares the canonical keys file with engine keys and routing, so
// the other regression this suite guards is clobbering: a Jev write must keep
// engine keys + routing, and an engine-key/routing write must keep the Jev block.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  JEV_DEFAULT_BASE_URL,
  clearJevConfig,
  jevStatus,
  normalizeJevBaseUrl,
  readJevConfig,
  saveJevConfig,
} from '../lib/jev-config.mjs'
import { formatJevStatusLines } from '../lib/installer/jev-wizard.mjs'
import { KEY_NAMES, readEngineRouting, readKeysFile, readKeysRouting, writeKeysFile } from '../lib/keys.mjs'
import { configNestedPath, prepareConfigWrite } from '../lib/config-paths.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const cli = join(root, 'cli.mjs')

let count = 0
const test = (name, fn) => { fn(); count++; console.log(`ok: ${name}`) }

const savedEnv = {
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  SEARCH_BOOST_HOME: process.env.SEARCH_BOOST_HOME,
  SEARCH_BOOST_KEYS_FILE: process.env.SEARCH_BOOST_KEYS_FILE,
  TYPESAFE_API_KEY: process.env.TYPESAFE_API_KEY,
}
const home = mkdtempSync(join(tmpdir(), `search-boost-jev-${process.pid}-`))
process.env.HOME = home
process.env.USERPROFILE = home
delete process.env.SEARCH_BOOST_HOME
delete process.env.SEARCH_BOOST_KEYS_FILE
delete process.env.TYPESAFE_API_KEY

/** The canonical user-level store: ~/.search-boost/config/keys.json */
const canonicalFile = () => configNestedPath('keys')
const readDoc = () => JSON.parse(readFileSync(canonicalFile(), 'utf8'))
const writeDoc = (doc) => {
  mkdirSync(dirname(canonicalFile()), { recursive: true })
  writeFileSync(canonicalFile(), `${JSON.stringify(doc, null, 2)}\n`)
}

/** @param {string[]} args */
function runCli(args) {
  const env = { ...process.env }
  delete env.TYPESAFE_API_KEY
  return execFileSync(process.execPath, [cli, ...args], {
    encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'], env,
  })
}

try {
  test('base URL is normalized and validated', () => {
    assert.equal(normalizeJevBaseUrl(' https://api.typesafe.ai/v1/ '), 'https://api.typesafe.ai/v1')
    assert.throws(() => normalizeJevBaseUrl('api.typesafe.ai'), /Not a valid URL/)
    assert.throws(() => normalizeJevBaseUrl('ftp://api.typesafe.ai'), /http:\/\/ or https:\/\//)
    assert.throws(() => normalizeJevBaseUrl(''), /required/)
  })

  test('unconfigured Jev stays quiet (defaults + empty status block)', () => {
    const cfg = readJevConfig()
    assert.equal(cfg.baseUrl, JEV_DEFAULT_BASE_URL)
    assert.equal(cfg.baseUrlStored, false)
    assert.equal(cfg.source, 'missing')
    assert.equal(jevStatus().configured, false)
    assert.deepEqual(formatJevStatusLines(), [])
  })

  test('TYPESAFE_API_KEY alone never configures Jev', () => {
    process.env.TYPESAFE_API_KEY = 'sk-env-1234567890'
    try {
      const cfg = readJevConfig()
      assert.equal(cfg.apiKey, undefined, 'the env key must not be consumed')
      assert.equal(cfg.source, 'missing')
      assert.equal(jevStatus().configured, false)
      assert.deepEqual(formatJevStatusLines(), [], 'status must not advertise an env fallback')
      assert.ok(!formatJevStatusLines().join('\n').includes('TYPESAFE_API_KEY'))
      // Only changing the URL must not absorb the env key into the file.
      assert.throws(() => saveJevConfig({ baseUrl: 'https://api.typesafe.ai/v1' }), /Jev API key is required/)
      const stored = (() => { try { return readFileSync(canonicalFile(), 'utf8') } catch { return '' } })()
      assert.ok(!stored.includes('sk-env-1234567890'), 'env key must never be stored')
    } finally {
      delete process.env.TYPESAFE_API_KEY
    }
  })

  test('an env-relocated keys file cannot supply Jev credentials', () => {
    const elsewhere = join(home, 'relocated-keys.json')
    writeFileSync(elsewhere, JSON.stringify({ jev: { baseUrl: 'https://evil.invalid/v1', apiKey: 'sk-evil-123456' } }))
    process.env.SEARCH_BOOST_KEYS_FILE = elsewhere
    try {
      const cfg = readJevConfig()
      assert.equal(cfg.source, 'missing', 'Jev must ignore an env-relocated store')
      assert.equal(cfg.baseUrl, JEV_DEFAULT_BASE_URL)
    } finally {
      delete process.env.SEARCH_BOOST_KEYS_FILE
    }
  })

  test('a project-local file cannot supply Jev credentials', () => {
    const projectFile = join(process.cwd(), '.search-boost-keys.json')
    const existed = (() => { try { readFileSync(projectFile, 'utf8'); return true } catch { return false } })()
    if (existed) return
    writeFileSync(projectFile, JSON.stringify({ jev: { baseUrl: 'https://project.invalid/v1', apiKey: 'sk-project-123456' } }))
    try {
      const cfg = readJevConfig()
      assert.equal(cfg.source, 'missing', 'a project file must not configure Jev')
      assert.equal(cfg.baseUrl, JEV_DEFAULT_BASE_URL)
    } finally {
      rmSync(projectFile, { force: true })
    }
  })

  test('save writes base URL + key into the canonical store', () => {
    saveJevConfig({ baseUrl: 'https://api.typesafe.ai/v1/', apiKey: 'sk-test-1234567890' })
    assert.deepEqual(readDoc().jev, { baseUrl: 'https://api.typesafe.ai/v1', apiKey: 'sk-test-1234567890' })
    const cfg = readJevConfig()
    assert.equal(cfg.baseUrl, 'https://api.typesafe.ai/v1')
    assert.equal(cfg.baseUrlStored, true)
    assert.equal(cfg.source, 'file')
    const status = jevStatus()
    assert.equal(status.configured, true)
    assert.match(status.masked, /^\S{4}\*{4}\S{4}$/)
    assert.ok(!status.masked.includes('sk-test-1234567890'), 'status must not expose the raw key')
  })

  test('Jev is not a search engine (absent from KEY_NAMES and routing)', () => {
    assert.deepEqual(KEY_NAMES, ['tavily', 'brave', 'exa'])
    assert.ok(!readKeysRouting().enabledNames.includes('jev'))
  })

  test('a Jev write keeps engine keys and api-layer routing', () => {
    writeKeysFile({ tavily: 'tvly-test-key-12345678', enabledEngines: ['tavily'] })
    saveJevConfig({ apiKey: 'sk-test-abcdefghij' })
    assert.equal(readKeysFile().tavily, 'tvly-test-key-12345678')
    assert.deepEqual(readEngineRouting().enabledEngines, ['tavily'])
    assert.equal(readDoc().jev.apiKey, 'sk-test-abcdefghij')
  })

  test('engine-key writes and routing writes keep the Jev block', () => {
    writeKeysFile({ exa: 'exa-test-key-1234567890' })
    writeKeysFile({ enabledEngines: null })
    writeKeysFile({ brave: undefined })
    assert.equal(readJevConfig().apiKey, 'sk-test-abcdefghij')
    assert.equal(readDoc().jev.baseUrl, 'https://api.typesafe.ai/v1')
    assert.equal(readKeysFile().exa, 'exa-test-key-1234567890')
  })

  test('clear removes only the Jev block and env cannot revive it', () => {
    saveJevConfig({ baseUrl: 'https://api.typesafe.ai/v1', apiKey: 'sk-test-1234567890' })
    clearJevConfig()
    assert.equal(readDoc().jev, undefined)
    assert.equal(readKeysFile().exa, 'exa-test-key-1234567890')
    assert.equal(jevStatus().configured, false)
    process.env.TYPESAFE_API_KEY = 'sk-env-1234567890'
    try {
      assert.equal(jevStatus().configured, false, 'a cleared store stays cleared')
    } finally {
      delete process.env.TYPESAFE_API_KEY
    }
  })

  test('a Jev-only canonical store is not overwritten by a flat/legacy copy', () => {
    const fakeHome = mkdtempSync(join(tmpdir(), 'search-boost-jev-migrate-'))
    try {
      const nestedDir = join(fakeHome, '.search-boost', 'config')
      mkdirSync(nestedDir, { recursive: true })
      const nestedFile = join(nestedDir, 'keys.json')
      writeFileSync(join(fakeHome, '.search-boost-keys.json'), JSON.stringify({ tavily: 'tvly-flat-12345678' }))
      writeFileSync(nestedFile, JSON.stringify({ jev: { baseUrl: 'https://proxy.test/v1', apiKey: 'sk-nested-123456' } }))
      const opts = { homeDir: fakeHome }
      prepareConfigWrite('keys', opts)
      const nested = JSON.parse(readFileSync(nestedFile, 'utf8'))
      assert.deepEqual(nested.jev, { baseUrl: 'https://proxy.test/v1', apiKey: 'sk-nested-123456' })
      assert.equal(nested.tavily, undefined, 'the flat copy must not overwrite a Jev-only nested file')
    } finally {
      rmSync(fakeHome, { recursive: true, force: true })
    }
  })

  test('a compat file\'s Jev block is never adopted by migration', () => {
    const fakeHome = mkdtempSync(join(tmpdir(), 'search-boost-jev-adopt-'))
    try {
      writeFileSync(join(fakeHome, '.search-boost-keys.json'), JSON.stringify({
        tavily: 'tvly-flat-12345678',
        jev: { baseUrl: 'https://legacy.invalid/v1', apiKey: 'sk-legacy-123456' },
      }))
      const nestedFile = join(fakeHome, '.search-boost', 'config', 'keys.json')
      const written = prepareConfigWrite('keys', { homeDir: fakeHome })
      assert.equal(written, nestedFile)
      const nested = JSON.parse(readFileSync(nestedFile, 'utf8'))
      assert.equal(nested.tavily, 'tvly-flat-12345678', 'engine keys still migrate')
      assert.equal(nested.jev, undefined, 'a non-canonical Jev block must not be imported')
    } finally {
      rmSync(fakeHome, { recursive: true, force: true })
    }
  })

  test('CLI: config jev --show reports an unconfigured state', () => {
    const out = runCli(['config', 'jev', '--show'])
    assert.match(out, /Jev \(experimental\)/)
    assert.match(out, /not configured/)
    assert.ok(!out.includes('TYPESAFE_API_KEY'), 'the CLI must not advertise an env fallback')
  })

  test('CLI: config jev saves, shows masked, and clears', () => {
    const saved = runCli(['config', 'jev', '--jev-base-url', 'https://api.typesafe.ai/v1', '--jev-api-key', 'sk-cli-1234567890'])
    assert.match(saved, /Saved Jev credentials/)
    const shown = runCli(['config', 'jev', '--show'])
    assert.match(shown, /https:\/\/api\.typesafe\.ai\/v1/)
    assert.ok(shown.includes('****'), 'show must mask the key')
    assert.ok(!shown.includes('sk-cli-1234567890'), 'show must not print the raw key')
    const cleared = runCli(['config', 'jev', '--clear'])
    assert.match(cleared, /Removed Jev credentials/)
    assert.equal(readDoc().jev, undefined)
  })

  test('CLI: requires a key and documents the flags in help', () => {
    assert.throws(
      () => runCli(['config', 'jev', '--jev-base-url', 'https://api.typesafe.ai/v1']),
      /Jev API key is required/,
    )
    const help = runCli(['--help'])
    assert.match(help, /Config jev \(experimental/)
    assert.match(help, /--jev-api-key KEY/)
    assert.match(help, /config keys\|layer\|x\|jev\|search\|diag/)
  })
} finally {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  rmSync(home, { recursive: true, force: true })
}

console.log(`\n${count} Jev config tests passed.`)
