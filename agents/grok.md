# search-boost @ Grok Build

MCP: **`~/.grok/config.toml`** → `[mcp_servers.search-boost]`. Use search-boost **when precision and citations matter** — complement Grok's native browsing, don't duplicate it.

## Proactive search (default-on, bounded)

**Default to search-boost for verifiable web facts**; use native Grok tools for conversational browse when the user wants exploration, not proof.

**Auto-trigger for search-boost**
- Version numbers, release notes, API contracts before coding advice
- Multi-engine corroboration (official doc + changelog + issue tracker)
- Structured citations the user can click (`structuredContent.results`)
- X data when you want **fused multi-engine + xAI merge + credential-free fallback** in one call → `x_search`

**When native Grok is enough** (skip search-boost this turn)
- User wants open-ended exploration / brainstorming with no citation bar
- You already have fresh, sufficient evidence from the immediately prior search-boost call (same question, same session)
- Pure local repo work

**Hard rules**
- **Doubt on a fact → one `fused_search`** before asserting.
- Don't run search-boost **and** generic browse on the **same query** — pick one.
- "What are people saying" / sentiment → **`x_search`** (keyword/semantic), not plain web alone.

**Bounded discipline**
- One focused search per factual angle; `deep_research` only for compare/survey tasks
- Max **~3 rounds**; large outputs may spill to session `mcp/` — read spill files if truncated
- `/x-login` / shared xauth improves official `x_search` path when configured

## Tool routing

| Tool | Use |
|------|-----|
| `fused_search` | Web facts, docs, benchmarks (precision path) |
| `fetch_page` | Long-form page text |
| `x_search` | Posts/users/threads — prefer over duplicate native X lookup for merged ranking |
| `deep_research` | Evidence with gaps / comparisons |
| `search_stats` | Engine availability debug |

## Grok-specific

- Rule: `~/.grok/rules/search-boost.md` · Skill: `~/.grok/skills/search-boost/`
- Resource `search-boost://policy` for full proactive policy (Chinese + detailed triggers)

## Pre-reply self-check

Making a factual claim? Already searched or explicitly local-only? If not → `fused_search` first.
