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

# Specific agents (cursor + cursor-cli merge into one AGENTS.md block)
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
--auto-allow         Claude / Antigravity: auto-allow search-boost MCP tools
--workspace [dir]    Also inject .agents/ under cwd or dir (Antigravity)
```

## Per-agent wiring

| Agent | MCP config | Prompt injection |
|-------|------------|------------------|
| **Cursor IDE** | `~/.cursor/mcp.json` | `~/.cursor/AGENTS.md` + skill |
| **Cursor CLI** | same mcp.json | merged into AGENTS.md when both selected |
| **Codex CLI** | `~/.codex/config.toml` | `~/.codex/AGENTS.md` |
| **Claude Code** | `~/.claude.json` | `~/.claude/CLAUDE.md` + skill |
| **Grok Build** | `~/.grok/config.toml` | `~/.grok/rules/search-boost.md` + skill |
| **Antigravity** | `~/.gemini/config/mcp_config.json`* | `~/.gemini/AGENTS.md` + `GEMINI.md` + skill |

\* Antigravity uses unified vs legacy MCP path detection; entry omits `type: "stdio"` (required by Antigravity UI). Uninstall sweeps both paths.

### Antigravity injection matrix

| Surface | Global | Workspace | Plugin |
|---------|--------|-----------|--------|
| MCP | `~/.gemini/config/mcp_config.json` | `.agents/mcp_config.json` | `mcp_config.json` |
| Cross-tool rules | `~/.gemini/AGENTS.md` | — | — |
| AGY routing override | `~/.gemini/GEMINI.md` | — | — |
| Always-on rule | — | `.agents/rules/search-boost.md` | `rules/search-boost.md` |
| Skill | `~/.gemini/config/skills/search-boost/` | `.agents/skills/search-boost/` | `skills/search-boost/` |
| Permissions | `~/.gemini/antigravity-cli/settings.json` + `--auto-allow` | — | manual |
| PreInvocation hook | — | `.agents/hooks.json` | `hooks.json` |

Recommended install:

```bash
# Global + workspace + auto-allow MCP tools
node cli.mjs install -t antigravity --auto-allow --workspace -y

# Optional: Antigravity CLI plugin bundle (skill, rule, MCP, hook)
npm run build:plugin
agy plugin install ./agents/antigravity/plugin
```

Plugin ships skill/rule/MCP/hook. Global `AGENTS.md`, `GEMINI.md`, and permissions still come from `cli.mjs install`.

Enable the PreInvocation reminder in workspace or plugin: set `"enabled": true` on `search-boost-reminder` in `hooks.json`.

Tailored prompt templates live in [`agents/`](./agents/). They implement a **bounded proactive search** policy aligned with dsh-search-boost `policy.js`: search-first for external facts, doubt→search, max ~3 rounds, per-agent restraint.

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
npm run build:plugin
npm run smoke
node cli.mjs install --dry-run -t antigravity --workspace --auto-allow
node cli.mjs install --print-config antigravity
```

## License

MIT
