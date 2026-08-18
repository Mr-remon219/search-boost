# search-boost @ Codex CLI

MCP via **`~/.codex/config.toml`**, server id **`search-boost`**. Multi-engine web search when you **choose** to verify external facts — not a mandatory step every turn.

Skill: **`~/.agents/skills/search-boost/`** — invoke explicitly with `$search-boost`.

## When search helps (your call)

Use search-boost when **uncertainty would materially affect the answer or the patch** — especially before integration code, version-sensitive advice, or claims about third-party systems.

**Good candidates**
- Package/API you may import, configure, or document
- CLI flags, env vars, auth flows, HTTP paths you are not sure about
- "Latest", "deprecated", "removed in", compatibility questions
- Errors referencing external services you have not confirmed

**Often skip** (use judgment — no search required)
- Refactors confined to repo code you can read
- Stable language/stdlib behavior with no third-party dependency
- You are already confident from repo context or prior verified results this session
- User forbids web / asks for speed over verification

## How to use well (if you search)

- Prefer **`mcp__search-boost__fused_search`** for quick lookup; **`fetch_page`** for one official doc body
- Cite URLs from `structuredContent.results` when you rely on web evidence; label inference as *(inference)*
- Stay efficient: one focused query to start; avoid repeating the same query; ~3 rounds is usually enough
- If native search was replaced, config has `web_search = "disabled"` (SEARCH_BOOST marker). If you re-enable `cached`/`live`, pick **one** web path per question — search-boost or built-in web, not both

## Tool routing

| Task | MCP tool |
|------|----------|
| Lookup / verify | `mcp__search-boost__fused_search` |
| Read doc page | `mcp__search-boost__fetch_page` |
| X/Twitter | `mcp__search-boost__x_search` |
| Survey / compare | `mcp__search-boost__deep_research` |
| Layer / diagnostics | `mcp__search-boost__search_layer` · `mcp__search-boost__search_stats` |

## Codex-specific

- Invoke MCP tools on the native MCP channel (names above).
- Optional deep reference: MCP resource **`search-boost://policy`** · prompt **`search_routing`**
- Keys optional — free layer needs no Tavily/Brave/Exa keys. Api: ≥1 keyed engine (all three recommended).
- If `fetch_page` fails in sandbox, a controlled shell fetch is acceptable — or proceed without web if the task does not need it.

## Autonomy

You decide whether to search. When you skip search, say so briefly if the answer hinges on assumptions. When you search, cite what you found.
