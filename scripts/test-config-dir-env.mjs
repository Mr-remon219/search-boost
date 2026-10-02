#!/usr/bin/env node
import './isolate-tests.mjs'
// P2-03 regression: install, status, print, uninstall, rules, skills and hooks
// must honor CODEX_HOME and CLAUDE_CONFIG_DIR, while the default locations and
// pre-existing user config keep working. Host visibility is modeled with
// fixture listings of the file each host reads (config.toml / .claude.json) —
// no installed host CLI is ever executed.
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { testRoot } from './isolate-tests.mjs'

const repo = fileURLToPath(new URL('..', import.meta.url))
const cli = join(repo, 'cli.mjs')

const read = (file) => (existsSync(file) ? readFileSync(file, 'utf8') : null)
const run = (args, env) => spawnSync(process.execPath, [cli, ...args], { env, cwd: testRoot, encoding: 'utf8', timeout: 120_000 })
const check = (label, ok, detail = '') => {
  assert.ok(ok, `${label}${detail ? ` — ${detail}` : ''}`)
  console.log(`ok: ${label}`)
}

/** Fixture host listing: user-scope MCP server names each host would report. */
function hostListing(env, home) {
  const codexConfig = join(env.CODEX_HOME ?? join(home, '.codex'), 'config.toml')
  const claudeConfig = env.CLAUDE_CONFIG_DIR ? join(env.CLAUDE_CONFIG_DIR, '.claude.json') : join(home, '.claude.json')
  const codexToml = read(codexConfig)
  const claudeJson = read(claudeConfig)
  return {
    codex: { config: codexConfig, servers: codexToml === null ? null : [...codexToml.matchAll(/^\s*\[mcp_servers\.([^\]]+)\]/gm)].map((match) => match[1]) },
    claude: { config: claudeConfig, servers: claudeJson === null ? null : Object.keys(JSON.parse(claudeJson).mcpServers ?? {}) },
  }
}

/**
 * One path flavor: install both hosts, verify the host-visible listing, status,
 * printed config path and injected rules/skills/hooks land in the right root,
 * then uninstall and confirm the same fixtures no longer list search-boost.
 */
