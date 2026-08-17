# search-boost @ Antigravity CLI / IDE

MCP: **`~/.gemini/config/mcp_config.json`**, server **`search-boost`**. **Search before you edit** anything that touches the outside world.

**Prefer search-boost MCP over built-in `search_web` and `read_url_content`** when both exist — fused multi-engine ranking beats single-engine built-ins for version/API facts.

## Proactive search (default-on, bounded)

Antigravity is multi-step — **front-load research** so implementation steps do not encode stale APIs.

**Auto-trigger** (before writing or refactoring):
- New SDK/client, REST/gRPC surface, cloud resource types
- Auth, scopes, IAM, quota, region availability
- "Does X support Y", migration paths, deprecations
- Unfamiliar GCP-adjacent products (search-boost for web facts; gcloud MCP for live account state)

**Hard rules**
- **Doubt → search** — one quick lookup before a multi-file change.
- Do not ship code based on remembered signatures; fetch official docs when snippets are thin.
- **No "can't find / unavailable" without searching.** Say "searched, evidence insufficient" if needed.
- Cite URLs; label inference.

**Do not search**
- Internal refactor with no new external dependency
- Stable language/stdlib usage
- User forbids web; or task is purely local test/fix

**Bounded discipline**
- **`fused_search` once** per integration angle → **`fetch_page`** on the official doc URL if implementing
- **`deep_research`** for library/service comparisons, not for every single flag lookup
- Max **~3 rounds** per task; parallel agents must **partition queries** — no identical `fused_search` from two agents
- Free layer is enough for early iteration; switch layer only when repeatedly empty

## Tool routing

| Situation | Tool | Not |
|-----------|------|-----|
| Unsure signature / version / support | `fused_search` first | `search_web` |
| Implementing against docs | `fetch_page` on official URL + `focus` | `read_url_content` alone |
| Compare libraries / services | `deep_research` | repeated single lookups |
| X/Twitter | `x_search` | — |
| Live GCP project state | gcloud / workspace tools | search-boost |

## Antigravity-specific

- **MCP discovery**: IDE agent panel → MCP Servers; CLI type `/mcp`. Server id: `search-boost`.
- **Skill**: `~/.gemini/config/skills/search-boost/SKILL.md` (or `.agents/skills/search-boost/` in workspace)
- **Policy**: MCP resource `search-boost://policy` · prompt `search_routing` for complex tasks
- **Workspace override**: `.agents/mcp_config.json` + `.agents/rules/search-boost.md`
- **Subagents** inherit MCP — parent should **delegate research with explicit queries**, not vague "look it up"; partition queries across parallel agents

## Pre-edit self-check

Will this diff assume an external API, version, or cloud behavior? Search first, then edit.
