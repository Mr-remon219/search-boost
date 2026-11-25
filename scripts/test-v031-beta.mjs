import './isolate-tests.mjs'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { ConsoleModel, renderConsole, displayWidth } from '../lib/console-tui.mjs'
import { setKey, writeKeysFile, readKeysRouting, readKeysFileDocument, keysFilePath, KEY_NAMES } from '../lib/keys.mjs'
import { formatKeyStatusLines } from '../lib/installer/keys-wizard.mjs'
import { describeDefaultSearch, explainSelection } from '../lib/search/routing.js'
import { plannedEngineCalls, fitDiagnosticNote } from '../lib/search/fusion.js'
import { normalizeSearchHit } from '../lib/search/results.js'
import { runFused, fusedResultIsError, fusedHitToJson, invalidateSearchCaches } from '../lib/runtime.mjs'
import { runChain } from '../lib/search/engines.js'
import { checkApiKeyedPool } from '../lib/doctor/checks/engines.mjs'

const key = (name) => `${name}-fixture-key-123456`
function clearKeys(extra = {}) {
  const patch = { enabledEngines: null }
  for (const name of KEY_NAMES) patch[name] = undefined
  writeKeysFile({ ...patch, ...extra })
}

clearKeys()
const none = describeDefaultSearch([])
assert.deepEqual(none.engines, ['bing', 'ddg', 'exa-free', 'anysearch'])
assert.equal(none.chargeable.length, 0)
assert.match(none.lines.join('\n'), /complete setup/)
assert.match(none.lines.join('\n'), /这是完整配置/)
assert.doesNotMatch(none.lines.join('\n'), /未配齐/)
assert.match(formatKeyStatusLines().join('\n'), /complete setup/)
assert.equal(checkApiKeyedPool().status, 'pass')
assert.match(checkApiKeyedPool().message, /no enabled API key/)
assert.doesNotMatch(checkApiKeyedPool().message, /未配齐/)

clearKeys({ firecrawl: key('firecrawl'), keenable: key('keenable') })
const paid = describeDefaultSearch(readKeysRouting().enabledNames, { whitelist: readKeysRouting().routing.enabledEngines })
assert.deepEqual(paid.engines, ['firecrawl', 'keenable'])
assert.deepEqual(paid.chargeable, ['firecrawl', 'keenable'])
assert.match(paid.lines.join('\n'), /engine_pool=free/)
assert.match(paid.lines.join('\n'), /May incur charges/)
const shown = formatKeyStatusLines().join('\n')
assert.match(shown, /firecrawl, keenable/)
assert.match(shown, /engine_pool=free/)
assert.doesNotMatch(shown, /未配齐/)
assert.equal(shown.includes(key('firecrawl')), false)

clearKeys()
setKey('tavily', key('tavily'))
assert.equal(readKeysFileDocument().doc.enabledEngines, undefined)
assert.deepEqual(readKeysRouting().enabledNames, ['tavily'])
setKey('deepseek-search', key('deepseek'))
assert.equal(readKeysFileDocument().doc.enabledEngines, undefined, 'saving a key does not create a whitelist')
assert.deepEqual(readKeysRouting().enabledNames, ['tavily', 'deepseek-search'], 'without a whitelist the new key joins the implicit default set')
writeKeysFile({ enabledEngines: ['tavily'] })
setKey('deepseek-search', key('deepseek-next'))
assert.deepEqual(readKeysFileDocument().doc.enabledEngines, ['tavily'])
assert.deepEqual(readKeysRouting().enabledNames, ['tavily'], 'an existing whitelist is not expanded by saving a key')
const whitelisted = formatKeyStatusLines().join('\n')
assert.match(whitelisted, /does not change the stored engine whitelist \(tavily\)/)
writeKeysFile({ enabledEngines: [] })
setKey('deepseek-search', key('deepseek-empty'))
assert.deepEqual(readKeysFileDocument().doc.enabledEngines, [])
assert.deepEqual(readKeysRouting().enabledNames, [])
clearKeys({ 'deepseek-search': key('deepseek'), enabledEngines: ['deepseek-search'] })
setKey('deepseek-search', key('deepseek-replaced'))
assert.deepEqual(readKeysFileDocument().doc.enabledEngines, ['deepseek-search'])
assert.deepEqual(readKeysRouting().enabledNames, ['deepseek-search'])

const cli = fileURLToPath(new URL('../cli.mjs', import.meta.url))
const show = spawnSync(process.execPath, [cli, 'config', 'keys', '--show'], { encoding: 'utf8' })
assert.equal(show.status, 0, show.stderr)
assert.match(show.stdout, /engine_pool is omitted/)
assert.match(show.stdout, /\/v1\/tools\/search/)
assert.doesNotMatch(show.stdout, /未配齐|live account was verified|web_search_20250305/)
console.log('--- isolation CLI keys --show (not a live search) ---')
console.log(show.stdout)

