import './isolate-tests.mjs'
// beta.2 UI gate. beta.1 did not run this set, so a previous pass is not reused.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ConsoleModel, renderConsole, displayWidth, runConsoleTui } from '../lib/console-tui.mjs'
import { linesForClack } from '../lib/installer/tui.mjs'
import { writeKeysFile, readKeys, keysFilePath } from '../lib/keys.mjs'
import { formatAllEnginesFailedMessage, runFused, fusedResultIsError, invalidateSearchCaches } from '../lib/runtime.mjs'
import { retryWaitMs } from '../lib/search/deepseek-search.js'

const root = fileURLToPath(new URL('..', import.meta.url))
const cli = fileURLToPath(new URL('../cli.mjs', import.meta.url))
const secret = 'fixture-beta2-ui-key-not-real'
const evidence = []
const note = (title, body = '') => evidence.push(body ? `${title}\n${body}` : title)
const key = (model, name, text = '', extra = {}) => model.handleKey(text, { name, ...extra })
const settle = () => new Promise((resolve) => setImmediate(resolve))
const within = (frame, columns) => {
  for (const line of frame.split('\n')) assert.ok(displayWidth(line) <= columns, line)
}

writeKeysFile({ 'deepseek-search': secret, enabledEngines: ['deepseek-search'] })
const before = readFileSync(keysFilePath(), 'utf8')

const model = new ConsoleModel({ language: 'en' })
const sections = []
for (const n of ['1', '2', '3', '4', '5', '6', '7', '8']) {
  key(model, n, n)
  sections.push(`${n}:${model.sectionId}`)
}
assert.deepEqual(sections, ['1:overview', '2:engines', '3:search', '4:tools', '5:community', '6:judgment', '7:agents', '8:settings'])
key(model, '3', '3')
assert.equal(model.focus, 'list')
key(model, 'down')
assert.equal(model.index, 1)
key(model, 'k')
assert.equal(model.index, 0)
key(model, 'j')
assert.equal(model.index, 1)
key(model, 'up')
assert.equal(model.index, 0)
key(model, 'tab')
assert.equal(model.focus, 'detail')
key(model, 'tab')
assert.equal(model.focus, 'sidebar')
key(model, 'tab', '', { shift: true })
assert.equal(model.focus, 'detail')
key(model, 'escape')
assert.equal(model.focus, 'list')
key(model, 'right')
assert.equal(model.focus, 'detail')
const detail = renderConsole(model, { columns: 100, rows: 28, color: false })
assert.match(detail, /▸ Details/)
assert.match(detail, /\/v1\/tools\/search/)
key(model, 'left')
const list = renderConsole(model, { columns: 100, rows: 28, color: false })
assert.match(list, /▸ Search defaults/)
assert.doesNotMatch(list, /▸ Details/)
key(model, 'down')
key(model, 'return')
assert.equal(model.focus, 'detail', 'Enter on a row without a single action opens details')
key(model, 'escape')
assert.equal(model.focus, 'list')
key(model, '', '?')
assert.equal(model.modal?.kind, 'text')
assert.match(model.modal.lines.join('\n'), /1–8/)
key(model, 'escape')
assert.equal(model.modal, null)
note('keyboard', sections.join(' ') + '\nfocus list/detail/sidebar, j/k, help, and the selection marker all responded.')

renderConsole(model, { columns: 48, rows: 16, color: false })
const sectionBeforeNarrow = model.section
key(model, '1', '1')
assert.equal(model.section, sectionBeforeNarrow, 'a too-small screen does not accept hidden navigation')
const tiny = renderConsole(model, { columns: 48, rows: 16, color: false })
within(tiny, 48)
assert.match(tiny, /54/)

const zh = new ConsoleModel({ language: 'zh-CN' })
key(zh, '3', '3')
const zhFrame = renderConsole(zh, { columns: 54, rows: 16, color: false })
within(zhFrame, 54)
assert.match(zhFrame, /自动搜索：deepseek-search/)
assert.match(zhFrame, /可能收费，以服务商为准。/)
note('zh-54', zhFrame)

