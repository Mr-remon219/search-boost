/** Read-only evidence: configuration and disk payload are not live-host handshakes. */
import { existsSync, readFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { PKG_ROOT, getVersion } from './pkg.mjs'
import { discoverIntegrations } from './upgrade/integrations.mjs'
import { inspectPackageSource } from './package-identity.mjs'
import { verifyDshPayload } from './dsh-payload.mjs'
import { AGENT_IDS, agentStatus } from './agents/index.mjs'
import { mcpTomlStringArray } from './toml.mjs'

function diskSource(root, hostResolution = false) {
  const evidence = { root: root ?? null, installedVersion: null, payload: 'unknown',
    ...(hostResolution ? { hostResolution: 'unverified' } : {}) }
  if (!root) return evidence
  if (!existsSync(join(root, 'package.json'))) return { ...evidence, payload: 'missing' }
  try {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
    if (!['search-boost', 'search-boost-mcp', 'pi-search-boost', 'dsh-search-boost'].includes(pkg.name)) return { ...evidence, payload: 'foreign' }
    // Version strings are metadata, not proof of payload identity or live load.
    const version = typeof pkg.version === 'string' && /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]+)?$/.test(pkg.version) ? pkg.version : null
    let payload = 'not_verified'
    try { verifyDshPayload(root, PKG_ROOT); payload = 'matches_current_package' } catch { /* mismatch, missing or unreadable files cannot establish matching code */ }
    return { ...evidence, installedVersion: version, payload }
  } catch { return { ...evidence, payload: 'unreadable' } }
}
function mcpRoot(target) {
  const file = target.paths.mcp ?? target.paths.config
  try {
    const args = ['grok', 'codex'].includes(target.id)
      ? mcpTomlStringArray(readFileSync(file, 'utf8'), 'search-boost', 'args')
      : JSON.parse(readFileSync(file, 'utf8')).mcpServers?.['search-boost']?.args
    const entry = Array.isArray(args) && args.find(value => typeof value === 'string' && isAbsolute(value) && ['cli.mjs','server.mjs'].includes(basename(value)))
    return entry ? dirname(entry) : null
  } catch { return null }
}
export async function installationStatus({ workspace } = {}) {
  const plan = await discoverIntegrations({ workspace })
  const registrations = plan.targets.map(target => {
    let evidence
    if (target.kind === 'mcp') evidence = diskSource(mcpRoot(target))
    else if (target.kind === 'dsh') evidence = diskSource(join(target.dir, 'node_modules', 'search-boost'), true)
    else {
      const sources = target.entries.map(item => inspectPackageSource(typeof item.entry === 'string' ? item.entry : item.entry?.source, target.agentDir))
      evidence = { sources: sources.map(source => diskSource(source?.root)) }
      if (!sources.length) evidence = diskSource(inspectPackageSource(target.shim, target.agentDir)?.root)
      if (target.legacyDirs?.length) evidence.legacySources = target.legacyDirs.map(root => diskSource(root))
    }
    return { host: target.id, scope: target.label, legacy: Boolean(target.legacy), ...evidence }
  })
  return {
    schemaVersion: 1,
    package: { version: getVersion(), root: PKG_ROOT },
    agents: AGENT_IDS.map(id => {
      const state = agentStatus(id)
      const found = registrations.filter(row => row.host === id)
      return { id, detected: state.detected, configured: state.configured, discovered: found.length > 0,
        registrations: found, loadedVersion: null,
        reload: state.configured || found.length ? 'unconfirmed_restart_or_reconnect' : 'not_applicable' }
    }),
    // Never echo parser errors, config values, subprocess output or credentials.
    configurationWarnings: plan.warnings.length,
    verification: 'Disk package/configuration only. Running host version and reload completion are unknown without a live handshake; DSH host resolution and native plugin caches are not inferred from profile files.',
  }
}
