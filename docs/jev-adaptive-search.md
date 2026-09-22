# Jev adaptive search: keyword targets and paginated results

This documents the current working-tree implementation, not an npm release promise.

## Public tool input (MCP, Pi and DSH)

Supply **exactly one** of `tasks`, legacy `questions`, or a pagination `cursor`.
`page_size` is optional for either a new search or a page read.

```json
{
  "tasks": [{
    "context": "ExampleDB 4.2 upgrade impact",
    "targets": [
      {
        "id": "compatibility",
        "keywords": ["breaking changes", "不兼容变更"],
        "question": "What incompatible changes affect an upgrade from 4.1 to 4.2?"
      },
      {
        "id": "migration",
        "keywords": ["migration guide", "升级指南"],
        "question": "What migration steps address those changes?"
      }
    ]
  }],
  "page_size": 20
}
```

- 1–6 tasks, each with a nonblank context of at most 400 characters.
- 1–4 targets per task, at most 12 targets across the call.
- Target IDs are unique within a task: 1–64 ASCII letters, digits, `_` or `-`.
- Each target has 1–4 nonblank keyword alternatives, at most 100 characters each,
  and an acceptance question of at most 400 characters.
- Keywords guide retrieval; **mentioning them does not satisfy the question**.
  Synonyms belong to one target, not separate acceptance checks.
- Put the stable entity/product/scope in `context`; keep it concise. Avoid placing
  every desired fact in every query. Put required conditions in the target question.
- Legacy `{"questions":["..."]}` still accepts 1–6 independent strings, each at
  most 400 characters. Identical target text, hints and time constraints reuse
  execution. Invalid input is rejected rather than silently shortened.

An optional task-level `time_range` provides inclusive calendar-day constraints:

```json
{
  "start": "2026-07-19",
  "end": "2026-07-19",
  "basis": "event"
}
```

`basis` is `event` or `published`. Publication dates and event dates are not
interchangeable. Implicit today/yesterday uses the UTC calendar day at call start,
reported in warnings. Explicit ISO dates in acceptance questions (including legacy
questions) also create a date window, reported with its basis and bounds. Dates in
task context alone do not impose a hard window; “as of”/“截至” wording is treated as
a knowledge cutoff, not a same-day event requirement. For precise temporal intent, prefer `time_range`. Current event extraction
is conservative: it recognizes ISO-dated event statements, not arbitrary dates in
URLs or titles; unsupported/ambiguous date wording stays unknown. This can exclude
valid sources and is not a general temporal-language parser.

## Public output

The tool returns a **flat list of approved URLs and extractive descriptions**, not
its internal evidence table or per-target score matrix:

```json
{
  "results": [{
    "url": "https://example.com/releases/4.2",
    "title": "ExampleDB 4.2 release notes",
    "description": "An excerpt of the material Jev actually reviewed."
  }],
  "totalResults": 37,
  "nextCursor": "opaque-cursor-returned-by-the-server",
  "expiresAt": "2026-07-19T12:30:00.000Z",
  "coverageComplete": false,
  "stopReason": "budget_rounds",
  "warnings": ["Some targets remain uncovered; approved URLs are not a complete answer."]
}
```

Only currently assessed, source-qualified material is returned. Navigation-only,
unassessed, injection-suspected, off-topic and date-unqualified candidates are
excluded. One canonical URL appears once; repeated search-engine discoveries are
not independent corroboration. Descriptions are reviewed excerpts, not generated
claims. Results are ordered by Jev source judgments rather than fusion weights.

**Approval is not independently verified truth.** A source can support part of a
target even when that target remains uncovered. `coverageComplete` reports target
coverage, not exhaustive discovery of all matching web pages. Empty results do not
prove absence. If Jev fails before assessment, fallback retrieval may collect
internal material, but unassessed links are not promoted into public results.

Read more with the same tool:

```json
{"cursor":"<nextCursor>","page_size":20}
```

- Page reads perform **zero searches, page fetches or Jev calls**, and do not need
  Jev credentials to remain configured.
- Page size defaults to 20, with a maximum of 50; result rows use a soft 45 KB
  byte budget (metadata is additional). A single oversized row is returned intact
  with a warning rather than truncating its URL or dropping an approved result.
- **There is no fixed cumulative approved-result count cap.** The old six-items-
  per-question diagnostic preview does not constrain public results.
- Retrieval is still bounded by deadlines, rounds and request/token budgets. Not
  capping result count does not mean unlimited execution or guaranteed volume.
- `nextCursor: null` means all collected approved results have been returned,
  not that every research target passed or that the web has been exhausted.
- Cursors are local to the running server process. Results are retained for up to
  30 minutes and 32 recent result sets; restart, expiry or eviction invalidates
  them. An expired cursor returns an error, never silently reruns research.
- Do not combine a cursor with tasks/questions. Page reads do not extend expiry.

This replaces the previous public question/evidence/usage object. The internal
loop still produces diagnostics (schema version 2); the evaluation harness requests
those explicitly with the programmatic `diagnostics: true` option. That option is
not a tool parameter and cannot be used to bypass the approved-only result policy.

## Three-stage round

Each round makes **at most three logical Jev requests**, one for each phase:

1. **Plan:** task context, unresolved acceptance targets, query candidates, engine
   traits, previous retrievals/failures and remaining budgets. Jev chooses a query
   strategy and engines or a permitted read/review/stop action. Code then searches
   or fetches pages through the existing core transports.
2. **Score:** newly arrived or changed fragments, with distinct relevance,
   substantive-support, premise-conflict and injection checks. Temporal targets
   add a time-match judgment. Canonical URLs appear once in a source registry;
   target-specific fragments reference that registry rather than duplicate bodies.
