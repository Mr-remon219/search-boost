---
description: Gap-driven parallel search — authorized searchers, a summarizer, and material follow-up
argument-hint: "<question>"
search-boost: owned
---
Apply the shared workflow below in **complex mode**: default 1–2 searcher waves, at most 3. Stop earlier when evidence is sufficient, the summarizer reports `need_another_round: no`, or the remaining gaps are marginal. The parent owns the final decision and answer.

Pi bindings through `search-parallel-subagent`:
- Searcher wave: `{"tasks":[{"agent":"searcher","task":"..."},...]}`. Choose the wave size within the task budget; this runner has no concurrency cap.
- Gap review: `{"agent":"summarizer","task":"Question, all reports, execution statuses, and prior synthesis"}`. This child has no tools. A proposed next wave is not permission to spawn it.

{{RESEARCH_WORKFLOW}}

Question: $@
