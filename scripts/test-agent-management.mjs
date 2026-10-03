#!/usr/bin/env node
import './isolate-tests.mjs'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { PKG_ROOT } from '../lib/pkg.mjs'
import { join } from 'node:path'
const old = spawnSync(process.execPath, [join(PKG_ROOT, 'cli.mjs'), 'upgrade', '--help'], { encoding: 'utf8', env: process.env })
assert.notEqual(old.status, 0, 'removed self-update command must not remain callable')
const help = spawnSync(process.execPath, [join(PKG_ROOT, 'cli.mjs'), '--help'], { encoding: 'utf8', env: process.env })
assert.equal(help.status, 0)
assert.match(help.stdout, /search-boost refresh/)
assert.doesNotMatch(help.stdout, /search-boost upgrade/)
console.log('ok: CLI removes software self-update and exposes current-version integration refresh')

// HOME as a recorded project must not duplicate the user-level Grok resources.
const { mkdirSync, writeFileSync } = await import('node:fs')
const { dirname } = await import('node:path')
const { PATHS } = await import('../lib/paths.mjs')
const { discoverIntegrations, integrationTargetKey } = await import('../lib/upgrade/integrations.mjs')
mkdirSync(dirname(PATHS.grok.config), { recursive: true })
writeFileSync(PATHS.grok.config, '[mcp_servers.search-boost]\ncommand="old"\nargs=[]\n')
const previous = process.cwd()
try {
 process.chdir(process.env.HOME)
 const plan = await discoverIntegrations()
 assert.equal(plan.targets.filter(t => t.id === 'grok').length, 1, 'same HOME resources are refreshed once')
 assert.equal(new Set(plan.targets.map(integrationTargetKey)).size, plan.targets.length)
} finally { process.chdir(previous) }
const { parseUpgradeArgs } = await import('../lib/upgrade/cli.mjs')
assert.throws(() => parseUpgradeArgs(['--sync-only']), /was removed/)
assert.equal(parseUpgradeArgs(['--repair-grok-cache']).options.repairGrokCache, true)
assert.throws(() => parseUpgradeArgs(['--repair-grok-cache'], { allowSyncOnly: false, command: 'migrate' }), /Unknown/)
assert.equal(parseUpgradeArgs(['--verbose']).options.verbose, true)
assert.throws(() => parseUpgradeArgs(['--verbose'], { allowSyncOnly: false, command: 'migrate' }), /Unknown/)
const unsupportedVerbose = spawnSync(process.execPath, [join(PKG_ROOT, 'cli.mjs'), 'migrate', '--verbose'], { encoding: 'utf8', env: process.env })
assert.notEqual(unsupportedVerbose.status, 0, 'migrate must reject unsupported flags before prompting or migration effects')
assert.match(unsupportedVerbose.stderr, /Unknown .*migrate argument: --verbose/)
// A blocked unselected host is disclosed but must not fail a selected healthy
// scope. Missing selected targets still fail closed, and a full refresh still fails.
const { runRefresh } = await import('../lib/upgrade/index.mjs')
mkdirSync(dirname(PATHS.codex.config), { recursive: true })
const blockedToml = 'mcp_servers.search-boost.args = ["/fixture/cli.mjs"]\n'
writeFileSync(PATHS.codex.config, blockedToml)
const scopedPlan = await discoverIntegrations()
const grok = scopedPlan.targets.find(target => target.id === 'grok')
assert(grok)
const logs = []
const selectedResult = await runRefresh({ dryRun: true, selected: [integrationTargetKey(grok)], log: text => logs.push(text),
  run: async () => { throw Error('no host commands for MCP-only dry-run') } })
assert.equal(selectedResult.ok, true, 'unselected Codex must not fail selected Grok MCP')
assert(selectedResult.warnings.some(warning => warning.startsWith('codex:')), 'unselected failure stays disclosed')
assert(logs.some(text => text.includes('[skipped]') && text.includes('codex:')))
const missing = await runRefresh({ dryRun: true, selected: ['missing-target'], log: () => {} })
assert.equal(missing.ok, false, 'unavailable selected target still blocks')
const all = await runRefresh({ dryRun: true, log: () => {}, run: async () => { throw Error('offline host') } })
assert.equal(all.ok, false, 'full refresh still treats discovery failures as blockers')
assert.equal((await import('node:fs')).readFileSync(PATHS.codex.config, 'utf8'), blockedToml)
console.log('ok: canonical selection deduplicates HOME, scopes refresh failure correctly and keeps migration/repair flags distinct')
