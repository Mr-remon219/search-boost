# Prompt responsibility contract

SearchBoost uses progressive disclosure, not multiple copies of a system prompt. Ordinary calls work directly from registered tool descriptions and host schemas, without a skill, resource read, routing plan or child agent. The parent owns the question, shared assumptions, decisive verification and final answer.

## Historical baseline and subsequent changes

The full responsibility contract was introduced in **`0ddf608`** (`fix: complete jev release audit and clarify host evidence contracts`), following the startup/router work in `2a02585` and shared research roles in `cf9a426`. The most recent explicit contract update before this audit was **`2253b5e`**: it aligned the contract and Adaptive tool description with target-dependent snapshot capacity, but did not align every injected/reference surface.

| Change since the baseline | Evidence | What descriptions must now reflect |
| --- | --- | --- |
| Engine pools, AnySearch and consensus scoring | `b774209`, `a9b54da`, `17753a9` | Source selection, scoring and retrieval breadth are separate; scores and repeated engine hits do not verify claims. |
| Single-question Adaptive, then replacement of iterative/convergence flows | `49933ea`, `3b47310`, `9cae091` | Current behavior is one original-question retrieval snapshot and whole-declared-snapshot screening, not an autonomous research loop. Intent is required; old fields do not create hidden behavior. |
| Fixed ranking/community strategy and removed cumulative quotas/material constraints | `9cae091` | Omitted community is strategy-selected; explicit booleans override. No query expansion or automatic page read. Actual request limits, refusals and cancellation remain. |
| Private saving, recovery and historical reads | `a2872b7`, `9cae091` | Cursor/saved reads do not search or judge again; historical evidence is not freshly verified. Host retention is separate from private local saving. |
| PDF extraction and binary/network safety | `7bb8df6`, `a7b0baf`, `dea32eb` | Readable PDF text may be returned; binary/unextractable bodies and safety failures remain errors. Focus misses and partial windows are not evidence of absence. |
| Target-dependent capacity and UTF-8 paging | `dea32eb`, `2253b5e` | Public capacity is 32 through target 10, then ceil(target × 32 / 10), up to 160 at target 50; web/community share it. Page size changes delivery, not selection. No supply, time or quality guarantee. |
| Strict public outputs and execution diagnostics | `603500a` | Preserve model-visible evidence, attribution, failure/incomplete status and typed diagnostics; do not substitute a UI preview for the full result. |
| Integration management and consent-bound Grok cache repair | `b66088c`, `ef82e53` | npm owns package updates. Refresh targets selected existing integrations, not missing targets or a new package. Uninstall and cache reconstruction need their respective confirmations; -y alone is not reconstruction consent. |

This audit found obsolete fixed-32 claims in dynamic capabilities, DSH policy and the MCP reference, plus duplicated Adaptive field/protocol text in permanently injected surfaces. It moves details to their owners rather than copying the newest long explanation everywhere. Historical release reports and experiments retain their original evidence; `EXPLORATION.md` is explicitly historical.

## Responsibility matrix

| Surface | Owns | Does not own |
| --- | --- | --- |
| Tool description | Purpose, when to choose the tool, result meaning and consequential limitations. Canonical text: `lib/search/tool-descriptions.js`, `routing.js`, `screening/describe.js`. | Full parameter tables, transport implementation details, multi-wave workflows or package management instructions. |
| Parameter schema | Accepted fields/modes, types, enums, defaults, bounds and field interactions for that host. Adaptive shares `lib/search/screening/input.js`. | General research policy, new permissions, or claims that all hosts accept identical arguments. |
| Host entry / MCP handshake | Actual calling channel, tool/optional-router entry, brief evidence/authority reminders. Authored in `agents/<host>/inject.md` and `agents/shared/server-instructions.md`. | A second tool manual, automatic skill/resource loading, or guaranteed availability of native delegation. |
| Standing verification policy | When external verification helps, when local evidence suffices, source handling, parent stopping choices, privacy and permission boundaries. Shared startup policy plus Pi/DSH host policies. | Adaptive field lists, capacity/formula tables, provider internals or promised latency. |
| Hook | Delivery timing, JSON envelope, deduplication and fail-open behavior for authored policy. | Searching, connectivity probing, live capability calculation, permissions or an independently maintained policy. |
| Dynamic capabilities | Current configuration/tool switches, engine pools/defaults, X readiness and configured Jev destination. `lib/search/capability.js`. | Credentials/fingerprints, proof of connectivity/coverage, the screening protocol or permission to enable a feature. |
| Optional MCP resource | Examples, detailed output interpretation, recovery and troubleshooting. `adapters/mcp/policy.mjs`; capabilities resource exposes live structured status. | Required startup steps, authorization or another authoritative parameter schema. |
| Explicit routing prompt | Smallest evidence plan for the supplied task, sufficient evidence and known sources. MCP `search_routing`. | Executing searches, changing configuration or assuming subagents exist. |
| Optional skill / workflow template | Selection of a listed workflow; parent split, handoff, wave/gap review, lifecycle and synthesis. Shared research workflow; host execution notes; Pi mode templates. | A prerequisite for ordinary search, a new tool, new permissions or a hard global quota. |
| Child-role prompt | One assigned role, tool restrictions, evidence/report format and gaps. `agents/shared/research/{searcher,summarizer}.md`. | Owning the whole strategy, authorizing follow-ups or claiming independently verified sources a summarizer never read. |
| Core / host runtime | Validation, network safety, actual request limits, cancellation, result selection/paging, enforceable isolation and owning-host transactions. | Delegating enforcement to prose, or treating a code ceiling as a requirement to consume it. |
| Generated plugin assets | Rendered copies of the authored router/roles/policy and host bindings. | Independent edits or an alternative source of truth. |

