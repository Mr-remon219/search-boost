/**
 * Codex uninstall restore integration tests — run via subprocess with HOME set
 * before module load (PATHS is resolved at import time).
 *
 * Usage: HOME=/tmp/xxx node scripts/test-codex-uninstall-integration.mjs <scenario>
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { AGENTS } from '../lib/agents/index.mjs'
import { writeCodexConfigOrUnlink } from '../lib/codex-toml.mjs'

const scenario = process.argv[2]
const home = process.env.HOME

if (!scenario || !home) {
  console.error('Usage: HOME=/tmp/xxx node scripts/test-codex-uninstall-integration.mjs <scenario>')
  process.exit(2)
}

let failed = 0

function assert(name, cond) {
  if (!cond) {
    console.error(`FAIL: ${name}`)
    failed++
  } else {
    console.log(`ok: ${name}`)
  }
}

const codexDir = join(home, '.codex')
const configPath = join(codexDir, 'config.toml')
const agentsPath = join(codexDir, 'AGENTS.md')

if (scenario === 'round-trip') {
  mkdirSync(codexDir, { recursive: true })
  const baseline = 'model = "gpt-test"\nweb_search = "cached"\n'
  writeFileSync(configPath, baseline, 'utf8')
  await AGENTS.codex.install({ dryRun: false, autoAllow: false, replaceNative: false })
  await AGENTS.codex.uninstall({ dryRun: false })
  assert('codex round-trip baseline config.toml', readFileSync(configPath, 'utf8') === baseline)
  assert('codex uninstall removes AGENTS.md when empty', !existsSync(agentsPath))
} else if (scenario === 'keep-native') {
  mkdirSync(codexDir, { recursive: true })
  const baseline = 'model = "gpt-test"\nweb_search = "cached"\n'
  writeFileSync(configPath, baseline, 'utf8')
  await AGENTS.codex.install({ dryRun: false, autoAllow: false, replaceNative: true })
  assert(
    'codex install replace-native adds marker',
    readFileSync(configPath, 'utf8').includes('SEARCH_BOOST_WEB_SEARCH_START'),
  )
  await AGENTS.codex.uninstall({ dryRun: false })
  const after = readFileSync(configPath, 'utf8')
  assert('codex keep-native round-trip preserves web_search', after === baseline)
  assert('codex uninstall removes web_search marker', !after.includes('SEARCH_BOOST_WEB_SEARCH_START'))
} else if (scenario === 'mcp-migration') {
  mkdirSync(codexDir, { recursive: true })
  writeFileSync(
    configPath,
    [
      'web_search = "cached"',
      '',
      '[mcp_servers.search-boost]',
      'command = "node"',
      '# SEARCH_BOOST_WEB_SEARCH_START',
      'web_search = "disabled"',
      '# SEARCH_BOOST_WEB_SEARCH_END',
      'args = ["serve"]',
    ].join('\n') + '\n',
    'utf8',
  )
  await AGENTS.codex.install({ dryRun: false, autoAllow: false, replaceNative: false })
  const afterInstall = readFileSync(configPath, 'utf8')
  assert('codex install keeps top-level web_search', afterInstall.includes('web_search = "cached"'))
  assert(
    'codex install strips marked web_search from MCP section',
    !/\[mcp_servers\.search-boost\][\s\S]*SEARCH_BOOST_WEB_SEARCH_START/.test(afterInstall),
  )
  await AGENTS.codex.uninstall({ dryRun: false })
} else if (scenario === 'foreign-skill') {
  const skillDir = join(home, '.agents', 'skills', 'search-boost')
  mkdirSync(skillDir, { recursive: true })
  const skillPath = join(skillDir, 'SKILL.md')
  const foreignSkill = '# Custom skill\nKeep this content.\n'
  writeFileSync(skillPath, foreignSkill, 'utf8')
  mkdirSync(codexDir, { recursive: true })
  writeFileSync(configPath, '[mcp_servers.search-boost]\ncommand = "node"\n', 'utf8')
  await AGENTS.codex.uninstall({ dryRun: false })
  assert('codex uninstall preserves foreign skill', readFileSync(skillPath, 'utf8') === foreignSkill)
} else if (scenario === 'empty-config') {
  mkdirSync(codexDir, { recursive: true })
  writeFileSync(configPath, '[mcp_servers.search-boost]\ncommand = "node"\n', 'utf8')
  await AGENTS.codex.uninstall({ dryRun: false })
  assert('codex uninstall unlinks empty config.toml', !existsSync(configPath))
} else if (scenario === 'write-unlink') {
  mkdirSync(codexDir, { recursive: true })
  writeFileSync(configPath, 'model = "x"\n', 'utf8')
  await writeCodexConfigOrUnlink(configPath, '   \n  ')
  assert('writeCodexConfigOrUnlink removes whitespace-only file', !existsSync(configPath))
} else {
  console.error(`Unknown scenario: ${scenario}`)
  process.exit(2)
}

process.exit(failed ? 1 : 0)
