# Jev adaptive search: implementation reference

This document describes the current `jev` / `v0.2.0` implementation, not a future roadmap. Historical design drafts remain in Git history. The package version or branch name alone does not mean this code has been published to npm.

## Role and entry points

`adaptive_search` is an optional bounded evidence-collection loop. It accepts `questions`, an array of 1–6 nonblank strings of at most 400 characters each. Identical questions share execution but retain separate output positions. Invalid input is rejected, not silently truncated.

Use `fused_search` for a precise lookup, `fetch_page` for a known public URL, and `x_search` for X-specific retrieval. Use `adaptive_search` when automatic follow-up and per-question evidence assessment are useful. It is not a subagent runner, a final-answer generator or an independent fact checker.

MCP, Pi and DSH register the same core operation. The tool remains discoverable without a Jev credential: a call then returns `not_configured` without making a network request. Direct search/read/X tools do not depend on Jev. Capability output reports configuration readiness, not successful connectivity.

## Configuration authority

Run `search-boost config jev` or use the TUI. The Jev endpoint and key come only from the canonical `config/keys.json` under `~/.search-boost/` (relocatable with `SEARCH_BOOST_HOME`). `TYPESAFE_API_KEY`, a project keys file, legacy adapter files and `SEARCH_BOOST_KEYS_FILE` cannot supply the Jev block. Clearing it does not resurrect an environment or legacy key.

Jev is not a search engine. It never joins `KEY_NAMES`, engine routing or the API-engine pool. Other providers retain their own documented compatibility rules; the Jev config-only rule does not remove Tavily/Brave/Exa or X environment fallbacks.

Relevant code: [`lib/jev-config.mjs`](../lib/jev-config.mjs), [`lib/keys.mjs`](../lib/keys.mjs), and [`lib/private-file.mjs`](../lib/private-file.mjs).

## Client protocol and trust boundary

The client sends `POST {baseUrl}/systemone` with a bearer credential and a JSON body containing `state`, `model` and typed `questions`. The default service is TypeSafe; a user-configured base URL can select a different gateway. The model alias is defined in `JEV_DEFAULT_MODEL`, not repeated as a version promise in prompts.

The two primitives used here are:

- `noul`: a probability for the supplied yes/no criteria. There is no separate confidence field to invent.
- `choice`: a selection from the supplied closed set, with its supported probability/confidence fields.

Code validates expected IDs, types, finite probability ranges and offered choices. Missing or invalid answers are missing signals, not zero scores or successful judgments. Unknown IDs are ignored and bounded in diagnostics. Response validation verifies shape, **not the truth of the response**.

Retries, HTTP attempts, request sizes and deadlines are bounded. Credential-bearing redirects are not followed. Errors expose controlled diagnostic codes, not raw response bodies; echoed credentials in server error/model/unknown-ID metadata are suppressed.

