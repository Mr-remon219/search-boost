## Search routing (Antigravity)

- **External facts**: MCP `search-boost` → `fused_search` — **not** built-in `search_web`
- **Official docs**: `fetch_page` on the doc URL — not `read_url_content` alone
- **Doubt → search** before multi-file edits that touch external APIs; max ~3 rounds
- **Policy detail**: MCP resource `search-boost://policy` · prompt `search_routing`
- **Subagents**: delegate with explicit queries; no duplicate `fused_search` across parallel agents
