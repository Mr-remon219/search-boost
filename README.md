# search-boost-mcp

Multi-engine web search **MCP server** for coding agents. One CLI install wires it into **Cursor**, **Cursor CLI**, **Codex**, **Claude Code**, **Grok Build**, and **Antigravity**.

> **search-boost family**
>
> | Project | For | Link |
> |---------|-----|------|
> | [**search-boost**](https://github.com/Mr-remon219/search-boost) *(this repo)* | Cursor · Codex · Claude · Grok · Antigravity via MCP | you are here |
> | [**dsh-search-boost**](https://github.com/Mr-remon219/dsh-search-boost) | [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) bundle plugin | [GitHub](https://github.com/Mr-remon219/dsh-search-boost) · [npm](https://www.npmjs.com/package/dsh-search-boost) |
> | [**pi-search-boost**](https://github.com/Mr-remon219/pi-search-boost) | [pi](https://github.com/earendil-works/pi-coding-agent) extension | [GitHub](https://github.com/Mr-remon219/pi-search-boost) · [npm](https://www.npmjs.com/package/pi-search-boost) |

Search engines are **vendored in [`lib/search/`](./lib/search/)** (originally from [dsh-search-boost](https://github.com/Mr-remon219/dsh-search-boost)): on the **free** layer, Bing, DuckDuckGo, Yahoo, and Exa-free run in parallel; the **api** layer adds Antigravity CLI (when available) and **whichever keyed Tavily / Brave / Exa engines you configure** (one key is enough; all three recommended for best fusion). Also included: X/Twitter fallback, Jina page fetch, and deep-research rounds.

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

### Verify install

```bash
search-boost doctor          # health checks (offline, pass/warn/fail)
search-boost doctor --json   # machine-readable report for CI/scripts
search-boost status          # install dashboard (keys, layer, agents)
```

Exit codes: **0** healthy · **1** failure (or warnings with `--strict`) · **2** warnings only.

Optional: `search-boost doctor --probe` adds live search smoke (needs network; Phase 2).

Then confirm in your agent:

| Agent | Quick check |
|-------|-------------|
| **Cursor** | Settings → MCP → `search-boost` connected; tools listed |
| **Cursor CLI** | Same MCP entry in `~/.cursor/mcp.json` |
| **Codex** | `codex` session lists `mcp__search-boost__*` tools |
| **Claude Code** | MCP panel shows `search-boost`; tools callable without deny prompt (if `--auto-allow`) |
| **Grok Build** | `grok mcp doctor search-boost` · `grok inspect` |
| **Antigravity** | MCP config includes `search-boost`; restart IDE after install |

If tools appear but calls fail, run `search-boost serve` in a terminal to see startup errors.

### Install flags (quick reference)

| Flag | Effect |
|------|--------|
| `-t`, `--target` | Which agent(s) to wire (`cursor`, `codex`, `claude`, `grok`, `antigravity`, `cursor-cli`, `auto`, `all`) |
| `-y`, `--yes` | Non-interactive: skips keys/layer wizard, uses `--target=auto`, **implies** `--auto-allow` and `--replace-native` |
| `-t` **without** `-y` | Still non-interactive for that target and still **replaces native search by default** — but does **not** imply `--auto-allow`; add it explicitly if you want no permission prompts |
| `--auto-allow` | Pre-approve search-boost MCP tools in agent config (Cursor CLI allowlist, Codex `default_tools_approval_mode`, Claude/Grok/Antigravity permission rules) so the agent does not prompt every session |
| `--replace-native` / `--keep-native` | Disable or keep built-in web search where the agent supports a switch (Codex `web_search`, Claude `WebSearch`). Default is replace when non-interactive |
| `--dry-run` | Print actions without writing files |

For full onboarding (API keys + layer choice), run `search-boost setup` or `search-boost install` without `-y`.

### Uninstall

```bash
search-boost uninstall -t codex -y
search-boost uninstall -t cursor,codex,claude -y
```

Uninstall removes only **search-boost-owned** blocks (marked MCP entries, skills, hooks, permission rules). Where the agent supports it, native web search is restored (Codex top-level `web_search`, Claude `WebSearch` deny) unless you used `--keep-native` at install time or had pre-existing unmarked settings. Config files created solely for search-boost are unlinked when empty after cleanup. Preview: `--dry-run`.

---

## What you get

| MCP tool | Purpose |
|----------|---------|
| `fused_search` | Multi-engine parallel search, dedupe, cross-ranking |
| `fetch_page` | Full page text (Jina + HTML fallback, optional `focus`) |
| `x_search` | X/Twitter keyword / user / thread |
| `deep_research` | One round per call — repeat with `suggested_queries` until gaps empty, then synthesize (~3 rounds max) |
| `search_layer` | Show or set `free` (keyless) vs `api` (keyed engines) |
| `search_stats` | Cache hits, engine availability, diagnostics |

Also: resource `search-boost://policy` · prompt `search_routing`

**Layers**

- **free** — Bing + DuckDuckGo + Yahoo + Exa-free; no API keys.
- **api** — free-layer engines plus Antigravity CLI (when available) and **any** of Tavily / Brave / Exa that you configure (one key works; all three recommended for best cross-engine fusion)

Keys: `search-boost config keys` → `~/.search-boost/config/keys.json` (flat `~/.search-boost-keys.json` and legacy `~/.dsh-search-boost-keys.json` still read; or env `TAVILY_API_KEY`, `BRAVE_API_KEY`, `EXA_API_KEY`). Optional routing: `enabledEngines: ["exa"]` or `"engines": { "brave": { "enabled": false } }` in the keys file.

**Config layout:** runtime data lives under `~/.search-boost/` — `config/` (keys, layer, xauth), `cache/` (xguest token), `state/` (Antigravity workspace registry). First write lazy-migrates from flat `~/.search-boost-*.json` and legacy `~/.dsh-*` files (old copies kept). Override base: `SEARCH_BOOST_HOME`; per-file: `SEARCH_BOOST_*_FILE`.

Obtain keys: [Tavily](https://app.tavily.com/) · [Brave Search API](https://brave.com/search/api/) · [Exa](https://dashboard.exa.ai/)

**X/Twitter auth (optional):** improves official `x_search` when credentials are present. Stored at `~/.search-boost/config/xauth.json` (flat/legacy paths still read) or via `XAI_API_KEY` / Grok `/x-login`. Override file path: `SEARCH_BOOST_XAUTH_FILE`.

**Config file overrides:** `SEARCH_BOOST_KEYS_FILE`, `SEARCH_BOOST_LAYER_FILE`, `SEARCH_BOOST_XAUTH_FILE` (optional env vars pointing at custom paths).

---

## CLI cheat sheet

| Command | What it does |
|---------|----------------|
| `search-boost` | Interactive TUI |
| `search-boost setup` | Onboarding (keys + layer + install) |
| `search-boost install` / `uninstall` | Wire MCP + prompts into agents |
| `search-boost serve` | Run MCP stdio server (used by agents) |
| `search-boost status` | Keys, layer, per-agent configured state |
| `search-boost doctor [--quick\|--probe] [--json] [--strict]` | Config/agents/engine health checks with pass/warn/fail |
| `search-boost status` | Keys, layer, per-agent install state (no verdict) |
| `search-boost config keys\|layer\|search` | Keys, default layer, native-search replace |
| `search-boost print <agent>` | Print MCP snippet without writing |
| `search-boost agents` | Machine-readable agent list |

**Install flags:** `-t cursor,codex,…|auto|all` · `-y` (non-interactive; implies `--auto-allow` + `--replace-native`) · `--dry-run` · `--auto-allow` (pre-approve MCP tools — see table above) · `--replace-native` / `--keep-native` · `--scope user|project` (Grok) · `--workspace` (Antigravity `.agents/`)

---

## Supported agents

| Agent | MCP config | Also installs |
|-------|------------|---------------|
| Cursor IDE | `~/.cursor/mcp.json` | hook, skill |
| Cursor CLI | `~/.cursor/mcp.json` (same surface as IDE) | hook, skill (CLI variant), optional CLI auto-allow |
| Codex CLI | `~/.codex/config.toml` | AGENTS.md, skill |
| Claude Code | `~/.claude.json` | CLAUDE.md, skill, permissions |
| Grok Build | `~/.grok/config.toml` | rule, skill · [grok-plugin](./grok-plugin/) |
| Antigravity | `~/.gemini/config/mcp_config.json` | AGENTS.md, GEMINI.md, skill, optional workspace |

Prompts use **model-discretion** wording (search when you choose — not forced every turn). See [`agents/`](./agents/) for per-agent templates.

**Native web search:** With `--replace-native` (default when non-interactive), Codex gets a marked top-level `web_search = "disabled"` in `config.toml` (never inside `[mcp_servers.*]`); Claude gets an ownership-marked `WebSearch` deny in `settings.json`. Uninstall removes only search-boost-owned entries and restores native search when safe. Cursor / Antigravity rely on skill + hook preference only. Grok native browse is left on.

**Cursor + Cursor CLI:** Both targets share one `~/.cursor/` surface. Installing `-t cursor,cursor-cli` merges IDE + CLI prompts into a single write; uninstall clears the shared surface.

**Antigravity + `agy` CLI:** On the **api** layer, the optional Antigravity CLI engine (`agy` on PATH) joins **medium** and **complex** `fused_search` tiers only — not simple lookups. It depends on local sign-in and platform quota; timeouts are ~45s.

---

## Grok plugin

The plugin ships inside the npm package (MCP via portable `npx`, plus skill).

**Re-install is idempotent:** `search-boost install -t grok` removes any prior search-boost `[permission]` block (marked or legacy) before writing a fresh one, so duplicate `[permission]` keys cannot break `grok` startup. Uninstall strips only search-boost-owned permission lines and unlinks empty configs. If `[ui] permission_mode = "always-approve"` is already set, `--auto-allow` skips injecting `[permission]` (always-approve approves MCP tools globally). `search-boost doctor` warns on duplicate or redundant permission blocks.

**From a git clone** (repo root):

```bash
grok plugin install ./grok-plugin --trust
search-boost install -t grok -y --auto-allow
```

**After `npm install -g search-boost-mcp`** (no clone needed):

```bash
# bash / macOS / Linux
grok plugin install "$(npm root -g)/search-boost-mcp/grok-plugin" --trust

# Windows PowerShell
grok plugin install "$(npm root -g)\search-boost-mcp\grok-plugin" --trust

search-boost install -t grok -y --auto-allow
```

The bundled `.mcp.json` uses `npx -y search-boost-mcp serve` so the plugin works on any machine with Node ≥ 22.13.

Details → [grok-plugin/README.md](./grok-plugin/README.md)

---

## Troubleshooting

| Symptom | What to try |
|---------|-------------|
| Is search-boost healthy? | `search-boost doctor` — pass/warn/fail verdict; `--json` for scripts |
| Install fails immediately | Node **≥ 22.13** (`node -v`); upgrade if older |
| MCP server missing in agent | Re-run install, **restart the agent**, check `search-boost status` |
| Tool calls blocked / approval every turn | Re-install with `--auto-allow`, or approve once in the agent UI |
| No results / empty engines | `search-boost doctor` — check layer/keys/engine checks; **free** needs no keys; **api** needs **at least one** keyed engine via `search-boost config keys` or env vars (all three recommended) |
| Network/proxy issues | Phase 2: `search-boost doctor --probe` (not yet implemented) |
| MCP won't start | `search-boost doctor` → `mcp_launch_command`, `node_version`; then `search-boost serve` |
| Grok plugin MCP won't start | `grok mcp doctor search-boost`; ensure `npx` and network access work |
| `grok` fails on config.toml parse | Duplicate `[permission]` — run `search-boost install -t grok -y --auto-allow` |
| Antigravity `agy` never runs | Requires **api** layer, `agy` on PATH, and `complexity` medium/complex — not simple |
| Timeouts / fetch errors | Corporate proxy or firewall may block Bing/DDG/Jina; try `search-boost serve` locally to read stderr |

---

## Development

```bash
git clone https://github.com/Mr-remon219/search-boost.git
cd search-boost && npm install
npm run check && npm run test:install && npm run smoke
node cli.mjs install --dry-run -y
```

Local clone installs write `node /path/to/cli.mjs serve` (not npx). No sibling checkout or `SEARCH_BOOST_DSH_ROOT` is required.

---

## License

MIT

---

**Links:** [Issues](https://github.com/Mr-remon219/search-boost/issues) · [dsh-search-boost](https://github.com/Mr-remon219/dsh-search-boost) · [pi-search-boost](https://github.com/Mr-remon219/pi-search-boost)

**Friendly link:** [LINUX DO 社区](https://linux.do/)
