# search-boost-mcp

Multi-engine web search as an **MCP server** for coding agents — one CLI installs into **Cursor**, **Cursor CLI**, **Codex**, **Claude Code**, **Grok Build**, and **Antigravity**.

> **search-boost family**
>
> | Project | For | Link |
> |---------|-----|------|
> | **search-boost-mcp** *(this repo)* | Cursor · Codex · Claude · Grok · Antigravity via MCP | you are here |
> | [**dsh-search-boost**](https://github.com/Mr-remon219/dsh-search-boost) | [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) bundle plugin | [GitHub](https://github.com/Mr-remon219/dsh-search-boost) · [npm](https://www.npmjs.com/package/dsh-search-boost) |
> | [**pi-search-boost**](https://github.com/Mr-remon219/pi-search-boost) | [pi](https://github.com/earendil-works/pi-coding-agent) extension | [GitHub](https://github.com/Mr-remon219/pi-search-boost) · [npm](https://www.npmjs.com/package/pi-search-boost) |

Search engines come from [`dsh-search-boost`](https://github.com/Mr-remon219/dsh-search-boost) (bundled as an npm dependency): Bing, DuckDuckGo, Exa-free, optional Tavily/Brave/Exa, X/Twitter fallback, Jina fetch, and deep-research rounds.

中文文档 → [README_zh.md](./README_zh.md)

---

## Install (recommended)

**Requires Node ≥ 22.13.**

```bash
npm install -g search-boost-mcp
search-boost setup          # interactive: keys → layer → agents
# or non-interactive:
search-boost install -y     # all detected agents
```

Restart each agent after install so MCP reloads.

### One-liners by agent

```bash
search-boost install -t cursor -y
search-boost install -t codex,claude -y --auto-allow
search-boost install -t grok -y --auto-allow
search-boost install -t antigravity --workspace --auto-allow -y
```

Preview without writing: `search-boost install --dry-run -y`

---

## What you get

| MCP tool | Purpose |
|----------|---------|
| `fused_search` | Multi-engine parallel search, dedupe, cross-ranking |
| `fetch_page` | Full page text (Jina + HTML fallback, optional `focus`) |
| `x_search` | X/Twitter keyword / user / thread |
| `deep_research` | One research round — gaps + suggested follow-ups |
| `search_layer` | Show or set `free` (keyless) vs `api` (keyed engines) |
| `search_stats` | Cache hits, engine availability, diagnostics |

Also: resource `search-boost://policy` · prompt `search_routing`

**Layers**

- **free** — Bing + DDG + Exa-free (+ Antigravity CLI when available); no API keys
- **api** — free engines plus Tavily / Brave / Exa when keys are set

Keys: `search-boost config keys` → `~/.dsh-search-boost-keys.json` (or env `TAVILY_API_KEY`, `BRAVE_API_KEY`, `EXA_API_KEY`).

---

## CLI cheat sheet

| Command | What it does |
|---------|----------------|
| `search-boost` | Interactive TUI |
| `search-boost setup` | Onboarding (keys + layer + install) |
| `search-boost install` / `uninstall` | Wire MCP + prompts into agents |
| `search-boost serve` | Run MCP stdio server (used by agents) |
| `search-boost status` | Keys, layer, per-agent configured state |
| `search-boost config keys\|layer\|search` | Keys, default layer, native-search replace |
| `search-boost print <agent>` | Print MCP snippet without writing |
| `search-boost agents` | Machine-readable agent list |

**Install flags:** `-t cursor,codex,…|auto|all` · `-y` (non-interactive) · `--dry-run` · `--auto-allow` · `--replace-native` / `--keep-native` · `--scope user|project` (Grok) · `--workspace` (Antigravity `.agents/`)

---

## Supported agents

| Agent | MCP config | Also installs |
|-------|------------|---------------|
| Cursor IDE / CLI | `~/.cursor/mcp.json` | hook, skill, optional CLI auto-allow |
| Codex CLI | `~/.codex/config.toml` | AGENTS.md, skill |
| Claude Code | `~/.claude.json` | CLAUDE.md, skill, permissions |
| Grok Build | `~/.grok/config.toml` | rule, skill · [grok-plugin](./grok-plugin/) |
| Antigravity | `~/.gemini/config/mcp_config.json` | AGENTS.md, GEMINI.md, skill, optional workspace |

Prompts use **model-discretion** wording (search when you choose — not forced every turn). See [`agents/`](./agents/) for per-agent templates.

**Native web search:** Codex `web_search` and Claude `WebSearch` can be disabled with `--replace-native` (default on `-y`). Cursor / Antigravity rely on skill + hook preference only. Grok native browse is left on.

---

## Grok plugin

```bash
grok plugin install ./grok-plugin --trust
search-boost install -t grok -y --auto-allow
```

Details → [grok-plugin/README.md](./grok-plugin/README.md)

---

## Development

```bash
git clone https://github.com/Mr-remon219/search-boost-mcp.git
cd search-boost-mcp && npm install
npm run check && npm run test:install && npm run smoke
node cli.mjs install --dry-run -y
```

Local clone installs write `node /path/to/cli.mjs serve` (not npx). Sibling checkout: set `SEARCH_BOOST_DSH_ROOT=../dsh-search-boost` if needed.

---

## License

MIT

---

**Links:** [Issues](https://github.com/Mr-remon219/search-boost-mcp/issues) · [dsh-search-boost](https://github.com/Mr-remon219/dsh-search-boost) · [pi-search-boost](https://github.com/Mr-remon219/pi-search-boost)

**Friendly link:** [LINUX DO 社区](https://linux.do/)
