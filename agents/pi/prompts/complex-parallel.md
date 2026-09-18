---
description: Gap-driven parallel search — searchers, then summarizer, then more searchers if needed
argument-hint: "<question>"
search-boost: owned
---
Use search-parallel-subagent to research this question. You choose parallelism and the max number of waves. Finish in as few waves as you can — do not make the user wait for completeness theater.

Default to 1–2 waves. Hard cap 3. Stop earlier if the summarizer says `need_another_round: no`, if leftover gaps are edge-cases, or if another wave would repeat the same angles.

Each wave:
1. You pick N independent searcher tasks (no tool-side cap). Call once:
   `{ "tasks": [{ "agent": "searcher", "task": "..." }, ...] }`
2. Hand every report to one summarizer:
   `{ "agent": "summarizer", "task": "Research question: ...\n\nReports:\n..." }`
3. If `need_another_round` is yes and you are under the cap, launch only the summarizer's next tasks. Otherwise synthesize the final answer with citations and stop.

Question: $@
