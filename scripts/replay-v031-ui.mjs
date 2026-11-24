// Isolated UI replay for the 0.3.1 beta console and keys status.
// It writes a fixture key in a temporary home and refuses to print that value.
import './isolate-tests.mjs'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ConsoleModel, renderConsole, displayWidth } from '../lib/console-tui.mjs'
import { writeKeysFile } from '../lib/keys.mjs'
import { formatAllEnginesFailedMessage } from '../lib/runtime.mjs'

const secret = 'fixture-replay-key-not-a-credential'
const cli = fileURLToPath(new URL('../cli.mjs', import.meta.url))
writeKeysFile({ 'deepseek-search': secret, enabledEngines: ['deepseek-search'] })

function within(frame, columns) {
  for (const line of frame.split('\n')) assert.ok(displayWidth(line) <= columns, line)
}

const en = new ConsoleModel({ language: 'en' })
en.handleKey('3')
const wide = renderConsole(en, { columns: 100, rows: 28, color: false })
const narrow = renderConsole(en, { columns: 48, rows: 16, color: false })
const compact = renderConsole(en, { columns: 54, rows: 16, color: false })
within(wide, 100)
within(narrow, 48)
within(compact, 54)
assert.match(narrow, /54/)
assert.match(wide, /\/v1\/tools\/search/)
assert.match(compact, /\/v1\/tools\/search/)
const zh = new ConsoleModel({ language: 'zh-CN' })
zh.handleKey('3')
const zhNarrow = renderConsole(zh, { columns: 54, rows: 16, color: false })
within(zhNarrow, 54)
assert.match(zhNarrow, /协议/)

const plain = renderConsole(en, { columns: 80, rows: 24, color: false })
const colored = renderConsole(en, { columns: 80, rows: 24, color: true })
assert.equal(plain.includes('\u001b'), false)
assert.match(colored, /\u001b\[/)

const missing = formatAllEnginesFailedMessage({
  query: 'stdio-no-key',
  enginePool: 'api',
  engineStats: {},
  warnings: ['deepseek-search unavailable (missing credentials, disabled, or locally unavailable); not called'],
})
assert.match(missing, /engine_pool=api did not run/)
assert.match(missing, /config keys --show/)
assert.match(missing, /config keys --set/)

const show = spawnSync(process.execPath, [cli, 'config', 'keys', '--show'], { encoding: 'utf8' })
assert.equal(show.status, 0, show.stderr)
assert.equal(show.stdout.includes(secret), false)
assert.match(show.stdout, /POST \/v1\/tools\/search/)
const preview = spawnSync(process.execPath, [cli, 'tui', '--preview', '--no-color'], { encoding: 'utf8' })
assert.equal(preview.status, 0, preview.stderr)
assert.equal(preview.stdout.includes(secret), false)
assert.equal(preview.stdout.includes('\u001b'), false)
const refused = spawnSync(process.execPath, [cli, 'tui'], { encoding: 'utf8' })
assert.notEqual(refused.status, 0)
assert.match(refused.stderr, /interactive terminal/)

const report = [
  '0.3.1-beta.2 UI replay. Isolation home. No live search. The fixture key is not printed.',
  '',
  'CLI keys --show',
  show.stdout.trimEnd(),
  '',
  'tui --preview --no-color (non-TTY, color off)',
  preview.stdout.trimEnd(),
  '',
  'library search page 100x28, English, color off',
  wide,
  '',
  'library search page 48x16, English, color off (below the 54-column floor)',
  narrow,
  '',
  'library search page 54x16, English, color off',
  compact,
  '',
  'library search page 54x16, Chinese, color off',
  zhNarrow,
  '',
  'missing-key recovery',
  missing,
].join('\n')
assert.equal(report.includes(secret), false)
const out = process.argv[2]
if (out) writeFileSync(isAbsolute(out) ? out : join(fileURLToPath(new URL('..', import.meta.url)), out), report + '\n')
console.log(report)
