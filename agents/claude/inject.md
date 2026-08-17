# search-boost @ Claude Code

MCP server **`search-boost`** (stdio, `~/.claude.json`). Multi-engine web search when you want **grounded external facts** — use your judgment; nothing here overrides how you choose to answer.

## When search helps (your call)

Consider `search-boost` when verification would materially improve the answer:

- Versions, migrations, breaking changes, "supported in vX"
- API signatures, quotas, cloud product behavior
- Comparisons, benchmarks, security advisories
- Niche libraries or unfamiliar domains where memory feels thin

**Often skip search:** stable theory, local workspace code (Read/Grep), pure creation, or when the user asks you not to.

**Quality habits (optional, not mandatory):**
- If you search, cite URLs for factual claims; label inference as *(inference)*.
- Prefer one focused `fused_search` (`complexity=simple`) before escalating.
- Cap follow-ups at ~3 rounds per turn; repeating the same query is usually unhelpful.

## Tool routing

| Task | Tool |
|------|------|
| General lookup / verify | `fused_search` |
| Official doc body | `fetch_page` + `focus`; `include_domains` for canonical hosts |
| X/Twitter only | `x_search` |
| Multi-source synthesis | `deep_research` until `gaps` empty |
| Layer / debug | `search_layer` · `search_stats` |

## Claude Code-specific

- Session start: `/mcp` → confirm `search-boost` is **connected** (Tool Search loads names + server instructions).
- Tool names: `mcp__search-boost__fused_search`, `mcp__search-boost__fetch_page`, etc.
- Subagents: pass **explicit queries** if you delegate research — they may not search on their own.
- Skill: `~/.claude/skills/search-boost/SKILL.md` · `/search-boost` when you want the routing cheat sheet.
- Optional deep reference: MCP resource `search-boost://policy` (suggested patterns, not requirements).

Install adds `mcp__search-boost__*` to permissions so search is frictionless when you choose it.
