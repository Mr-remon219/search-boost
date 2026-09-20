// One description, one input contract and one text renderer for adaptive_search
// across MCP, Pi and DSH. Hosts add only their own registration/presentation.
//
// Wording rules kept here on purpose:
//  * the destination is "the Jev service you configured (default TypeSafe)" —
//    a custom gateway is never described as the official address;
//  * `covered` is a model judgement about the reviewed fragments, not an
//    independently verified fact;
//  * core tools keep their own, unchanged contracts — adaptive_search is an
//    additional high-level tool for multi-question evidence work.

export const ADAPTIVE_TOOL_NAME = 'adaptive_search'

export const ADAPTIVE_QUESTIONS_PARAM =
  '1–6 independent questions (each ≤400 characters, not blank). Every question is searched and judged on its own and keeps its position in the output; identical questions reuse one execution but still appear separately. One question is allowed.'

export const ADAPTIVE_DESCRIPTION =
  'Optional bounded evidence collection for 1–6 independent questions. Jev selects searches and judges reviewed fragments per question; code validates response shapes, enforces action/budget limits, and returns statuses plus the reviewed evidence. It is not a subagent runner or an independent fact checker: covered means model-judged support, not verified truth. Requires Jev credentials; otherwise returns not_configured without network requests. Questions and necessary evidence go to the configured Jev service (default TypeSafe), never engine credentials or fingerprints. Evidence is held in memory by the core; hosts may retain audit/session history. Prefer fused_search for a precise lookup, fetch_page for a known URL and x_search for X-specific retrieval; use this tool when automatic follow-up and per-question coverage are useful.'

export const ADAPTIVE_PROMPT_GUIDELINES = [
  'Read the returned reviewed fragments and explicit gaps before answering; a coverage probability is not factual certainty.',
  'Do not blindly rerun the whole adaptive loop after partial results. Address only material gaps within the remaining user/host budget.',
  'Research authorization does not authorize configuring Jev, adding credentials or changing the persistent search layer.',
]

/** Text rendering shared by all three hosts (the structured result stays authoritative). */
export function renderAdaptiveSummary(result) {
  const lines = []
  const questions = result?.questions ?? []
  const covered = questions.filter((q) => q.status === 'covered').length
  lines.push(`adaptive_search: ${covered}/${questions.length} covered — ${result?.rounds ?? 0} round(s), ${result?.stopReason ?? '?'}${result?.stopDetail ? ` (${result.stopDetail})` : ''}`)
  for (const q of questions) {
    const coverage = q.coverage
      ? `, coverage p=${q.coverage.probability ?? 'n/a'}, required > ${q.coverage.threshold} (basis ${q.coverage.textBasis ?? 'n/a'}${q.coverage.snippetOnly ? ', snippet-only' : ''})`
      : ''
    lines.push('')
    lines.push(`${q.id} [${q.status}${q.assessed ? '' : ', unassessed'}] ${q.question}${coverage}`)
    for (const item of (q.evidence ?? []).slice(0, 2)) {
      lines.push(`   - ${item.evidenceId} ${item.url} (${item.textBasis ?? 'no text'}, ${item.status}${item.premiseConflict ? ', contradicts a premise' : ''}${item.injectionSuspected ? ', injection suspected' : ''})`)
      const text = String(item.reviewedText ?? '').replace(/\s+/g, ' ').trim()
      if (text) lines.push(`     "${text.slice(0, 220)}${text.length > 220 ? '…' : ''}"`)
    }
    const returned = q.evidence?.length ?? 0
    if (returned > 2) lines.push(`   - ${returned - 2} more evidence item(s) in the structured result`)
    if (q.evidenceCount > returned) lines.push(`   - ${q.evidenceCount - returned} evidence item(s) omitted by the output cap`)
    if (q.conflicts?.length) for (const conflict of q.conflicts) lines.push(`   ! unresolved source conflict (${conflict.kind}, p=${conflict.probability})`)
    if (q.status !== 'covered') lines.push(`   reason: ${(q.uncoveredReasons ?? []).join(', ') || 'unspecified'}${q.coverage?.missingExplicitRequirements?.length ? `; missing explicit token(s): ${q.coverage.missingExplicitRequirements.join(', ')}` : ''}`)
  }
  const usage = result?.usage ?? {}
  lines.push('')
  lines.push(`searches: ${usage.searchCalls ?? 0} call(s) / ${usage.engineRequests ?? 0} engine request(s) (${Object.entries(usage.engineStats ?? {}).map(([name, stat]) => `${name}:${stat.errors ? (stat.successes > 0 ? 'partial' : 'FAIL') : 'ok'}`).join(', ') || 'none'}); fetches: ${usage.fetchCalls ?? 0} network + ${Math.max(0, (usage.fetchReads ?? 0) - (usage.fetchCalls ?? 0))} cache read(s)`)
  lines.push(`jev: ${result?.jev?.used ? `used (${result.jev.model ?? 'model unknown'}, ${usage.jevCalls ?? 0} call(s), ${usage.jevHttpAttempts ?? 0} HTTP attempt(s), ~${usage.jevInputTokensEstimated ?? 0} estimated input tokens${usage.tokenAccounting?.serverReported ? `, ${usage.jevInputTokens ?? 0} server-reported` : ''})` : 'not executed'}${result?.jev?.degraded ? ' — DEGRADED' : ''}${result?.jev?.disabled ? ' — disabled for this call' : ''}`)
  const warnings = result?.warnings ?? []
  if (warnings.length) lines.push(`warnings: ${warnings.join('; ')}`)
  lines.push('Uncovered is not proof of absence: review the reasons, the reviewed fragments and the evidence status before searching again.')
  return lines.join('\n')
}

/** Hosts whose details/UI metadata is not model-visible must also emit the
 * code-capped structured result as text, rather than discard reviewed evidence. */
export function adaptiveTextContent(result) {
  return [
    { type: 'text', text: renderAdaptiveSummary(result) },
    { type: 'text', text: JSON.stringify(result) },
  ]
}
