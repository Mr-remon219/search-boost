# search-boost

search-boost is the MCP server for web search, page reading, and X/Twitter. Claude Code exposes its tools as `mcp__search-boost__*`; use the registered MCP tools rather than shell commands.

Ordinary calls use the MCP tool descriptions and schemas directly. The `search-boost` skill is the entry point for optional workflow extensions, not a required step before searching.