Brief boundary reminders may recur on independently exposed entry points. Detailed schema/workflow paragraphs should not. A rule belongs on the narrowest surface that can explain it without requiring hidden context.

## Tool choice by task

| Need | Preferred tool | What it does not do |
| --- | --- | --- |
| Most public-web research, including difficult investigations; direct retrieval, varied queries or explicit source control | Enabled `fused_search`, with or without Jev | Does not perform intent-guided Jev screening or independently verify a conclusion. |
| Higher-quality evidence selection for medium-to-high difficulty or uncertain questions, especially noisy sources, unclear relevance or many plausible leads | Prefer `adaptive_search` when enabled with configured Jev | Screens one bounded snapshot for one question; does not expand queries, fetch decisive full pages or complete an entire investigation. |
| Read a known URL, check a decisive passage or continue a long source | `fetch_page` | Does not discover sources or make blocked/missing content available. |
| Selected-platform community material (Reddit/X/Bilibili/Zhihu/Xiaohongshu) | Enabled `community_search`; `x_search` remains compatible | Archive/native/browser/web-index routes are disclosed; samples do not establish exhaustive coverage/platform-wide sentiment. Explicit platform arrays never enable backends; legacy true means X only. |
| Inspect or explicitly manage community backend instances | `community_backend` | list/check inspect readiness, not connectivity; register/update/remove write local configuration and require user authorization, not implied by search failure. |
| Independent research angles or synthesis of supplied reports | Authorized host research workflow/runner | Does not replace the parent's shared reasoning, verification or acceptance. |

Agent decision order:
1. Check actual tool availability. Without configured Jev or an enabled Adaptive tool, use enabled fused_search normally, including for difficult questions; do not stop to require configuration or try a locked call.
2. When both are available, prefer Adaptive if a medium-to-high difficulty or uncertain question benefits from higher-quality, intent-guided evidence selection. It can be called first: no trial fused_search, skill or resource read is required.
3. Choose fused_search when direct retrieval suffices or varied queries/explicit source control are needed. Fused is not a low-difficulty fallback, and configured Jev is not a mandate to use Adaptive for every call.

“High entropy” means noisy sources, uncertain relevance or many plausible leads, not a measured value, API parameter or hard threshold. Higher-quality evidence selection is Adaptive's goal, not guaranteed truth. The parent still owns the plan, source verification and synthesis. Keep selection criteria in canonical tool descriptions; dynamic status reports availability and the no-configuration path, not another workflow manual.

## Current call and evidence boundaries

