/**
 * Unit-style checks for install helpers (no writes to real home dir).
 */
import { upsertTomlSection, removeTomlSection, hasTomlSection } from '../lib/toml.mjs'
import { injectBlock, injectGeminiBlock, removeBlock, removeGeminiBlock } from '../lib/inject.mjs'
import { normalizeTargets } from '../lib/agents/index.mjs'
import { antigravityMcpEntry, antigravityPermissions, jsonMcpEntry } from '../lib/mcp-entry.mjs'
import {
  HOOK_ENTRY_KEY,
  injectAntigravityRule,
  injectSkill,
  loadAgentPrompt,
} from '../lib/agents/shared.mjs'
import {
  getRoute,
  geminiSnippetPath,
  hooksConfigPath,
  promptPath,
  rulePath,
  ROUTE_IDS,
} from '../agents/router.mjs'
import { workspaceAgents } from '../lib/paths.mjs'
import { readJsonFile, writeJsonFile } from '../lib/json-config.mjs'
import { maskKey, readKeysFile, writeKeysFile } from '../lib/keys.mjs'
import { getLayer, setLayer } from '../lib/layer-config.mjs'
import { mkdir, readFile, rm } from 'node:fs/promises'
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

// GEMINI block round-trip
let gem = injectGeminiBlock('', '## search routing')
assert('inject gemini empty', gem.includes('SEARCH_BOOST_GEMINI_START'))
gem = injectGeminiBlock(gem, '## search routing\nupdated')
assert('inject gemini replace', gem.includes('updated'))
gem = removeGeminiBlock(gem)
assert('remove gemini block', !gem.includes('SEARCH_BOOST_GEMINI_START'))

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

// antigravity permissions
const perms = antigravityPermissions()
assert('antigravity permissions wildcard', perms.includes('mcp(search-boost/*)'))
assert('antigravity permissions fused_search', perms.includes('mcp(search-boost/fused_search)'))

// workspace paths
const ws = workspaceAgents('/tmp/myproject')
assert('workspace mcp path', ws.mcp.endsWith('.agents/mcp_config.json') || ws.mcp.includes('.agents\\mcp_config.json'))
assert('workspace rule path', ws.rule.includes('search-boost.md'))

// antigravity route assets
const agyRoute = getRoute('antigravity')
assert('antigravity has rule template', agyRoute.rule === 'rule.md' && rulePath('antigravity').includes('rule.md'))
assert('antigravity has gemini snippet', agyRoute.geminiSnippet && geminiSnippetPath('antigravity'))
assert('antigravity has hooks', agyRoute.hooks && hooksConfigPath('antigravity'))
assert('antigravity skillDescription', typeof agyRoute.skillDescription === 'string' && agyRoute.skillDescription.length > 20)

// skill + rule inject (temp dir)
const tempRoot = join(tmpdir(), `search-boost-install-test-${process.pid}`)
await mkdir(tempRoot, { recursive: true })
const skillFile = join(tempRoot, 'SKILL.md')
const ruleFile = join(tempRoot, 'search-boost.md')
await injectSkill('antigravity', skillFile)
const skillText = await readFile(skillFile, 'utf8')
assert('antigravity skill has description', skillText.includes('description:') && skillText.includes('search_web'))
await injectAntigravityRule(ruleFile)
const ruleText = await readFile(ruleFile, 'utf8')
assert('antigravity rule always_on', ruleText.includes('trigger: always_on'))

// hooks.json merge preserves other entries
const hooksFile = join(tempRoot, 'hooks.json')
await writeJsonFile(hooksFile, {
  'user-hook': { PreToolUse: [{ matcher: 'run_command', hooks: [{ command: './x.sh' }] }] },
})
const incoming = await readJsonFile(hooksConfigPath('antigravity'), {})
const merged = await readJsonFile(hooksFile, {})
merged[HOOK_ENTRY_KEY] = incoming[HOOK_ENTRY_KEY]
await writeJsonFile(hooksFile, merged)
const afterMerge = await readJsonFile(hooksFile, {})
assert('hooks merge keeps user-hook', !!afterMerge['user-hook'])
assert('hooks merge adds search-boost', !!afterMerge[HOOK_ENTRY_KEY])
await rm(tempRoot, { recursive: true, force: true })

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
const agyPrompt = await loadAgentPrompt('antigravity')
assert('load antigravity inject mentions search_web', agyPrompt.includes('search_web'))

if (failed) {
  console.error(`\n${failed} test(s) failed`)
  process.exit(1)
}
console.log('\nAll install helper tests passed.')