const plain = renderConsole(model, { columns: 80, rows: 24, color: false })
assert.equal(plain.includes('\u001b'), false)
const input = new PassThrough()
input.isTTY = true
input.setRawMode = () => {}
const output = new EventEmitter()
output.isTTY = true
output.columns = 80
output.rows = 24
let written = ''
output.write = (text) => { written += text; return true }
const previousColor = process.env.NO_COLOR
const previousTerm = process.env.TERM
process.env.NO_COLOR = '1'
process.env.TERM = 'dumb'
try {
  const session = runConsoleTui(['--no-color'], { input, output, model: new ConsoleModel({ language: 'en' }) })
  input.emit('keypress', '3', { name: '3' })
  input.emit('keypress', 'q', { name: 'q' })
  await session
} finally {
  if (previousColor === undefined) delete process.env.NO_COLOR
  else process.env.NO_COLOR = previousColor
  if (previousTerm === undefined) delete process.env.TERM
  else process.env.TERM = previousTerm
}
assert.equal(written.includes('\u001b[38;'), false)
assert.equal(written.includes('\u001b[48;'), false)
assert.match(written, /Automatic search: deepseek-search/)
assert.match(written, /May incur charges/)
note('NO_COLOR', 'interactive --no-color with NO_COLOR=1 and TERM=dumb has no truecolor SGR.')

const preview = spawnSync(process.execPath, [cli, 'tui', '--preview', '--no-color'], { encoding: 'utf8', env: { ...process.env, NO_COLOR: '1', TERM: 'dumb' } })
assert.equal(preview.status, 0, preview.stderr)
assert.equal(preview.stdout.includes('\u001b'), false)
assert.equal(preview.stdout.includes(secret), false)
const refused = spawnSync(process.execPath, [cli, 'tui'], { encoding: 'utf8' })
assert.notEqual(refused.status, 0)
assert.match(refused.stderr, /interactive terminal/)
note('non-tty', 'tui without a TTY fails and names --preview. --preview --no-color prints plain text.')

const cancelModel = new ConsoleModel({ language: 'en' })
cancelModel.confirm('replace the whitelist?', () => writeKeysFile({ enabledEngines: ['tavily'] }))
assert.equal(cancelModel.modal.options[0].label, 'Cancel — do not save')
assert.equal(cancelModel.modal.index, 0)
key(cancelModel, 'return')
await settle()
assert.equal(readFileSync(keysFilePath(), 'utf8'), before, 'the default confirm choice writes nothing')
note('cancel', 'Enter on the default confirm choice left keys.json unchanged.')

const conflict = new ConsoleModel({ language: 'en' })
conflict.editKey('tavily')
key(conflict, 's', 'stale-beta2-value')
key(conflict, 'return')
key(conflict, 'return')
await settle()
writeKeysFile({ tavily: 'newer-concurrent-value', 'deepseek-search': secret, enabledEngines: ['deepseek-search'] })
key(conflict, 'down')
key(conflict, 'return')
await settle()
assert.equal(readKeys().tavily, 'newer-concurrent-value')
assert.equal(readKeys()['deepseek-search'], secret)
assert.match(conflict.notice, /changed elsewhere/)
assert.equal(JSON.stringify(conflict).includes('stale-beta2-value'), false)
note('conflict', conflict.notice)

