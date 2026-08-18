# search-boost @ Cursor IDE

MCP server **`search-boost`** is available for multi-engine web search. **Use it when you choose** — especially when external facts need verification or citations. Prefer it over built-in **WebSearch** / `@web` when you do search and want structured results.

## When it helps (optional)

Good fits when **you** want evidence beyond repo context:

- Version numbers, release dates, deprecations, pricing, "latest" status
- Library/API behavior you will rely on in code or advice
- Unfamiliar or niche tech before recommending

**Often skip:** stable fundamentals, purely local workspace facts, pure creation with no factual claims, user forbids browsing.

## If you search

- Start with one focused `fused_search` (`complexity=simple`) when a quick check suffices
- Follow up only when snippets are insufficient (~3 rounds max per question is a reasonable cap)
- Cite URLs from results; label inference as *(inference)*

## Tool routing

| Need | Tool |
|------|------|
| Default lookup | `fused_search` |
| Snippet too short | `fetch_page` + optional `focus` |
| X/Twitter | `x_search` |
| Multi-source compare | `deep_research` |
| Layer / diagnostics | `search_layer` · `search_stats` |

## Cursor-specific

- `GetMcpTools` → server `search-boost` when web tools may be useful
- Resource `search-boost://policy` for extended optional guidance
- Free layer works without keys (`bing`+`ddg`+`yahoo`+`exa-free`)
