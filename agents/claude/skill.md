# search-boost MCP @ Claude Code

Server id: `search-boost` in `~/.claude.json`.

## Proactive default (bounded)

**Search first, then answer** for external facts. **Doubt → one `fused_search`.** Do not claim "no info" without searching.

**Skip search only:** stable fundamentals, workspace-local code/files, pure creation, user forbids web.

**Stay bounded:** one focused search to start; max ~3 rounds; same query twice = stop.

## Tools

| Tool | Use |
|------|-----|
| `fused_search` | Default verify / lookup |
| `fetch_page` | Full page when snippets fail |
| `x_search` | X/Twitter |
| `deep_research` | Multi-source compare |
| `search_layer` | free vs api |
| `search_stats` | Diagnostics |

## Policy

`~/.claude/CLAUDE.md` (SEARCH_BOOST block) · MCP resource `search-boost://policy`.

## Keys

Optional — run `search-boost config keys` or set env vars.
