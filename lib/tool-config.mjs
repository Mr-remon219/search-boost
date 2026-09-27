import { join } from 'node:path'
import { searchBoostHome } from './config-paths.mjs'
import { readJsonStore, withFileLock, writeFileAtomicPrivate } from './private-file.mjs'
import { readJevConfig } from './jev-config.mjs'

// Host aliases share a single preference. These are tool-entry switches, not
// engine switches: adaptive may still use fusion/fetch internally.
export const TOOL_CATALOG = [
  { name: 'fused_search', hint: 'MCP / Pi / DSH · multi-engine search' },
  { name: 'fetch_page', hint: 'MCP / Pi / DSH · read pages' },
  { name: 'x_search', hint: 'MCP / Pi / DSH · X search' },
  { name: 'adaptive_search', hint: 'MCP / Pi / DSH · requires Jev' },
  { name: 'research_parallel', hint: 'Pi: search-parallel-subagent / DSH: research_parallel' },
  { name: 'search_stats', hint: 'MCP / DSH · diagnostics' },
  { name: 'search_layer', hint: 'MCP · layer switch' },
]
const canonical = (name) => name === 'search-parallel-subagent' ? 'research_parallel' : name
export const toolsFilePath = () => join(searchBoostHome(), 'config', 'tools.json')

function readPreferences() {
  const { doc, error } = readJsonStore(toolsFilePath())
  if (error) throw error
  const tools = doc?.tools ?? {}
  if (!tools || typeof tools !== 'object' || Array.isArray(tools) || Object.values(tools).some((v) => typeof v !== 'boolean')) {
    throw new Error('Invalid tools.json: tools must map tool names to booleans')
  }
  return { doc: doc ?? {}, tools }
}

export function toolStates() {
  const { tools } = readPreferences()
  let jevReady = false
  let jevReason = 'Jev not configured — configure Jev credentials first'
  try { jevReady = Boolean(readJevConfig().apiKey) } catch { jevReason = 'Jev configuration unreadable — repair credentials first' }
  return TOOL_CATALOG.map((tool) => {
    const locked = tool.name === 'adaptive_search' && !jevReady
    const requested = tools[tool.name] !== false
    return { ...tool, requested, locked, enabled: requested && !locked, reason: locked ? jevReason : requested ? '' : 'Disabled by user' }
  })
}

export function toolState(name) {
  const row = toolStates().find((tool) => tool.name === canonical(name))
  if (!row) throw new Error(`Unknown search-boost tool: ${name}`)
  return row
}
export function assertToolEnabled(name) {
  const state = toolState(name)
  if (!state.enabled) throw new Error(`${name}: ${state.reason}`)
}

/** Patch only changed preferences; lock + atomic replacement preserve other writers. */
export function saveToolPreferences(patch) {
  const normalized = Object.fromEntries(Object.entries(patch).map(([name, value]) => [canonical(name), value]))
  return withFileLock(toolsFilePath(), () => {
    const states = toolStates()
    for (const [name, value] of Object.entries(normalized)) {
      const state = states.find((row) => row.name === name)
      if (!state || typeof value !== 'boolean') throw new Error(`Invalid tool preference: ${name}`)
      if (value && state.locked) throw new Error(`${name}: ${state.reason}`)
    }
    const { doc, tools } = readPreferences()
    writeFileAtomicPrivate(toolsFilePath(), `${JSON.stringify({ ...doc, tools: { ...tools, ...normalized } }, null, 2)}\n`)
  })
}

/** Polling survives atomic rename and files/directories created after startup.
 * Each invocation still checks synchronously, so the refresh interval is not an
 * authorization window. Broken configuration fails closed, never re-enables.
 */
export function watchToolStates(onChange, { interval = 300, onError = () => {} } = {}) {
  let previous
  const refresh = () => {
    let states
    try { states = toolStates() } catch (error) {
      states = TOOL_CATALOG.map((row) => ({ ...row, enabled: false, reason: 'Tool configuration unreadable' }))
      onError(error)
    }
    const key = JSON.stringify(states.map(({ name, enabled }) => [name, enabled]))
    if (key !== previous) {
      try { onChange(states); previous = key } catch (error) { onError(error) }
    }
  }
  refresh()
  const timer = setInterval(refresh, interval)
  timer.unref?.()
  return () => clearInterval(timer)
}

/** Host execution gate; never mutates the host API or another extension. */
export function guardedTool(definition) {
  return { ...definition, async execute(...args) {
    assertToolEnabled(definition.name)
    return definition.execute.apply(this, args)
  } }
}
