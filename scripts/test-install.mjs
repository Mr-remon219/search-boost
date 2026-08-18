/**
 * Unit-style checks for install helpers (no writes to real home dir).
 */
import { upsertTomlSection, removeTomlSection, hasTomlSection } from '../lib/toml.mjs'
import {
  injectBlock,
  injectGeminiBlock,
  injectTomlSection,
  MARKER_END,
  MARKER_START,
  removeBlock,
  removeGeminiBlock,
  removeMarked,
  removeTomlSection as removeMarkedToml,
} from '../lib/inject.mjs'
import { normalizeTargets, parseTargetSpec, AGENTS } from '../lib/agents/index.mjs'
import { parseFlags } from '../lib/cli/args.mjs'
import { stripAllowList, upsertAllowList } from '../lib/json-config.mjs'
import {
  applyClaudeNativeSettings,
  applyCodexNativeToml,
  autoAllowAgentIds,
  CLAUDE_WEB_SEARCH_DENY,
  claudeNativeReplaced,
  codexNativeReplaced,
  replaceableNativeIds,
} from '../lib/native-search.mjs'
import { installCursorSurface } from '../lib/agents/cursor-family.mjs'
import {
  antigravityMcpEntry,
  antigravityPermissions,
  claudePermissions,
  grokPermissionAllows,
  formatPrintConfig,
  grokPermissionTomlBlock,
  jsonMcpEntry,
  pluginMcpEntry,
  resolveMcpLaunch,
  tomlMcpBlock,
} from '../lib/mcp-entry.mjs'
import {
  buildSkillHeader,
  HOOK_ENTRY_KEY,
  injectAntigravityRule,
  injectSkill,
  installAntigravityHook,
  loadAgentPrompt,
  loadAgentSkill,
} from '../lib/agents/shared.mjs'
import {
  geminiSnippetPath,
  getRoute,
  hooksConfigPath,
  hookScriptPath,
  mcpServerInstructionsPath,
  promptPath,
  ROUTE_IDS,
  rulePath,
  SHARED_SERVER_INSTRUCTIONS,
  skillPath,
} from '../agents/router.mjs'
import { agentConfigured, grokConfigCandidates, grokInstallPaths, workspaceAgents } from '../lib/paths.mjs'
import { readJsonFile, writeJsonFile } from '../lib/json-config.mjs'
import { maskKey, readKeysFile, readKeysFromCandidates, writeKeysFile } from '../lib/keys.mjs'
import { readFirstExistingJson } from '../lib/config-paths.mjs'
import {
  forgetAntigravityWorkspace,
  listAntigravityWorkspaces,
  recordAntigravityWorkspace,
} from '../lib/workspace-marker.mjs'
import { getLayer, setLayer } from '../lib/layer-config.mjs'
import { formatKeyStatusLines } from '../lib/installer/keys-wizard.mjs'
import { layerApiNoKeysWarning } from '../lib/installer/status.mjs'
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
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

// idempotent upsert + clean remove (Codex/Grok config.toml)
toml = 'model = "test"\n'
toml = upsertTomlSection(toml, 'search-boost', 'command = "node"\nargs = ["serve"]')
toml = upsertTomlSection(toml, 'search-boost', 'command = "node"\nargs = ["serve", "v2"]')
assert('toml upsert idempotent body', (toml.match(/^command =/gm) || []).length === 1 && toml.includes('"serve", "v2"'))
toml = removeTomlSection(toml, 'search-boost')
assert('toml remove leaves unrelated keys', toml.includes('model = "test"') && !toml.includes('command ='))

// web_search marker round-trip
toml = injectTomlSection(toml, 'WEB_SEARCH', 'web_search = "disabled"')
assert('web_search marker present', toml.includes('SEARCH_BOOST_WEB_SEARCH_START'))
assert('web_search marker value', toml.includes('web_search = "disabled"'))
toml = removeMarkedToml(toml, 'WEB_SEARCH')
assert('web_search marker removed', !toml.includes('SEARCH_BOOST_WEB_SEARCH_START'))

