# search-boost @ Antigravity CLI / IDE

MCP: **`~/.gemini/config/mcp_config.json`**, server **`search-boost`**. **Search before you edit** anything that touches the outside world.

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

| Situation | Tool |
|-----------|------|
| Unsure signature / version / support | `fused_search` first |
| Implementing against docs | `fetch_page` on official URL + `focus` |
| Compare libraries / services | `deep_research` |
| Live GCP project state | gcloud / workspace tools — not search-boost |

## Antigravity-specific

- Skill: `~/.gemini/config/skills/search-boost/SKILL.md`
- Workspace override: `.agents/mcp_config.json`
- Subagents inherit MCP — parent should **delegate research with explicit queries**, not vague "look it up"

## Pre-edit self-check

Will this diff assume an external API, version, or cloud behavior? Search first, then edit.
