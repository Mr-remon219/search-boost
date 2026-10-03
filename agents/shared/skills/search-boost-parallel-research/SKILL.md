---
name: search-boost-parallel-research
description: Research independent web questions with authorized host subagents, then synthesize cited evidence and gaps. Use for requested parallel or multi-angle research, not ordinary lookups. Check child MCP access before fan-out; disclose serial fallback when delegation is unavailable.
---

<!-- search-boost: skill -->
# Parallel research

{{MCP_CONTEXT}}

This is a workflow, not an additional MCP tool or an installed subagent definition. The parent owns the research plan and final acceptance, and runs it using the chosen host runner's existing capabilities and permissions. A workflow load does not authorize delegation; no Pi installation or CLI is needed.

## Host execution

{{PARALLEL_HOST}}

{{RESEARCH_WORKFLOW}}

## Searcher instructions to pass to each research child

{{RESEARCH_SEARCHER}}

## Summarizer instructions

Pass the question, all reports with their run status, prior synthesis, and remaining budget. Prefer parent synthesis in fast mode; a separate summarizer is optional and must not search. Use a no-tools child only if the host can enforce it; otherwise summarize in the parent.

{{RESEARCH_SUMMARIZER}}