// MCP toml block: auto approval only when opted in
assert('toml mcp approval opt-in', tomlMcpBlock({ approvalAuto: true }).includes('default_tools_approval_mode = "auto"'))
assert('toml mcp approval default off', !tomlMcpBlock().includes('default_tools_approval_mode'))
assert('toml mcp no baked layer env', !tomlMcpBlock().includes('SEARCH_BOOST_LAYER'))

// native-search capability table + pure apply
assert('auto-allow ids include cursor', autoAllowAgentIds().includes('cursor') && autoAllowAgentIds().includes('claude'))
assert('replaceable native is codex+claude', replaceableNativeIds().join() === 'codex,claude')
assert('grok native is leave', replaceableNativeIds(['grok', 'cursor']).length === 0)
let nativeToml = 'model = "x"\n'
nativeToml = applyCodexNativeToml(nativeToml, true)
assert('codex native apply marker', codexNativeReplaced(nativeToml) && nativeToml.includes('web_search = "disabled"'))
nativeToml = applyCodexNativeToml(nativeToml, false)
assert('codex native revert', !codexNativeReplaced(nativeToml) && nativeToml.includes('model = "x"'))
const claudeOn = applyClaudeNativeSettings({ permissions: { allow: ['mcp__search-boost__*'] } }, true)
assert('claude native deny', claudeNativeReplaced(claudeOn) && claudeOn.permissions.allow.includes('mcp__search-boost__*'))
const claudeOff = applyClaudeNativeSettings(claudeOn, false)
assert('claude native revert keeps allow', !claudeNativeReplaced(claudeOff) && claudeOff.permissions.allow.includes('mcp__search-boost__*'))
assert('claude deny constant', CLAUDE_WEB_SEARCH_DENY === 'WebSearch')

const printed = formatPrintConfig('codex', '/tmp/config.toml')
assert('print-config no approval by default', !printed.includes('default_tools_approval_mode'))
assert('print-config includes web_search by default', printed.includes('web_search = "disabled"'))
const printedKeep = formatPrintConfig('codex', '/tmp/config.toml', { replaceNative: false, autoAllow: true })
assert('print-config keep-native omits web_search', !printedKeep.includes('web_search = "disabled"'))
assert('print-config auto-allow opt-in', printedKeep.includes('default_tools_approval_mode = "auto"'))

// inject block round-trip
const snippet = '## search-boost rules'
let md = injectBlock('', snippet)
assert('inject empty', md.includes('SEARCH_BOOST_START'))
md = injectBlock(md, snippet + '\nupdated')
assert('inject replace', md.includes('updated'))
md = removeBlock(md)
assert('remove block', !md.includes('SEARCH_BOOST_START'))
const broken = `${MARKER_START}\nbody\n<!-- user edited away end -->`
assert('removeMarked keeps file when end missing', removeMarked(broken, MARKER_START, MARKER_END) === broken)

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

let unknownTarget = false
try {
  parseTargetSpec('cursor,nope')
} catch (err) {
  unknownTarget = err instanceof Error && err.message.includes('Unknown agent')
}
assert('parseTargetSpec rejects unknown', unknownTarget)
assert('parseTargetSpec all', parseTargetSpec('all').includes('grok'))

const flags = parseFlags(['-t', 'codex', '--keep-native', '--scope', 'project'])
assert('parseFlags keep-native', flags.replaceNative === false && flags.target === 'codex' && flags.scope === 'project')
let badFlag = false
try {
  parseFlags(['--bogus'])
} catch (err) {
  badFlag = err instanceof Error && err.message.includes('Unknown flag')
}
assert('parseFlags rejects unknown', badFlag)
let missingVal = false
try {
  parseFlags(['--scope'])
} catch (err) {
  missingVal = err instanceof Error && err.message.includes('requires a value')
}
assert('parseFlags requires values', missingVal)