See [`lib/jev/client.mjs`](../lib/jev/client.mjs), [`lib/jev/questions.js`](../lib/jev/questions.js), and the [TypeSafe API reference](https://docs.typesafe.ai/api).

## Execution flow

1. Validate input and credential readiness; establish the host deadline and the available engine set. No allowed engines produces `no_engines`, not an automatic configuration change.
2. Canonicalize duplicate questions and build per-question evidence state. Ask Jev to choose from the engines/actions actually offered by code.
3. Reserve the relevant budgets before dispatch. Reuse the existing search/fetch core rather than create a second transport or bypass engine restrictions.
4. Associate material with each question and retain its provenance and reviewed text. Judge relevance, whether the text states evidence, premise conflicts and suspected prompt injection separately.
5. Fetch useful pages within the remaining budgets when snippets are insufficient. A text change invalidates judgments tied to its previous version.
6. Assess coverage from eligible, reviewed evidence, expose conflicts and missing requirements, and continue only when a permitted action can address a useful gap. Return partial results on a stopping condition.

The core owns the hard limits. The model cannot raise a budget, enable an engine or lower a threshold through tool arguments. The parent agent still owns the overall user task and the decision to make another tool call.

Implementation map:

| Module | Responsibility |
| --- | --- |
| [`lib/runtime.mjs`](../lib/runtime.mjs) | Shared host entry point and existing core operations. |
| [`lib/search/adaptive/loop.mjs`](../lib/search/adaptive/loop.mjs) | Scheduling, budgets, cancellation, degradation and final results. |
| [`lib/search/adaptive/engine-brief.js`](../lib/search/adaptive/engine-brief.js) | Available-engine briefs, not credential transport. |
| [`lib/search/adaptive/prompts.js`](../lib/search/adaptive/prompts.js) | Typed planning/evidence/coverage questions. |
| [`lib/search/adaptive/evidence.js`](../lib/search/adaptive/evidence.js) | Question/source associations, text versions and evidence state. |
| [`lib/search/adaptive/limits.js`](../lib/search/adaptive/limits.js) | Authoritative budgets, per-host deadlines and heuristic thresholds. |
| [`lib/search/adaptive/describe.js`](../lib/search/adaptive/describe.js) | Shared tool wording and host-independent rendering. |

## Result interpretation

Each input position receives a question result:

| Status | Interpretation |
| --- | --- |
| `covered` | The eligible reviewed fragments met the current model-judged coverage conditions. **Not independently verified truth.** |
| `insufficient` | The assessed material did not satisfy the coverage conditions. |
| `unassessed` | Material or a question lacks a valid assessment; do not substitute confidence from retrieval ranking. |
| `not_searched` | No search was completed for this question. Inspect the stop reason and budget state. |
| `failed` | Execution could not produce a usable result for this question. Inspect its reasons. |

Read `assessed`, `coverage`, `evidence`, `uncoveredReasons`, `conflicts` and `searchedEngines` together. Evidence preserves identifiers, URLs, source engines, reviewed fragments, text basis/version and assessment status. `textBasis` distinguishes snippets, engine content and fetched-page material. Unassessed, off-topic or suspected-injection material must not silently become supporting coverage.

The aggregate result exposes `stopReason`, `stopDetail`, rounds, usage, engine attempts, Jev degradation, warnings and output truncation. A numerical coverage probability is a heuristic model judgment, not a calibrated correctness rate. Different judgment types are not summed into one truth score. `insufficient` or an empty result does not prove that the requested fact does not exist.

A degraded plain-search fallback can collect useful material, but newly collected material without a valid Jev assessment stays unassessed. Fatal client problems disable Jev for that call. Budget exhaustion and cancellation must not start unlimited follow-up work.

## Evidence visibility and output limits

The compact summary is navigation, not the entire evidence record. MCP returns the core result in `structuredContent`. Pi preserves that result in `details` **and** includes the bounded JSON as model-visible text. DSH also renders the bounded JSON alongside the summary. This avoids a host UI metadata field becoming the only place where reviewed evidence exists.

Output limits can omit evidence. `evidenceCount`, `evidenceTruncated` and `outputTruncated` expose this; the summary distinguishes extra returned items from items omitted by a cap. It never describes omitted items as available in a hidden structured result. A parent should answer from the material actually returned and describe important gaps.

## Network, privacy and authorization

Queries go to the selected engines; fetched URLs may go to Jina Reader. Questions and the necessary evidence fragments go to the configured Jev service. Engine credentials and key fingerprints do not belong in the Jev body.

The core evidence pool is in memory. **This is not a promise of no persistence:** hosts can retain conversation/tool results and audit events. Pi's search audit can record queries and source URLs; `/search-audit clear` affects that audit, not host conversation history. Local credential files are private configuration, not encrypted storage.

The existing shared network policy governs service requests and arbitrary page fetches. Local page connections validate and pin resolved addresses; failure to support a proxy is explicit, not permission to use a shell/network bypass. The tool does not configure credentials, change persistent layers or grant delegation permissions.

## Prompt responsibilities

Descriptions/schemas own selection and argument contracts. Injected text owns the small verification/budget/authorization policy. Dynamic capabilities own current readiness. Skills own multi-step workflow and child-role guidance. Executable code owns enforceable limits and security checks. None is a prerequisite ceremony before calling an otherwise suitable tool.

Jev rounds, a parent agent's search rounds, and parallel-subagent waves are different counters. Avoid copying the loop's changing numerical limits into host prompts or README promises. See [the prompt responsibility contract](prompt-contract.md).

## Verification

```bash
npm run test:jev
npm run test:jev-client
npm run test:adaptive
npm run test:keys-authority
npm run test:network
npm run test:adapters
npm run test:mcp
```

These tests cover deterministic fixtures, not a live-service accuracy or cost claim. `jev:probe` and `eval:adaptive` are separate, explicitly invoked network exercises that require appropriate credentials and can incur charges. Do not infer live provider availability, calibrated accuracy, pricing or universal host compatibility from an offline green test suite.
