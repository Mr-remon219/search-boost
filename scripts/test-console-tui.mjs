import './isolate-tests.mjs'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { ConsoleModel, renderConsole, displayWidth, fitText, cleanText, runConsoleTui } from '../lib/console-tui.mjs'
import { readKeys, readKeysRouting, writeKeysFile, keysFilePath } from '../lib/keys.mjs'
import { toolStates } from '../lib/tool-config.mjs'
import { readCommunityConfig, communityConfigPath } from '../lib/community/config.mjs'
import { readTuiSettings, saveTuiLayout } from '../lib/installer/i18n.mjs'
import { CONSOLE_THEMES, CONSOLE_LOGO, DEFAULT_CONSOLE_THEME, consoleSettingsPath, readConsoleTheme, saveConsoleTheme } from '../lib/console-theme.mjs'
import { searchBoostHome } from '../lib/config-paths.mjs'
import { readJudgmentProfiles, saveJudgmentProfile, judgmentFilePath } from '../lib/judgment/config.mjs'

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
  key(model, 'tab'); assert.equal(model.focus, 'detail')
  key(model, 'tab', '', { shift: true }); assert.equal(model.focus, 'list')
  key(model, 'tab', '', { shift: true }); assert.equal(model.focus, 'sidebar')
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
  model.addJudgment(); key(model, 'return'); await settle(); key(model, 'return'); await settle()
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
    model.navigate(4)
    assert.notEqual(model.current.id, 'error')
    assert.match(model.current.details.join('\n'), /runtime configuration unreadable/)
  } finally { writeFileSync(keysFilePath(), before) }
})
await test('long modal and small form keep confirmation and focused input visible', () => {
  const model = new ConsoleModel({ language: 'en' })
  model.confirm('very long description '.repeat(100), () => {})
  let frame = renderConsole(model, { columns: 54, rows: 16, color: false })
  assert.match(frame, /Cancel/)
  model.addJudgment(); key(model, 'return'); key(model, 'return')
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

// Keep new configuration scenarios hermetic and prove that UI interaction never probes.
async function freshConsole(fn) {
  const before = process.env.SEARCH_BOOST_HOME, token = process.env.CONSOLE_TEST_BROWSER_TOKEN, fetch = globalThis.fetch
  process.env.SEARCH_BOOST_HOME = join(process.env.HOME, `console-config-${count}`)
  delete process.env.CONSOLE_TEST_BROWSER_TOKEN
  globalThis.fetch = () => { throw new Error('UI must stay offline') }
  try { await fn() } finally {
    globalThis.fetch = fetch
    if (before === undefined) delete process.env.SEARCH_BOOST_HOME; else process.env.SEARCH_BOOST_HOME = before
    if (token === undefined) delete process.env.CONSOLE_TEST_BROWSER_TOKEN; else process.env.CONSOLE_TEST_BROWSER_TOKEN = token
  }
}
async function submit(model, values) {
  assert.equal(model.modal.kind, 'form')
  model.modal.values = values; model.modal.index = model.modal.fields.length
  key(model, 'return'); await settle()
}
const jevProfile = (baseUrl = 'https://api.typesafe.ai/v1', apiKey = 'judgment-fixture-secret') => ({ provider: 'jev', baseUrl, apiKey })

await test('new sections default to read-only details and use real runtime community readiness', () => freshConsole(async () => {
  const model = new ConsoleModel({ language: 'en', services: {
    collectRuntimeCapabilities: () => ({ availableEngines: ['bing'], x: { official: { available: false }, fallback: { available: true } } }),
    authStatus: () => ({ source: 'env' }),
  } })
  model.navigate(4)
  assert.equal(model.rows.find(r => r.id === 'zhihu').status, 'Enabled', 'web readiness must use available engines, not an empty context')
  assert.match(model.rows.find(r => r.id === 'x').details.join('\n'), /Auth: env/)
  assert.match(model.current.details.join('\n'), /community/)
  key(model, 'return'); assert.equal(model.focus, 'detail'); assert.equal(model.modal, null)
  assert.equal(model.current.actions[model.detailView.actionIndex].id, 'view')
  key(model, 'return'); await settle(); assert.equal(model.modal.kind, 'text')
  key(model, 'escape'); model.navigate(5)
  assert.equal(model.current.id, 'status'); assert.match(model.current.details.join('\n'), /No active profile/)
  key(model, 'return'); key(model, 'return'); await settle(); assert.equal(model.modal.kind, 'text')
  assert.equal(existsSync(searchBoostHome()), false)
}))
await test('Reddit scopes validate, cancel without writes and preserve all other platforms', () => freshConsole(async () => {
  const model = new ConsoleModel({ language: 'en' }), before = readCommunityConfig()
  const backend = before.backends.find(b => b.provider === 'reddit-arctic')
  model.configureCommunity('reddit', backend)
  await submit(model, ['a,b,c,d,e,f']); assert.equal(model.modal.kind, 'form'); assert.ok(model.modal.error)
  await submit(model, ['r/node， LocalLLaMA']); assert.equal(model.modal.kind, 'select')
  key(model, 'return'); await settle(); assert.equal(existsSync(communityConfigPath()), false)
  model.configureCommunity('reddit', backend)
  await submit(model, ['r/node， LocalLLaMA']); await confirm(model)
  const after = readCommunityConfig()
  assert.deepEqual(after.backends.find(b => b.id === backend.id).config.subreddits, ['node', 'localllama'])
  assert.deepEqual(after.backends.filter(b => b.id !== backend.id), before.backends.filter(b => b.id !== backend.id))
  model.navigate(4); assert.match(model.rows.find(r => r.id === 'reddit').details.join('\n'), /node, localllama/)
}))
await test('browser setup validates origins, saves unready settings without switching, and supports enable/delete/dry-run', () => freshConsole(async () => {
  const model = new ConsoleModel({ language: 'en' })
  model.chooseCommunity('zhihu')
  model.modal.index = model.modal.options.findIndex(o => o.backend.provider === 'zhihu-browser')
  key(model, 'return'); await settle()
  assert.equal(model.modal.kind, 'form'); assert.match(model.modal.description, /community-browser/)
  await submit(model, ['https://remote.example', 'CONSOLE_TEST_BROWSER_TOKEN']); assert.equal(model.modal.kind, 'form')
  await submit(model, ['http://127.0.0.1:19826', 'CONSOLE_TEST_BROWSER_TOKEN'])
  assert.match(model.modal.description, /settings only/); await confirm(model)
  let doc = readCommunityConfig(), browser = doc.backends.find(b => b.provider === 'zhihu-browser')
  assert.equal(browser.enabled, false); assert.equal(doc.backends.find(b => b.provider === 'zhihu-web').enabled, true)
  process.env.CONSOLE_TEST_BROWSER_TOKEN = 'hidden-browser-fixture'
  model.chooseCommunity('zhihu'); model.modal.index = model.modal.options.findIndex(o => o.backend.provider === 'zhihu-browser')
  key(model, 'return'); await settle(); await confirm(model)
  assert.equal(readCommunityConfig().backends.find(b => b.id === browser.id).enabled, true)
  const bytes = readFileSync(communityConfigPath(), 'utf8')
  const dry = new ConsoleModel({ language: 'en', dryRun: true })
  dry.configureCommunity('zhihu', browser); await submit(dry, ['http://localhost:19827', 'CONSOLE_TEST_BROWSER_TOKEN']); await confirm(dry)
  assert.equal(readFileSync(communityConfigPath(), 'utf8'), bytes)
  model.navigate(4)
  const row = model.rows.find(r => r.id === 'zhihu')
  assert.match(row.details.join('\n'), /Token env: CONSOLE_TEST_BROWSER_TOKEN/)
  assert.doesNotMatch(renderConsole(model), /hidden-browser-fixture/)
  row.actions.find(a => a.id === `remove:${browser.id}`).run(); await confirm(model)
  assert.equal(readCommunityConfig().backends.some(b => b.id === browser.id), false)
}))
await test('community form rejects a stale snapshot before showing confirmation', () => freshConsole(async () => {
  const model = new ConsoleModel({ language: 'en' }), backend = readCommunityConfig().backends.find(b => b.provider === 'reddit-arctic')
  model.configureCommunity('reddit', backend)
  const other = new ConsoleModel({ language: 'en' }); other.communityChange('x', { action: 'disable' }); await confirm(other)
  const bytes = readFileSync(communityConfigPath(), 'utf8')
  await submit(model, ['node'])
  assert.match(model.notice, /failed/); assert.equal(model.modal, null)
  assert.equal(readFileSync(communityConfigPath(), 'utf8'), bytes)
}))
await test('judgment destination selection derives the Gateway protocol and clearly asks for a Gateway key', () => freshConsole(async () => {
  const model = new ConsoleModel({ language: 'en' })
  model.addJudgment(); key(model, 'return'); await settle()
  assert.equal(model.modal.options.length, 3)
  key(model, 'down'); key(model, 'return'); await settle()
  assert.match(model.modal.fields[2].label, /Gateway/)
  await submit(model, ['gateway', 'https://ai-gateway.vercel.sh/v1', 'gateway-fixture-secret'])
  assert.match(model.modal.description, /v4\/ai\/evaluation-model/)
  assert.doesNotMatch(renderConsole(model), /gateway-fixture-secret/)
  await confirm(model)
  const profile = readJudgmentProfiles().profiles.gateway
  assert.equal(profile.model, 'typesafe-ai/jev'); assert.equal(profile.transport, 'vercel-evaluation')
}))
await test('judgment edits preserve active selection and keys only for the same normalized destination', () => freshConsole(async () => {
  saveJudgmentProfile('primary', jevProfile())
  saveJudgmentProfile('secondary', jevProfile(), { activate: false })
  const model = new ConsoleModel({ language: 'en' })
  model.editJudgment('secondary')
  await submit(model, ['https://api.typesafe.ai/v1/', '']); await confirm(model)
  assert.equal(readJudgmentProfiles().activeProfile, 'primary')
  assert.equal(readJudgmentProfiles().profiles.secondary.apiKey, 'judgment-fixture-secret')
  model.editJudgment('secondary')
  await submit(model, ['https://ai-gateway.vercel.sh/v1', ''])
  assert.equal(model.modal.kind, 'form', 'missing new-destination key keeps the user in the form')
  assert.ok(model.modal.error)
  await submit(model, ['https://ai-gateway.vercel.sh/v1', 'replacement-gateway-key']); await confirm(model)
  assert.equal(readJudgmentProfiles().profiles.secondary.transport, 'vercel-evaluation')
  assert.equal(readJudgmentProfiles().activeProfile, 'primary')
  model.navigate(5)
  assert.equal(model.rows[1].id, 'profile:primary')
  assert.equal(model.rows[1].actions[0].id, 'view')
  model.rows.find(r => r.id === 'profile:secondary').actions.find(a => a.id === 'activate').run()
  key(model, 'return'); await settle(); assert.equal(readJudgmentProfiles().activeProfile, 'primary', 'activation defaults to cancel')
  model.rows.find(r => r.id === 'profile:secondary').actions.find(a => a.id === 'activate').run(); await confirm(model)
  assert.equal(readJudgmentProfiles().activeProfile, 'secondary')
}))
await test('Laya edit preserves model/budgets and can clear optional auth without switching', () => freshConsole(async () => {
  saveJudgmentProfile('primary', jevProfile())
  saveJudgmentProfile('laya', { provider: 'laya', baseUrl: 'http://localhost:8000/v1', model: 'english', apiKey: 'laya-private-key', authMode: 'bearer', options: { max_len: 2048, head_max_len: 512 } }, { activate: false })
  const model = new ConsoleModel({ language: 'en' })
  model.editJudgment('laya'); await submit(model, ['http://localhost:8000/v1', '-']); await confirm(model)
  const store = readJudgmentProfiles()
  assert.equal(store.activeProfile, 'primary'); assert.equal(store.profiles.laya.apiKey, null)
  assert.equal(store.profiles.laya.model, 'english'); assert.deepEqual(store.profiles.laya.options, { max_len: 2048, head_max_len: 512 })
  model.editJudgment('laya'); await submit(model, ['http://localhost:8000/v1', ''])
  saveJudgmentProfile('concurrent', jevProfile())
  await confirm(model); assert.match(model.notice, /failed/)
  assert.equal(readJudgmentProfiles().activeProfile, 'concurrent')
  const dry = new ConsoleModel({ language: 'en', dryRun: true }), bytes = readFileSync(judgmentFilePath(), 'utf8')
  dry.editJudgment('laya'); await submit(dry, ['http://localhost:8000/v1', 'dry-private-key']); await confirm(dry)
  assert.equal(readFileSync(judgmentFilePath(), 'utf8'), bytes)
}))
await test('Enter transfers focus to details without a dialog; three-pane geometry stays fixed through edit and confirmation', async () => freshConsole(async () => {
  const model = new ConsoleModel({ language: 'en' }); model.navigate(1)
  const middle = frame => frame.split('\n').slice(3, -4).map((line, index) => index === 0 ? line.split(' │ ')[1].replace(/^▸/, ' ') : line.split(' │ ')[1]).join('\n')
  const list = renderConsole(model, { columns: 120, rows: 32, color: false })
  key(model, 'return')
  assert.equal(model.focus, 'detail'); assert.equal(model.modal, null)
  assert.equal(model.current.id, 'tavily'); assert.equal(model.detailView.actionIndex, 0)
  const detail = renderConsole(model, { columns: 120, rows: 32, color: false })
  assert.equal(middle(list), middle(detail), 'entering details changes focus, not the middle-pane geometry or contents')
  key(model, 'return'); await settle(); assert.equal(model.modal.kind, 'form')
  assert.equal(middle(detail), middle(renderConsole(model, { columns: 120, rows: 32, color: false })))
  const draft = model.modal
  await submit(model, ['focus-fixture-secret']); assert.equal(model.modal.kind, 'select')
  const confirmation = renderConsole(model, { columns: 120, rows: 32, color: false })
  assert.equal(middle(detail), middle(confirmation)); assert.doesNotMatch(confirmation, /focus-fixture-secret/)
  key(model, 'escape')
  assert.equal(model.modal, draft); assert.equal(model.modal.values[0], 'focus-fixture-secret')
  key(model, 'escape'); assert.equal(model.modal, null); assert.equal(model.focus, 'detail')
  key(model, 'escape'); assert.equal(model.focus, 'list')
  key(model, 'escape'); assert.equal(model.focus, 'sidebar')
  assert.equal(existsSync(searchBoostHome()), false)
}))
await test('adjacent-pane arrows, reverse Tab and action navigation never move the selected middle item', () => freshConsole(async () => {
  const model = new ConsoleModel({ language: 'en' }); model.navigate(1)
  key(model, 'down'); const id = model.current.id
  key(model, 'tab'); assert.equal(model.focus, 'detail')
  key(model, 'down'); assert.equal(model.detailView.actionIndex, 1); assert.equal(model.current.id, id)
  key(model, 'tab', '', { shift: true }); assert.equal(model.focus, 'list')
  key(model, 'left'); assert.equal(model.focus, 'sidebar')
  key(model, 'left'); assert.equal(model.focus, 'sidebar')
  key(model, 'right'); assert.equal(model.focus, 'list')
  key(model, 'right'); assert.equal(model.focus, 'detail'); assert.equal(model.detailView.actionIndex, 1)
  key(model, 'right'); assert.equal(model.focus, 'detail')
  key(model, 'tab'); assert.equal(model.focus, 'sidebar')
  key(model, 'tab', '', { shift: true }); assert.equal(model.focus, 'detail')
  key(model, 'end'); assert.equal(model.detailView.actionIndex, model.current.actions.length - 1)
  key(model, 'down'); assert.equal(model.detailView.actionIndex, model.current.actions.length - 1)
  key(model, 'home'); key(model, 'up'); assert.equal(model.detailView.actionIndex, 0)
  key(model, 'escape'); key(model, 'home'); key(model, 'up'); assert.equal(model.index, 0)
  key(model, 'end'); key(model, 'down'); assert.equal(model.index, model.rows.length - 1)
}))
await test('narrow terminals preserve logical detail focus and restore the list on back and resize', () => freshConsole(async () => {
  const model = new ConsoleModel({ language: 'en' }); model.navigate(1); key(model, 'down')
  const id = model.current.id, widths = [54, 80, 100, 112, 120, 180]
  for (const columns of widths) {
    model.focus = 'list'; key(model, 'return')
    let frame = renderConsole(model, { columns, rows: 24, color: false })
    assert.match(frame, /Details/); assert.equal(model.current.id, id); assert.equal(model.focus, 'detail')
    key(model, 'e'); assert.equal(model.modal.kind, 'form')
    frame = renderConsole(model, { columns, rows: 24, color: false })
    for (const line of frame.split('\n')) assert.ok(displayWidth(line) <= columns - 1)
    key(model, 'escape'); assert.equal(model.focus, 'detail')
    key(model, 'left'); assert.equal(model.focus, 'list'); assert.equal(model.current.id, id)
    assert.match(renderConsole(model, { columns, rows: 24, color: false }), /API quota overview/)
  }
  key(model, 'return'); renderConsole(model, { columns: 120, rows: 24 })
  renderConsole(model, { columns: 80, rows: 24 }); assert.equal(model.focus, 'detail')
  renderConsole(model, { columns: 120, rows: 24 }); assert.equal(model.focus, 'detail')
}))
await test('details keep actions visible, and read-only/text scrolling has real bounds with immediate upward response', () => freshConsole(async () => {
  const model = new ConsoleModel({ language: 'en' }); model.navigate(1)
  model.current.details = Array.from({ length: 60 }, (_, i) => `Detail line ${i + 1}`)
  key(model, 'return'); let frame = renderConsole(model, { columns: 120, rows: 24, color: false })
  assert.match(frame, /Set \/ replace key/)
  for (let i = 0; i < 30; i++) key(model, 'pagedown')
  assert.equal(model.detailView.scroll, model.detailView.scrollMax)
  frame = renderConsole(model, { columns: 120, rows: 24, color: false }); assert.match(frame, /Detail line 60/); assert.match(frame, /Set \/ replace key/)
  const bottom = model.detailView.scroll; key(model, 'pageup'); assert.ok(model.detailView.scroll < bottom)
  model.current.actions = []; key(model, 'end'); const end = model.detailView.scroll
  key(model, 'down'); assert.equal(model.detailView.scroll, end)
  key(model, 'up'); assert.equal(model.detailView.scroll, end - 1)
  model.showText(Array.from({ length: 60 }, (_, i) => `Text line ${i + 1}`))
  renderConsole(model, { columns: 120, rows: 24, color: false }); key(model, 'end'); const textBottom = model.modal.scroll
  for (let i = 0; i < 30; i++) key(model, 'pagedown')
  assert.equal(model.modal.scroll, textBottom); key(model, 'up'); assert.equal(model.modal.scroll, textBottom - 1)
  key(model, 'escape'); assert.equal(model.focus, 'detail')
}))
await test('all long confirmation descriptions are pageable and default cancellation cannot wrap to confirm', () => freshConsole(async () => {
  const model = new ConsoleModel({ language: 'en' }); let commits = 0
  model.navigate(1); key(model, 'return')
  model.confirm(`${'Important disclosure\n'.repeat(40)}FINAL DESTINATION`, () => { commits++ })
  let frame = renderConsole(model, { columns: 112, rows: 16, color: false })
  assert.match(frame, /Cancel/); assert.match(frame, /PgUp\/PgDn/)
  key(model, 'up'); assert.equal(model.modal.index, 0)
  for (let i = 0; i < 50; i++) key(model, 'pagedown')
  frame = renderConsole(model, { columns: 112, rows: 16, color: false })
  assert.match(frame, /FINAL DESTINATION/); assert.match(frame, /Cancel/)
  assert.equal(model.modal.descriptionScroll, model.modal.descriptionScrollMax)
  key(model, 'return'); await settle(); assert.equal(commits, 0); assert.equal(model.focus, 'detail')
  model.confirm('Tab support', () => { commits++ })
  key(model, 'tab'); assert.equal(model.modal.index, 1)
  key(model, 'tab', '', { shift: true }); assert.equal(model.modal.index, 0)
  key(model, 'escape'); assert.equal(commits, 0)
}))
await test('wizard back restores provider choices and form drafts; cancel confirmation also returns to the draft', () => freshConsole(async () => {
  const model = new ConsoleModel({ language: 'en' }); model.navigate(5); key(model, 'return')
  model.addJudgment(); const providers = model.modal
  key(model, 'return'); await settle(); const destinations = model.modal
  key(model, 'return'); await settle(); const draft = model.modal
  await submit(model, ['back-fixture', 'https://api.typesafe.ai/v1', 'back-fixture-secret'])
  assert.equal(model.modal.kind, 'select')
  key(model, 'return'); await settle(); assert.equal(model.modal, draft)
  assert.equal(model.modal.values[2], 'back-fixture-secret')
  key(model, 'escape'); assert.equal(model.modal, destinations)
  key(model, 'escape'); assert.equal(model.modal, providers)
  key(model, 'escape'); assert.equal(model.modal, null); assert.equal(model.focus, 'detail')
  assert.equal(existsSync(searchBoostHome()), false)
}))
await test('form hints and errors stay visible, invalid fields regain focus, and long inputs show their editable tail', () => freshConsole(async () => {
  const model = new ConsoleModel({ language: 'en' })
  model.form('Long form', Array.from({ length: 6 }, (_, i) => ({ label: `Field ${i + 1}`, required: true, value: i === 5 ? '' : 'ok' })), () => {})
  model.modal.description = `${'Form setup instruction\n'.repeat(12)}FINAL FORM HINT`
  model.modal.index = 6; key(model, 'return'); assert.equal(model.modal.index, 5)
  for (let i = 0; i < 20; i++) key(model, 'pagedown')
  let frame = renderConsole(model, { columns: 54, rows: 16, color: false })
  // Re-page using the actual small viewport rather than the default model size.
  for (let i = 0; i < 20; i++) key(model, 'pagedown')
  frame = renderConsole(model, { columns: 54, rows: 16, color: false })
  assert.match(frame, /FINAL FORM HINT/); assert.match(frame, /Field 6/); assert.match(frame, /required/)
  key(model, 'x', `${'prefix-'.repeat(20)}VISIBLE-TAIL`)
  frame = renderConsole(model, { columns: 54, rows: 16, color: false }); assert.match(frame, /VISIBLE-TAIL/)
  const value = model.modal.values[5]; key(model, 'right', '\x1b[C'); assert.equal(model.modal.values[5], value)
  key(model, 'u', '', { ctrl: true }); assert.equal(model.modal.values[5], '')
}))
await test('refresh/activation keeps the selected profile identity and avoids landing on delete when an action disappears', () => freshConsole(async () => {
  saveJudgmentProfile('first', jevProfile())
  saveJudgmentProfile('second', jevProfile(), { activate: false })
  const model = new ConsoleModel({ language: 'en' }); model.navigate(5)
  model.selection.judgment = model.rows.findIndex(row => row.id === 'profile:second')
  key(model, 'return'); model.detailView.actionIndex = model.current.actions.findIndex(action => action.id === 'activate')
  key(model, 'return'); await settle(); await confirm(model)
  assert.equal(readJudgmentProfiles().activeProfile, 'second')
  assert.equal(model.current.id, 'profile:second'); assert.equal(model.focus, 'detail')
  assert.equal(model.current.actions[model.detailView.actionIndex].id, 'view')
  key(model, 'r'); assert.equal(model.current.id, 'profile:second')
}))
await test('completed operations replace Working, restore original focus and never return to a stale busy dialog', () => freshConsole(async () => {
  for (const focus of ['list', 'detail']) {
    const model = new ConsoleModel({ language: 'en' }); model.navigate(6); model.focus = focus
    let complete
    const pending = model.runBusy(() => new Promise(resolve => { complete = resolve }))
    const working = renderConsole(model, { columns: 120, rows: 24, color: false })
    assert.match(working, /Operation in progress/); assert.match(working, /Ctrl\+C exits after completion/)
    assert.doesNotMatch(working, /Enter \/ Esc back|Q quit/)
    key(model, 'q', 'q'); assert.equal(model.closed, false)
    complete('Finished fixture'); await pending
    assert.equal(model.busy, false); assert.equal(model.modal.title, 'Result'); assert.equal(model.modal.parent, null)
    key(model, 'escape'); assert.equal(model.modal, null); assert.equal(model.focus, focus)
  }
}))
await test('integration discovery visibly indicates busy state and does not leave a stale Working parent', () => freshConsole(async () => {
  let complete
  const model = new ConsoleModel({ language: 'en', services: { integrations: {
    integrationTargetKey: target => target.label,
    discoverIntegrations: () => new Promise(resolve => { complete = resolve }),
  } } })
  model.navigate(6); key(model, 'return')
  const pending = model.refreshAgent('codex')
  assert.equal(model.busy, true)
  const frame = renderConsole(model, { columns: 120, rows: 24, color: false })
  assert.match(frame, /Discovering integrations/); assert.match(frame, /Operation in progress/)
  complete({ targets: [] }); await pending
  assert.equal(model.busy, false); assert.equal(model.modal.kind, 'text'); assert.equal(model.modal.parent, null)
  key(model, 'escape'); assert.equal(model.modal, null); assert.equal(model.focus, 'detail')
}))
await test('input caret supports grapheme-safe insertion, arrows, Home/End, Delete and Backspace while secrets stay masked', () => freshConsole(async () => {
  const model = new ConsoleModel({ language: 'en' })
  model.form('Caret fixture', [{ label: 'URL', value: 'ab' }, { label: 'Secret', secret: true }], () => {})
  key(model, 'left'); key(model, 'x', '中👩‍💻')
  assert.equal(model.modal.values[0], 'a中👩‍💻b')
  key(model, 'backspace'); assert.equal(model.modal.values[0], 'a中b', 'emoji deleted as a single grapheme')
  key(model, 'home'); key(model, 'backspace', '\x7f'); assert.equal(model.modal.values[0], 'a中b', 'Backspace at the start is a no-op, including its raw terminal byte')
  key(model, 'delete'); assert.equal(model.modal.values[0], '中b')
  key(model, 'right'); key(model, 'x', 'e\u0301'); assert.equal(model.modal.values[0], '中e\u0301b')
  key(model, 'backspace'); assert.equal(model.modal.values[0], '中b', 'combining sequence deleted as a single grapheme')
  key(model, 'end'); key(model, 'x', 'Z'); assert.equal(model.modal.values[0], '中bZ')
  key(model, 'tab'); key(model, 'x', 'secret-caret-fixture'); key(model, 'home'); key(model, 'x', 'START')
  assert.equal(model.modal.values[1], 'STARTsecret-caret-fixture')
  for (const columns of [54, 80, 112, 120]) {
    const frame = renderConsole(model, { columns, rows: 16, color: false })
    assert.doesNotMatch(frame, /START|secret-caret-fixture/)
    for (const line of frame.split('\n')) assert.ok(displayWidth(line) <= columns - 1)
  }
  key(model, 'u', '', { ctrl: true }); assert.equal(model.modal.values[1], '')
}))
await test('list paging uses its visible rows, and narrow mode clearly describes the three-column width requirement', () => freshConsole(async () => {
  const model = new ConsoleModel({ language: 'en' }); model.navigate(1)
  const template = model.current
  model.pages.engines = Array.from({ length: 50 }, (_, i) => ({ ...template, id: `fixture-${i}`, label: `Fixture ${i}` }))
  for (const columns of [54, 80, 100, 112, 120]) {
    for (const rows of [16, 24, 32]) {
      model.selection.engines = 0
      const frame = renderConsole(model, { columns, rows, color: false })
      if (columns < 112) assert.match(frame, /≥112 columns/)
      const visible = frame.split('\n').slice(5, 5 + model.viewport.listPageSize).filter(line => /Fixture \d+/.test(line.split(' │ ')[1])).length
      key(model, 'pagedown'); assert.equal(model.index, visible)
      key(model, 'pageup'); assert.equal(model.index, 0)
    }
  }
}))
await test('console themes default offline and persist separately without changing legacy language/layout or unknown fields', () => freshConsole(async () => {
  const model = new ConsoleModel({ language: 'en' })
  assert.equal(model.theme, DEFAULT_CONSOLE_THEME); assert.equal(existsSync(searchBoostHome()), false)
  saveTuiLayout('folder'); const legacy = readTuiSettings()
  saveConsoleTheme('ayu'); writeFileSync(consoleSettingsPath(), JSON.stringify({ theme: 'ayu', future: { preserve: true } }))
  model.navigate(7); model.selection.settings = model.rows.findIndex(row => row.id === 'theme')
  key(model, 'return'); key(model, 'return'); await settle()
  assert.deepEqual(model.modal.options.map(option => option.label.replace(/ · ●$/, '')), ['Ayu Dark', 'TokyoNight Dark'])
  key(model, 'down'); key(model, 'return'); await settle()
  assert.equal(model.modal.kind, 'select'); assert.equal(model.theme, 'ayu'); assert.equal(readConsoleTheme(), 'ayu')
  await confirm(model)
  assert.equal(model.theme, 'tokyonight'); assert.equal(readConsoleTheme(), 'tokyonight')
  assert.equal(model.current.id, 'theme'); assert.equal(model.current.status, 'TokyoNight'); assert.equal(model.focus, 'detail')
  assert.deepEqual(JSON.parse(readFileSync(consoleSettingsPath(), 'utf8')).future, { preserve: true })
  assert.deepEqual(readTuiSettings(), legacy)
  assert.equal(new ConsoleModel({ language: 'en' }).theme, 'tokyonight')
  saveConsoleTheme('ayu'); key(model, 'r'); assert.equal(model.theme, 'ayu')
  assert.doesNotMatch(readFileSync(new URL('../lib/installer/tui.mjs', import.meta.url), 'utf8'), /console-theme|chooseTheme|TokyoNight/)
}))
await test('theme selection cancel, dry-run and concurrent changes do not overwrite preferences', () => freshConsole(async () => {
  const model = new ConsoleModel({ language: 'en' }); model.chooseTheme()
  key(model, 'down'); key(model, 'return'); await settle(); key(model, 'return'); await settle()
  assert.equal(model.modal.kind, 'select', 'default cancellation returns to the theme picker')
  assert.equal(model.theme, 'ayu'); assert.equal(existsSync(consoleSettingsPath()), false)
  key(model, 'escape')
  const dry = new ConsoleModel({ language: 'en', dryRun: true }); dry.chooseTheme()
  key(dry, 'down'); key(dry, 'return'); await settle(); await confirm(dry)
  assert.equal(dry.theme, 'ayu'); assert.equal(existsSync(consoleSettingsPath()), false)
  model.chooseTheme(); key(model, 'down'); key(model, 'return'); await settle()
  saveConsoleTheme('tokyonight'); await confirm(model)
  assert.match(model.notice, /failed/); assert.equal(model.theme, 'ayu'); assert.equal(readConsoleTheme(), 'tokyonight')
  assert.throws(() => saveConsoleTheme('light'), /Unsupported/)
}))
await test('unreadable or unknown console theme configuration is visible and never overwritten', () => freshConsole(async () => {
  saveConsoleTheme('ayu')
  for (const bytes of ['{broken-private-value', '{"theme":"unrecognized"}', '[]']) {
    writeFileSync(consoleSettingsPath(), bytes)
    assert.throws(() => readConsoleTheme())
    const model = new ConsoleModel({ language: 'en' })
    assert.equal(model.theme, 'ayu'); assert.match(model.notice, /unreadable/)
    assert.doesNotMatch(renderConsole(model), /broken-private-value/)
    await model.perform(() => model.chooseTheme())
    assert.equal(model.modal, null); assert.equal(readFileSync(consoleSettingsPath(), 'utf8'), bytes)
    assert.throws(() => saveConsoleTheme('tokyonight'))
    assert.equal(readFileSync(consoleSettingsPath(), 'utf8'), bytes)
  }
}))
await test('Ayu/TokyoNight palettes and the standard SearchBoost logo cover all panes, dialogs and terminal sizes', () => freshConsole(async () => {
  const model = new ConsoleModel({ language: 'en' })
  for (const theme of Object.keys(CONSOLE_THEMES)) {
    model.theme = theme
    for (const columns of [1, 40, 54, 80, 100, 112, 120, 180]) for (const rows of [2, 10, 16, 24, 32]) {
      for (const mode of ['list', 'detail', 'form', 'confirmation', 'quota']) {
        model.navigate(1); model.theme = theme
        if (mode === 'detail') key(model, 'return')
        if (mode === 'form') model.editKey('tavily')
        if (mode === 'confirmation') model.confirm('Fixture disclosure', () => {})
        if (mode === 'quota') model.showQuotaOverview()
        for (const color of [false, true]) {
          const frame = renderConsole(model, { columns, rows, color })
          assert.ok(frame.split('\n').length <= Math.max(1, rows - 1))
          for (const line of frame.split('\n')) assert.ok(displayWidth(line) <= Math.max(0, columns - 1))
          if (!color) assert.doesNotMatch(frame, /\x1b/)
          if (columns >= 54 && rows >= 16) {
            assert.match(frame, /SearchBoost/); assert.doesNotMatch(frame, /SEARCHBOOST/)
            if (!color) CONSOLE_LOGO.forEach((logo, i) => assert.ok(frame.split('\n')[i].startsWith(`  ${logo}  `)))
          }
        }
      }
    }
    model.navigate(1); model.theme = theme
    const frame = renderConsole(model, { columns: 120, rows: 32, color: true })
    const rgb = hex => [1, 3, 5].map(start => parseInt(hex.slice(start, start + 2), 16)).join(';')
    const palette = CONSOLE_THEMES[theme]
    assert.ok(frame.includes(`48;2;${rgb(palette.background)}`), 'theme has a real dark background, not just accent colors')
    assert.ok(frame.includes(`38;2;${rgb(palette.logo)}`)); assert.ok(frame.includes(`38;2;${rgb(palette.logoAlt)}`))
    assert.ok(frame.includes(`48;2;${rgb(palette.accent)}`), 'focused rows use the chosen theme')
  }
  assert.equal(existsSync(searchBoostHome()), false, 'rendering and palette changes never write settings')
}))
console.log(`\n${count} independent console TUI tests passed.`)
