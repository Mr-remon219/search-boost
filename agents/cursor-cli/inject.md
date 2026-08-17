# search-boost @ Cursor CLI

**search-boost** MCP is available for multi-engine web search with citations. **You decide** when a lookup helps — it is not required on every turn.

## When search-boost helps (optional)

Consider it when **verifiable external facts** would improve the answer and you are not confident from repo context alone:

- Package/API versions, flags, endpoints, deprecations
- Time-sensitive or vendor-specific behavior before `npm install`, curl, or similar
- Comparing libraries or confirming niche documentation

**Often skip:** stable CS fundamentals, pure local work (files, tests, git), creative tasks with no factual claims, or when the user forbids web.

## Tool routing (if you search)

| Situation | Tool |
|-----------|------|
| Quick fact / version / API shape | `fused_search` `complexity=simple` |
| Snippets too thin | `fetch_page` + `focus` |
| X / Twitter | `x_search` |
| Multi-source compare | `deep_research` |

## Habits (non-binding)

- `GetMcpTools` server `search-boost` when you might need web tools this session.
- Prefer search-boost over built-in `WebSearch` when you **choose** to search and want structured results + URLs.
- Stay efficient: one focused query per angle; ~3 rounds max if follow-ups are needed.
- Cite URLs for external claims; label guesses as *(inference)*.

Resource `search-boost://policy` has extended guidance (optional read).
