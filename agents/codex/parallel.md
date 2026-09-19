Use Codex's native subagent tools only when they are exposed in this session (for example spawn_agent, wait, and close_agent; use the actual schemas). A skill load is not an explicit request to spawn: follow the user's delegation request and Codex's current delegation policy. Do not enable agent features or modify config.toml automatically.

Pass the question, bounded task, actual MCP tool names, and shared searcher instructions explicitly. Verify child search-boost MCP access: parent availability does not establish inheritance in every version/configuration. Prefer a fresh/minimal-context child where supported, without inventing launch parameters. Start independent children before waiting; collect results using their returned IDs, and close only owned children after completion or cancellation. Do not assume closing equals successful completion. Use parent synthesis unless a true no-tools summarizer is available.

Reference: https://developers.openai.com/codex/subagents