const model = new ConsoleModel({ language: 'en' })
model.handleKey('3')
const details = model.rows.map(row => (row.details ?? []).join('\n')).join('\n')
assert.match(details, /engine_pool is omitted/)
assert.match(details, /May incur charges/)
assert.doesNotMatch(details, /未配齐/)
const screen = renderConsole(model, { columns: 120, rows: 40, color: false })
assert.match(details.split('\n')[0], /Automatic search:/)
assert.match(details, /POST \/v1\/tools\/search/)
assert.match(screen, /Automatic search:/)
const narrow = renderConsole(model, { columns: 48, rows: 16, color: false })
for (const line of narrow.split('\n')) assert.ok(displayWidth(line) <= 48, line)
assert.match(narrow, /54/)
const compact = renderConsole(model, { columns: 54, rows: 16, color: false })
for (const line of compact.split('\n')) assert.ok(displayWidth(line) <= 54, line)
assert.match(compact, /Automatic search:/)
const zh = new ConsoleModel({ language: 'zh-CN' })
zh.handleKey('3')
const zhScreen = renderConsole(zh, { columns: 54, rows: 16, color: false })
for (const line of zhScreen.split('\n')) assert.ok(displayWidth(line) <= 54, line)
assert.match(zhScreen, /自动搜索/)
console.log('--- isolation console search page (not a host TUI) ---')
console.log(details)
console.log(screen)
const before = readFileSync(keysFilePath(), 'utf8')
model.confirm('replace the whitelist?', () => writeKeysFile({ enabledEngines: ['tavily', 'deepseek-search'] }))
model.handleKey('', { name: 'return' })
assert.equal(readFileSync(keysFilePath(), 'utf8'), before, 'the default confirm choice cancels and writes nothing')
assert.match(renderConsole(model, { columns: 100, rows: 20, color: false }), /Cancel — do not save|Ready|engine_pool/)

const messy = normalizeSearchHit({
  url: 'https://example.com/docs',
  title: '  <b>标题</b> \u202ehid',
  snippet: 'a < b &amp; café مرحبا',
  summary: '<em>给模型的摘要</em>',
  published: null,
})
assert.equal(messy.title, '标题 hid')
assert.equal(messy.snippet, 'a < b & café مرحبا')
assert.equal(messy.summary, '给模型的摘要')
assert.equal(messy.published, null)
assert.doesNotMatch(messy.snippet, /<em>|<b>/)
const script = normalizeSearchHit({ url: 'https://example.com/x', title: 'T', snippet: '<script>alert(1)</script>' })
assert.equal(script.snippet, 'alert(1)')
assert.equal(script.summary, undefined)
assert.equal(normalizeSearchHit({ url: 'https://example.com/x', title: '', snippet: '' }).title, '')
assert.equal(normalizeSearchHit({ url: 'https://user:secret@example.com/x', title: 'nope' }), null)
assert.equal(normalizeSearchHit({ url: 'javascript:alert(1)', title: 'nope' }), null)