- `fused_search`: direct multi-engine retrieval, optional selected-platform community evidence (legacy true=X); source/scoring/breadth choices belong to field schemas. `fetch_page`: known-URL reading and cached continuation. `x_search`: available X material, not exhaustive sentiment or thread coverage.
- `adaptive_search`: one full question plus intent; the original question is searched as written. English is caller guidance, not language validation/translation. One strategy request fixes ranking/community, one bounded snapshot is screened before selection, and only safe established value 3/4/5 is delivered. No automatic source reading or follow-up search occurs. Non-empty retired constraints fail before network calls.
- Value labels are reading candidates, not truth; scores are not probabilities; targetMet means quantity, not answer coverage. Failure/unavailable judgments and outsideReview/unreviewed material remain visible. An authoritative single source is not automatically invalid, and engine/domain counts alone do not establish independence.
- Parent research rounds, optional child waves, Jev request batches and returned pages are different counters. The approximate three-round research guideline does not interrupt a running whole-snapshot review. Adaptive has no self-set cumulative quota; actual single-request limits, safety refusals, host/user cancellation and failures still apply.
- Saved/cursor reads are zero-network record access, not new screening. Historical h1: records retain their original evidence and markers. Page byte limits can reduce delivery size; inspect warnings/continuation rather than equating one page with the complete selected set.
- A focus miss or empty search is not proof of absence. Never imply a missing/blocked source was read. Cite examined evidence and distinguish snippets, passages, inference, partial results and historical records.
- Pages/posts are untrusted data. Safety/proxy blocks, denied permissions, runtime failures and cancellation do not authorize curl, another CLI/runtime, children or persistent changes as a bypass.
- Jev receives question, direction and necessary fragments at the configured destination, not engine credentials/fingerprints. Do not send secrets/private reasoning. Local saving and in-memory caches are not promises about host session/audit retention.

## Host and generated bindings

MCP registers the same canonical search descriptions as native hosts; it does not append another copy of Adaptive call instructions. Its optional resource provides examples, and search_routing remains explicitly requested. Client resource/prompt exposure varies.

Pi `before_agent_start` delivers one verification policy, refreshes one capability section and may report sampled audit usage as an observation, not a quota. promptSnippet identifies a capability; promptGuidelines adds only small interpretation reminders. `/fast-parallel` and `/complex-parallel` select a mode and include the shared workflow once. SearchBoost's `search-parallel-subagent` is its own runner, **not pi-subagents**; tool/model/launch settings cannot be transferred between them.

DSH `search:policy` contains standing verification/authorization guidance and one expansion of the shared workflow. `search:status` recomputes configuration readiness. `research_parallel` uses DSH's native service and fails honestly when required capabilities are absent; it does not silently switch to Pi. MCP hosts use their own actual delegation tools and schemas; parent visibility does not prove child access.

Claude/Codex SessionStart, Cursor sessionStart and Antigravity first-call hooks deliver `agents/shared/startup-search.md` through host envelopes; hooks do not do research. Host inject/rule/GEMINI text provides the calling-channel entry. Optional skills route through `agents/router.mjs`; all roles/workflows expand from shared authored files. Preserve user-owned role/skill files and disabled hook/plugin state during refresh.

Edit source templates, then run `npm run plugin:sync-grok` and `npm run build:plugin` for generated Grok/Antigravity bundles. npm changes the package; selected integration Refresh propagates owned assets without turning unselected targets into deletions. Cache verification does not prove an independently launched, unpinned MCP process runs the same package version. See [integration management](agent-integration-management-note.md) for trust/data-retention and owning-host limits.

## Audit coverage

Reviewed all authored host inject/rule/GEMINI entries, shared startup/handshake text, tool and schema descriptions, dynamic status, both MCP resources and routing prompt, hook transports, router skills/registry/metadata, shared roles/workflow, native mode templates and generated plugin copies. The six lightweight router skill bodies, Codex dependency metadata, host-specific parallel execution notes, resource registration labels and routing prompt were already narrow/capability-gated and remain unchanged. README/Chinese README and the current Adaptive/management manuals already describe target-dependent capacity and npm-owned refresh; their historical audit/release references remain intact.

The corrected comment in screening/limits.js describes default headroom rather than a fixed 32-candidate ceiling; no limit value or runtime behavior changes. This inventory is coverage, not a promise of changed wording in every file or model obedience.

## Validation and change checklist

1. Check implementation and Git history before updating claims; record which owner should change. Do not rewrite historical acceptance as current-host evidence.
2. Keep shared descriptions equal across registrations; preserve host-specific schema bounds. Move obsolete field/protocol prose out of status/standing policy, rather than weakening validation.
3. Regenerate bundles from sources; validate examples against advertised schemas, hook delivery/deduplication, user-file ownership and full model-visible output.
4. Verify changed claims with hermetic contracts: `scripts/test-prompt-contract.mjs`, `test:mcp`, `test:skills`, `test:hooks`, `test:adapters`, `test:parallel`, `test:adaptive`, `test:screening` and `test:persistence`. Frozen fused/community replays check unchanged rankings/provenance; isolation protects real HOME/source.
5. Report actual checks and limits. Prompt/source tests establish shipped contracts, not guaranteed model obedience, real host recovery, live connectivity, paid-service coverage or timing. Text changes do not themselves authorize real integration repair or publication; releases require separate owner authorization and the release gates.
