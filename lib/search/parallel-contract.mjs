/** Shared research roles and result contract; no host process or subagent APIs. */
import { readFileSync } from 'node:fs'
import { hostOf, normalizeUrl } from './fusion.js'

export const RESEARCH_ROLES = new Set(['searcher', 'summarizer'])
export const RESEARCH_TOOLS = ['fused_search', 'fetch_page']
// LF regardless of the checkout platform: this text is injected into shipped
// skill bundles, whose content is compared byte-for-byte.
const reference = (name) => readFileSync(new URL(`../../agents/shared/research/${name}.md`, import.meta.url), 'utf8').replace(/\r\n/g, '\n').trim()

export function researchRole(name, prefix = '') {
  if (!RESEARCH_ROLES.has(name)) throw new Error(`Unknown research role: ${name}`)
  return reference(name)
    .replaceAll('{{TOOL_FUSED_SEARCH}}', `${prefix}fused_search`)
    .replaceAll('{{TOOL_FETCH_PAGE}}', `${prefix}fetch_page`)
}

export function renderResearchTemplate(text, prefix = '') {
  return text.replaceAll('{{RESEARCH_WORKFLOW}}', reference('workflow'))
    .replaceAll('{{RESEARCH_SEARCHER}}', researchRole('searcher', prefix))
    .replaceAll('{{RESEARCH_SUMMARIZER}}', researchRole('summarizer', prefix))
}

export function normalizeResearchTasks(params, label = 'search-parallel-subagent') {
  const single = params?.agent !== undefined || params?.task !== undefined
  const batch = params?.tasks !== undefined
  if (single === batch) throw new Error(`${label}: provide exactly one of { agent, task } or tasks[]`)
  const tasks = single ? [{ agent: params.agent, task: params.task }] : params.tasks
  if (!Array.isArray(tasks) || !tasks.length) throw new Error(`${label}: tasks must not be empty`)
  return tasks.map((item) => {
    if (typeof item?.agent !== 'string' || typeof item?.task !== 'string' || !item.task.trim() || !item.agent.trim()) {
      throw new Error(`${label}: each item needs agent and task`)
    }
    const agent = item.agent.trim()
    if (!RESEARCH_ROLES.has(agent)) throw new Error(`${label}: unknown agent "${agent}"`)
    return { agent, task: item.task.trim() }
  })
}

/** URLs are citation candidates, not evidence validation. Retain balanced URL parentheses. */
export function extractSourceUrls(text) {
  const urls = new Set()
  for (const match of String(text ?? '').matchAll(/https?:\/\/[^\s<>"'`\]}]+/g)) {
    let value = match[0].replace(/[.,;:!?]+$/, '').replace(/(?:\*{1,3}|_{1,3}|~{1,2})$/, '')
    while (value.endsWith(')') && (value.match(/\)/g)?.length ?? 0) > (value.match(/\(/g)?.length ?? 0)) value = value.slice(0, -1)
    const url = normalizeUrl(value)
    try { if (['http:', 'https:'].includes(new URL(url).protocol)) urls.add(url) } catch { /* not a URL */ }
  }
  return [...urls]
}

export function researchResult(item, { result = '', status = 'completed', error, tookMs = 0, turns = 0, attempts = 1 } = {}) {
  if (status === 'completed' && !result.trim()) { status = 'error'; error ||= 'child returned no output' }
  const limit = 50_000
  const truncated = result.length > limit
  const text = result.slice(0, limit)
  const sources = extractSourceUrls(text)
  return {
    ...item, ok: status === 'completed', status, result: text, tookMs, turns, attempts, truncated,
    sources, domains: [...new Set(sources.map(hostOf).filter(Boolean))],
    ...(status === 'completed' ? {} : { error: error || `child ended: ${status}` }),
  }
}

export function researchSummary(results, started) {
  // Failed/partial reports remain inspectable, but are not counted as successful evidence.
  const sourceUrls = [...new Set(results.filter((r) => r.ok).flatMap((r) => r.sources))]
  return {
    results, okCount: results.filter((r) => r.ok).length, sourceUrls,
    domains: [...new Set(sourceUrls.map(hostOf).filter(Boolean))],
    totalTurns: results.reduce((n, r) => n + r.turns, 0), totalMs: Date.now() - started,
  }
}
