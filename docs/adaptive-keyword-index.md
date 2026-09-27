> 历史设计/实现记录：描述 V2 事实验收控制器，已不再是默认行为。当前 V3 意图导向搜索见 [实现契约](jev-adaptive-search.md)。原实验结论与哈希保持历史含义。

# Fact-aware keyword readiness (working tree)

The default `adaptive_search` controller now implements the
[fact-aware design](jev-evidence-design.md). This is **not a calibrated probability
of truth or a promise of exhaustive retrieval**. Model quality remains provisional.

## Flow and bounds

- Initial searches share **500 unique candidate URLs globally**, not per engine or
  per target. Ordinary public `fused_search` still returns at most 20.
- No extra engine-count cap; configuration, authorization, health and budgets
  still constrain which engines can run. Providers may return far fewer than500.
- Every source is assessed for each target it is associated with. Keyword
  relevance and evidence must each be **>0.60**; injection must be known and≤0.70.
  Dates/versions remain constraints. Partial material is not discarded merely
  because it cannot answer a whole compound question alone.
- Requests are micro-batched (at most24 associations and bounded serialized size).
  Global caps:72 logical Jev calls,80 HTTP attempts,1.2M estimated input tokens,
  6 rounds,30 searches and host120–150s deadlines. More facts/targets mean more
  judgments; a500-source pool can leave pending associations.

## Fixed facts, not new URLs

Targets may supply `facts: [{id, question}]` (1–8 fixed acceptance units). Otherwise
code splits explicit question/semicolon/newline separators. Ambiguous compound
prose remains one unit; this is not a free-form fact-generation model.

Each material is judged against each unit using typed support, stance and explicit
first-hand-provenance questions. Facts inherit full target scope. Date requirements
in individual facts also have code eligibility checks. Unknown attribution earns
no fact credit. Fact coverage is shared within a target across spelling alternatives;
a keyword still needs its own qualifying material to become ready.

When partial fragments jointly answer an unsplit compound unit, a bounded
`fact_bundle` request can assess their union. This earns F only, not first-evidence
A or independent-source R. It cannot raise budgets and is not repeatedly asked for
an unchanged pool. All constituent text versions/witnesses must reach the final
check, or the target cannot be declared covered.

## Index

```
A = max qualified keyword quality        (quality = min(relevance,evidence))
F = sum_f weight_f * max support_for_f    (fixed fact weights sum to1)
R = sum_f weight_f * bounded same-fact independent corroboration
S = 0.25*A + 0.90*F + 0.10*R
ready = keyword has qualifying evidence AND no missing acceptance facts AND S >1
```

R uses one best item per provenance group and stance. Only explicit first-hand
judgments>0.85 qualify for R; different domains/engines alone are not proof.
The first qualifying group is already represented by coverage; additional groups
get geometric weights1/2,1/4,1/8… . Support and refutation never corroborate each
other. Both strongest opposing witnesses are preserved for final conflict checking.

The constants satisfy algebraic bounds (base+corroboration cannot alone cross1;
one high-quality complete source can cross1). They are **engineering starting
values, not experimentally established optima**. The former V2 log-harmonic
formula and its global document-order discount are no longer used.

Exact copies and conservative site groups are merged for R. Near-copy grouping
uses bounded MinHash blocking and symmetric shingle similarity; it can miss
paraphrases and over-group public-suffix hosts. These discounts do not erase new
fact coverage: a same-site or mostly duplicated page can still supply a missing
condition. F does not increase merely because text is different.

## Subsequent rounds and completion

For U unfinished keywords out of K:

```
B_next = min(500,max(24,ceil(500*1.25*U/K)))
```

U=0 means final checking, not another search. The final checker uses actual
qualified witnesses, not only scores, and runs at most two global sweeps.
Coverage must exceed **0.85** (the experimental0.60 release gate was not adopted).
A known material gap, unknown requested judgment, unresolved conflict, missing
explicit condition or omitted necessary witness prevents release. Budget stops
remain honest partial results.

Up to4 union assessments run per round, with final-call/HTTP/token headroom.
Transient union-assessment failures do not end retrieval; fatal/configuration,
rate-limit, cancellation and budget failures still stop. Once ready, source draining
may pause to preserve final-check capacity while reporting pending honestly.

All scores are recomputed from current reviewed versions. Search rounds earn no
points; pending material is reviewed before expanding the pool. Repeated actions,
no progress, cancellation and deadlines bound continuation.

## Output and checks

Public pages include `keywordProgress` with A/F/R/score, ready, missing fact IDs,
fact support/conflict summaries and final target status, plus pendingAssessments.
Shared missingFacts/factProgress occur once, on the first keyword per target;
taskId/canonicalId disambiguate reused target names. All approved sources can be paged; the six-item diagnostic preview is not the
public result cap. Ready is never the same as covered.

- `npm run test:facts`: algebra, copies, independent repetition, late new facts,
  same-site complements, opposing stances, unknowns, fixed inputs and typed prompts.
- `npm run test:keywords`: default integrated controller,500-row resource pressure,
  global quotas, compound evidence unions, final vetoes, witness budgets and expiry.
- `npm run test:adaptive` and `scripts/test-recursion.mjs`: explicitly frozen older
  controller comparisons, not a substitute for testing the new defaults.

The new500-row synthetic check used33 logical calls and approximately877879
estimated input tokens. It is not a real-web500-result or accuracy experiment.
See [the implementation validation record](jev-fact-implementation.md).