const mergedAllow = upsertAllowList(['Shell(git)', 'mcp__search-boost__old'], ['mcp__search-boost__*'], (p) => p.startsWith('mcp__search-boost__'))
assert('upsertAllowList replaces ours', mergedAllow.includes('Shell(git)') && mergedAllow.includes('mcp__search-boost__*') && !mergedAllow.includes('mcp__search-boost__old'))
assert('stripAllowList', stripAllowList(mergedAllow, (p) => p.startsWith('mcp__search-boost__')).join() === 'Shell(git)')

// cursor cli-config allow is opt-in like every other agent's auto-allow surface
const cursorPlain = await installCursorSurface({ dryRun: true, skillAgentId: 'cursor' })
assert('cursor skips cli-config without auto-allow', !cursorPlain.some((f) => f.endsWith('cli-config.json')))
const cursorAllowed = await installCursorSurface({ dryRun: true, autoAllow: true, skillAgentId: 'cursor' })
assert('cursor writes cli-config with auto-allow', cursorAllowed.some((f) => f.endsWith('cli-config.json')))

// MCP entry shapes
const json = jsonMcpEntry()
assert('json entry has type stdio', json.type === 'stdio' && json.command && json.args?.length)
const launch = resolveMcpLaunch()
assert('mcp launch uses node cli before npx', launch.command !== 'npx' && launch.args.some((a) => a.endsWith('cli.mjs')))
const plugin = pluginMcpEntry()
assert('plugin mcp entry is npx', plugin.command === 'npx' && plugin.args?.includes('-y') && plugin.args?.includes('search-boost-mcp'))
assert('plugin mcp entry no abs paths', !/[A-Za-z]:[/\\]/.test(JSON.stringify(plugin)))
const agy = antigravityMcpEntry()
assert('antigravity omits type', !('type' in agy) && agy.command && agy.args?.length)

// antigravity permissions
const agyPerms = antigravityPermissions()
assert('antigravity permissions wildcard', agyPerms.includes('mcp(search-boost/*)'))
assert('antigravity permissions fused_search', agyPerms.includes('mcp(search-boost/fused_search)'))

// workspace paths
const ws = workspaceAgents('/tmp/myproject')
assert('workspace mcp path', ws.mcp.endsWith('.agents/mcp_config.json') || ws.mcp.includes('.agents\\mcp_config.json'))
assert('workspace rule path', ws.rule.includes('search-boost.md'))

// antigravity route assets
const agyRoute = getRoute('antigravity')
assert('antigravity has rule template', agyRoute.rule === 'rule.md' && rulePath('antigravity').includes('rule.md'))
assert('antigravity has gemini snippet', agyRoute.geminiSnippet && geminiSnippetPath('antigravity'))
assert('antigravity has hooks', agyRoute.hooks && hooksConfigPath('antigravity'))
assert('antigravity skill description', (agyRoute.skillFrontmatter?.description ?? '').length > 20)

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

// empty primary must not fall back to legacy keys
const emptyPrimaryHome = mkdtempSync(join(tmpdir(), 'sb-empty-primary-'))
writeFileSync(join(emptyPrimaryHome, '.search-boost-keys.json'), '{}\n', 'utf8')
writeFileSync(
  join(emptyPrimaryHome, '.dsh-search-boost-keys.json'),
  `${JSON.stringify({ tavily: 'legacy-should-not-load' })}\n`,
  'utf8',
)
const clearedPrimary = readKeysFile({ homeDir: emptyPrimaryHome })
assert('empty primary blocks legacy keys', !clearedPrimary.tavily)
rmSync(emptyPrimaryHome, { recursive: true, force: true })

