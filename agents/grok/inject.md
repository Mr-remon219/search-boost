# search-boost @ Grok Build

MCP: **`~/.grok/config.toml`** → `[mcp_servers.search-boost]`. Optional precision search — use when **you judge** citations or multi-engine corroboration help; native Grok browse is equally valid for exploration.

## When search-boost helps (your call)

**Consider search-boost** when the user or task benefits from verifiable, citable web facts:

- Version numbers, release notes, API contracts — especially before high-stakes coding advice
- Multi-engine corroboration (official doc + changelog + issues)
- Structured citations (`structuredContent.results`) the user can click
- X data via **`x_search`** (fused ranking + credential-free fallback)

**Native Grok browse may be enough** when:

- Open-ended exploration / brainstorming with no citation bar
- You already have fresh evidence from a recent search-boost call (same question, same session)
- Pure local repo work, or memory / reasoning alone satisfies the user

**You decide** whether to search, skip, or answer from context — no mandatory pre-reply search step.

## Practical guidelines (if you search)

- Prefer **one tool path per query** — don't run search-boost and generic browse on the **same query**
- X/sentiment → **`x_search`** often beats plain web alone
- Stay bounded: one focused query per angle; `deep_research` for compare/survey; ~3 rounds max if iterating
- Large outputs may spill to session `mcp/` — read spill files if truncated
- `/x-login` / shared xauth improves official `x_search` when configured

## Tool routing

| Tool | Use |
|------|-----|
| `fused_search` | Web facts, docs, benchmarks (precision path) |
| `fetch_page` | Long-form page text |
| `x_search` | Posts/users/threads — merged ranking vs duplicate native X lookup |
| `deep_research` | Evidence gaps / comparisons |
| `search_stats` | Engine availability debug |

## Grok-specific

- Rule: `~/.grok/rules/search-boost.md` · Skill: `~/.grok/skills/search-boost/`
- Resource `search-boost://policy` — optional detailed routing reference (Chinese)
- **Plugin:** `grok plugin install ./grok-plugin --trust` then `search-boost install -t grok -y --auto-allow`
- **Project MCP:** `search-boost install -t grok --scope project -y` writes `.grok/config.toml` in cwd (rules stay user-level)
