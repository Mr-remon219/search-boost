import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'sb-base-urls-'))
process.env.HOME = process.env.USERPROFILE = home
process.env.SEARCH_BOOST_HOME = join(home, '.search-boost')
delete process.env.SEARCH_BOOST_KEYS_FILE
for (const name of ['TAVILY_API_KEY', 'BRAVE_API_KEY', 'EXA_API_KEY', 'ANYSEARCH_API_KEY', 'PI_SEARCH_TAVILY_KEY', 'PI_SEARCH_BRAVE_KEY', 'PI_SEARCH_EXA_KEY']) delete process.env[name]
const { ENGINE_BASE_URLS, normalizeEngineBaseUrl } = await import('../lib/engine-endpoints.mjs')
const { keysFilePath, readEngineBaseUrls, readKeysFileDocument, writeKeysFile } = await import('../lib/keys.mjs')
const { runKeysWizard, formatKeyStatusLines } = await import('../lib/installer/keys-wizard.mjs')
const { parseFlags } = await import('../lib/cli/args.mjs')
const { runtimeSnapshot } = await import('../lib/search/capability.js')
try {
  assert.deepEqual(readEngineBaseUrls(), ENGINE_BASE_URLS)
  for (const url of ['', 'ftp://example.org', '/relative', 'https://user:secret@example.org', 'https://example.org?key=secret', 'https://example.org#fragment', 'https://example.org\\path']) {
    assert.throws(() => normalizeEngineBaseUrl(url), /Base URL/)
  }
  assert.equal(normalizeEngineBaseUrl(' https://gateway.example/prefix/// '), 'https://gateway.example/prefix')
  // A hand-written URL-only canonical store must outrank a legacy key file.
  mkdirSync(join(home, '.search-boost', 'config'), { recursive: true })
  writeFileSync(keysFilePath(), JSON.stringify({ engines: { exa: { baseUrl: 'https://canonical.example' } } }))
  writeFileSync(join(home, '.search-boost-keys.json'), JSON.stringify({ exa: 'stale-key' }))
  assert.equal(readEngineBaseUrls().exa, 'https://canonical.example')
  assert.equal(readKeysFileDocument().doc.exa, undefined)
  writeKeysFile({ baseUrls: { exa: null } })
  const before = runtimeSnapshot().fingerprint
  await runKeysWizard(null, parseFlags(['--base-url', 'anysearch=https://gateway.example/v1/']))
  assert.equal(readEngineBaseUrls().anysearch, 'https://gateway.example/v1')
  assert.notEqual(runtimeSnapshot().fingerprint, before)
  assert.ok(formatKeyStatusLines().join('\n').includes('https://gateway.example/v1 (custom)'))
  writeKeysFile({ exa: 'fixture-key', engineFlags: { anysearch: false }, jev: { apiKey: 'jev-key' } })
  writeKeysFile({ enabledEngines: ['anysearch'] })
  assert.equal(readEngineBaseUrls().anysearch, 'https://gateway.example/v1')
  assert.equal(readKeysFileDocument().doc.engines.anysearch.enabled, undefined)
  let original = readFileSync(keysFilePath(), 'utf8')
  await runKeysWizard(null, parseFlags(['--base-url', 'exa=https://dry.example', '--dry-run']))
  assert.equal(readFileSync(keysFilePath(), 'utf8'), original)
  await assert.rejects(runKeysWizard(null, parseFlags(['--set', 'exa=replacement', '--base-url', 'brave=invalid'])))
  await assert.rejects(runKeysWizard(null, parseFlags(['--base-url', 'unknown=https://example.org'])))
  await assert.rejects(runKeysWizard(null, parseFlags(['--base-url', 'exa=https://example.org', '--reset-base-url', 'exa'])))
  assert.equal(readFileSync(keysFilePath(), 'utf8'), original)

  const actions = ['url', 'set', 'keep', 'keep', 'reset-url', 'keep']
  const prompts = []
  const clack = {
    isCancel: () => false,
    log: { info() {}, warn() {}, success() {} },
    select: async (prompt) => { prompts.push(prompt); assert.ok(actions.length); return actions.shift() },
    text: async (prompt) => {
      assert.match(prompt.validate('bad'), /Base URL/)
      assert.equal(prompt.validate('https://tui.example/tavily/'), undefined)
      return 'https://tui.example/tavily/'
    },
    password: async () => 'new-key',
    multiselect: async () => ['tavily', 'exa'],
  }
  await runKeysWizard(clack)
  assert.equal(actions.length, 0)
  assert.match(prompts[1].message, /https:\/\/tui.example\/tavily \(custom\)/)
  assert.equal(readEngineBaseUrls().tavily, 'https://tui.example/tavily')
  assert.equal(readEngineBaseUrls().anysearch, ENGINE_BASE_URLS.anysearch)
  assert.equal(readKeysFileDocument().doc.tavily, 'new-key')
  assert.equal(readKeysFileDocument().doc.jev.apiKey, 'jev-key')
  original = readFileSync(keysFilePath(), 'utf8')
  actions.push('url', 'keep', 'keep', 'keep', 'keep')
  await runKeysWizard(clack, { dryRun: true })
  assert.equal(readFileSync(keysFilePath(), 'utf8'), original)
  actions.push('url')
  await assert.rejects(runKeysWizard({ ...clack, text: async () => { throw new Error('cancelled') } }), /cancelled/)
  assert.equal(readFileSync(keysFilePath(), 'utf8'), original)
  await runKeysWizard(null, parseFlags(['--reset-base-url', 'tavily']))
  assert.deepEqual(readEngineBaseUrls(), ENGINE_BASE_URLS)
  assert.equal(readKeysFileDocument().doc.tavily, 'new-key')
  console.log('ok: Base URL validation, persistence, CLI, TUI, dry-run, reset and cache partition')
} finally {
  rmSync(home, { recursive: true, force: true })
}