function fake(name, impl) {
  return { available: () => true, passthroughQuery: name === 'deepseek-search', search: impl }
}
const calls = []
const engines = {
  'deepseek-search': fake('deepseek-search', async (q) => { calls.push(['deepseek-search', q]); return [] }),
  tavily: fake('tavily', async () => { calls.push(['tavily']); throw Object.assign(new Error('tavily http 401'), { kind: 'http_401' }) }),
  firecrawl: fake('firecrawl', async () => { calls.push(['firecrawl']); return [{ title: 'Kept', url: 'https://example.com/kept', snippet: 'ui', summary: 'agent text' }] }),
  bing: fake('bing', async () => { calls.push(['bing']); return [{ title: 'Bing', url: 'https://example.com/bing', snippet: 'b' }] }),
}
let enabledNames = ['deepseek-search']
const snapshot = () => ({ engines, routing: { enabledNames, keys: {} }, fingerprint: `v031-${enabledNames.join()}`, capability: {} })
invalidateSearchCaches()
const empty = await runFused({ query: 'alpha site:example.com', engineList: ['deepseek-search'], complexity: 'simple' }, { snapshot })
assert.deepEqual(calls, [['deepseek-search', 'alpha site:example.com']])
assert.equal(empty.results.length, 0)
assert.equal(empty.engineStats['deepseek-search'].successes, 1)
assert.equal(fusedResultIsError(empty), false)
assert.match(empty.routeExplanation, /listed engines/)
assert.match(empty.warnings.join('\n'), /no matches/)
calls.length = 0
engines['deepseek-search'] = fake('deepseek-search', async () => { calls.push(['deepseek-search']); throw Object.assign(new Error('deepseek-search http 401'), { kind: 'http_401' }) })
const failed = await runFused({ query: 'beta', engineList: ['deepseek-search'], complexity: 'simple' }, { snapshot })
assert.deepEqual(calls, [['deepseek-search']])
assert.match(failed.engineStats['deepseek-search'].note, /^http_401: /)
assert.equal(fusedResultIsError(failed), true)
assert.match(failed.warnings.join('\n'), /only this engine was called/)
calls.length = 0
engines['deepseek-search'] = fake('deepseek-search', async () => { calls.push(['deepseek-search']); return [{ title: 'D', url: 'https://example.com/d', snippet: 'short', summary: 'long source summary', published: null, siteName: null, authority: null, rerankScore: null }] })
const mixed = await runFused({ query: 'gamma', engineList: ['deepseek-search', 'firecrawl'], complexity: 'simple' }, { snapshot })
assert.deepEqual(calls.map(c => c[0]).sort(), ['deepseek-search', 'firecrawl'])
assert.equal(fusedResultIsError(mixed), false)
assert.equal(mixed.results.length > 0, true)
const deepseekRow = fusedHitToJson(mixed.results.find(r => r.url === 'https://example.com/d'))
assert.equal(deepseekRow.summary, 'long source summary')
assert.equal(deepseekRow.snippet, 'short')
assert.equal(deepseekRow.published, null)
assert.equal(deepseekRow.siteName, null)
calls.length = 0
engines.tavily = fake('tavily', async () => { calls.push(['tavily']); throw Object.assign(new Error('tavily http 401'), { kind: 'http_401' }) })
const partial = await runFused({ query: 'delta', engineList: ['tavily', 'firecrawl'], complexity: 'simple' }, { snapshot })
assert.deepEqual(calls.map(c => c[0]).sort(), ['firecrawl', 'tavily'])
assert.match(partial.engineStats.tavily.note, /^http_401: /)
assert.equal(partial.engineStats.firecrawl.successes, 1)
assert.equal(fusedResultIsError(partial), false)
assert.equal(partial.results.some(r => r.engines.includes('firecrawl')), true)
calls.length = 0
enabledNames = []
for (const name of ['tavily', 'brave', 'exa', 'tinyfish', 'deepseek-search', 'firecrawl', 'keenable']) {
  engines[name] = { available: () => false, search: async () => { calls.push([name]); throw new Error('paid engine must not run') } }
}
for (const name of ['bing', 'ddg', 'exa-free']) engines[name] = fake(name, async () => { calls.push([name]); return [{ title: name, url: `https://example.com/${name}`, snippet: name }] })
engines.anysearch = { available: () => true, availableForPool: (pool) => pool !== 'api', search: async () => { calls.push(['anysearch']); return [{ title: 'Any', url: 'https://example.com/any', snippet: 'any' }] } }
const free = await runFused({ query: 'free-only', complexity: 'simple' }, { snapshot })
assert.deepEqual(calls.map(c => c[0]).sort(), ['anysearch', 'bing', 'ddg', 'exa-free'])
assert.match(free.routeExplanation, /no keyed API is enabled/)
assert.equal(explainSelection({ engineNames: ['firecrawl', 'keenable'], enabledNames: ['firecrawl', 'keenable'] }).includes('these APIs are enabled'), true)
assert.equal(plannedEngineCalls(['deepseek-search'], { tier: 'simple' }), 1)
assert.equal(plannedEngineCalls(['bing', 'ddg'], { tier: 'medium' }), 4)
assert.equal(plannedEngineCalls(['deepseek-search', 'bing'], { tier: 'medium' }), 3)
const sample = 2000
const started = performance.now()
for (let i = 0; i < sample; i++) explainSelection({ explicitEngines: true, engineNames: ['deepseek-search'], enabledNames: ['deepseek-search', 'tavily'] })
const elapsedMs = performance.now() - started
console.log(`route explanation sample=${sample} elapsedMs=${elapsedMs.toFixed(2)} (in-process loop, not a search and not a speedup claim)`)
let chain = 0
await assert.rejects(runChain({
  bing: { available: () => true, search: async () => { chain += 1; throw new Error('down') } },
  ddg: { available: () => true, search: async () => { chain += 1; return [] } },
}, 'q', 1, {}), /cross-engine fallback is disabled/)
assert.equal(chain, 0)
const longNote = `HEAD ${'x'.repeat(180)} TAIL-MARKER`
const fitted = fitDiagnosticNote(`http_500: ${longNote}`)
assert.equal(fitted.length, 120)
assert.match(fitted, /^http_500: HEAD/)
assert.match(fitted, /TAIL-MARKER$/)
calls.length = 0
engines.bing = fake('bing', async () => { throw Object.assign(new Error(longNote), { kind: 'http_500' }) })
const tailed = await runFused({ query: 'note-tail', engineList: ['bing'], complexity: 'simple' }, { snapshot })
assert.match(tailed.engineStats.bing.note, /TAIL-MARKER$/)
assert.ok(tailed.engineStats.bing.note.length <= 120)
console.log('v0.3.1 beta isolation checks passed (fixture engines and local CLI/console; no live provider).')