function scenario({ name, codexHome, claudeConfigDir }) {
  const home = join(testRoot, 'config-dir-env', name, 'home')
  mkdirSync(home, { recursive: true })
  const env = { ...process.env, HOME: home, USERPROFILE: home }
  if (codexHome) env.CODEX_HOME = codexHome
  if (claudeConfigDir) env.CLAUDE_CONFIG_DIR = claudeConfigDir

  // User-owned config at the default locations, plus the user's own MCP server.
  mkdirSync(join(home, '.codex'), { recursive: true })
  writeFileSync(join(home, '.codex', 'config.toml'), '[mcp_servers.user-server]\ncommand = "node"\n')
  writeFileSync(join(home, '.claude.json'), `${JSON.stringify({ mcpServers: { 'user-server': { command: 'node' } }, theme: 'dark' }, null, 2)}\n`)

  // A stale search-boost entry at the default path must stay unconfigured while
  // an override is active: status has to read the same root the host reads.
  if (codexHome || claudeConfigDir) {
    if (codexHome) writeFileSync(join(home, '.codex', 'config.toml'), '[mcp_servers.user-server]\ncommand = "node"\n\n[mcp_servers.search-boost]\ncommand = "node"\n')
    if (claudeConfigDir) writeFileSync(join(home, '.claude.json'), `${JSON.stringify({ mcpServers: { 'user-server': { command: 'node' }, 'search-boost': { command: 'node' } }, theme: 'dark' }, null, 2)}\n`)
    const stale = run(['agents'], env)
    const staleRow = (id) => (stale.stdout ?? '').split('\n').find((line) => line.startsWith(`${id}\t`)) ?? ''
    if (codexHome) check(`${name}: codex status ignores a stale default config`, !staleRow('codex').includes('configured'), staleRow('codex'))
    if (claudeConfigDir) check(`${name}: claude status ignores a stale default config`, !staleRow('claude').includes('configured'), staleRow('claude'))
  }
  const defaultCodex = read(join(home, '.codex', 'config.toml'))
  const defaultClaude = read(join(home, '.claude.json'))

  const install = run(['install', '-t', 'codex,claude', '-y'], env)
  assert.equal(install.status, 0, `${name}: install — ${install.stderr?.slice(-500)}`)
  const listing = hostListing(env, home)
  check(`${name}: codex host listing sees search-boost`, listing.codex.servers?.includes('search-boost'),
    `servers=${JSON.stringify(listing.codex.servers)} config=${listing.codex.config}`)
  check(`${name}: claude host listing sees search-boost`, listing.claude.servers?.includes('search-boost'),
    `servers=${JSON.stringify(listing.claude.servers)} config=${listing.claude.config}`)

  const codexRoot = env.CODEX_HOME ?? join(home, '.codex')
  const claudeRoot = env.CLAUDE_CONFIG_DIR ?? join(home, '.claude')
  for (const [label, file] of [
    ['codex rules', join(codexRoot, 'AGENTS.md')],
    ['codex user skill', join(home, '.agents', 'skills', 'search-boost', 'SKILL.md')],
    ['codex user skill metadata', join(home, '.agents', 'skills', 'search-boost', 'agents', 'openai.yaml')],
    ['codex hooks', join(codexRoot, 'hooks.json')],
    ['codex hook script', join(codexRoot, 'hooks', 'search-boost-session.mjs')],
    ['claude rules', join(claudeRoot, 'CLAUDE.md')],
    ['claude hook config', join(claudeRoot, 'settings.json')],
    ['claude hook script', join(claudeRoot, 'hooks', 'search-boost-session.mjs')],
    ['claude skill', join(claudeRoot, 'skills', 'search-boost', 'SKILL.md')],
  ]) check(`${name}: ${label} in the host root`, existsSync(file), file)

  const agents = run(['agents'], env)
  const row = (id) => (agents.stdout ?? '').split('\n').find((line) => line.startsWith(`${id}\t`)) ?? ''
  check(`${name}: status reports codex configured`, row('codex').includes('configured'), row('codex'))
  check(`${name}: status reports claude configured`, row('claude').includes('configured'), row('claude'))

  const printCodex = run(['print', 'codex'], env)
  const printClaude = run(['print', 'claude'], env)
  check(`${name}: print codex names the host config path`, (printCodex.stdout ?? '').includes(listing.codex.config), (printCodex.stdout ?? '').split('\n')[0])
  check(`${name}: print claude names the host config path`, (printClaude.stdout ?? '').includes(listing.claude.config), (printClaude.stdout ?? '').split('\n')[0])

  // A host-root override must not move the other host or rewrite its config.
  if (codexHome) check(`${name}: codex default user config untouched`, read(join(home, '.codex', 'config.toml')) === defaultCodex)
  else check(`${name}: codex default config keeps the user server`, (read(join(home, '.codex', 'config.toml')) ?? '').includes('user-server'))
  if (claudeConfigDir) check(`${name}: claude default user config untouched`, read(join(home, '.claude.json')) === defaultClaude)
  else {
    const claude = JSON.parse(read(join(home, '.claude.json')))
    check(`${name}: claude default config keeps user entries`, Boolean(claude.mcpServers?.['user-server']) && claude.theme === 'dark')
  }

  const uninstall = run(['uninstall', '-t', 'codex,claude', '-y'], env)
  assert.equal(uninstall.status, 0, `${name}: uninstall — ${uninstall.stderr?.slice(-500)}`)
  const cleared = hostListing(env, home)
  check(`${name}: codex listing cleared`, !cleared.codex.servers?.includes('search-boost'), JSON.stringify(cleared.codex.servers))
  check(`${name}: claude listing cleared`, !cleared.claude.servers?.includes('search-boost'), JSON.stringify(cleared.claude.servers))
  check(`${name}: codex rules removed`, !existsSync(join(codexRoot, 'AGENTS.md')))
  check(`${name}: codex user skill removed`, !existsSync(join(home, '.agents', 'skills', 'search-boost', 'SKILL.md')))
  check(`${name}: claude skill removed`, !existsSync(join(claudeRoot, 'skills', 'search-boost', 'SKILL.md')))
  if (codexHome) {
    check(`${name}: codex default user config still untouched`, read(join(home, '.codex', 'config.toml')) === defaultCodex)
  } else check(`${name}: codex default config keeps the user server after uninstall`, (read(join(home, '.codex', 'config.toml')) ?? '').includes('user-server'))
  if (claudeConfigDir) check(`${name}: claude default user config still untouched`, read(join(home, '.claude.json')) === defaultClaude)
  else {
    const claude = JSON.parse(read(join(home, '.claude.json')))
    check(`${name}: claude default config keeps user entries after uninstall`, Boolean(claude.mcpServers?.['user-server']) && claude.theme === 'dark')
  }
  rmSync(join(testRoot, 'config-dir-env', name), { recursive: true, force: true })
}

const base = join(testRoot, 'config-dir-env')
scenario({ name: 'default' })
scenario({ name: 'custom', codexHome: join(base, 'custom', 'codex-state'), claudeConfigDir: join(base, 'custom', 'claude-state') })
scenario({ name: 'space', codexHome: join(base, 'space', 'codex state'), claudeConfigDir: join(base, 'space', 'claude state') })
scenario({ name: 'chinese', codexHome: join(base, 'chinese', '配置目录'), claudeConfigDir: join(base, 'chinese', '中文 配置') })
scenario({ name: 'codex-only', codexHome: join(base, 'codex-only', 'codex-state') })
scenario({ name: 'claude-only', claudeConfigDir: join(base, 'claude-only', 'claude-state') })

console.log('ok: CODEX_HOME/CLAUDE_CONFIG_DIR are honored across install, status, print, uninstall, rules, skills and hooks')
