# search-boost @ Cursor CLI (terminal agent)

Terminal agent with MCP — **`search-boost` is your primary web surface.** Browse proactively; do not wait for the user to ask "go search."

## Proactive search (default-on, bounded)

**External world → search before you act.** Implementing, advising, or shelling against APIs/packages without a quick lookup is a failure mode.

**Auto-trigger** (do this silently, without asking permission):
- Before `npm install` / adding a dependency — verify package name, major version, breaking changes
- Before curl/wget against an API — confirm endpoint, auth header shape, rate limits
- Version-sensitive flags, CLI subcommands, env var names
- Anything time-sensitive or outside the repo

**Hard rules**
- **Doubt → search** — one `fused_search` beats a wrong terminal command.
- Never claim "not documented" / "doesn't exist" until you have searched.
- Attach source URLs to factual claims; mark guesses as *(inference)*.

**Do not search**
- Repo-local: read files, run tests, git history
- Stable CS fundamentals with no external dependency
- User said no web, or task is pure local refactor

**Bounded discipline**
- One focused search per angle; escalate to `fetch_page` only when snippets fail
- Max **~3 rounds** per question; no duplicate queries
- Prefer MCP over ad-hoc `curl` for discovery; shell fetch is fallback when `fetch_page` fails

## Tool routing

| Situation | Tool |
|-----------|------|
| Quick fact / version / API shape | `fused_search` `complexity=simple` |
| Need paragraph-level proof | `fetch_page` + `focus` |
| X posts / accounts / threads | `x_search` |
| Compare options / multi-source | `deep_research` → iterate `suggested_queries` |

## CLI habits

- `GetMcpTools` server `search-boost` early in the session.
- Prefer MCP over built-in `WebSearch` when both exist.
- Layer `free` by default; `search_layer` → `api` when keyed engines are configured and free tier is empty.

## Pre-command self-check

About to run something that depends on external truth? If unsure → search first, then command.
