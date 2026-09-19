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
  'High-level evidence loop for several independent questions at once. A configured Jev (TypeSafe System One) decision model selects the search engines, judges each collected fragment against the question it belongs to, and decides per question whether the qualified evidence really supports an answer; this client validates every answer, runs only whitelisted searches/page fetches and reports each question with its reviewed fragments. Question text and the necessary evidence fragments go to the Jev service you configured (default: TypeSafe). No engine credentials or fingerprints are sent, and nothing is written to disk. Requires Jev credentials — without them it returns not_configured without any network request. Results distinguish search-engine snippets from engine-returned text and fetched page text, and `covered` means the model judged the cited fragments sufficient (not that a fact was independently verified). Use fused_search / fetch_page / x_search for single lookups or when you want to control query, engines and parameters yourself; their contracts are unchanged.'

export const ADAPTIVE_PROMPT_GUIDELINES = [
  'adaptive_search takes only questions[1..6]; it chooses engines and depth itself. Do not use it for a single precise lookup — fused_search is cheaper and more direct.',
  'adaptive_search returns per-question status (covered / insufficient / unassessed / not_searched / failed), the reviewed excerpts behind each judgement, and code-generated reasons. Treat covered as model-judged support, never as independent verification.',
  'adaptive_search sends question text and the evidence fragments needed for each judgement to the Jev service you configured; configure it with `search-boost config jev`, and expect no request at all when it is not configured.',
  'adaptive_search never calls fused_search/fetch_page/x_search through a tool protocol and never exposes engine credentials; the underlying search behaviour (ranking=balanced, community=false, current layer limits) is identical to the core tools.',
]

/** Text rendering shared by all three hosts (the structured result stays authoritative). */
export function renderAdaptiveSummary(result) {
  const lines = []
  const questions = result?.questions ?? []
  const covered = questions.filter((q) => q.status === 'covered').length
  lines.push(`adaptive_search: ${covered}/${questions.length} covered — ${result?.rounds ?? 0} round(s), ${result?.stopReason ?? '?'}${result?.stopDetail ? ` (${result.stopDetail})` : ''}`)
  for (const q of questions) {
    const coverage = q.coverage
      ? `, coverage ${q.coverage.probability ?? 'n/a'} > ${q.coverage.threshold} (basis ${q.coverage.textBasis ?? 'n/a'}${q.coverage.snippetOnly ? ', snippet-only' : ''})`
      : ''
    lines.push('')
    lines.push(`${q.id} [${q.status}${q.assessed ? '' : ', unassessed'}] ${q.question}${coverage}`)
    for (const item of (q.evidence ?? []).slice(0, 2)) {
      lines.push(`   - ${item.evidenceId} ${item.url} (${item.textBasis ?? 'no text'}, ${item.status}${item.premiseConflict ? ', contradicts a premise' : ''}${item.injectionSuspected ? ', injection suspected' : ''})`)
      const text = String(item.reviewedText ?? '').replace(/\s+/g, ' ').trim()
      if (text) lines.push(`     "${text.slice(0, 220)}${text.length > 220 ? '…' : ''}"`)
    }
    if (q.evidenceCount > (q.evidence?.length ?? 0)) lines.push(`   - ${q.evidenceCount - (q.evidence?.length ?? 0)} more evidence item(s) in the structured result`)
    if (q.conflicts?.length) for (const conflict of q.conflicts) lines.push(`   ! unresolved source conflict (${conflict.kind}, p=${conflict.probability})`)
    if (q.status !== 'covered') lines.push(`   reason: ${(q.uncoveredReasons ?? []).join(', ') || 'unspecified'}${q.coverage?.missingExplicitRequirements?.length ? `; missing explicit token(s): ${q.coverage.missingExplicitRequirements.join(', ')}` : ''}`)
  }
  const usage = result?.usage ?? {}
  lines.push('')
  lines.push(`searches: ${usage.searchCalls ?? 0} call(s) / ${usage.engineRequests ?? 0} engine request(s) (${Object.entries(usage.engineStats ?? {}).map(([name, stat]) => `${name}:${stat.errors ? 'FAIL' : 'ok'}`).join(', ') || 'none'}); fetches: ${usage.fetchCalls ?? 0} network + ${Math.max(0, (usage.fetchReads ?? 0) - (usage.fetchCalls ?? 0))} cache read(s)`)
  lines.push(`jev: ${result?.jev?.used ? `used (${result.jev.model ?? 'model unknown'}, ${usage.jevCalls ?? 0} call(s), ${usage.jevHttpAttempts ?? 0} HTTP attempt(s), ~${usage.jevInputTokensEstimated ?? 0} estimated input tokens${usage.tokenAccounting?.serverReported ? `, ${usage.jevInputTokens ?? 0} server-reported` : ''})` : 'not executed'}${result?.jev?.degraded ? ' — DEGRADED' : ''}${result?.jev?.disabled ? ' — disabled for this call' : ''}`)
  const warnings = result?.warnings ?? []
  if (warnings.length) lines.push(`warnings: ${warnings.join('; ')}`)
  lines.push('Uncovered is not proof of absence: review the reasons, the reviewed fragments and the evidence status before searching again.')
  return lines.join('\n')
}
