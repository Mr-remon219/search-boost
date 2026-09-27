// One description, one input contract and one text renderer for adaptive_search
// across MCP, Pi and DSH. Hosts add only their own registration/presentation.
//
// Wording rules kept here on purpose:
//  * the destination is "the Jev service you configured (default TypeSafe)" —
//    a custom gateway is never described as the official address;
//  * reading value and search satisfaction never claim a complete answer;
//  * core tools keep their own, unchanged contracts — adaptive_search is an
//    additional selector of high-value search results.

export const ADAPTIVE_TOOL_NAME = 'adaptive_search'

export const ADAPTIVE_QUESTIONS_PARAM =
  'Legacy input: 1–6 independent nonblank questions, each ≤400 characters. Identical questions reuse execution; approved results are merged into one URL-deduplicated list.'

export const ADAPTIVE_DESCRIPTION =
  'Intent-guided search result selection with Jev, not an autonomous research or answer-verification tool. Supply questions with optional bound keywords, or tasks with context and targets (id, keywords, question); add intent to explain what would be useful to read. At most 6 questions/tasks and 12 targets. Jev judges relevance, reading value and helpfulness to the intent, including useful counterevidence; credible pointers and partial information may qualify. Code tracks each keyword as continue, satisfied, exhausted or pending and stops when the queue closes or budgets run out. Collects up to 500 unique candidate URLs per round (capacity, not a promise), using bounded judgement micro-batches; no automatic page reading. Returns selected URLs, titles and extractive descriptions with heuristic valueScore, directionMatch and kind, not generated answers. These scores and retrievalSufficient are model judgements, not correctness or answer-completeness claims. Inspect keywordProgress, pendingAssessments and warnings; exhausted is not success or proof of absence. Deprecated coverageComplete is always false in schemaVersion 3. Read more with cursor only (optional page_size), without new search/Jev calls; default 20/max 50 per page, no fixed cumulative selected-result cap, finite search budgets. Cursors are process-local, retained up to 30 minutes/32 runs; end of pagination is not exhaustive search. Relative dates use UTC; unknown event dates cannot qualify. Requires configured Jev credentials, otherwise not_configured without network requests. Task, intent and necessary fragments go to the configured Jev service (default TypeSafe), never engine credentials. Do not include secrets/private reasoning in intent. Use fused_search for direct lookup, fetch_page to read a known URL, x_search for X-only retrieval.'

export const ADAPTIVE_PROMPT_GUIDELINES = [
  'Use adaptive_search for intent-guided result selection: bind keywords to questions and provide concise intent/preferences, not private reasoning or secrets.',
  'Read returned descriptions before answering. Reading value and direction match do not establish truth; useful counterevidence can match the intent.',
  'Inspect retrievalSufficient, keywordProgress, pendingAssessments and warnings. Search satisfaction does not mean a complete answer; deprecated coverageComplete stays false.',
  'Use cursor only to read more pages. A null nextCursor means collected selected results were returned, not that search was exhaustive.',
  'Address remaining search directions within the remaining budget instead of blindly rerunning the whole loop. Search authorization does not authorize changing credentials or persistent settings.',
]

/** Text rendering shared by all three hosts (the structured result stays authoritative). */
export function renderAdaptiveSummary(result) {
  if (Array.isArray(result?.results)) return `adaptive_search: ${result.results.length}/${result.totalResults} selected results — ${result.stopReason}; ${result.schemaVersion === 3 ? `keyword search ${result.retrievalSufficient ? 'satisfied' : 'unfinished or exhausted'}; answer completeness not assessed` : 'legacy evidence result'}${result.nextCursor ? '; more results: call with nextCursor as cursor' : ''}${result.warnings.length ? `\nwarnings: ${result.warnings.join('; ')}` : ''}`
  if (result?.schemaVersion === 3) return `adaptive_search: ${result.questions?.filter(q => q.status === 'satisfied').length ?? 0}/${result.questions?.length ?? 0} search targets satisfied — ${result.stopReason}; answer completeness not assessed\n${(result.warnings ?? []).join('; ')}`
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
