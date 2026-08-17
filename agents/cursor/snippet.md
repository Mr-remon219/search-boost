# search-boost MCP — Cursor agent policy

When **search-boost** MCP is available, you **may** use it for verifiable external facts. Prefer it over built-in `WebSearch` when you choose to search and want citations.

## Optional use

- Versions, APIs, docs, deprecations, comparisons — when repo context is insufficient
- If uncertain about an external fact, consider one `fused_search` before asserting
- Skip: stable fundamentals, local repo only, pure creation, user forbids web
- Stay bounded: ~3 rounds max; cite URLs; mark inference

## Tool routing

| Need | Tool |
|------|------|
| Verify / lookup | `fused_search` |
| Full page | `fetch_page` + `focus` |
| X/Twitter | `x_search` |
| Multi-source | `deep_research` |
| Layer / debug | `search_layer` · `search_stats` |

## Discovery

`GetMcpTools` server `search-boost`. Resource `search-boost://policy` has optional extended guidance.
