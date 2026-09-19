---
description: Fast parallel search — spawn searchers once, then continue
argument-hint: "<question>"
search-boost: owned
---
Use the search-parallel-subagent tool for a single parallel wave, then continue your own work.

1. Split this question into independent searcher tasks. You choose how many — the tool does not cap concurrency. Pass every task in one `tasks` array:
   `{ "tasks": [{ "agent": "searcher", "task": "..." }, ...] }`
2. Wait for the reports. Synthesize them yourself. Cite URLs. Mark single-source claims.
3. Do not call summarizer. Do not start a second wave.

{{RESEARCH_WORKFLOW}}

Question: $@
