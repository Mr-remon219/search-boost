---
name: search-boost
description: >-
  Multi-engine web search MCP. Proactively search before external factual claims
  (versions, APIs, docs). Use for verify-before-assert; skip for local code only.
  Prefer fused_search over built-in WebSearch. Free layer needs no API keys.
---

# search-boost MCP

Server id: `search-boost` in `~/.cursor/mcp.json`.

## Proactive default (bounded)

**Search first, then answer** for external facts. **Doubt → one `fused_search`.** Do not claim "no info" without searching.

**Skip search only:** stable fundamentals, workspace-local code/files, pure creation (no factual claims), user forbids web.

**Stay bounded:** one focused search to start; max ~3 rounds; same query twice = stop.

## Tools

| Tool | Use |
|------|-----|
| `fused_search` | Default verify / lookup (use `complexity=simple` first) |
| `fetch_page` | Full page when snippets fail; `focus` saves tokens |
| `x_search` | X/Twitter |
| `deep_research` | Multi-source compare; until `gaps` empty |
| `search_layer` | free vs api |
| `search_stats` | Diagnostics |

## Flow

1. `GetMcpTools` → server `search-boost`
2. External fact needed → `fused_search` before asserting
3. Implementing integration → search official docs before editing files

## Policy

`~/.cursor/AGENTS.md` (SEARCH_BOOST block) · MCP resource `search-boost://policy` (full rules, Chinese).

## Keys

Optional — free layer: bing + ddg + exa-free. See `dsh-search-boost` README for keyed setup.