key(model, '2', '2')
const engines = renderConsole(model, { columns: 100, rows: 28, color: false })
assert.match(engines, /deepseek-search/)
assert.match(engines, /Enabled/)
assert.match(engines, /No key/)
assert.equal(engines.includes(secret), false)
const missing = formatAllEnginesFailedMessage({
  query: 'stdio-no-key',
  enginePool: 'api',
  engineStats: {},
  warnings: ['deepseek-search unavailable (missing credentials, disabled, or locally unavailable); not called. No selected engine was called (deepseek-search). engine_pool=api did not run.'],
})
assert.match(missing, /not an empty search result/)
assert.match(missing, /engine_pool=api did not run/)
assert.match(missing, /config keys --show/)
assert.match(missing, /config keys --set/)
const fixedNow = Date.parse('2026-11-25T00:00:00.000Z')
assert.equal(retryWaitMs(1, '1.5', fixedNow), null)
assert.equal(retryWaitMs(1, '2', fixedNow), null)
assert.equal(retryWaitMs(1, '1', fixedNow), 1000)
assert.equal(retryWaitMs(1, 'not-a-date', fixedNow), null)
assert.equal(retryWaitMs(1, new Date(fixedNow + 120_000).toUTCString(), fixedNow), null)
note('diagnostics', `${missing}\nRetry-After 1.5, integer 2, invalid text and a future HTTP-date all stop.`)

invalidateSearchCaches()
const calls = []
const enginesFake = {
  bing: { available: () => true, search: async () => { calls.push('bing'); return [{ title: 'Same', url: 'https://example.com/same', snippet: 'bing line' }] } },
  ddg: { available: () => true, search: async () => { calls.push('ddg'); return [{ title: 'Same', url: 'https://example.com/same', snippet: 'ddg line' }] } },
  tavily: { available: () => true, search: async () => { calls.push('tavily'); return [] } },
}
const deduped = await runFused({ query: 'same page', engineList: ['bing', 'ddg'], complexity: 'simple' }, {
  snapshot: () => ({ engines: enginesFake, routing: { enabledNames: [] }, fingerprint: 'beta2-dedup', capability: {} }),
})
assert.deepEqual(calls.sort(), ['bing', 'ddg'])
assert.equal(deduped.results.length, 1)
assert.equal(deduped.results[0].provenance.length, 2)
assert.deepEqual(deduped.results[0].provenance.map((row) => row.engine).sort(), ['bing', 'ddg'])
assert.equal(fusedResultIsError(deduped), false)
calls.length = 0
const only = await runFused({ query: 'only bing', engineList: ['bing'], complexity: 'simple' }, {
  snapshot: () => ({ engines: enginesFake, routing: { enabledNames: ['tavily'] }, fingerprint: 'beta2-only', capability: {} }),
})
assert.deepEqual(calls, ['bing'])
assert.equal(only.results.length, 1)
note('dedup', 'one URL from bing and ddg stays one row and keeps both provenance entries. A named bing call does not add tavily.')

function screenOf(language, columns, rows, setup) {
  const view = new ConsoleModel({ language })
  setup?.(view)
  return renderConsole(view, { columns, rows, color: false })
}
writeKeysFile({ 'deepseek-search': undefined, tavily: undefined, enabledEngines: null })
const overviewEn = screenOf('en', 80, 24)
const overviewZh = screenOf('zh-CN', 60, 20)
within(overviewEn, 80)
within(overviewZh, 60)
assert.match(overviewEn, /Automatic search:/)
assert.match(overviewEn, /complete setup/)
assert.doesNotMatch(overviewEn.split('\n').slice(0, 12).join('\n'), /Config home/)
assert.match(overviewZh, /自动搜索：免 Key 引擎/)
assert.match(overviewZh, /这是完整配置/)
note('overview-80x24', overviewEn)
note('overview-zh-60x20', overviewZh)

