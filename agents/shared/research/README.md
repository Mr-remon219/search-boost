# Shared parallel-research contract

## Ownership

- `searcher.md`, `summarizer.md`, `workflow.md`: canonical role/report and orchestration instructions. Searcher output maps claims to examined URLs; summarizer reads reports only. The parent makes final research and follow-up decisions.
- `lib/search/parallel-contract.mjs`: role expansion, task validation, citation-candidate extraction, per-task execution status and wave summary. URL extraction/domain counts are not source verification.
- Pi: `adapters/pi/search-parallel-subagent.js` retains child-process launch, model inheritance, JSONL parsing, cancellation and its existing bounded transient retry. Owned agent/prompt templates are expanded when installed; packaged fallback agent templates are expanded at runtime. User-owned installed role definitions remain authoritative.
- DSH: `lib/search/research.js`, called by the native adapter, uses DSH's subagent service. It does not call Pi or use Pi agent files. Both success and failure handles are disposed; startup is included in the deadline and late handles are observed/disposed. DSH does not auto-retry or choose an alternate provider after failure.
- MCP hosts: `agents/shared/skills/search-boost-parallel-research/SKILL.md` embeds the same roles/workflow plus `agents/<host>/parallel.md` execution notes at install/plugin-build time. No runtime outside the host is installed or invoked by this skill.

## Inputs and outputs

Native inputs are `{ agent: "searcher" | "summarizer", task }` or `{ tasks: [{ agent, task }, ...] }`, exclusively. The parent chooses the wave size. DSH retains legacy `{ query, sub_queries? }` (2–4 explicit queries; omitted queries get two heuristic angles); explicit tasks are preferred. A DSH `query` can also provide context alongside explicit role/tasks, but `sub_queries` cannot be mixed with them.

Shared native result fields include `results`, `okCount`, `sourceUrls`, `domains`, `totalTurns`, and `totalMs`. Each task carries `agent`, `task`, `ok`, `status`, `result`, `error` on failure, `sources`, `domains`, `tookMs`, `attempts`, `turns`, and `truncated`. DSH does not report turn counts through the seam, so its turn counters are zero/unavailable. Its legacy `query`, `sub_tasks`, `merged_sources`, `took_ms`, and `note` fields remain available.

`ok` means execution completed with nonempty text, **not that every claim is proven**. Failed/partial reports remain available but their URLs are excluded from the successful aggregate. Reports longer than 50,000 characters are explicitly marked truncated; extracted URLs only cover retained text. Summarizer conclusions and reports with a BLOCKED note still require parent inspection even if the model turn completed normally.

Fast/complex wave limits are workflow instructions, not global quotas enforced across independent tool calls. The native mechanisms enforce their documented tool isolation and cancellation behavior; a skill can only request controls its host provides.

## Host API evidence

DSH seam verified against upstream revision `ddefc45fbc7f8e46dd73185e68295696d1297887`:

- [Subagent request, capability and disposal contracts](https://github.com/deepseek-ai/deepseek-harness/blob/ddefc45fbc7f8e46dd73185e68295696d1297887/packages/subagent/subagent/src/types.ts)
- [Provider discovery and start](https://github.com/deepseek-ai/deepseek-harness/blob/ddefc45fbc7f8e46dd73185e68295696d1297887/packages/subagent/subagent/src/index.ts)
- [Native spawn provider](https://github.com/deepseek-ai/deepseek-harness/blob/ddefc45fbc7f8e46dd73185e68295696d1297887/packages/subagent/subagent-spawn-in-process/src/index.ts)
- [ToolRestriction allow/deny contract](https://github.com/deepseek-ai/deepseek-harness/blob/ddefc45fbc7f8e46dd73185e68295696d1297887/packages/core/tools/src/index.ts)

Default provider `spawn` must advertise `inheritsParentContext: false` and `toolFilter`, `depthLimit`, `persona`. The plugin can explicitly configure `researchProvider`, but never silently chooses a different provider. Unsupported/older profiles fail before child launch; deployment configuration remains the user's decision. Searchers receive `toolFilter: { allow: ['fused_search', 'fetch_page'] }`; summarizers receive `{ allow: [] }`. The absolute `maxDepth: 1` permits children of the main agent, not nested research delegation.

MCP host guidance is based on official [Claude subagent](https://code.claude.com/docs/en/sub-agents), [Codex subagent](https://developers.openai.com/codex/subagents), and [Cursor subagent](https://cursor.com/docs/subagents) documentation. The installed client's actual tools and permissions always take precedence. Grok and Antigravity notes intentionally do not assert a particular subagent API; their skill paths are capability-gated. No skill installs a custom host agent or changes permissions/features.

## Verification and remaining limits

`npm run test:parallel` exercises common role/result contracts, DSH provider preflight, concurrent dispatch, no-tools summarization, legacy calls, failure/empty/refusal handling, deadline/cancellation/late-handle cleanup, Pi JSONL dispatch through a deterministic process double, and DSH adapter schema/forwarding. `npm run test:skills` verifies all six host installations, rendered role/host notes, router links, migrations, user-file preservation, and plugin parity.

These are hermetic tests, not live authenticated model research. They cannot prove a specific installed host grants child MCP access, obeys every prompt instruction, or completes cancellation correctly. Smoke-test the first real bounded research task in the target host before larger fan-out; report the actual limitation rather than claiming universal subagent support.
