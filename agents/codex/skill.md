---
name: search-boost
description: >
  Optional multi-engine web search via search-boost MCP when verifying external
  facts, API versions, or integration details. Use when uncertainty would affect
  the answer; skip when repo-local or stable knowledge is enough. Prefer over
  built-in web_search when this MCP is configured. Tool routing and citations
  when you choose to search.
---

# search-boost MCP @ Codex

Server id: `search-boost` in `~/.codex/config.toml`. MCP tool names: `mcp__search-boost__*`.

## Your discretion

Search is **available, not required**. Use it when web evidence would improve correctness; skip when you are confident from the workspace or the user does not need verification.

**Consider searching when:** versions, deprecations, external API shapes, or niche docs could change the outcome.

**Consider skipping when:** local files answer the question, fundamentals are stable, or the user wants a fast draft without citations.

## Tools (when you search)

| MCP tool | Use |
|----------|-----|
| `mcp__search-boost__fused_search` | Quick lookup (`complexity=simple` first) |
| `mcp__search-boost__fetch_page` | Full page when snippets fail; `focus` saves tokens |
| `mcp__search-boost__x_search` | X/Twitter |
| `mcp__search-boost__deep_research` | Multi-source synthesis — one round per call; repeat with `suggested_queries` until gaps empty (~3 rounds max) |
| `mcp__search-boost__search_layer` | free vs api |
| `mcp__search-boost__search_stats` | Diagnostics |

## If you use web results

- Cite URLs from `structuredContent.results` for factual claims drawn from search
- One focused query to start; avoid duplicate queries; ~3 rounds is usually enough
- Full optional policy: MCP resource `search-boost://policy` · prompt `search_routing`

## Keys

Optional — free layer: bing + ddg + yahoo + exa-free. Run `search-boost config keys`.
