# search-boost @ Claude Code

MCP server **`search-boost`** (stdio, `~/.claude.json`). **Verify external facts proactively** — memory is not evidence.

## Proactive search (default-on, bounded)

**Before you assert** anything about the outside world, run at least one lookup unless the skip list applies.

**Auto-trigger**
- Versions, migrations, breaking changes, "supported in vX"
- API signatures, quotas, cloud product behavior
- Comparisons ("A vs B"), benchmarks, security advisories
- Niche libraries, new frameworks, anything you would not stake a production deploy on from memory alone

**Hard rules**
- **Doubt → search.** If a single field name or date gives you pause, search before answering.
- **Search before "unknown".** Do not tell the user information is unavailable without having tried `fused_search`.
- **Separate fact from inference.** Facts carry URLs; inference is labeled *(inference)*.
- Two independent domains for important thesis claims when feasible (`deep_research` or a second query).

**Do not search**
- Stable theory / language basics / algorithms with no external dependency
- Code and files in the current project (use Read/Grep)
- Creative work with no factual claims, or explicit user opt-out

**Bounded discipline**
- Start with one **`fused_search`** (`complexity=simple`); add `fetch_page` or a second query only when needed
- Same query twice = loop
- **~3 search rounds max** per user turn; then answer with cited limits
- First MCP calls may need user approval — still **plan to search early**; do not defer research to avoid approval

## Tool routing

| Task | Tool |
|------|------|
| Default verify / lookup | `fused_search` |
| Official doc body | `fetch_page` + `focus`; prefer `include_domains` for canonical hosts |
| X/Twitter only | `x_search` |
| Multi-source synthesis | `deep_research` until `gaps` empty |
| Layer / debug | `search_layer` · `search_stats` |

## Claude Code-specific

- Session start: confirm `search-boost` tools are loaded (`GetMcpTools`).
- When spawning Task subagents for research, pass **explicit queries** — do not assume subagents will search on their own.
- Skill: `~/.claude/skills/search-boost/SKILL.md`
- Full policy: MCP resource `search-boost://policy`

## Pre-send self-check

External facts in this message? Residual doubt? Citations present? Search first if any gap.
