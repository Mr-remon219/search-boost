# search-boost @ Cursor IDE

MCP server **`search-boost`** is available — **use it proactively** for external facts. Prefer it over built-in **WebSearch** / `@web` when both exist.

## Proactive search (default-on, bounded)

**Search first, then answer** — do not guess versions, API shapes, or "current" status from memory.

**Auto-trigger** (one `fused_search`, `complexity=simple`, before you assert):
- Version numbers, release dates, deprecation, pricing, policy, "latest" anything
- Library/API behavior you will rely on in code or advice
- Unfamiliar or niche tech — confirm before recommending
- Any external fact you are not 100% sure about

**Hard rules**
- **Doubt → search.** A small uncertainty (one digit, one flag name) still triggers one quick search.
- **No "can't find / unavailable" without searching.** If results are thin, say "searched, evidence insufficient" — not "there is no info."
- **Facts need URLs.** Cite `structuredContent.results[].url`; label inference as *(inference)*.

**Do not search** (only these):
- Stable fundamentals (math, language syntax, algorithms taught in textbooks)
- Purely local: files open in the workspace, git diff, project config you can read
- Pure creation with no external factual claims, or user explicitly forbids browsing

**Bounded discipline** — stay proactive, not noisy:
- Start with **one focused** `fused_search`; follow up only when snippets are insufficient or you need a second domain
- Same query twice = loop → rephrase or stop
- **~3 search rounds max** per user question; then synthesize with what you have
- `simple` tier is cheap and cache-friendly — cost is not a reason to skip

## Tool routing

| Need | Tool |
|------|------|
| Default lookup / verify | `fused_search` |
| Snippet too short | `fetch_page` + optional `focus` |
| X/Twitter | `x_search` |
| Multi-source compare / survey | `deep_research` until `gaps` empty |
| Layer / diagnostics | `search_layer` · `search_stats` |

## Cursor-specific

- At session start or before first factual claim: `GetMcpTools` → server `search-boost`; resource `search-boost://policy` for full policy.
- When editing integration code (SDK, REST, cloud): **search official docs before changing files** — one search beats a wrong import.
- Read `structuredContent` when present; use text `content` for quick scan.
- Free layer works without keys (`bing`+`ddg`+`exa-free`).

## Pre-send self-check

Does this reply assert external facts? Any doubt? URLs attached? If yes to 1 or 2 and you have not searched → search first, then send.
