/** Pi-subagents integration: repair existing SearchBoost references, never grant tools.
 * `tools` selects names; `extensions` loads code. Explicit [] must stay disabled.
 */
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { inspectPackageSource, localPackagePath, PI_PACKAGE_NAMES, splitSourceModifier } from './package-identity.mjs'

const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

/** Recognize only package evidence or the exact retired Pi npm entry (even after removal). */
export function piSearchExtension(source, agentDir) {
  const installed = inspectPackageSource(source, agentDir)
  if (PI_PACKAGE_NAMES.includes(installed?.name)) return true
  const plain = splitSourceModifier(source).source
  const path = localPackagePath(plain, agentDir)
  if (!path || existsSync(path)) return false
  // Do not claim arbitrary paths merely containing the old package name.
  const legacyRoot = resolve(agentDir, 'npm', 'node_modules', 'pi-search-boost')
  if (existsSync(join(legacyRoot, 'package.json'))) return false // existing foreign/malformed metadata is not ours
  return ['index.ts', 'index.js'].some((entry) => path === join(legacyRoot, entry))
}

function configRows(settings) {
  const sub = settings.subagents
  if (sub === undefined) return []
  if (!object(sub)) throw new Error('Invalid subagents settings; left unchanged')
  const rows = [{ value: sub, key: 'subagents', fields: ['defaultExtensions', 'defaultSubagentOnlyExtensions'] }]
  function overrides(value, key) {
    if (value === undefined) return
    if (!object(value)) throw new Error(`Invalid ${key}; left unchanged`)
    for (const [name, config] of Object.entries(value)) {
      if (!object(config)) throw new Error(`Invalid ${key}.${name}; left unchanged`)
      rows.push({ value: config, key: `${key}.${name}`, fields: ['extensions', 'subagentOnlyExtensions', 'tools'] })
    }
  }
  overrides(sub.agentOverrides, 'subagents.agentOverrides')
  if (sub.agentOverridesByProvider !== undefined) {
    if (!object(sub.agentOverridesByProvider)) throw new Error('Invalid subagents.agentOverridesByProvider; left unchanged')
    for (const [provider, configs] of Object.entries(sub.agentOverridesByProvider)) {
      overrides(configs, `subagents.agentOverridesByProvider.${provider}`)
    }
  }
  for (const { value, key, fields } of rows) {
    for (const field of fields) {
      const list = value[field]
      // pi-subagents uses false to clear a per-agent override.
      if (list === undefined || (key !== 'subagents' && list === false)) continue
      if (!Array.isArray(list) || list.some((entry) => typeof entry !== 'string' || !entry.trim())) {
        throw new Error(`Invalid ${key}.${field}; expected an array of tool names/extension paths; left unchanged`)
      }
    }
  }
  return rows
}

/** Pure plan: only retarget existing owned extension references and retire an obsolete allow entry.
 * adaptive_search is NOT an API-compatible alias for deep_research and is not auto-granted.
 */
export function migratePiSubagentSettings(settings, agentDir, adapter) {
  const next = structuredClone(settings)
  const rows = configRows(next)
  const changes = []
  const sharedSearch = rows[0]?.fields.some((field) => rows[0].value[field]?.some((entry) => piSearchExtension(entry, agentDir))) ?? false
  for (const { value, key, fields } of rows) {
    const ownSearch = fields.some((field) => Array.isArray(value[field]) && value[field].some((entry) => piSearchExtension(entry, agentDir)))
    for (const field of fields) {
      if (!Array.isArray(value[field])) continue
      const before = value[field]
      const mapped = before.flatMap((entry) => {
        if (field === 'tools' && entry === 'deep_research' && (sharedSearch || ownSearch)) return []
        if (!piSearchExtension(entry, agentDir)) return [entry]
        return [splitSourceModifier(entry).modifier + adapter]
      })
      // Only dedupe references to our adapter, not unrelated user entries.
      const seen = new Set()
      const after = mapped.filter((entry) => {
        if (splitSourceModifier(entry).source !== adapter) return true
        if (seen.has(entry)) return false
        seen.add(entry)
        return true
      })
      if (JSON.stringify(before) !== JSON.stringify(after)) {
        value[field] = after
        changes.push(`${key}.${field}`)
      }
    }
  }
  return { settings: next, changes }
}

/** Static diagnostics, not proof of live tool registration or permission to execute. */
export function inspectPiSubagentSettings(settings, agentDir) {
  const rows = configRows(settings)
  const issues = []
  for (const { value, key, fields } of rows) {
    for (const field of fields) {
      if (!Array.isArray(value[field])) continue
      for (const entry of value[field]) {
        const location = `${key}.${field}`
        if (field === 'tools' && entry === 'deep_research') {
          issues.push({ location, problem: 'retired_tool', tool: entry })
        }
        if (piSearchExtension(entry, agentDir)) {
          const plain = splitSourceModifier(entry).source
          const path = localPackagePath(plain, agentDir)
          if (path && !existsSync(path)) issues.push({ location, problem: 'missing_extension', path })
        }
      }
    }
  }
  // Do not infer that a parent package grants tools to explicitly isolated children.
  const sub = settings.subagents
  for (const { value, key } of rows.slice(1)) {
    if (!Array.isArray(value.tools) || !value.tools.some((name) => ['fused_search', 'fetch_page', 'adaptive_search', 'x_search'].includes(name))) continue
    const extensions = value.extensions === false ? sub.defaultExtensions : value.extensions ?? sub.defaultExtensions
    const childOnly = value.subagentOnlyExtensions === false ? sub.defaultSubagentOnlyExtensions : value.subagentOnlyExtensions ?? sub.defaultSubagentOnlyExtensions
    if (Array.isArray(extensions) && ![...extensions, ...(childOnly ?? []), ...value.tools].some((entry) => piSearchExtension(entry, agentDir))) {
      issues.push({ location: key, problem: 'explicit_extensions_without_search_boost' })
    }
  }
  return issues
}
