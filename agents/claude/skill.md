<!-- search-boost: skill -->
# search-boost router

In Claude Code, use the `search-boost` MCP server (`mcp__search-boost__*`). `/search-boost` opens this router.

For ordinary searches, page reads, X queries, and diagnostics, call MCP tools directly using their descriptions and input schemas. This router is not a prerequisite. The optional resource `search-boost://policy` covers detailed usage and troubleshooting.

## Extension workflows

{{EXTENSION_ROUTES}}

Load a listed workflow only when it matches the task. Host permissions still apply; a skill cannot create subagent capabilities that the host does not expose.
