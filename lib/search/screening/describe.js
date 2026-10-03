// Shared call-level contract; field modes/limits live in input.js and detailed
// examples/recovery explanations in the optional MCP policy resource.
export const ADAPTIVE_TOOL_NAME = 'adaptive_search'
export const ADAPTIVE_DESCRIPTION = [
  'Use for higher-quality evidence selection on medium-to-high difficulty or uncertain research questions. When enabled with configured Jev, prefer it over fused_search if sources are noisy, relevance is unclear or many plausible leads need screening against the research intent. Call it directly; no preliminary fused_search is required.',
  'Use fused_search when direct retrieval is sufficient, varied queries or explicit source control are needed, or Adaptive is unavailable. Jev being configured alone is not a reason to use Adaptive for every search.',
  'Supply ONE full question and its intent. Jev selects a fixed ranking/community strategy; one search retrieves a target-dependent bounded snapshot using only the original question. The whole declared snapshot is reviewed before selection, even if the requested count is already met.',
  'Returns ranked extracts admitted as safe with established value 3/4/5, plus selection, diagnostics, usage and warnings. Value labels and scores do not verify claims; targetMet means quantity only. Failed or unavailable judgments and unreviewed material are disclosed.',
  'No query expansion or automatic full-page reading; no self-imposed cumulative cost, token, request-count or total-duration quota. Request timeouts, limited retries, safety refusals and cancellation still apply.',
  'Supports optional local saving and zero-network pagination/recovery. Historical snapshots are not fresh evidence. Requires configured Jev; it receives the question, intent and necessary fragments, never engine credentials.',
  'The parent still owns source verification, follow-up research and the final answer. Use fetch_page for known URLs and x_search for X-only tasks.',
].join(' ')
export const ADAPTIVE_PROMPT_GUIDELINES = [
  'Use screened extracts as reading candidates, not a verified answer; inspect incomplete review and failure diagnostics before planning follow-ups.',
  'A saved or historical snapshot retains its original evidence date: reading another page does not refresh or re-verify it.',
]
export function renderAdaptiveSummary(result) {
  const warnings = (result?.warnings ?? []).join('; ')
  if (result?.restoration?.historical) {
    return `adaptive_search: historical snapshot (${result.restoration.originalFormat}${result.restoration.originalSchemaVersion === null ? '' : `, schema v${result.restoration.originalSchemaVersion}`}) — ${result?.pageResults ?? result?.results?.length ?? 0} on this page, ${result?.totalResults ?? 0} saved; original stopReason ${result?.stopReason ?? '?'}; not re-searched, re-screened or re-verified${result?.nextCursor ? '; nextCursor available' : ''}\n${warnings}`
  }
  const selection = result?.selection ?? {}
  return `adaptive_search: ${result?.pageResults ?? result?.results?.length ?? 0} on this page, ${selection.returned ?? 0}/${selection.requested ?? 0} saved — ${result?.stopReason ?? '?'}; ${selection.incomplete ? 'incomplete screening' : 'declared snapshot review finished'}; quantity is not research completion${result?.nextCursor ? '; nextCursor available' : ''}\n${warnings}`
}
export function adaptiveTextContent(result) {
  return [{ type: 'text', text: renderAdaptiveSummary(result) }, { type: 'text', text: JSON.stringify(result) }]
}
