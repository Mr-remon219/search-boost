// DSH native research runner. Uses the shared Pi/skill roles, never the Pi CLI.
// Contract checked against deepseek-ai/deepseek-harness ddefc45f:
// packages/subagent/subagent/src/{types,index}.ts and packages/core/tools/src/index.ts.
import { setTimeout, clearTimeout } from 'node:timers'
import { RESEARCH_TOOLS, normalizeResearchTasks, researchRole, researchResult, researchSummary } from './parallel-contract.mjs'

function legacyTasks({ query, subQueries }) {
  if (typeof query !== 'string' || !query.trim()) throw new Error('research_parallel: query is required in legacy mode')
  let tasks = subQueries
  if (tasks !== undefined && (!Array.isArray(tasks) || tasks.length < 2 || tasks.length > 4)) {
    throw new Error('research_parallel: provide 2-4 sub_queries or omit for auto-derived angles')
  }
  if (!tasks) {
    // Compatibility only. Explicit independent tasks are preferred to these heuristic angles.
    const zh = /[\u4e00-\u9fff]/.test(query)
    tasks = [
      `${query} — ${zh ? '官方文档与已确认事实' : 'official documentation and established facts'}`,
      `${query} — ${zh ? '限制、反例与冲突证据' : 'limitations, counterexamples, and conflicting evidence'}`,
    ]
  }
  return normalizeResearchTasks({ tasks: tasks.map((task) => ({ agent: 'searcher', task })) }, 'research_parallel')
}

function selectProvider(subagents, name) {
  if (!subagents?.start) throw new Error('subagents service unavailable — research_parallel requires DSH native subagents (not MCP or Pi)')
  const provider = subagents.getProvider?.(name)
  if (!provider) throw new Error(`research_parallel: native provider "${name}" unavailable or capability discovery unsupported; inspect the DSH profile/version (no runtime fallback)`)
  for (const feature of ['toolFilter', 'depthLimit', 'persona']) {
    if (provider.capabilities?.[feature] !== true) throw new Error(`research_parallel: provider "${name}" lacks ${feature}; refusing unscoped delegation`)
  }
  // This workflow needs a fresh context, not a fork of unrelated/private parent history.
  if (provider.inheritsParentContext !== false) throw new Error(`research_parallel: provider "${name}" does not declare fresh-context isolation`)
  return name
}

/** One wave or one summarizer. The parent chooses follow-up waves and final synthesis. */
export async function parallelResearch(opts) {
  const started = Date.now()
  const explicit = opts.tasks !== undefined || opts.agentRole !== undefined || opts.task !== undefined
  if (explicit && opts.subQueries !== undefined) throw new Error('research_parallel: do not mix tasks/agent with sub_queries')
  const tasks = explicit
    ? normalizeResearchTasks({ tasks: opts.tasks, agent: opts.agentRole, task: opts.task }, 'research_parallel')
    : legacyTasks(opts)
  const provider = selectProvider(opts.subagents, opts.provider ?? 'spawn')
  const maxSeconds = opts.maxSeconds ?? 120
  const maxSources = opts.maxSources ?? 6
  if (!Number.isFinite(maxSeconds) || maxSeconds < 1 || maxSeconds > 300) throw new Error('research_parallel: max_seconds must be 1–300')
  if (!Number.isInteger(maxSources) || maxSources < 1 || maxSources > 10) throw new Error('research_parallel: max_sources must be 1–10')

  const controller = new AbortController()
  let stoppedBy = 'aborted'
  let wake
  const stopped = new Promise((resolve) => { wake = resolve })
  const stop = (reason) => {
    if (controller.signal.aborted) return
    stoppedBy = reason
    controller.abort()
    wake()
  }
  const onAbort = () => stop('aborted')
  const timer = setTimeout(() => stop('timeout'), maxSeconds * 1000)
  if (opts.signal?.aborted) onAbort()
  else opts.signal?.addEventListener('abort', onAbort, { once: true })

  function stoppedResult(item, start) {
    return researchResult(item, {
      status: stoppedBy, error: `${stoppedBy}; cancellation requested through the DSH signal; pending host cleanup must finish before reuse`,
      tookMs: Date.now() - start,
    })
  }

  async function attempt(item) {
    const start = Date.now()
    if (controller.signal.aborted) return stoppedResult(item, start)
    let run
    let result
    try {
      const context = [opts.query && `Research question: ${opts.query}`, opts.goal && `Goal: ${opts.goal}`].filter(Boolean).join('\n')
      run = await opts.subagents.start(provider, {
        label: `research:${item.agent}:${item.task.slice(0, 60)}`,
        parent: opts.agent,
        signal: controller.signal,
        maxDepth: 1,
        toolFilter: { allow: item.agent === 'searcher' ? [...RESEARCH_TOOLS] : [] },
        persona: researchRole(item.agent),
        prompt: [{ type: 'text', text: `${context}\n\nTask: ${item.task}${item.agent === 'searcher' ? `\nUse up to ${maxSources} results per search; return only sources you examined.` : ''}` }],
      })
      // Observe even a late handle's result before disposing it. Never leak a child
      // that publishes after the deadline or let its result reject unobserved.
      const observed = Promise.resolve(run.result)
      observed.catch(() => {})
      if (controller.signal.aborted) result = stoppedResult(item, start)
      else {
        const raw = await Promise.race([observed, stopped.then(() => null)])
        if (!raw || controller.signal.aborted) result = stoppedResult(item, start)
        else {
          const output = (raw.output ?? []).filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n')
          result = researchResult(item, {
            result: output, status: raw.stopReason || 'error', error: raw.diagnostic,
            tookMs: Date.now() - start,
          })
        }
      }
    } catch (err) {
      result = controller.signal.aborted ? stoppedResult(item, start)
        : researchResult(item, { status: 'error', error: err instanceof Error ? err.message : String(err), tookMs: Date.now() - start })
    } finally {
      // DSH's one-shot seam requires disposal even on successful completion.
      if (run) {
        try { await run.dispose() } catch (err) {
          result = researchResult(item, { result: result?.result, status: 'error', error: `DSH cleanup failed: ${err instanceof Error ? err.message : String(err)}`, tookMs: Date.now() - start })
        }
      }
    }
    return result
  }

  try {
    const results = await Promise.all(tasks.map((item) => {
      // Bound both provider startup and execution. Late handles stay observed and
      // are disposed by attempt(); an uncooperative provider is not called success.
      return Promise.race([attempt(item), stopped.then(() => stoppedResult(item, started))])
    }))
    const summary = researchSummary(results, started)
    return {
      ...summary,
      // Keep the legacy DSH result fields for clients and native presentation cards.
      query: opts.query ?? tasks.map((t) => t.task).join(' | '),
      sub_tasks: results.map((r) => ({ title: r.task, agent: r.agent, status: r.status, output: r.result, sources: r.sources, truncated: r.truncated, ...(r.error ? { error: r.error } : {}) })),
      merged_sources: summary.sourceUrls,
      took_ms: summary.totalMs,
      note: `${summary.okCount}/${results.length} tasks completed; citation candidates are not independent verification. Parent owns synthesis and any next wave.`,
    }
  } finally {
    clearTimeout(timer)
    opts.signal?.removeEventListener('abort', onAbort)
  }
}
