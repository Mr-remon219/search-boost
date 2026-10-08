// Shared call-level contract; field modes/limits live in input.js and detailed
// examples/recovery explanations in the optional MCP policy resource.
export const ADAPTIVE_TOOL_NAME = 'adaptive_search'
export const ADAPTIVE_DESCRIPTION = [
  'Use for higher-quality evidence selection on medium-to-high difficulty or uncertain research questions. When enabled with a configured judgment model (Jev or Laya), prefer it over fused_search if sources are noisy, relevance is unclear or many plausible leads need screening against the research intent. Call it directly; no preliminary fused_search is required.',
  'Use fused_search when direct retrieval is sufficient, varied queries or explicit source control are needed, or Adaptive is unavailable. A judgment model being configured alone is not a reason to use Adaptive for every search.',
  'Supply ONE full question and its intent. The selected judgment model selects a fixed ranking/community strategy; one fused search retrieves a target-dependent bounded Web/community snapshot. The Web query is the original question; only explicit caller-supplied platform queries may override their community leg. The whole declared snapshot is reviewed before selection, even if the requested count is already met.',
  'Community retrieval uses the same fused base and configured adapters, not a second community_search call. Select supported platform arrays and use the shared platform_options contract; routes, partial failures and selected source provenance are disclosed. Snapshot reads do not acquire or screen community evidence again.',
  'Returns ranked extracts admitted as safe with established value 3/4/5, plus selection, diagnostics, usage and warnings. Value labels and scores do not verify claims; targetMet means quantity only. Failed or unavailable judgments and unreviewed material are disclosed.',
  'No query expansion or automatic full-page reading; no self-imposed cumulative cost, token, request-count or total-duration quota. Request timeouts, limited retries, safety refusals and cancellation still apply.',
  'Supports optional local saving and zero-network pagination/recovery. Historical snapshots are not fresh evidence. Requires a configured judgment model (Jev or Laya); it receives the question, intent and necessary fragments, never engine credentials.',
  'The parent still owns source verification, follow-up research and the final answer. Use fetch_page for known URLs and community_search with engines:["x"] for X-only tasks.',
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
