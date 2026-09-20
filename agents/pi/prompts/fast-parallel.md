---
description: Fast parallel search — one authorized searcher wave, then parent synthesis
argument-hint: "<question>"
search-boost: owned
---
Apply the shared workflow below in **fast mode**: one searcher wave only. The parent synthesizes the reports; do not launch a summarizer or a second wave.

Pi binding: call `search-parallel-subagent` with `{"tasks":[{"agent":"searcher","task":"..."},...]}`. The caller chooses the wave size; this tool has no concurrency cap. Follow the task budget and delegation permissions.

{{RESEARCH_WORKFLOW}}

Question: $@
