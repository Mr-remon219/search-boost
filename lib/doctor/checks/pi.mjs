import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { PATHS } from '../../paths.mjs'
import { inspectPiSubagentSettings } from '../../pi-subagent-config.mjs'

/** Static only: never load extensions, call models, or change Pi settings. */
export function checkPiSubagentTools(ctx = {}) {
  const dirs = new Set([
    ctx.homeDir && !process.env.PI_CODING_AGENT_DIR ? join(ctx.homeDir, '.pi', 'agent') : PATHS.pi.agentDir,
    resolve('.pi'),
  ])
  const issues = []
  let configured = false
  for (const dir of dirs) {
    const file = join(dir, 'settings.json')
    if (!existsSync(file)) continue
    try {
      const settings = JSON.parse(readFileSync(file, 'utf8'))
      if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('Invalid settings object')
      if (settings.subagents === undefined) continue
      configured = true
      issues.push(...inspectPiSubagentSettings(settings, dir).map((issue) => ({ file, ...issue })))
    } catch {
      issues.push({ file, problem: 'invalid_settings' })
    }
  }
  return {
    id: 'pi_subagent_tools', category: 'agents',
    status: issues.length ? 'warn' : configured ? 'pass' : 'skip',
    message: issues.length
      ? `Pi subagent search configuration has ${issues.length} issue(s): ${[...new Set(issues.map((i) => i.problem))].join(', ')}`
      : configured ? 'Pi subagent settings have no known stale search references (static check only)' : 'No Pi subagent settings to check',
    ...(issues.length ? {
      fix_hint: 'For an existing Pi registration, run search-boost upgrade --sync-only to migrate owned child references. If only child references remain and installation is wanted, use search-boost install -t pi. Otherwise remove stale references manually. Remove retired deep_research requirements manually from roles without owned SearchBoost references; adaptive_search is not an automatic alias. Check explicit child extensions/tools and custom agent Markdown, then reload Pi.',
      details: { issues },
    } : {}),
  }
}
