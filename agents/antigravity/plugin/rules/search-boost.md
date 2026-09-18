---
trigger: always_on
description: Search before editing external APIs; prefer search-boost MCP over search_web.
---

# search-boost — proactive search (always on)

**Search before you edit** anything that touches external APIs, SDKs, or cloud products.

## Tool priority

- External facts → MCP **`search-boost`** (`fused_search`) — **not** built-in `search_web`
- Official doc body → **`fetch_page`** — not `read_url_content` alone
- Library/service compare → **`deep_research`**
- Live GCP account state → gcloud MCP — not search-boost

## When to search (auto-trigger)

- New SDK/client, REST/gRPC, cloud resource types
- Auth, scopes, IAM, quota, region availability
- Version numbers, deprecations, "does X support Y"
- Any external fact you are not 100% sure about

## Hard rules

- **Doubt → one `fused_search`** before multi-file changes
- Do not assert from memory; fetch official docs when snippets are thin
- Cite URLs; label inference
- Max **~3 search rounds** per task; duplicate query = stop

## Skip search only

- Internal refactor with no new external dependency
- Stable language/stdlib usage
- User forbids web; purely local test/fix

## Flow

1. Unsure → `fused_search` (`complexity=simple`)
2. Implementing → `fetch_page` on official URL (+ `focus`)
3. Full policy → MCP resource `search-boost://policy`