const search = new ConsoleModel({ language: 'zh-CN' })
writeKeysFile({ 'deepseek-search': secret, enabledEngines: ['deepseek-search'] })
search.reload()
key(search, '3', '3')
renderConsole(search, { columns: 60, rows: 20, color: false })
key(search, 'return')
assert.equal(search.sectionId, 'search')
assert.equal(search.focus, 'detail')
const detailZh = renderConsole(search, { columns: 60, rows: 20, color: false })
assert.match(detailZh, /自动搜索：deepseek-search/)
assert.match(detailZh, /可能收费，以服务商为准。/)
let protocolPages = 0
while (!/POST \/v1\/tools\/search/.test(renderConsole(search, { columns: 60, rows: 20, color: false })) && protocolPages < 3) {
  key(search, 'pagedown')
  protocolPages += 1
}
assert.ok(protocolPages <= 2, `protocol took ${protocolPages} PgDn`)
const wideSearch = new ConsoleModel({ language: 'en' })
wideSearch.reload()
key(wideSearch, '3', '3')
renderConsole(wideSearch, { columns: 80, rows: 24, color: false })
key(wideSearch, 'return')
let widePages = 0
while (!/POST \/v1\/tools\/search/.test(renderConsole(wideSearch, { columns: 80, rows: 24, color: false })) && widePages < 3) {
  key(wideSearch, 'pagedown')
  widePages += 1
}
assert.ok(widePages <= 1, `80x24 protocol took ${widePages} PgDn`)
const place = wideSearch.sectionId
const placeIndex = wideSearch.index
wideSearch.confirm('leave this row?', () => writeKeysFile({ enabledEngines: ['tavily'] }))
const confirmFrame = renderConsole(wideSearch, { columns: 80, rows: 24, color: false })
const confirmNarrow = renderConsole(wideSearch, { columns: 60, rows: 20, color: false })
for (const frame of [confirmFrame, confirmNarrow]) {
  assert.match(frame, /Cancel — do not save/)
  assert.match(frame, /Confirm/)
  assert.match(frame, /No writes before consent/)
  within(frame, frame === confirmFrame ? 80 : 60)
}
assert.equal(wideSearch.modal.index, 0)
key(wideSearch, 'return')
await settle()
assert.equal(wideSearch.sectionId, place)
assert.equal(wideSearch.index, placeIndex)
assert.equal(wideSearch.focus, 'detail')
const three = renderConsole(new ConsoleModel({ language: 'en' }), { columns: 120, rows: 40, color: false })
assert.ok(three.split('\n').some(line => (line.match(/│/g) ?? []).length >= 2))
assert.match(three, /▸/)
const marks = new ConsoleModel({ language: 'en' })
key(marks, '2', '2')
const marked = renderConsole(marks, { columns: 80, rows: 24, color: false })
assert.match(marked, /● /)
assert.match(marked, /○ No key/)
assert.match(renderConsole(marks, { columns: 80, rows: 24, color: false }), /▸/)
const safe = linesForClack('Protocol: POST /v1/tools/search only. No live check.', 60)
assert.deepEqual(safe, ['Protocol: POST /v1/tools/search only. No live check.'])
const wrapped = linesForClack('deepseek-search calls the official Search API POST /v1/tools/search and must not split those tokens across a menu.', 60)
assert.ok(wrapped.every(line => displayWidth(line) <= 52))
assert.ok(wrapped.some(line => line.includes('official Search API')))
assert.ok(wrapped.some(line => /(^| )POST( |$)/.test(line)))
assert.ok(wrapped.some(line => line.includes('/v1/tools/search')))
assert.ok(wrapped.every(line => !line.startsWith('OST') && !line.startsWith('fficial')))
note('detail-zh-60x20', detailZh)
note('confirm-80x24', confirmFrame)

const report = [
  '0.3.1-beta.2 UI gate. Isolation home. No live search and no credential is printed.',
  'beta.1 did not run this set. These lines are from this process.',
  '',
  ...evidence,
  '',
  'English search page after keyboard focus returned to the list',
  list,
  '',
  '48 columns',
  tiny,
].join('\n')
assert.equal(report.includes(secret), false)
assert.equal(report.includes('stale-beta2-value'), false)
assert.equal(report.includes('newer-concurrent-value'), false)
const out = join(root, 'docs/v0.3.1-beta2-ui-after.txt')
writeFileSync(out, report + '\n')
console.log('beta.2 UI gate passed; wrote', out)
