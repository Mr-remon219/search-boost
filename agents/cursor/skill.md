# search-boost MCP @ Cursor

Server id: `search-boost` in `~/.cursor/mcp.json`.

## Your call

Multi-engine web search when **you** decide external facts need verification or citations. Repo context and stable knowledge are enough when they are sufficient — no mandatory search per turn.

## Tools

| Tool | Use |
|------|-----|
| `fused_search` | Quick lookup (`complexity=simple` first if searching) |
| `fetch_page` | Full page when snippets fail; `focus` saves tokens |
| `x_search` | X/Twitter |
| `deep_research` | Multi-source compare |
| `search_layer` | free vs api |
| `search_stats` | Diagnostics |

## If you search

1. `GetMcpTools` → server `search-boost`
2. Prefer search-boost over built-in `WebSearch` when structured results help

## More detail

Hook capability summary at session start · MCP resource `search-boost://policy` (optional routing reference).

## Keys

Optional — free layer: bing + ddg + exa-free. Run `search-boost config keys` or see dsh-search-boost README.
