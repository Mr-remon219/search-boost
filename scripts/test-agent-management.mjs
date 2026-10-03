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
console.log('ok: canonical existing-target selection deduplicates HOME and keeps migration/repair flags distinct')