// legacy config path fallback (primary missing, legacy file present)
const legacyDir = mkdtempSync(join(tmpdir(), 'sb-legacy-keys-'))
const primaryKeysPath = join(legacyDir, '.search-boost-keys.json')
const legacyKeysPath = join(legacyDir, '.dsh-search-boost-keys.json')
writeFileSync(legacyKeysPath, `${JSON.stringify({ tavily: 'legacy-key-from-dsh-path' })}\n`, 'utf8')
const legacyRead = readKeysFromCandidates([primaryKeysPath, legacyKeysPath])
assert('legacy keys path fallback', legacyRead.tavily === 'legacy-key-from-dsh-path')
const jsonFallback = readFirstExistingJson([primaryKeysPath, legacyKeysPath], {})
assert('readFirstExistingJson legacy', jsonFallback.tavily === 'legacy-key-from-dsh-path')
rmSync(legacyDir, { recursive: true, force: true })

// layer config legacy fallback
const legacyLayerDir = mkdtempSync(join(tmpdir(), 'sb-legacy-layer-'))
const primaryLayerPath = join(legacyLayerDir, '.search-boost-layer.json')
const legacyLayerPath = join(legacyLayerDir, '.dsh-search-boost-layer.json')
writeFileSync(legacyLayerPath, `${JSON.stringify({ layer: 'free' })}\n`, 'utf8')
process.env.SEARCH_BOOST_LAYER_FILE = primaryLayerPath
// Simulate layer read: primary missing → should not find via env-only path; test candidates directly
const layerParsed = readFirstExistingJson([primaryLayerPath, legacyLayerPath], {})
assert('legacy layer path readable', layerParsed.layer === 'free')
rmSync(legacyLayerDir, { recursive: true, force: true })
process.env.SEARCH_BOOST_LAYER_FILE = join(tmpdir(), `search-boost-test-layer-${process.pid}.json`)

// layer
setLayer('free')
assert('layer free', getLayer() === 'free')
setLayer('api')
assert('layer api', getLayer() === 'api')
process.env.SEARCH_BOOST_LAYER = 'free'
assert('layer file beats env', getLayer() === 'api')
delete process.env.SEARCH_BOOST_LAYER

// status helpers
setLayer('api')
writeKeysFile({ tavily: undefined, brave: undefined, exa: undefined })
delete process.env.TAVILY_API_KEY
delete process.env.BRAVE_API_KEY
delete process.env.EXA_API_KEY
assert('layer api no keys warning', layerApiNoKeysWarning()?.includes('no API keys configured'))
setLayer('free')
assert('layer free no warning', layerApiNoKeysWarning() === null)
writeKeysFile({ tavily: 'tvly-test-key-12345678' })
setLayer('api')
assert('layer api with keys no warning', layerApiNoKeysWarning() === null)
writeKeysFile({ tavily: undefined })
const keyLines = formatKeyStatusLines()
assert('formatKeyStatusLines has keys header', keyLines[0].includes('API keys'))
assert('formatKeyStatusLines has file path', keyLines.some((l) => l.startsWith('File:')))

// router resolves per-agent assets
for (const id of ROUTE_IDS) {
  assert(`route ${id} prompt exists`, promptPath(id).includes(getRoute(id).dir))
}
const cursorPrompt = await loadAgentPrompt('cursor')
assert(
  'load cursor inject',
  cursorPrompt.includes('search-boost @ Cursor IDE') && cursorPrompt.includes('when you choose'),
)
assert('codex route has skill', getRoute('codex').skill === 'skill.md')
assert('codex route has openai yaml', getRoute('codex').openaiYaml === 'openai.yaml')
const codexPrompt = await loadAgentPrompt('codex')
assert('load codex inject', codexPrompt.includes('search-boost @ Codex CLI'))
const codexSkill = await loadAgentSkill('codex')
assert('load codex skill', codexSkill?.includes('mcp__search-boost__fused_search'))

// claude permissions wildcard
const perms = claudePermissions()
assert('claude permissions wildcard', perms.length === 1 && perms[0] === 'mcp__search-boost__*')

