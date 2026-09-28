// One description, one input contract and one text renderer for adaptive_search
// across MCP, Pi and DSH. Hosts add only their own registration/presentation.
//
// Wording rules kept here on purpose:
//  * the destination is "the Jev service you configured (default TypeSafe)" —
//    a custom gateway is never described as the official address;
//  * reading value and search satisfaction never claim a complete answer;
//  * core tools keep their own, unchanged contracts — adaptive_search is an
//    additional retriever of useful focused and supporting materials.

export const ADAPTIVE_TOOL_NAME = 'adaptive_search'

export const ADAPTIVE_QUESTIONS_PARAM =
  'Exactly one coherent research question (questions has one item, ≤400 characters); related comparison aspects are allowed. Independent questions require separate calls.'

export const ADAPTIVE_DESCRIPTION =
  'Bounded automated research retrieval with Jev for ONE difficult question. Supply questions with exactly one item, optional research intent, flat keywords search points, and constraints containing only explicit checkable hard document restrictions. Put every mandatory document condition in constraints; the question is context, not a hidden restriction list. Omit constraints or use [] when none. Code offers bounded queries; Jev chooses a query from current gaps/material/search feedback, then assesses engines for that exact query. Results enter a URL-deduplicated pool. A separate Boolean prefilter checks ALL explicit constraints (skipped when empty), then quality judges relevance, reading value and injection. Direction prioritises focus; keyword matches attribute contributions, neither vetoes useful supporting material. Counterevidence and medium-value context can qualify. Returns focus materials first, supporting materials afterward. Code recomputes capped per-keyword progress from current deduplicated quality scores, and stops when the equally weighted total reaches its threshold AND every keyword meets its floor. No whole-material final review is sent to Jev. Weak points guide follow-up searches; retries and duplicate material earn no extra credit, and invalidated material loses credit. Thresholds are initial heuristics, not calibrated probabilities. Unresolved assessments and budget exits are disclosed. Up to 500 unique candidate URLs per round (capacity, not promise). Returns URLs, titles and reviewed extracts, not answers. Scores and retrievalSufficient are not source verification or exhaustive coverage. Inspect reviewSummary, scopeSummary, convergence, keywordProgress, pendingAssessments and warnings. Cursor-only pagination (optional page_size) makes no new search/Jev calls: default 20/max 50 per page, byte limits, no fixed cumulative result cap, finite execution budgets; process-local cursors last up to 30 minutes/32 runs. Deprecated coverageComplete remains false in schemaVersion 3. Requires configured Jev credentials; otherwise not_configured without network. Question, intent, constraints and necessary fragments go to the configured Jev service (default TypeSafe), never engine credentials. No secrets/private reasoning. Use fused_search for direct lookups, fetch_page for known URLs, x_search for X-only retrieval.'


export const ADAPTIVE_PROMPT_GUIDELINES = [
  'Use adaptive_search for one difficult research question: questions must contain exactly one item; intent states the research purpose, keywords identify search points, constraints state only explicit checkable hard document restrictions.',
  'Write restrictions as complete conditions (e.g. explicitly applicable to Node.js 22), not isolated words. Do not put direction, soft preferences, keywords or desired conclusions in constraints; use [] when none.',
  'Read returned extracts before answering. Counterevidence may fit the direction; model scores and a satisfied retrieval stopping rule do not establish truth or full answer coverage.',
  'Inspect reviewSummary, scopeSummary, convergence, keywordProgress, pendingAssessments and warnings. Constraint non-pass means compliance was not established, not necessarily a proven violation. Unreviewed/unavailable assessments are not semantic rejection, and unfinished retrieval is not proof of absence.',
  'Use cursor only for saved pages. End of pagination is not exhaustive search. Search remaining concrete doubts rather than blindly repeating the whole run. Search authority never permits changing credentials or persistent defaults.',
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
