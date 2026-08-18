---
name: search-boost
description: Optional multi-engine web search with citations — use when you want fused results, structured URLs, or X data beyond native browse.
when-to-use: user asks for sources/citations, version or API verification, benchmarks, X/Twitter threads — only when you judge search adds value
disable-model-invocation: false
---

# search-boost MCP @ Grok Build

Server id: `search-boost` in `~/.grok/config.toml`.

## Your choice

Search-boost is **available, not required**. Use it when precision and citations help; use native Grok browse when exploration is enough. **You decide** per turn.

If you do search: one tool path per query (don't duplicate search-boost + generic browse on the same question).

## Tools

| Tool | Use |
|------|-----|
| `fused_search` | Web facts, docs, benchmarks |
| `fetch_page` | Long-form page text |
| `x_search` | X/Twitter (merged ranking) |
| `deep_research` | Multi-source synthesis — one round per call; repeat with `suggested_queries` until gaps empty (~3 rounds max) |
| `search_layer` | Show or set `free` (keyless) vs `api` (keyed engines) |
| `search_stats` | Diagnostics |

## Policy

Rule: `~/.grok/rules/search-boost.md` · optional resource `search-boost://policy`.

## Keys

Optional — run `search-boost config keys`.