// shared MCP server instructions
assert('mcp instructions path is shared', mcpServerInstructionsPath() === SHARED_SERVER_INSTRUCTIONS)

// claude skill frontmatter
const claudeHeader = buildSkillHeader('claude')
assert('claude skill has description', claudeHeader.includes('description: Multi-engine web search'))
assert('claude skill has allowed-tools', claudeHeader.includes('allowed-tools: mcp__search-boost__fused_search'))
assert('claude skill no agent field', !claudeHeader.includes('agent: claude'))

// other agents: name only, no agent field
const cursorHeader = buildSkillHeader('cursor')
assert('cursor skill name only', cursorHeader.includes('name: search-boost') && !cursorHeader.includes('agent:'))

// grok: prompt, permissions, project scope
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

const grokSkillPath = skillPath('grok')
assert('grok skill path', !!grokSkillPath)
assert('grok skill frontmatter', readFileSync(grokSkillPath, 'utf8').trimStart().startsWith('---'))

const projectPaths = grokInstallPaths('project')
assert('grok project config path', projectPaths.config.includes('.grok'))
assert('grok project rule path', projectPaths.rule.includes('.grok') && projectPaths.rule.includes('rules'))
assert('grok project skill path', projectPaths.skill.includes('.grok') && projectPaths.skill.includes('skills'))

const candidates = grokConfigCandidates()
assert('grok config candidates user+project', candidates.length === 2 && candidates.every((p) => p.endsWith('config.toml')))

const grokDir = mkdtempSync(join(tmpdir(), 'sb-grok-'))
mkdirSync(join(grokDir, '.grok'), { recursive: true })
writeFileSync(join(grokDir, '.grok', 'config.toml'), '[mcp_servers.search-boost]\ncommand = "npx"\n')
const origCwd = process.cwd()
process.chdir(grokDir)
assert('grok configured project scope', agentConfigured('grok') === true)
process.chdir(origCwd)
rmSync(grokDir, { recursive: true, force: true })

// shared instructions cover per-agent routing notes
assert('mcp instructions mention grok', readFileSync(mcpServerInstructionsPath(), 'utf8').includes('Grok Build'))

const agyPrompt = await loadAgentPrompt('antigravity')
assert('load antigravity inject mentions search_web', agyPrompt.includes('search_web'))

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

// antigravity workspace marker round-trip
process.env.SEARCH_BOOST_WORKSPACES_FILE = join(tmpdir(), `search-boost-workspaces-${process.pid}.json`)
await recordAntigravityWorkspace('/tmp/project-a', false)
await recordAntigravityWorkspace('/tmp/project-b', false)
assert('workspace marker records', (await listAntigravityWorkspaces()).length === 2)
await forgetAntigravityWorkspace('/tmp/project-a', false)
assert('workspace marker forgets', (await listAntigravityWorkspaces()).length === 1)
delete process.env.SEARCH_BOOST_WORKSPACES_FILE

// antigravity workspace hook enables on install
const agyHookDir = mkdtempSync(join(tmpdir(), 'sb-agy-hook-'))
await installAntigravityHook(agyHookDir, false)
const agyHooks = JSON.parse(readFileSync(join(agyHookDir, '.agents', 'hooks.json'), 'utf8'))
assert('antigravity hook enabled on install', agyHooks[HOOK_ENTRY_KEY]?.enabled === true)
rmSync(agyHookDir, { recursive: true, force: true })

// agent install adapters (dry-run — catches missing imports on codex/claude paths)
await AGENTS.codex.install({ dryRun: true, autoAllow: false, replaceNative: true })
await AGENTS.claude.install({ dryRun: true, autoAllow: false, replaceNative: true })
assert('codex install dry-run', true)
assert('claude install dry-run', true)

if (failed) {
  console.error(`\n${failed} test(s) failed`)
  process.exit(1)
}
console.log('\nAll install helper tests passed.')
