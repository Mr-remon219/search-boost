---
name: search-boost
description: Multi-engine web search before external API/integration work. Use when verifying versions, SDK signatures, cloud quotas, or comparing libraries. Prefer over built-in search_web.
---

# search-boost MCP @ Antigravity

Server id: `search-boost` in `~/.gemini/config/mcp_config.json` (or `.agents/mcp_config.json`).

## Proactive default (bounded)

**Search before you edit** anything that touches external APIs or cloud products. Prefer MCP tools over built-in `search_web`.

**Doubt → one `fused_search`.** Max ~3 rounds per task.

## Tools

| Tool | Use |
|------|-----|
| `fused_search` | Version / API / support lookup (default) |
| `fetch_page` | Official doc body (+ `focus`) |
| `deep_research` | Library / service compare |
| `x_search` | X/Twitter |
| `search_layer` | free vs api |
| `search_stats` | Diagnostics |

## Flow

1. External fact needed → `fused_search` before asserting
2. Implementing integration → `fetch_page` on official URL before editing files
3. Complex routing → prompt `search_routing` · resource `search-boost://policy`

## Policy

`~/.gemini/AGENTS.md` (SEARCH_BOOST block) · resource `search-boost://policy`.

## Keys

Optional — run `search-boost config keys`.
