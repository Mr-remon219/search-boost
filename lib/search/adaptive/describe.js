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
  'Legacy input: 1–6 independent nonblank questions, each ≤400 characters. Identical questions reuse execution; approved results are merged into one URL-deduplicated list.'

export const ADAPTIVE_DESCRIPTION =
  'Jev-driven keyword-target research. Supply tasks with context and targets (id, keywords, question), or legacy questions; at most 6 tasks and 12 targets total. Each round has at most three batched Jev calls: plan, evidence scoring, coverage/continuation. Returns only Jev-approved URLs, titles and extractive descriptions, not rejected or unassessed candidates. Approval is a model judgement, not verified truth. Follow nextCursor using cursor (without tasks/questions) to read more, without search or Jev calls. page_size defaults to 20 (max 50); there is no total approved-result count cap, but search time/request budgets remain finite. Pagination is not exhaustive search: inspect coverageComplete and warnings. Results are held in this server process for up to 30 minutes / 32 recent runs and are lost on restart or eviction. Relative today/yesterday constraints use UTC; unknown event dates do not qualify. Requires Jev credentials; otherwise returns not_configured without network requests. Task text and necessary fragments go to the configured Jev service (default TypeSafe), never engine credentials. Prefer fused_search for a precise lookup, fetch_page for a known URL and x_search for X-specific retrieval.'

export const ADAPTIVE_PROMPT_GUIDELINES = [
  'Use adaptive_search tasks to bind search keywords to explicit acceptance questions; synonyms are query alternatives, not separate targets.',
  'Read adaptive_search approved descriptions before answering; approval and coverageComplete are model judgements, not independent verification.',
  'Read additional adaptive_search pages with cursor only. A null nextCursor means all collected approved results were returned, not that the research is exhaustive.',
  'Do not blindly rerun the whole adaptive loop after partial results. Address only material gaps within the remaining user/host budget.',
  'Research authorization does not authorize configuring Jev, adding credentials or changing the persistent search layer.',
]

/** Text rendering shared by all three hosts (the structured result stays authoritative). */
export function renderAdaptiveSummary(result) {
  if (Array.isArray(result?.results)) return `adaptive_search: ${result.results.length}/${result.totalResults} approved results — ${result.stopReason}; target coverage ${result.coverageComplete ? 'complete' : 'incomplete'}${result.nextCursor ? '; more results: call with nextCursor as cursor' : ''}${result.warnings.length ? `\nwarnings: ${result.warnings.join('; ')}` : ''}`
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
