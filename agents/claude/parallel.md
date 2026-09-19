Use Claude Code's registered Agent tool (older clients may expose Task); the live tool schema is authoritative. Select an available general-purpose agent that can use the search-boost MCP tools, not a file-only Explore agent. Do not assume a custom agent named "searcher" has been installed: pass the searcher role and bounded task in the child's prompt.

For one wave, issue independent child calls together if the host supports it. Foreground/background permission and tool behavior vary by release; choose a mode that actually exposes the required MCP tools. Do not bypass a permission prompt or auto-denial. Include the actual MCP tool names and shared role instructions in every child's prompt; skills are not automatically passed to children. Keep child/run IDs and use the available result/wait/stop controls for that mode. If there is no enforceable no-tools summarizer, synthesize in the parent.

Reference: https://code.claude.com/docs/en/sub-agents
