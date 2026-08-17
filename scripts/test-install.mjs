/**
 * Unit-style checks for install helpers (no writes to real home dir).
 */
import { upsertTomlSection, removeTomlSection, hasTomlSection } from '../lib/toml.mjs'
import { injectBlock, removeBlock } from '../lib/inject.mjs'
import { normalizeTargets } from '../lib/agents/index.mjs'
import { antigravityMcpEntry, jsonMcpEntry } from '../lib/mcp-entry.mjs'
import { loadAgentPrompt } from '../lib/agents/shared.mjs'
import { getRoute, promptPath, ROUTE_IDS, hookScriptPath } from '../agents/router.mjs'
import { maskKey, readKeysFile, writeKeysFile } from '../lib/keys.mjs'
import { getLayer, setLayer } from '../lib/layer-config.mjs'
import {
  buildSessionStartCommand,
  isSearchBoostHook,
  removeSessionStartHook,
  upsertSessionStartHook,
} from '../lib/hooks-config.mjs'
import {
  CURSOR_CLI_MCP_ALLOW,
  mergeCliPermissionAllow,
  removeCliPermissionAllow,
} from '../lib/cli-config.mjs'
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failed = 0

function assert(name, cond) {
  if (!cond) {
    console.error(`FAIL: ${name}`)
    failed++
  } else {
    console.log(`ok: ${name}`)
  }
}

// TOML upsert/remove
let toml = '# codex\nweb_search = "disabled"\n'
toml = upsertTomlSection(toml, 'search-boost', 'command = "node"\nargs = ["serve"]')
assert('toml has section', hasTomlSection(toml, 'search-boost'))
toml = upsertTomlSection(toml, 'search-boost', 'command = "node"\nargs = ["serve", "v2"]')
assert('toml upsert updates body', toml.includes('"serve", "v2"'))
toml = removeTomlSection(toml, 'search-boost')
assert('toml remove section', !hasTomlSection(toml, 'search-boost'))
assert('toml preserves other keys', toml.includes('web_search'))

// inject block round-trip
const snippet = '## search-boost rules'
let md = injectBlock('', snippet)
assert('inject empty', md.includes('SEARCH_BOOST_START'))
md = injectBlock(md, snippet + '\nupdated')
assert('inject replace', md.includes('updated'))
md = removeBlock(md)
assert('remove block', !md.includes('SEARCH_BOOST_START'))

// normalize targets
const n1 = normalizeTargets(['cursor', 'cursor-cli', 'codex'])
assert('merge cursor family', n1.mergeCursorCli && n1.targets.join() === 'cursor,codex')
const n2 = normalizeTargets(['cursor-cli'])
assert('solo cursor-cli', !n2.mergeCursorCli && n2.targets[0] === 'cursor-cli')

// MCP entry shapes
const json = jsonMcpEntry()
assert('json entry has type stdio', json.type === 'stdio' && json.command && json.args?.length)
const agy = antigravityMcpEntry()
assert('antigravity omits type', !('type' in agy) && agy.command && agy.args?.length)

// keys + layer round-trip (isolated temp files)
process.env.SEARCH_BOOST_KEYS_FILE = join(tmpdir(), `search-boost-test-keys-${process.pid}.json`)
process.env.SEARCH_BOOST_LAYER_FILE = join(tmpdir(), `search-boost-test-layer-${process.pid}.json`)
delete process.env.SEARCH_BOOST_LAYER
writeKeysFile({ tavily: 'tvly-test-key-12345678', brave: undefined })
const k = readKeysFile()
assert('keys write tavily', k.tavily === 'tvly-test-key-12345678')
assert('keys mask', maskKey('tvly-test-key-12345678').includes('****'))
writeKeysFile({ tavily: undefined })
assert('keys unset', !readKeysFile().tavily)

// layer
setLayer('free')
assert('layer free', getLayer() === 'free')
setLayer('api')
assert('layer api', getLayer() === 'api')

// router resolves per-agent assets
for (const id of ROUTE_IDS) {
  assert(`route ${id} prompt exists`, promptPath(id).includes(getRoute(id).dir))
}
const cursorPrompt = await loadAgentPrompt('cursor')
assert('load cursor inject', cursorPrompt.includes('search-boost @ Cursor IDE') && cursorPrompt.includes('when you choose'))

// hooks-config round-trip
const hooksDir = mkdtempSync(join(tmpdir(), 'sb-hooks-'))
const hooksPath = join(hooksDir, 'hooks.json')
const hookCmd = buildSessionStartCommand(process.execPath, join(hooksDir, 'search-boost-session.mjs'))
await upsertSessionStartHook(hooksPath, hookCmd, false)
const hooksAfter = JSON.parse(readFileSync(hooksPath, 'utf8'))
assert('hooks upsert sessionStart', hooksAfter.hooks?.sessionStart?.some((e) => isSearchBoostHook(e.command)))
await upsertSessionStartHook(hooksPath, hookCmd, false)
assert('hooks upsert idempotent', hooksAfter.hooks.sessionStart.length === JSON.parse(readFileSync(hooksPath, 'utf8')).hooks.sessionStart.length)
await removeSessionStartHook(hooksPath, false)
assert('hooks remove', !JSON.parse(readFileSync(hooksPath, 'utf8')).hooks?.sessionStart?.length)

// cli-config merge round-trip
const cliDir = mkdtempSync(join(tmpdir(), 'sb-cli-'))
const cliPath = join(cliDir, 'cli-config.json')
writeFileSync(cliPath, JSON.stringify({ permissions: { allow: ['Shell(git)'] } }))
await mergeCliPermissionAllow(cliPath, CURSOR_CLI_MCP_ALLOW, false)
const cliCfg = JSON.parse(readFileSync(cliPath, 'utf8'))
assert('cli-config merge allow', cliCfg.permissions.allow.includes(CURSOR_CLI_MCP_ALLOW))
await mergeCliPermissionAllow(cliPath, CURSOR_CLI_MCP_ALLOW, false)
assert('cli-config merge idempotent', cliCfg.permissions.allow.length === JSON.parse(readFileSync(cliPath, 'utf8')).permissions.allow.length)
await removeCliPermissionAllow(cliPath, CURSOR_CLI_MCP_ALLOW, false)
assert('cli-config remove', !JSON.parse(readFileSync(cliPath, 'utf8')).permissions.allow.includes(CURSOR_CLI_MCP_ALLOW))

// session-start hook outputs valid JSON
const hookDir = mkdtempSync(join(tmpdir(), 'sb-hook-'))
writeFileSync(join(hookDir, 'search-boost-inject.md'), '# test policy\n')
copyFileSync(hookScriptPath('cursor-cli'), join(hookDir, 'search-boost-session.mjs'))
const out = execFileSync(process.execPath, [join(hookDir, 'search-boost-session.mjs')], {
  encoding: 'utf8',
})
const parsed = JSON.parse(out.trim())
assert('session-start json', parsed.continue === true && parsed.additional_context.includes('test policy'))
rmSync(hookDir, { recursive: true, force: true })
rmSync(hooksDir, { recursive: true, force: true })
rmSync(cliDir, { recursive: true, force: true })

if (failed) {
  console.error(`\n${failed} test(s) failed`)
  process.exit(1)
}
console.log('\nAll install helper tests passed.')
