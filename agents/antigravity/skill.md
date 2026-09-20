<!-- search-boost: skill -->
# search-boost router

In Antigravity, use MCP server `search-boost` for web evidence rather than `search_web`; use authorized cloud tools for live account state.

For ordinary searches, page reads, X queries, and diagnostics, call MCP tools directly using their descriptions and input schemas. This router is not a prerequisite. The optional resource `search-boost://policy` covers detailed usage and troubleshooting.

## Extension workflows

{{EXTENSION_ROUTES}}

Load a listed workflow only when it matches the task. Host permissions still apply; a skill cannot create subagent capabilities that the host does not expose.
