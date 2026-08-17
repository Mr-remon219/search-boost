/**
 * Unit-style checks for install helpers (no writes to real home dir).
 */
import { upsertTomlSection, removeTomlSection, hasTomlSection } from '../lib/toml.mjs'
import { injectBlock, removeBlock, injectTomlSection, removeTomlSection as removeMarkedToml } from '../lib/inject.mjs'
import { normalizeTargets } from '../lib/agents/index.mjs'
import { antigravityMcpEntry, jsonMcpEntry, grokPermissionAllows, grokPermissionTomlBlock } from '../lib/mcp-entry.mjs'
import { loadAgentPrompt } from '../lib/agents/shared.mjs'
import { getRoute, promptPath, ROUTE_IDS, mcpServerInstructionsPath, skillPath } from '../agents/router.mjs'
import { grokInstallPaths } from '../lib/paths.mjs'
import { readFileSync } from 'node:fs'
import { maskKey, readKeysFile, writeKeysFile } from '../lib/keys.mjs'
import { getLayer, setLayer } from '../lib/layer-config.mjs'
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
assert('load cursor inject', cursorPrompt.includes('search-boost @ Cursor IDE'))
const grokPrompt = await loadAgentPrompt('grok')
assert('load grok inject', grokPrompt.includes('search-boost @ Grok Build'))
assert('load grok inject native browse', /native (Grok|browsing)/i.test(grokPrompt))
assert('grok permission allows count', grokPermissionAllows().length === 6)
assert('grok permission toml block', grokPermissionTomlBlock().includes('[permission]'))

let grokToml = ''
grokToml = injectTomlSection(grokToml, 'permission', grokPermissionTomlBlock())
assert('grok permission inject marker', grokToml.includes('SEARCH_BOOST_permission_START'))
grokToml = removeMarkedToml(grokToml, 'permission')
assert('grok permission remove marker', !grokToml.includes('SEARCH_BOOST_permission_START'))

const mcpInstr = mcpServerInstructionsPath()
assert('mcp instructions path', mcpInstr.endsWith('agents\\mcp\\server-instructions.md') || mcpInstr.endsWith('agents/mcp/server-instructions.md'))
assert('mcp instructions grok branch', readFileSync(mcpInstr, 'utf8').includes('Grok Build'))

const grokSkillPath = skillPath('grok')
assert('grok skill path', !!grokSkillPath)
assert('grok skill frontmatter', readFileSync(grokSkillPath, 'utf8').trimStart().startsWith('---'))

const projectPaths = grokInstallPaths('project')
assert('grok project config path', projectPaths.config.includes('.grok'))
assert('grok project rule stays user', projectPaths.rule.includes('.grok') && projectPaths.rule.includes('rules'))

if (failed) {
  console.error(`\n${failed} test(s) failed`)
  process.exit(1)
}
console.log('\nAll install helper tests passed.')
