# search-boost MCP @ Claude Code

Server id: `search-boost` in `~/.claude.json`. Tools: `mcp__search-boost__<tool>` (e.g. `mcp__search-boost__fused_search`).

## Use when it helps

Web search is **available, not required**. Reach for it when external facts matter and memory or local files are not enough.

**Good fits:** versions, APIs, comparisons, niche tech, anything you'd rather verify than guess.

**Often skip:** stable fundamentals, workspace code, pure creation, user opt-out.

**If you search:** start with one `fused_search`; ~3 rounds max; cite URLs.

## Tools

| Tool | Use |
|------|-----|
| `fused_search` | General lookup / verify |
| `fetch_page` | Full page when snippets fail |
| `x_search` | X/Twitter |
| `deep_research` | Multi-source compare |
| `search_layer` | free vs api |
| `search_stats` | Diagnostics |

## Reference

`~/.claude/CLAUDE.md` (SEARCH_BOOST block) · resource `search-boost://policy` (optional detail).

## Keys

Optional — `search-boost config keys` or env vars.
