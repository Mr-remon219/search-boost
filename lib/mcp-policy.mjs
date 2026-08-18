/**
 * MCP policy resource — model-discretion wording aligned with agent skills/hooks.
 */
export const MCP_POLICY_TEXT = `# search-boost — optional search policy

Multi-engine web search is **available when you choose** grounded external facts. The model decides whether to search — not a mandatory pre-answer step.

## When search helps

- Version numbers, release dates, deprecations, pricing, "latest" status
- Library/API behavior you will rely on in code or advice
- Unfamiliar or niche tech before recommending
- User explicitly asks for sources or current info

**Often skip:** stable fundamentals, files already in the workspace, pure creation with no factual claims, user forbids browsing.

## If you search

- Start with one focused \`fused_search\` (\`complexity=simple\` first when a quick check suffices)
- Follow up only when snippets are insufficient (~3 rounds max per question is reasonable)
- Cite URLs from results; label inference as *(inference)*

## Tool routing

| Tool | Use |
|------|-----|
| \`fused_search\` | General lookup / verify |
| \`fetch_page\` | Snippets insufficient; official doc body (+ \`focus\`) |
| \`x_search\` | X/Twitter posts, accounts, threads |
| \`deep_research\` | Multi-source synthesis (repeat until gaps empty) |
| \`search_layer\` | Show or persist default layer: \`free\` (keyless) vs \`api\` (keyed engines) |
| \`search_stats\` | Diagnostics |

## Layers

- **free** — bing, ddg, yahoo, exa-free; no API keys
- **api** — free engines plus antigravity, tavily/brave/exa when keys are configured

Per-call \`layer\` on \`fused_search\` / \`deep_research\` overrides for that request only. Use \`search_layer\` to change the persisted default (~/.search-boost-layer.json; legacy ~/.dsh-search-boost-layer.json still read). Optional override: \`SEARCH_BOOST_LAYER\` env; file path override: \`SEARCH_BOOST_LAYER_FILE\`.

## Keys

Optional — free layer works without keys. Configure via \`search-boost config keys\` → ~/.search-boost-keys.json (legacy ~/.dsh-search-boost-keys.json still read) or env \`TAVILY_API_KEY\` / \`BRAVE_API_KEY\` / \`EXA_API_KEY\`. File path override: \`SEARCH_BOOST_KEYS_FILE\`.
`
