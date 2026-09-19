# search-boost

Multi-engine web search for coding agents — **one SearchBoost core, three host adapters**. The MCP server wires into **Cursor**, **Cursor CLI**, **Codex**, **Claude Code**, **Grok Build**, and **Antigravity**; the same package is also a **[pi](https://github.com/earendil-works/pi-coding-agent) extension** and a **[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) bundle plugin**.

```text
                SearchBoost Core  (lib/runtime.mjs + lib/search/)
                        │
          ┌─────────────┼─────────────┐
          │             │             │
     adapters/mcp   adapters/pi   adapters/dsh
     (stdio MCP)   (pi extension) (Cordis bundle)
          │             │             │
          └── agents/<host> prompt policy ──┘
```

> The former standalone repos **pi-search-boost** and **dsh-search-boost** are merged here as host adapters. Search engines, fusion, fetch, and X search are maintained **only** in this repo's core.

**Core** ([`lib/search/`](./lib/search/)): `fused_search` is the main Web Search entry point. `engine_pool` selects **free** (Bing / DuckDuckGo / Yahoo / Exa-free), **api** (Tavily / Brave / Exa only), or **hybrid**; `ranking` changes final engine weights, while `complexity` controls budget/variants/depth. Optional `community=true` reuses X Core for developer/community voices. Normal calls need no manual engine selection. Existing layer settings remain compatible: free → free, api → hybrid. Jina page fetch with `focus` and standalone X account/thread search remain available.

See [search routing, weights, capability and compatibility](docs/search-routing.md). MCP exposes live status at `search-boost://capabilities`; Pi and DSH inject the same dynamically computed capability into their prompts. Results return `enginesUsed`, `effectiveWeights`, `communityUsed`, and `warnings`.

中文文档 → [README_zh.md](./README_zh.md)

---

## Install (recommended)

**Requires Node ≥ 22.13.**

```bash
npm install -g search-boost
search-boost setup          # interactive: keys → layer → agents
# or non-interactive:
search-boost install -y     # all detected agents
```

Restart each agent after install so MCP reloads.

### Updates and one-time npm migration

**Already using `search-boost`:** open the TUI and choose **Update**. It checks npm, runs a newer updater from the npx cache when needed, updates SearchBoost, and refreshes **all installed agent integrations**. Pi and DSH are included: existing `pi-search-boost` / `dsh-search-boost` adapters are moved to the unified `search-boost` package. Detected but unconfigured agents are not installed.

```bash
search-boost                         # TUI → Update
# CLI equivalent / preview / offline asset refresh:
search-boost upgrade -y
search-boost upgrade --dry-run
search-boost upgrade --sync-only -y
search-boost upgrade --workspace /path/to/project -y
```

**Still using the global `search-boost-mcp` npm package:** run the new package's migration code directly through npx. No transition release or manual uninstall is required.

```bash
npx --yes --package=search-boost@latest -- search-boost migrate -y
# Preview:
npx --yes --package=search-boost@latest -- search-boost migrate --dry-run
# After migration:
search-boost                         # future updates: TUI → Update
```

`migrate` is **only the one-time global npm rename**, not the normal update command. It installs/verifies the new global package, then uninstalls global `search-boost-mcp` and verifies the new command. **Agent configuration is left unchanged; choose TUI Update afterward to refresh all existing integrations.** The old package's exact root/extension entries are recorded before removal so local registrations remain recognizable. A conflicting old-owned bin is temporarily parked (never blindly forced); installation failure restores it and retains the old package. API keys, authentication, model settings, permissions and disabled state are retained. Old Pi key environment variables remain supported.

Private configuration backups are under `~/.search-boost/backups/`; upgrade results are in `state/last-upgrade.json` and version-independent local-source ownership in `state/package-sources.json` (all honor `SEARCH_BOOST_HOME`). Pi/DSH remain discoverable across release-directory changes; receipts alone never reinstall a removed integration. Discovery covers known user configs, DSH profiles, current/recorded projects and `--workspace`, not a full-disk scan. Restart/reload affected hosts after completion.

See [migration and release notes](docs/migration.md) and [repeatable Pi/DSH upgrades](docs/host-upgrades.md). The new `search-boost` release must be published before npm `@latest` can deliver this code; there is no old-name transition package to publish.

### One-liners by agent

```bash
search-boost install -t cursor -y
search-boost install -t codex,claude -y --auto-allow
search-boost install -t grok -y --auto-allow   # plugin + config when grok CLI on PATH
search-boost install -t antigravity --workspace --auto-allow -y
search-boost install -t pi -y                  # pi shim + searcher/summarizer + /fast-parallel /complex-parallel
search-boost install -t dsh -y --profile web   # dsh plugin --profile web add … (needs dsh + pnpm)
```

Preview without writing: `search-boost install --dry-run -y`

**pi / DSH without the CLI:** `pi install npm:search-boost` (package manifest `pi.extensions`) or `dsh plugin --profile web add search-boost` (package manifest `dsh.bundle`). See [Host adapters](#host-adapters-pi--deepseek-harness).

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
| `-t`, `--target` | Which agent(s) to wire (`cursor`, `codex`, `claude`, `grok`, `antigravity`, `cursor-cli`, `pi`, `dsh`, `auto`, `all`) |
| `--profile <name>` | DSH only: profile under `$DSH_HOME/profiles` (default `web`) |
| `-y`, `--yes` | Non-interactive: skips keys/layer wizard, uses `--target=auto`, **implies** `--auto-allow` and `--replace-native` |
| `-t` **without** `-y` | Still non-interactive for that target and still **replaces native search by default** — but does **not** imply `--auto-allow`; add it explicitly if you want no permission prompts |
| `--auto-allow` | Pre-approve search-boost MCP tools in agent config (Cursor CLI allowlist, Codex `default_tools_approval_mode`, Claude/Grok/Antigravity permission rules) so the agent does not prompt every session |
| `--replace-native` / `--keep-native` | Disable or keep built-in web search where the agent supports a switch (Codex `web_search`, Claude `WebSearch`). Default is replace when non-interactive |
| `--scope user\|project\|all` | Grok only: user (`~/.grok`), project (`.grok/` in cwd), or both on uninstall |
| `--skip-grok-plugin` | Grok only: skip bundled `grok plugin install`; still writes config.toml, rule, and skill |
| `--dry-run` | Print actions without writing files |

For full onboarding (API keys + layer choice), run `search-boost setup` or `search-boost install` without `-y`.

### Uninstall

```bash
search-boost uninstall -t codex -y
search-boost uninstall -t cursor,codex,claude -y
```

Uninstall removes only **search-boost-owned** blocks (marked MCP entries, skills, hooks, permission rules). Where the agent supports it, native web search is restored (Codex top-level `web_search`, Claude `WebSearch` deny) unless you used `--keep-native` at install time or had pre-existing unmarked settings. Config files created solely for search-boost are unlinked when empty after cleanup; empty directories created during install are left in place (a directory cannot be attributed to us rather than to the user or another tool, so it is not removed). For Grok, plugin removal via `grok plugin uninstall` is **best-effort** (warns and continues if the CLI is missing or uninstall fails). Preview: `--dry-run`.

---

## What you get

| MCP tool | Purpose |
|----------|---------|
| `fused_search` | Multi-engine parallel search, dedupe, cross-ranking |
| `fetch_page` | Full page text (Jina + HTML fallback, chrome stripped, no clip; optional `focus`) |
| `x_search` | X/Twitter keyword / user / thread |
| `search_layer` | Show/set the compatibility default: `free → free`, `api → hybrid`; use `engine_pool` per search |
| `search_stats` | Cache hits, engine availability, diagnostics |
| `adaptive_search` | Optional 1–6 independent questions with per-question coverage evidence (Jev-driven; requires Jev credentials) |

Also: resource `search-boost://policy` · prompt `search_routing`

**Layers**

- **free** — Bing + DuckDuckGo + Yahoo + Exa-free; no API keys.
- **api** — free-layer engines plus **any** of Tavily / Brave / Exa that you configure (one key works; all three recommended for best cross-engine fusion)

Keys: `search-boost config keys` → `~/.search-boost/config/keys.json` (flat `~/.search-boost-keys.json` and legacy `~/.dsh-search-boost-keys.json` still read; or env `TAVILY_API_KEY`, `BRAVE_API_KEY`, `EXA_API_KEY`). Optional routing: `enabledEngines: ["exa"]` or `"engines": { "brave": { "enabled": false } }` in the keys file.

**Config layout:** runtime data lives under `~/.search-boost/` — `config/` (keys, layer, xauth), `cache/` (xguest token), `state/` (Antigravity workspace registry). First write lazy-migrates from flat `~/.search-boost-*.json` and legacy `~/.dsh-*` files (old copies kept). Override base: `SEARCH_BOOST_HOME`; per-file: `SEARCH_BOOST_*_FILE`.

Obtain keys: [Tavily](https://app.tavily.com/) · [Brave Search API](https://brave.com/search/api/) · [Exa](https://dashboard.exa.ai/)

**X/Twitter auth (optional):** improves official `x_search` when credentials are present. Stored at `~/.search-boost/config/xauth.json` (flat/legacy paths still read) or via `XAI_API_KEY`. Configure with `search-boost config x` (see CLI cheat sheet). MCP `/x-login` and `search-boost config x` write the same local copy. Override file path: `SEARCH_BOOST_XAUTH_FILE`.

```bash
search-boost config x --show              # xauth status
search-boost config x --import-grok       # import grok CLI login
search-boost config x --set-xai-key KEY   # store XAI API key
search-boost config x --logout            # remove local copy
```

**Jev credentials (experimental):** TUI → **Jev credentials (experimental)**, or `search-boost config jev`, stores the endpoint and API key for [TypeSafe's Jev](https://console.typesafe.ai/settings/keys) System One decision model. The `jev` block lives in the same keys file as the engine keys so every secret has one home, but Jev is **not a search engine**: it never joins `KEY_NAMES`, engine routing, or the api-layer pool. With credentials set, the optional `adaptive_search` tool uses Jev to pick engines, judge each collected fragment for its own question and report per-question coverage (statuses `covered` / `insufficient` / `unassessed` / `not_searched` / `failed`, with the reviewed fragments). Question text and the necessary evidence fragments are sent to the configured service (default TypeSafe) — no engine key or fingerprint is ever sent, and nothing is written to disk. Without credentials the tool returns `not_configured` without any network request; `fused_search` / `fetch_page` / `x_search` are unaffected and always available. `search-boost status` / TUI → Status print the block once it is set. `TYPESAFE_API_KEY` is read as a fallback; default base URL `https://api.typesafe.ai/v1`.

```bash
search-boost config jev --show                                     # Jev status
search-boost config jev --jev-base-url https://api.typesafe.ai/v1 \
                        --jev-api-key KEY                          # store endpoint + key
search-boost config jev --clear                                    # remove the block
```

**X filtering (with or without login):** all sources share one pipeline: retrieval/enrichment → normalization → merge/deduplication → filtering → result limit. Author handles come from X/Twitter URLs, and modern post IDs supply missing posting times. `from_date` / `to_date` include both UTC calendar dates; keyword `since:` is inclusive and `until:` exclusive. `username`, `allowed_x_handles`, and `excluded_x_handles` are case-insensitive author filters (`@` optional; allow/exclude lists are mutually exclusive, max 20). In user mode, dates filter `recent_posts`, not the account creation date.

Local keyword metadata filters support `from:`, `-from:`, `since:`, `until:`, `min_faves:`, `min_retweets:`, `min_replies:`, and `lang:` with AND/OR groups. Quoted text is not parsed as filters. Text relevance and other operators remain provider-side (unsupported operators are noted). Candidates missing metadata needed to verify a filter are omitted with a note—not treated as matching. Thus keyless engagement/language filtering may return fewer or no posts; search-index coverage and oEmbed cannot reproduce the full authenticated X corpus. Date semantics follow the [xAI tool contract](https://docs.x.ai/developers/tools/x-search).

**Config file overrides:** `SEARCH_BOOST_KEYS_FILE`, `SEARCH_BOOST_LAYER_FILE`, `SEARCH_BOOST_XAUTH_FILE` (optional env vars pointing at custom paths).

---

## CLI cheat sheet

| Command | What it does |
|---------|----------------|
| `search-boost` | Interactive TUI |
| `search-boost setup` | Onboarding (keys + layer + install) |
| `search-boost install` / `uninstall` | Wire MCP + prompts into agents |
| `search-boost serve` | Run MCP stdio server (used by agents) |
| `search-boost status` | Keys, layer, X credentials, per-agent configured state |
| `search-boost doctor [--quick\|--probe] [--json] [--strict]` | Config/agents/engine health checks with pass/warn/fail |
| `search-boost config keys\|layer\|x\|jev\|search` | Keys, default layer, X auth, Jev credentials (experimental), native-search replace |
| `search-boost print <agent>` | Print MCP snippet without writing |
| `search-boost agents` | Machine-readable agent list |

**Install flags:** `-t cursor,codex,…|auto|all` · `-y` (non-interactive; implies `--auto-allow` + `--replace-native`) · `--dry-run` · `--auto-allow` (pre-approve MCP tools — see table above) · `--replace-native` / `--keep-native` · `--scope user|project|all` (Grok) · `--skip-grok-plugin` (Grok) · `--workspace` (Antigravity `.agents/`)

---

## Supported agents

| Agent | MCP config | Also installs |
|-------|------------|---------------|
| Cursor IDE | `~/.cursor/mcp.json` | hook, skill |
| Cursor CLI | `~/.cursor/mcp.json` (same surface as IDE) | hook, skill (CLI variant), optional CLI auto-allow |
| Codex CLI | `~/.codex/config.toml` | SessionStart hook, AGENTS.md, skill |
| Claude Code | `~/.claude.json` | SessionStart hook, CLAUDE.md, skill, permissions |
| Grok Build | `~/.grok/config.toml` | rule, skill, bundled [grok-plugin](./grok-plugin/) (when `grok` on PATH) |
| Antigravity | `~/.gemini/config/mcp_config.json` | first-invocation hook, AGENTS.md, GEMINI.md, skill, optional workspace |
| pi | — (in-process extension, [`adapters/pi`](./adapters/pi/)) | `~/.pi/agent/extensions/search-boost.js` shim; `agents/` + `prompts/` (searcher, summarizer, `/fast-parallel`, `/complex-parallel`) |
| DeepSeek Harness | — (in-process bundle, [`adapters/dsh`](./adapters/dsh/)) | `dsh plugin --profile <p> add` → profile `package.json` |

MCP installs now supply a startup reminder to **proactively verify external facts**: versions, APIs, uncertain technical behavior, comparisons, and recommendations, without waiting for the user to request a search. Skip local-only questions, stable fundamentals, creative writing, and user opt-outs; this does not require searching every turn. Shared policy: [`agents/shared/startup-search.md`](./agents/shared/startup-search.md). pi / DSH retain their host-native search policies.

### Prompt responsibilities and extension entry point

```text
hook: proactive verification       inject.md: basic host/capability context
                      ↓
Ordinary tasks → MCP descriptions + schemas → direct calls
Detailed reference → optional resource: search-boost://policy
Extended workflows → search-boost skill router → registered workflow skills
```

**MCP hosts install the lightweight `search-boost` router and the `search-boost-parallel-research` workflow skill. Neither is a prerequisite for ordinary searches.** The four search/fetch/x/diagnostics tool-manual skills are retired: selection and parameters belong in MCP descriptions/schemas; examples, evidence caveats, and troubleshooting belong in the optional resource. The `search_routing` MCP prompt remains an explicitly requested planning aid, not an automatic stage before each call. Resource reading and context inclusion are controlled by the host.

Router templates live at `agents/<agent>/skill.md`; the six `inject.md` files provide basic orientation only. `SKILL_EXTENSIONS` in [`agents/router.mjs`](./agents/router.mjs) is the extension registry. It registers the parallel-research workflow and drives installation, plugin packaging, and generated router links, with optional host restrictions. Host-specific delegation notes are rendered into the skill; supporting a skill does not imply supporting subagents. See [`agents/shared/skills/README.md`](./agents/shared/skills/README.md). Skills can orchestrate existing, authorized host capabilities; they cannot create subagent tools.

Reinstall keeps the router and removes owned retired tool-manual skills and Codex metadata, preserving user files. Uninstall also handles retired-skill leftovers. Sync plugins with `npm run plugin:sync-grok` / `npm run build:plugin`, then reinstall target hosts after template changes. pi / DSH retain native integration; Grok still carries the proactive reminder in its startup rule.

### Shared parallel research

Pi, DSH, and MCP-host skills share the role prompts and bounded workflow in [`agents/shared/research/`](./agents/shared/research/). Ordinary single-point searches still call tools directly.

| Host | Entry | Execution |
|------|-------|-----------|
| Pi | `search-parallel-subagent`; `/fast-parallel`, `/complex-parallel` | Pi child processes; searcher gets only `fused_search`/`fetch_page`, summarizer gets no tools |
| DSH | Existing native `research_parallel` tool | DSH `spawn` provider; role persona, tool allowlist, depth limit, whole-wave cancellation and handle disposal; **no Pi dependency** |
| Claude / Codex / Cursor IDE & CLI | `search-boost-parallel-research` skill | Use the session's authorized native subagent tools; check child MCP access before fan-out |
| Grok / Antigravity | Same skill, capability-gated | No subagent API is presumed; use native delegation only when actually exposed, otherwise disclose serial research |

Pi and DSH accept the same role/task shapes (DSH also keeps its legacy `query` / `sub_queries` interface):

```json
{"tasks":[{"agent":"searcher","task":"Official API behavior for the target version"},{"agent":"searcher","task":"Known limitations and conflicting evidence"}]}
```

```json
{"agent":"summarizer","task":"Research question, every report with execution status, prior synthesis, and remaining budget"}
```

Fast mode is one wave followed by parent synthesis. Complex mode uses a summarizer to identify material gaps, normally 1–2 waves and at most 3 by workflow policy; the parent remains in control. A native tool call executes **one wave**, not an autonomous research loop. Timeouts, permission failures, truncated reports, and single-source claims must remain visible.

DSH requires a native provider that advertises fresh-context isolation plus `toolFilter`, `depthLimit`, and `persona` support. The default is `spawn`; plugin config `researchProvider` can explicitly select another compatible provider. Older/missing providers fail clearly instead of silently running unrestricted children. `max_seconds` (1–300, default 120) bounds startup and execution for the whole wave; cancellation requests host cleanup, and a non-cooperative provider is not reported as successfully stopped. `max_sources` is prompt guidance, not a hard tool-call quota.

Skills do not install custom host agents, enable delegation features, or enforce runtime controls by themselves. If child delegation/MCP access is absent, serial research is labeled and permitted only when it still meets the user's request. Permission denial, runtime failure, and cancellation are blockers—not reasons to launch another CLI. See [contract, host references, and validation limits](./agents/shared/research/README.md).

### MCP startup injection

| Agent | Mechanism and configuration |
|-------|-----------------------------|
| Claude Code | `~/.claude/settings.json` → `SessionStart` → `hookSpecificOutput.additionalContext` |
| Codex CLI | `~/.codex/hooks.json` → `SessionStart` → `hookSpecificOutput.additionalContext` |
| Cursor IDE / CLI | Reuses `sessionStart` in `~/.cursor/hooks.json`; merged prompts include the proactive policy only once |
| Antigravity | `PreInvocation` in `~/.gemini/config/hooks.json`, only when `invocationNum = 0`; `--workspace` also installs a workspace copy, which defers to the enabled global hook |
| Grok Build | Startup-loaded `search-boost.md` rule; passive hook stdout is ignored by Grok, so no ineffective SessionStart injection is installed |

Hooks read local policy only: no network requests or permission grants. Missing policy or malformed runtime input fails open. Reinstall does not accumulate hooks; uninstall preserves other user hooks. Installation respects host hook-disable settings and does not bypass trust review. **Current Codex requires reviewing and trusting the hook in `/hooks`; older versions may require upgrading or manually enabling their experimental hooks feature.** Cursor cloud agents do not support this `sessionStart` hook.

After changing source or policy, reinstall the target and restart the agent (for example, `node cli.mjs install -t claude -y --keep-native`). Manually adding MCP configuration or using `search-boost print` does not install hooks.

Protocol references: [Claude](https://code.claude.com/docs/en/hooks), [Codex](https://developers.openai.com/codex/hooks), [Cursor](https://cursor.com/docs/agent/hooks), [Antigravity](https://antigravity.google/docs/hooks), [Grok](https://docs.x.ai/build/features/hooks).

## Host adapters (pi / DeepSeek Harness)

Both hosts run the search tools **in-process** on the same core the MCP server uses — no second engine implementation, no MCP hop.

| | pi (`adapters/pi`) | DSH (`adapters/dsh`) |
|---|---|---|
| Load | `pi install npm:search-boost`, `pi -e adapters/pi/index.js`, or the shim written by `search-boost install -t pi` | `dsh plugin --profile web add search-boost` (auto-wires `adapters/dsh/cordis.patch.yml`; repoints built-in `web_search` / `web_fetch`) |
| Tools | `fused_search` (+`site`/`min_score`/`depth`, up to 20 results), `fetch_page` (no clip), `search-parallel-subagent` (searcher/summarizer children; `/fast-parallel` `/complex-parallel`), `x_search`, `adaptive_search` (Jev) | `fused_search`, `fetch_page`, `x_search`, `research_parallel` (DSH native subagents), `search_stats`, `adaptive_search` (Jev); native citation cards |
| Commands | `/web_change`, `/x-login`, `/x-logout`, `/search-cache`, `/search-audit` | `/web_change`, `/x-login`, `/x-logout` |
| Prompt | `<search_balance>` appended on `before_agent_start` + daily search budget note | `systemPrompt.section` `search:policy` (115) + live `search:status` (116) |
| State | audit log `~/.pi/agent/search-boost-audit.jsonl`; legacy `~/.pi/agent/search-boost-layer.json` / `xsearch-auth.json` still read | — |

Keys, layer and X credentials are shared with the MCP server: `search-boost config keys|layer|x` (or the TUI) — `PI_SEARCH_*` env vars and `~/.dsh-search-boost-*.json` are no longer written (legacy files are still read).

**Native web search:** With `--replace-native` (default when non-interactive), Codex gets a marked top-level `web_search = "disabled"` in `config.toml` (never inside `[mcp_servers.*]`); Claude gets an ownership-marked `WebSearch` deny in `settings.json`. Uninstall removes only search-boost-owned entries and restores native search when safe. Cursor / Antigravity rely on skill + hook preference only. Grok native browse is left on.

**Cursor + Cursor CLI:** Both targets share one `~/.cursor/` surface. Installing `-t cursor,cursor-cli` merges IDE + CLI prompts into a single write; uninstall clears the shared surface.

**Grok Build:** `search-boost install -t grok -y --auto-allow` runs `grok plugin install <bundled grok-plugin> --trust` when the Grok CLI is on PATH, then writes `config.toml`, rule, and skill. If `grok` is not on PATH, the plugin step is skipped with a warning and the config install still proceeds. Use `--skip-grok-plugin` for config/rule/skill only. Re-install is idempotent for `[permission]` blocks (marked or legacy); uninstall strips search-boost-owned permission lines. If `[ui] permission_mode = "always-approve"`, `--auto-allow` skips injecting `[permission]`. The plugin's `.mcp.json` uses portable `npx`; `config.toml` uses `resolveMcpLaunch()` (local `node` when developing from a clone) — both can coexist. Manual plugin install: `grok plugin install ./grok-plugin --trust` (advanced) → [grok-plugin/README.md](./grok-plugin/README.md). On Windows the grok CLI answers "no plugins found in the source" when the plugin source path exceeds ~55 characters; copy `grok-plugin` to a shorter path (e.g. `C:\sb\grok-plugin`) and install from there. Either way search-boost only warns, and the config.toml, rule and skill steps still run.

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
| Timeouts / fetch errors | Corporate proxy or firewall may block Bing/DDG/Jina; try `search-boost serve` locally to read stderr |

---

## Development

```bash
git clone https://github.com/Mr-remon219/search-boost.git
cd search-boost && npm install
npm run check && npm run test:install && npm run test:adapters && npm run smoke
node cli.mjs install --dry-run -y
```

Local clone installs write `node /path/to/cli.mjs serve` (not npx). No sibling checkout or `SEARCH_BOOST_DSH_ROOT` is required.

Layout: `lib/runtime.mjs` + `lib/search/` are the core (host-neutral); `adapters/{mcp,pi,dsh}` are the host adapters (registration, rendering, lifecycle only); `agents/<host>/` holds host-level prompt policy; `lib/agents/` is the installer. Search logic belongs in the core — adapters must not reimplement it.

---

## License

MIT

---

**Links:** [Issues](https://github.com/Mr-remon219/search-boost/issues) · former repos merged here: [dsh-search-boost](https://github.com/Mr-remon219/dsh-search-boost) · [pi-search-boost](https://github.com/Mr-remon219/pi-search-boost)

**Friendly link:** [LINUX DO 社区](https://linux.do/)
