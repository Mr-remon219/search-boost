// Jev credentials (experimental) — storage round-trips and CLI surface.
//
// The `jev` block shares the keys file with the engine keys, so the regression
// this suite guards is clobbering: a Jev write must keep engine keys + routing,
// an engine-key write must keep the Jev block, and a Jev-only keys.json must not
// look empty to the lazy flat/legacy migration in lib/config-paths.mjs.
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
import { prepareConfigWrite } from '../lib/config-paths.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const cli = join(root, 'cli.mjs')

let count = 0
const test = (name, fn) => { fn(); count++; console.log(`ok: ${name}`) }

const home = mkdtempSync(join(tmpdir(), `search-boost-jev-${process.pid}-`))
const keysFile = join(home, 'keys.json')
const savedKeysFile = process.env.SEARCH_BOOST_KEYS_FILE
const savedJevKey = process.env.TYPESAFE_API_KEY
process.env.SEARCH_BOOST_KEYS_FILE = keysFile
delete process.env.TYPESAFE_API_KEY

const readDoc = () => JSON.parse(readFileSync(keysFile, 'utf8'))

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

  test('save writes base URL + key next to the engine keys', () => {
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

  test('key from TYPESAFE_API_KEY is reported as env, not stored', () => {
    clearJevConfig()
    process.env.TYPESAFE_API_KEY = 'sk-env-1234567890'
    const status = jevStatus()
    assert.equal(status.configured, true)
    assert.equal(status.source, 'env')
    assert.equal(readDoc().jev, undefined)
    assert.ok(formatJevStatusLines().some((line) => line.includes('TYPESAFE_API_KEY')))
    delete process.env.TYPESAFE_API_KEY
  })

  test('clear removes only the Jev block', () => {
    saveJevConfig({ baseUrl: 'https://api.typesafe.ai/v1', apiKey: 'sk-test-1234567890' })
    clearJevConfig()
    assert.equal(readDoc().jev, undefined)
    assert.equal(readKeysFile().exa, 'exa-test-key-1234567890')
    assert.equal(jevStatus().configured, false)
  })

  test('a Jev-only keys.json is not overwritten by a flat/legacy copy', () => {
    const fakeHome = mkdtempSync(join(tmpdir(), 'search-boost-jev-migrate-'))
    try {
      const nestedDir = join(fakeHome, '.search-boost', 'config')
      mkdirSync(nestedDir, { recursive: true })
      const nestedFile = join(nestedDir, 'keys.json')
      writeFileSync(join(fakeHome, '.search-boost-keys.json'), JSON.stringify({ tavily: 'tvly-flat-12345678' }))
      writeFileSync(nestedFile, JSON.stringify({ jev: { baseUrl: 'https://proxy.test/v1', apiKey: 'sk-nested-123456' } }))
      const opts = { homeDir: fakeHome }
      delete process.env.SEARCH_BOOST_KEYS_FILE
      prepareConfigWrite('keys', opts)
      const nested = JSON.parse(readFileSync(nestedFile, 'utf8'))
      assert.deepEqual(nested.jev, { baseUrl: 'https://proxy.test/v1', apiKey: 'sk-nested-123456' })
      assert.equal(nested.tavily, undefined, 'the flat copy must not overwrite a Jev-only nested file')
    } finally {
      process.env.SEARCH_BOOST_KEYS_FILE = keysFile
      rmSync(fakeHome, { recursive: true, force: true })
    }
  })

  test('CLI: config jev --show reports an unconfigured state', () => {
    const out = runCli(['config', 'jev', '--show'])
    assert.match(out, /Jev \(experimental\)/)
    assert.match(out, /not configured/)
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
  if (savedKeysFile === undefined) delete process.env.SEARCH_BOOST_KEYS_FILE
  else process.env.SEARCH_BOOST_KEYS_FILE = savedKeysFile
  if (savedJevKey === undefined) delete process.env.TYPESAFE_API_KEY
  else process.env.TYPESAFE_API_KEY = savedJevKey
  rmSync(home, { recursive: true, force: true })
}

console.log(`\n${count} Jev config tests passed.`)
