# search-boost MCP — server instructions

Multi-engine web search for coding agents. **Available when you want grounded external facts** — the model decides whether to search.

## When to consider search

- Versions, APIs, deprecations, comparisons, niche or fast-moving tech
- Claims where a wrong answer has real cost
- User explicitly asks for sources or current info

**Often skip:** stable fundamentals, files in the workspace, pure creation, user opt-out.

**If you search:** prefer one focused `fused_search` (`complexity=simple`); cite URLs; label inference; ~3 rounds max; duplicate query → stop.

Optional detail: resource `search-boost://policy`.

## Tools

| Tool | When |
|------|------|
| `fused_search` | General lookup / verify |
| `fetch_page` | Snippets insufficient; official doc body |
| `x_search` | X/Twitter |
| `deep_research` | Multi-source synthesis |
| `search_layer` | free vs api |
| `search_stats` | Diagnostics |

## Resources & prompts

- Resource `search-boost://policy` — extended routing reference (suggestions, not mandates)
- Prompt `search_routing` — tool picker for a task description

## Protocol notes

- **structuredContent** (JSON) + human-readable **content**
- Errors: `isError: true`; honour **abortSignal** (90–180s)
- Annotations: `readOnlyHint` + `openWorldHint`

## Keys

Free layer: no keys. Api: `~/.dsh-search-boost-keys.json` or `TAVILY_API_KEY` / `BRAVE_API_KEY` / `EXA_API_KEY`.
