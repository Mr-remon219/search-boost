# Prompt responsibility contract

SearchBoost uses progressive disclosure, not several copies of one system prompt. Ordinary tool calls must work without loading a skill, reading an MCP resource or requesting a routing plan.

| Surface | Owns | Does not own |
| --- | --- | --- |
| Tool description | Purpose, appropriate call, output meaning and important limitations. Shared contracts live in `lib/search/tool-descriptions.js`, `routing.js` and `lib/search/screening/describe.js`. | Repeating a multi-wave workflow or installing/configuring tools. |
| Parameter schema | Field semantics, types, enums and bounds supported by that host. | General research policy or authorization to mutate configuration. |
| Startup / inject policy | When external verification is needed, when it is unnecessary, source handling, stopping and permission boundaries. | Full schemas, provider implementation details or promised latency. |
| Dynamic capabilities | Configured/enabled engines, current compatibility defaults and optional feature readiness. | Credentials, proof of connectivity or permission to enable a feature. |
| Optional skill / prompt template | A workflow the parent chooses: task split, evidence handoff, gap review and synthesis. | A prerequisite for ordinary search, or a new tool capability. |
| Child-role prompt | One role's job, tool restrictions and output format. | Deciding the parent's entire research plan or inventing more permissions. |
| Core code | Network safety, actual budgets, validation, cancellation and enforceable tool isolation. | Delegating security enforcement to text instructions. |

## Host bindings

MCP instructions and host inject files route to directly callable tools. `search-boost://policy` is optional reference material; `search_routing` is an explicitly requested planning aid. Host skills link optional workflow extensions rather than restating all tools.

Pi's `before_agent_start` adds the verification policy and refreshes capabilities. Tool `promptSnippet` identifies a capability; `promptGuidelines` supplies only a small interpretive/host boundary, not a duplicate schema. `/fast-parallel` and `/complex-parallel` select a mode and include the shared workflow once. Pi's runner leaves wave size to the caller: prompt-level budget guidance is not a hard concurrency limit.

DSH's policy section supplies the verification/authorization boundary and includes `agents/shared/research/workflow.md` once. Native `research_parallel` describes its invocation and reports execution outcomes; it does not silently fall back to Pi. Searcher and summarizer roles reuse the shared role texts.

The parent's search rounds, parallel searcher waves and Jev's single screening pass are different counters. A skill cannot raise a code limit, and a code limit is not an instruction to consume it. Prefer stopping as soon as sufficient evidence is available.

## Evidence and failure language

`fused_search` is one search operation; `fetch_page` reads a known URL; `x_search` retrieves available X material; `adaptive_search` performs ONE bounded pass for one research question with a required intent: a single fixed-option strategy request picks the ranking preset (and the community branch when the caller omits it), one bounded fused snapshot of at most 32 candidates is screened with fixed safety/value/discount/preference options, and only safe value 3/4/5 material is returned. There is no keyword-continuation loop, no per-material constraints gate, no language check, no automatic page read and no self-set cumulative budget stop; it is not an answer generator or delegation tool. The parent still owns the answer.

Do not claim complete threads, guaranteed real-time results, a fixed latency, identical results at different reasoning settings, or a fixed token-saving percentage. A `focus` miss is not evidence of absence. `retrievalSufficient` is a model judgment of keyword search satisfaction, never answer completeness or independently established truth. Domain count alone is not corroboration; an authoritative single source is not automatically invalid.

For adaptive results, preserve the code-capped structured evidence in model-visible output, not merely in UI-only metadata. Show output truncation explicitly and never say omitted evidence is available in a structured result that no longer contains it.

A safety/proxy block, denied permission or cancellation is not an invitation to fetch via `curl`, install another runtime or spawn a child. Offer only permitted alternatives. Search failures do not authorize changing a persistent layer or credentials.

Privacy language must distinguish the in-memory core from host session/audit retention. Jev questions and necessary fragments go to the configured endpoint; the Jev body must not include engine credentials or fingerprints. Jev authentication is canonical-config-only, not an environment fallback.

## Editing and validation

Edit authored assets in `agents/`; run `npm run plugin:sync-grok` for generated Grok assets. The install/skill/adapter tests exercise template expansion, ownership and injection. ``test:network` includes release regressions for security; `test:screening`, `test:adaptive` (with the real MCP/Pi/DSH host fixtures) and the persistence suite verify the shared v5/historical contract and that every host's full adaptive result stays model-visible.

When adding a feature, put each rule on the narrowest applicable surface. Brief routing/boundary reminders may recur where needed; copied schemas and duplicated workflow paragraphs should not.
