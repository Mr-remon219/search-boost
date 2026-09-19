<!-- search-boost: skill -->
# search-boost router

In Cursor CLI, call the `search-boost` MCP tools directly, not as shell commands. The IDE shares this skill set.

For ordinary searches, page reads, X queries, and diagnostics, call MCP tools directly using their descriptions and input schemas. This router is not a prerequisite. The optional resource `search-boost://policy` covers detailed usage and troubleshooting.

## Extension workflows

{{EXTENSION_ROUTES}}

Load a listed workflow only when it matches the task. Host permissions still apply; a skill cannot create subagent capabilities that the host does not expose.