3. **Coverage:** only qualified evidence for each target. Jev judges completeness,
   disagreement and (when needed) snippet sufficiency, plus a closed-set missing
   category. Code combines these independent answers with hard constraints to
   continue or stop. Planning the next retrieval happens in the next round's first
   request, not a fourth request.

Empty/unchanged phases can be skipped; cancellation and budget stops never make
filler requests just to reach three. HTTP retries are counted separately. Oversize
batches defer whole plans or judgments rather than split into extra calls. Deferred
unassessed material is not returned as approved evidence.

Jev's API supports typed `choice` and `noul`, **not free-form query generation**.
The calling agent supplies target questions and keyword alternatives. Code builds
bounded combinations of context, one alternative and explicit constraints; Jev
selects them. It can change engines or reuse a healthy engine with a new query.
Missing categories (fact, official source, date, region, independent corroboration)
feed subsequent query options; they are not an unrestricted generated subquestion.

The default fusion weights remain unchanged. Adaptive retrieval reserves candidate
opportunities per selected engine before final source assessment, so fusion weights
cannot crowd every low-weight engine out before Jev sees any of its candidates.
The candidate pass prefers up to two rows per domain, then fills unused slots if
only same-domain alternatives remain. It honors the score floor but intentionally
does not add a single-engine discount: engine consensus is not source verification.
Repeated failures temporarily exclude an engine across targets for this call.
A failed page read is not retried each round; exact engine/query/depth combinations
are not repeated, and follow-up choices are restricted to unexecuted combinations. No
selection can enable a disabled/unconfigured engine or change the persistent pool.

## Evidence, budgets and remaining limits

- Sources are URL-keyed; associations are target × source. Sharing a URL does not
  share a relevance verdict or a snippet selected for another target.
- Source judgments are bound to exact fragment versions; unchanged judgments are
  reused. Changed material invalidates old judgments. Coverage uses qualified-set
  signatures to avoid unchanged re-evaluation.
- Boilerplate filtering also applies on the excerpt fallback path and to snippets.
  This is a heuristic cleaner, not a guarantee that every advertisement is removed.
- Explicit date eligibility is a code gate plus a model judgment. Unknown dates
  cannot be compensated for by a high relevance/coverage score.
- Source and coverage thresholds are heuristic and require evaluation; `0.85`
  coverage is not a claim of 85% factual accuracy.
- Source batch selection rotates among targets. Fetch scheduling gives targets
  with fewer successful page reads earlier opportunity. It is not an optimal
  information-gain scheduler or a guarantee of equal spend.
- Deduplication is URL-level, not a general cross-publisher event clustering system.
- A source `description` can still be a search snippet. Full-page reading is not
  mandatory when the snippet is sufficient for the specific target.
- The model cannot raise limits, lower thresholds, or change credentials. See
  [`limits.js`](../lib/search/adaptive/limits.js) for execution ceilings.

## Implementation map

| Module | Responsibility |
| --- | --- |
| `lib/search/adaptive/input.js` | Shared input schema, strict task/target normalization |
| `lib/search/adaptive/planning.js` | Query alternatives and per-engine candidate selection |
| `lib/search/adaptive/material.js` | Unique-source wire representation and request-size accounting |
| `lib/search/adaptive/loop.mjs` | Three-phase scheduling, budgets, partial results and diagnostics |
| `lib/search/adaptive/prompts.js` | Typed plan/source/coverage questions |
| `lib/search/adaptive/evidence.js` | Source/target associations, cleaning, provenance and versions |
| `lib/search/adaptive/temporal.js` | Conservative calendar-date constraints and witnesses |
| `lib/search/adaptive/pages.js` | Approved-only projection and process-local cursors |
| `lib/runtime.mjs` | Shared execution and public paginated entry point |
| `adapters/{mcp,pi,dsh}` | Matching host input/output contracts |

## Configuration, network and privacy

Configure Jev with `search-boost config jev` or the TUI. Credentials/endpoint come
from canonical configuration, never model-selected engines or tool parameters.
Without credentials a new research call returns `not_configured` without network
requests. Existing result pages remain readable. Readiness is not connectivity.

The configured Jev service receives task text and required evidence, never engine
credentials or fingerprints. Queries go to selected engines; URLs can go to the
existing page-fetch fallback. The shared network policy, cancellation, bounded
retries and credential-bearing redirect protections remain in force. This feature
does not grant delegation or authorize persistent configuration changes.

Source pools and paginated results are in process memory. This is not a promise of
no persistence: hosts can retain tool results and audit/session history. The
programmatic diagnostic/evaluation path can retain more than public tool output.

## Validation and primary references

```bash
npm run test:adaptive
npm run test:jev-client
npm run test:adapters
npm run test:mcp
npm run test:fusion
npm run test:search
npm run check
```

The tests use deterministic fixtures, not live-service accuracy or cost claims.
`jev:probe` and `eval:adaptive` are separately opted-in network exercises and can
incur charges. No threshold calibration or search-quality improvement should be
inferred solely from an offline green suite.

- [TypeSafe API](https://docs.typesafe.ai/api): typed request/response protocol.
- [TypeSafe primitives](https://docs.typesafe.ai/primitives): independent judgments
  in one request; genuine dependencies belong in a subsequent request.
- [TypeSafe Noul](https://docs.typesafe.ai/primitives/noul): probability semantics,
  separate conditions and application-specific thresholds.
- [Azure agentic retrieval](https://learn.microsoft.com/en-gb/azure/search/agentic-retrieval-overview):
  focused subqueries and merged retrieval; architectural context, not a benchmark
  for this implementation.
