import './isolate-tests.mjs'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { ConsoleModel, renderConsole, displayWidth, fitText, cleanText, runConsoleTui } from '../lib/console-tui.mjs'
import { readKeys, readKeysRouting, writeKeysFile, keysFilePath } from '../lib/keys.mjs'
import { toolStates } from '../lib/tool-config.mjs'
import { readCommunityConfig } from '../lib/community/config.mjs'
import { readTuiSettings, saveTuiLayout } from '../lib/installer/i18n.mjs'
import { searchBoostHome } from '../lib/config-paths.mjs'
import { readJudgmentProfiles } from '../lib/judgment/config.mjs'

let count = 0
async function test(name, fn) { await fn(); count++; console.log(`ok: ${name}`) }
const key = (model, name, text = '', extra = {}) => model.handleKey(text, { name, ...extra })
const settle = () => new Promise(resolve => setImmediate(resolve))
async function confirm(model) { key(model, 'down'); key(model, 'return'); await settle() }
const cli = fileURLToPath(new URL('../cli.mjs', import.meta.url))

await test('independent CLI route, help, preview and non-TTY failure', () => {
  const source = readFileSync(cli, 'utf8')
  assert.match(source, /case 'tui'/)
  assert.match(source, /lib\/console-tui\.mjs/)
  const consoleSource = readFileSync(new URL('../lib/console-tui.mjs', import.meta.url), 'utf8')
  assert.doesNotMatch(consoleSource, /installer\/(?:tui|.*wizard|ui)\.mjs|@clack\/prompts/)
  const run = args => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', timeout: 30_000 })
  assert.equal(run(['tui', '--help']).status, 0)
  const preview = run(['tui', '--preview'])
  assert.equal(preview.status, 0, preview.stderr)
  assert.match(preview.stdout, /CONTROL CENTER/)
  assert.doesNotMatch(preview.stdout, /\x1b/)
  const notTty = run(['tui'])
  assert.equal(notTty.status, 1)
  assert.match(notTty.stderr, /interactive terminal/)
  assert.equal(run(['tui', '--bogus']).status, 1)
  assert.equal(run(['tui', '--help', '--bogus']).status, 1)
  assert.match(execFileSync(process.execPath, [cli, '--help'], { encoding: 'utf8' }), /search-boost tui/)
})
await test('browsing every page is read-only and contains actual data', () => {
  const model = new ConsoleModel({ language: 'zh-CN' })
  assert.equal(existsSync(searchBoostHome()), false)
  for (let section = 0; section < 8; section++) {
    model.navigate(section)
    assert.ok(model.rows.length)
    assert.notEqual(model.current.id, 'error')
  }
  assert.equal(existsSync(searchBoostHome()), false)
})
await test('CJK, emoji, controls and every terminal size remain bounded', () => {
  assert.equal(displayWidth('搜索引擎'), 8)
  assert.equal(displayWidth('👩‍💻'), 2)
  assert.equal(displayWidth(fitText('搜索引擎', 5)), 5)
  assert.equal(cleanText('\x1b[31mhello\x1b[0m\n'), 'hello ')
  const model = new ConsoleModel({ language: 'zh-CN' })
  for (const columns of [1, 40, 54, 80, 100, 112, 140]) for (const rows of [2, 10, 16, 24, 40]) {
    for (let section = 0; section < 8; section++) {
      model.navigate(section)
      for (const color of [false, true]) {
        const lines = renderConsole(model, { columns, rows, color }).split('\n')
        assert.ok(lines.length <= rows - 1, `${columns}x${rows}: height`)
        for (const line of lines) assert.ok(displayWidth(line) <= columns - 1, `${columns}x${rows}: ${cleanText(line)}`)
      }
    }
  }
})
await test('focus, section shortcuts, remembered selection and help', () => {
  const model = new ConsoleModel({ language: 'en' })
  key(model, '2', '2'); assert.equal(model.sectionId, 'engines')
  key(model, 'down'); assert.equal(model.index, 1)
  key(model, 'tab'); assert.equal(model.focus, 'sidebar')
  key(model, 'down'); assert.equal(model.sectionId, 'search')
  key(model, '2', '2'); assert.equal(model.index, 1)
  key(model, undefined, '?'); assert.equal(model.modal.kind, 'text')
  key(model, 'escape'); assert.equal(model.modal, null)
  key(model, 'escape'); assert.equal(model.focus, 'sidebar')
  key(model, 'return'); assert.equal(model.focus, 'list')
})
await test('sidebar ignores item-edit shortcuts and Q exits help dialogs', () => {
  const model = new ConsoleModel({ language: 'en' }); model.navigate(1)
  key(model, 'left'); key(model, 'e'); assert.equal(model.modal, null)
  key(model, 'space'); assert.equal(model.modal, null)
  model.showText(model.helpLines()); key(model, 'q', 'q')
  assert.equal(model.closed, true)
})
await test('password editing never renders the key, Q is text and cancel writes nothing', async () => {
  const model = new ConsoleModel({ language: 'en' })
  model.navigate(1); key(model, 'e')
  key(model, 'q', 'q'); key(model, 'x', 'private-secret-value')
  assert.equal(model.closed, false)
  assert.doesNotMatch(renderConsole(model), /private-secret-value/)
  key(model, 'escape'); assert.equal(existsSync(keysFilePath()), false)
  model.editKey('tavily'); key(model, 'return'); key(model, 'return')
  assert.match(model.modal.error, /required/)
  key(model, 'escape')
  model.editKey('tavily'); key(model, 's', 'super-secret-api-key')
  key(model, 'return'); key(model, 'return'); await settle()
  assert.equal(model.modal.kind, 'select')
  assert.doesNotMatch(renderConsole(model), /super-secret-api-key/)
  key(model, 'return'); await settle() // default cancel
  assert.equal(existsSync(keysFilePath()), false)
})
await test('key persistence preserves other keys, routing and custom URLs', async () => {
  writeKeysFile({ brave: 'brave-test-private-key', enabledEngines: ['brave'], baseUrls: { brave: 'https://example.org/api' } })
  const model = new ConsoleModel({ language: 'en' })
  model.editKey('tavily'); key(model, 's', 'tavily-test-private-key')
  key(model, 'return'); key(model, 'return'); await settle(); await confirm(model)
  assert.equal(readKeys().tavily, 'tavily-test-private-key')
  const routing = readKeysRouting()
  assert.equal(routing.baseUrls.brave, 'https://example.org/api')
  assert.deepEqual(routing.enabledNames, ['brave'])
  model.navigate(1)
  assert.doesNotMatch(renderConsole(model), /tavily-test-private-key|brave-test-private-key/)
  model.toggleEngine('tavily'); await confirm(model)
  assert.deepEqual(new Set(readKeysRouting().enabledNames), new Set(['brave', 'tavily']))
})
await test('concurrent key edit refuses stale confirmation', async () => {
  const model = new ConsoleModel({ language: 'en' })
  model.editKey('tavily'); key(model, 's', 'stale-value')
  key(model, 'return'); key(model, 'return'); await settle()
  writeKeysFile({ tavily: 'newer-concurrent-value' })
  await confirm(model)
  assert.equal(readKeys().tavily, 'newer-concurrent-value')
  assert.match(model.notice, /failed/)
})
await test('dry-run never persists configuration or display preference', async () => {
  const model = new ConsoleModel({ language: 'en', dryRun: true })
  const before = readFileSync(keysFilePath(), 'utf8')
  model.keyPatch({ tavily: 'dry-run-secret' }, 'preview'); await confirm(model)
  assert.equal(readFileSync(keysFilePath(), 'utf8'), before)
  model.switchLanguage(); await confirm(model)
  assert.equal(model.language, 'en')
  assert.match(model.notice, /dry-run/)
})
await test('tools use real lock/readiness state and persist after confirmation', async () => {
  const model = new ConsoleModel({ language: 'en' }); model.navigate(3)
  const locked = model.rows.find(r => r.id === 'adaptive_search')
  assert.equal(locked.status, 'Locked'); assert.equal(locked.actions.length, 0)
  key(model, 'space'); await confirm(model)
  assert.equal(toolStates().find(t => t.name === 'fused_search').enabled, false)
})
await test('community selection changes only selected platform atomically', async () => {
  const model = new ConsoleModel({ language: 'en' })
  const before = readCommunityConfig().backends.filter(b => !b.id.startsWith('reddit'))
  model.chooseCommunity('reddit')
  assert.equal(model.modal.kind, 'select')
  const web = model.modal.options.findIndex(o => o.backend.provider === 'reddit-web')
  assert.ok(web >= 0); model.modal.index = web
  key(model, 'return'); await settle(); await confirm(model)
  const after = readCommunityConfig().backends
  assert.deepEqual(after.filter(b => !b.id.startsWith('reddit')), before)
  assert.equal(after.find(b => b.provider === 'reddit-web').enabled, true)
  assert.equal(after.find(b => b.provider === 'reddit-arctic').enabled, false)
})
await test('new judgment profile validates, hides key and saves with explicit consent', async () => {
  const model = new ConsoleModel({ language: 'en' })
  model.addJudgment(); key(model, 'return'); await settle()
  assert.equal(model.modal.kind, 'form')
  model.modal.values = ['jev-console', 'https://api.typesafe.ai/v1', 'private-jev-key']
  model.modal.index = model.modal.fields.length
  assert.doesNotMatch(renderConsole(model), /private-jev-key/)
  key(model, 'return'); await settle()
  assert.equal(model.modal.kind, 'select'); await confirm(model)
  assert.equal(readJudgmentProfiles().activeProfile, 'jev-console')
})
await test('integration actions use safe explicit options, default cancel and dry-run', async () => {
  const calls = []
  const agents = { codex: { install: async opts => calls.push(['install', opts]), uninstall: async opts => calls.push(['uninstall', opts]) } }
  const model = new ConsoleModel({ language: 'en', services: { agents } })
  await model.agentOperation('codex', false)
  key(model, 'return'); await settle(); assert.equal(calls.length, 0)
  await model.agentOperation('codex', false); await confirm(model)
  assert.equal(calls.length, 1)
  assert.equal(calls[0][1].autoAllow, false)
  assert.equal(calls[0][1].replaceNative, false)
  assert.equal(calls[0][1].scope, 'user')
  assert.equal(model.modal.kind, 'text')
  const dry = new ConsoleModel({ language: 'en', dryRun: true, services: { agents } })
  await dry.agentOperation('codex', true); await confirm(dry)
  assert.equal(calls.length, 1)
  const fail = new ConsoleModel({ language: 'en', services: { agents: { codex: { install: async () => { throw new Error('private-key-in-error') } } } } })
  await fail.agentOperation('codex', false); await confirm(fail)
  assert.match(fail.notice, /failed/)
  assert.doesNotMatch(renderConsole(fail), /private-key-in-error/)
})
await test('X credential input stays inside independent UI and preserves routing', async () => {
  const model = new ConsoleModel({ language: 'en' }); model.navigate(4)
  const before = readCommunityConfig()
  const x = model.rows.find(row => row.id === 'x')
  x.actions.find(a => a.id === 'credential').run()
  key(model, 'x', 'xai-private-local-key'); key(model, 'return'); key(model, 'return'); await settle()
  assert.doesNotMatch(renderConsole(model), /xai-private-local-key/)
  await confirm(model)
  assert.equal(model.services.readPiAuth().kind, 'api-key')
  assert.deepEqual(readCommunityConfig(), before)
})
await test('language change preserves legacy layout setting', async () => {
  saveTuiLayout('folder')
  const model = new ConsoleModel({ language: 'en' })
  model.switchLanguage(); await confirm(model)
  assert.equal(model.language, 'zh-CN')
  assert.deepEqual(readTuiSettings(), { layout: 'folder', language: 'zh-CN' })
})
await test('corrupt configuration is visible, not overwritten or leaked', () => {
  const before = readFileSync(keysFilePath(), 'utf8')
  writeFileSync(keysFilePath(), '{ "private-secret-from-invalid-json":')
  try {
    const model = new ConsoleModel({ language: 'en' }); model.navigate(1)
    assert.equal(model.current.id, 'error')
    assert.doesNotMatch(renderConsole(model), /private-secret-from-invalid-json/)
    assert.equal(model.current.actions.length, 0)
  } finally { writeFileSync(keysFilePath(), before) }
})
await test('long modal and small form keep confirmation and focused input visible', () => {
  const model = new ConsoleModel({ language: 'en' })
  model.confirm('very long description '.repeat(100), () => {})
  let frame = renderConsole(model, { columns: 54, rows: 16, color: false })
  assert.match(frame, /Cancel/)
  model.addJudgment(); key(model, 'return')
  model.modal.index = 3
  frame = renderConsole(model, { columns: 54, rows: 16, color: false })
  assert.match(frame, /Continue/)
})
await test('TTY restores raw mode, cursor, alternate screen and listeners on quit', async () => {
  const input = new PassThrough(); input.isTTY = true; input.isRaw = false
  input.setRawMode = raw => { input.isRaw = raw }
  input.pause()
  const output = new EventEmitter(); output.isTTY = true; output.columns = 120; output.rows = 28
  let written = ''; output.write = text => { written += text; return true }
  const model = new ConsoleModel({ language: 'en' })
  const session = runConsoleTui([], { input, output, model })
  assert.equal(input.isRaw, true)
  output.columns = 54; output.emit('resize')
  input.emit('keypress', 'q', { name: 'q' })
  await session
  assert.equal(input.isRaw, false)
  assert.equal(input.isPaused(), true)
  assert.equal(input.listenerCount('keypress'), 0)
  assert.equal(output.listenerCount('resize'), 0)
  assert.match(written, /\x1b\[\?1049h/)
  assert.ok(written.endsWith('\x1b[0m\x1b[?25h\x1b[?1049l'))
})
await test('TTY cleanup on EOF and asynchronous output error', async () => {
  for (const error of [false, true]) {
    const input = new PassThrough(); input.isTTY = true; input.setRawMode = raw => { input.isRaw = raw }
    const output = new EventEmitter(); output.isTTY = true; output.write = () => true
    const session = runConsoleTui([], { input, output, model: new ConsoleModel({ language: 'en' }) })
    if (error) output.emit('error', new Error('terminal lost')); else input.emit('end')
    if (error) await assert.rejects(session, /terminal lost/); else await session
    assert.equal(input.isRaw, false)
    assert.equal(output.listenerCount('resize'), 0)
  }
})
await test('busy Ctrl+C waits for operation completion', async () => {
  const model = new ConsoleModel({ language: 'en' })
  let complete
  const pending = model.runBusy(() => new Promise(resolve => { complete = resolve }))
  key(model, 'c', '', { ctrl: true })
  assert.equal(model.closed, false); assert.equal(model.exitRequested, true)
  complete('done'); await pending
  assert.equal(model.closed, true)
})
console.log(`\n${count} independent console TUI tests passed.`)
