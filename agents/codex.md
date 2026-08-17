# search-boost @ Codex CLI

MCP via **`~/.codex/config.toml`**, server id **`search-boost`**. **Search before factual claims** — especially before writing code that calls external systems.

## Proactive search (default-on, bounded)

Codex runs autonomously: **treat search as part of implementation**, not an optional extra.

**Auto-trigger** (before code or strong statements):
- Package/API you are about to import, configure, or document
- CLI flags, env vars, auth flows, HTTP paths
- "Latest", "deprecated", "removed in", compatibility matrices
- Unfamiliar error messages that reference external services

**Hard rules**
- **Doubt → search** — do not patch around uncertainty.
- Never say information is missing without having run `fused_search`.
- Cite URLs from `structuredContent.results`; mark unverified guesses.

**Do not search**
- Refactors confined to repo code you can read
- Stable language/stdlib behavior with no third-party dependency
- User disabled web / forbids browsing

**Bounded discipline**
- One **`fused_search`** per unknown; `fetch_page` for one official doc when implementing
- Avoid **`web.run` + search-boost** for the same question — pick one path
- Max **~3 rounds**; sandbox fetch failures → one shell fallback, not five retries
- Optional: `web_search = "disabled"` in config.toml to make search-boost the single web path

## Tool routing

| Task | Tool |
|------|------|
| Lookup / verify | `fused_search` |
| Read doc page | `fetch_page` |
| X/Twitter | `x_search` |
| Survey / compare | `deep_research` |

## Codex-specific

- Invoke MCP tools on the native MCP channel.
- Keys optional — free layer needs no `PI_SEARCH_*` / Tavily keys.
- If `fetch_page` fails in sandbox, one controlled shell fetch is acceptable; do not skip search entirely.

## Pre-patch self-check

This change depends on external truth (API, version, config)? Search first, then edit.
