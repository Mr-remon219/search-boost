# search-boost-mcp

Multi-engine web search **MCP server** for coding agents — with one CLI to install into **Cursor**, **Cursor CLI**, **Codex**, **Claude Code**, **Grok Build**, and **Antigravity**.

Engine implementation read-only from [`dsh-search-boost`](../dsh-search-boost/) `lib/` (or npm `dsh-search-boost` when published).

## Quick start (local dev)

```bash
cd search-boost-mcp
npm install
npm run check
npm run test:install
npm run smoke

# Interactive agent picker (codegraph-style)
node cli.mjs install

# Non-interactive — all detected agents
node cli.mjs install -y

# Specific agents (cursor + cursor-cli merge into one hook inject)
node cli.mjs install -t cursor,cursor-cli,codex -y

# Preview without writes
node cli.mjs install --dry-run -y

# Check detection vs configured state
node cli.mjs status
```

After install, **restart** each agent to load MCP.

## npm package (not published yet)

```bash
npm install -g search-boost-mcp   # future
search-boost-mcp install -y
search-boost-mcp serve            # MCP stdio entry
```

When installed via npm, MCP config uses `search-boost-mcp serve` or `npx -y search-boost-mcp serve` — no hard-coded repo paths.

## CLI commands

| Command | Description |
|---------|-------------|
| `serve` | Run MCP stdio server (default) |
| `install` | Merge MCP config + inject agent-specific prompts |
| `uninstall` | Remove search-boost from selected agents |
| `agents` | List agents + detection/config status |
| `status` | Table of detected vs configured |
| `install --print-config <id>` | Print snippet only (no writes) |

### Install flags

```
-t, --target <ids>   cursor | cursor-cli | codex | claude | grok | antigravity | auto | all
-y, --yes            auto-detect agents, no prompt
--dry-run            preview only
--auto-allow         Auto-allow search-boost MCP tools (Claude + Cursor CLI)
```

## Per-agent wiring

| Agent | MCP config | Prompt injection |
|-------|------------|------------------|
| **Cursor IDE** | `~/.cursor/mcp.json` | Hook `sessionStart` + skill |
| **Cursor CLI** | same mcp.json | same hook + skill + `cli-config.json` |
| **Codex CLI** | `~/.codex/config.toml` | `~/.codex/AGENTS.md` |
| **Claude Code** | `~/.claude.json` | `~/.claude/CLAUDE.md` + skill |
| **Grok Build** | `~/.grok/config.toml` | `~/.grok/rules/search-boost.md` + skill |
| **Antigravity** | `~/.gemini/config/mcp_config.json`* | `~/.gemini/AGENTS.md` + skill |

### Cursor / Cursor CLI surfaces

| Surface | Path |
|---------|------|
| MCP | `~/.cursor/mcp.json` |
| Proactive policy | `~/.cursor/hooks.json` → `sessionStart` (capability summary, optional) |
| Inject body | `~/.cursor/hooks/search-boost-inject.md` |
| Hook script | `~/.cursor/hooks/search-boost-session.mjs` |
| Tool routing skill | `~/.cursor/skills/search-boost/SKILL.md` |
| CLI auto-allow | `~/.cursor/cli-config.json` → `Mcp(search-boost:*)` |
| Policy runtime | MCP resource `search-boost://policy` |

\* Antigravity uses unified vs legacy MCP path detection; entry omits `type: "stdio"` (required by Antigravity UI). Uninstall sweeps both paths.

Tailored prompt templates live in [`agents/`](./agents/). Cursor surfaces describe **when search-boost helps** and tool routing — the model decides whether to search; bounded efficiency hints (~3 rounds) are suggestions, not mandates.

## MCP tools

`fused_search` · `fetch_page` · `deep_research` · `x_search` · `search_layer` · `search_stats`

Resource: `search-boost://policy` · Prompt: `search_routing`

## dsh-search-boost dependency

Resolve order:

1. `SEARCH_BOOST_DSH_ROOT` env
2. Sibling `../dsh-search-boost/` (monorepo dev)
3. `node_modules/dsh-search-boost/` (after npm co-install)

## Development

```bash
npm run check
npm run test:install
npm run smoke
node cli.mjs install --dry-run -t all
node cli.mjs install --print-config antigravity
```

## License

MIT
