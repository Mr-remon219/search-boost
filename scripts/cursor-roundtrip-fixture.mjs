/**
 * Cursor install/uninstall round-trip fixture — run with isolated HOME:
 *   node scripts/cursor-roundtrip-fixture.mjs <homeDir> <nodeExe> <repoRoot>
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const home = process.argv[2]
const node = process.argv[3]
const repo = process.argv[4]
if (!home || !node || !repo) {
  console.error('usage: cursor-roundtrip-fixture.mjs <homeDir> <nodeExe> <repoRoot>')
  process.exit(2)
}

process.env.HOME = home
process.env.USERPROFILE = home
process.env.SEARCH_BOOST_CURSOR_INSTALL_STATE = join(home, '.search-boost', 'state', 'cursor-install.json')

const { installCursorSurface, uninstallCursorSurface } = await import(pathToFileURL(join(repo, 'lib/agents/cursor-family.mjs')).href)
const { agentConfigured, CURSOR_SURFACE: surface } = await import(pathToFileURL(join(repo, 'lib/paths.mjs')).href)
const { CURSOR_CLI_MCP_ALLOW } = await import(pathToFileURL(join(repo, 'lib/cli-config.mjs')).href)

const out = {}
mkdirSync(join(home, '.cursor', 'hooks'), { recursive: true })
const foreignHook = { command: `${node} "${join(home, '.cursor', 'hooks', 'foreign-hook.mjs')}"`, timeout: 5 }
writeFileSync(surface.hooks, `${JSON.stringify({ version: 1, hooks: { sessionStart: [foreignHook] } })}\n`, 'utf8')

await installCursorSurface({ dryRun: false, autoAllow: true, skillAgentId: 'cursor' })
out.configuredAfterInstall = agentConfigured('cursor')
const hooksMid = JSON.parse(readFileSync(surface.hooks, 'utf8'))
out.foreignHookAfterInstall = hooksMid.hooks.sessionStart.some((e) => e.command === foreignHook.command)
out.autoAllowWritten = JSON.parse(readFileSync(surface.cliConfig, 'utf8')).permissions.allow.includes(CURSOR_CLI_MCP_ALLOW)

await uninstallCursorSurface({ dryRun: false })
out.unconfiguredAfterUninstall = !agentConfigured('cursor')
out.skillRemoved = !existsSync(surface.skill)
out.skillParentRemoved = !existsSync(join(home, '.cursor', 'skills', 'search-boost'))
out.hookScriptRemoved = !existsSync(surface.hookScript)
out.mcpPruned = !existsSync(surface.mcp)
out.cliConfigPruned = !existsSync(surface.cliConfig)
const hooksEnd = existsSync(surface.hooks) ? JSON.parse(readFileSync(surface.hooks, 'utf8')) : null
out.foreignHookAfterUninstall = hooksEnd?.hooks?.sessionStart?.some((e) => e.command === foreignHook.command)

writeFileSync(surface.cliConfig, `${JSON.stringify({ permissions: { allow: ['Shell(git)'] } })}\n`, 'utf8')
await installCursorSurface({ dryRun: false, autoAllow: false, skillAgentId: 'cursor' })
out.noAutoAllowOnInstall = !JSON.parse(readFileSync(surface.cliConfig, 'utf8')).permissions.allow.includes(CURSOR_CLI_MCP_ALLOW)
await uninstallCursorSurface({ dryRun: false })
const stillNoAllow = existsSync(surface.cliConfig) ? JSON.parse(readFileSync(surface.cliConfig, 'utf8')) : { permissions: { allow: [] } }
out.noAutoAllowOnUninstall = !stillNoAllow.permissions?.allow?.includes(CURSOR_CLI_MCP_ALLOW)

await installCursorSurface({ dryRun: false, autoAllow: true, skillAgentId: 'cursor' })
out.withAutoAllowOnInstall = JSON.parse(readFileSync(surface.cliConfig, 'utf8')).permissions.allow.includes(CURSOR_CLI_MCP_ALLOW)
await uninstallCursorSurface({ dryRun: false })
out.withAutoAllowOnUninstall = !existsSync(surface.cliConfig)
  || !JSON.parse(readFileSync(surface.cliConfig, 'utf8')).permissions?.allow?.includes(CURSOR_CLI_MCP_ALLOW)

writeFileSync(
  surface.cliConfig,
  `${JSON.stringify({ permissions: { allow: [CURSOR_CLI_MCP_ALLOW, 'Shell(git)'] } })}\n`,
  'utf8',
)
await installCursorSurface({ dryRun: false, autoAllow: true, skillAgentId: 'cursor' })
await uninstallCursorSurface({ dryRun: false })
const preExistingEnd = JSON.parse(readFileSync(surface.cliConfig, 'utf8'))
out.preExistingAllowPreserved = preExistingEnd.permissions.allow.includes(CURSOR_CLI_MCP_ALLOW)
out.preExistingForeignPreserved = preExistingEnd.permissions.allow.includes('Shell(git)')

console.log(JSON.stringify(out))
