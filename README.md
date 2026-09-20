# SearchBoost

**Multi-engine web evidence for coding agents — one core, three adapters.**

SearchBoost gives an agent web search, page reading, X/Twitter retrieval and optional Jev-assisted evidence collection. It merges search results, removes duplicates and reports the engines, warnings and evidence actually used. The agent still decides what to investigate and writes the final answer.

[中文说明](./README_zh.md) · [Search routing](./docs/search-routing.md) · [Migration](./docs/migration.md) · [Host upgrades](./docs/host-upgrades.md)

```text
                SearchBoost CLI / TUI
             installation · configuration · updates
                          │
                 Shared SearchBoost Core
             search · fetch · X · adaptive evidence
                          │
          ┌───────────────┼───────────────┐
          MCP             Pi              DSH
          stdio server    extension       native bundle
```

The former `pi-search-boost` and `dsh-search-boost` projects are integrated here. Search algorithms live in `lib/`, not in three separate implementations. MCP integrations cover Cursor / Cursor CLI, Codex, Claude Code, Grok Build and Antigravity; Pi and DeepSeek Harness use their native adapters.

> **Release preparation:** the `v0.2.0` branch is not an npm release. Commands containing `@latest` use the published package, not this Git branch. Before the unified release is published, use [installation from source](#installation-from-source) to try this branch. Merging a PR does not publish npm automatically.

## Quick start

Requires **Node.js 22.13 or later** and npm. Install the package, then let the setup wizard configure the engines and the hosts you choose:

```bash
npm install -g search-boost
search-boost setup
search-boost doctor
```

No API key is required for the free engine pool. Restart or reload the affected agent after installation so its tools and prompt assets refresh.

Already configured your keys? Install specific integrations instead:

```bash
search-boost install -t cursor --keep-native
search-boost install -t codex,claude --keep-native
search-boost install -t pi -y
search-boost install -t dsh -y --profile web
search-boost install -t antigravity --workspace /path/to/project --keep-native
```

**Read the install flags before automating:** `-y` skips the wizard and implies `--auto-allow` and `--replace-native`. Specifying `-t` without `-y` is also non-interactive and defaults to replacing native search, but does **not** imply auto-approval. `--keep-native` preserves native search; omit `--auto-allow` when you need host permission prompts. Changes depend on what each host supports.

```bash
search-boost install -t cursor --dry-run --keep-native
search-boost status
search-boost print codex
```

`--dry-run` previews supported operations without writes. `print` prints an MCP configuration snippet without installing it. Run `search-boost --help` for the complete command reference.

### Host-specific notes

| Host | Integration and verification |
| --- | --- |
| Cursor / Cursor CLI | MCP entry in `~/.cursor/mcp.json`; check that `search-boost` is connected. |
| Codex / Claude Code | MCP tools plus host prompt/skill assets; confirm the tools are available after restart. |
| Grok Build | MCP/config assets and the bundled plugin when the `grok` CLI is available; `--skip-grok-plugin` skips plugin installation. |
| Antigravity | MCP plus workspace guidance; pass `--workspace` for a specific project. |
| Pi | Native extension plus owned searcher/summarizer definitions and `/fast-parallel`, `/complex-parallel` templates. |
| DeepSeek Harness | Native bundle; CLI installation needs `dsh` and `pnpm`. `--profile` selects the DSH profile, default `web`. |

Native package managers are also supported:

```bash
pi install npm:search-boost
dsh plugin --profile web add search-boost
```

The Pi package manifest loads the extension; use `search-boost install -t pi -y` for the owned role definitions and prompt templates as well. Do not install the old standalone adapter beside the new one. The managed updater handles recognized legacy registrations.

### Installation from source

Keep the checkout in a permanent directory while using a source-linked installation:

```bash
git clone https://github.com/Mr-remon219/search-boost.git
cd search-boost
git switch v0.2.0
npm ci
npm run plugin:sync-grok
npm install -g .
search-boost setup
```

To refresh that checkout, pull the intended branch, run `npm ci` and `npm run plugin:sync-grok` again, then `search-boost upgrade --sync-only -y`. Do not assume an npm update follows a development branch.

## How to use it

Use the tools in your agent conversation; the CLI installs/configures the integration and is not a separate `search <query>` command. For example:

> Check the official documentation for this dependency's current API, read the relevant page, and explain whether our code needs a change. Do not change my search configuration.

### Tool responsibilities

| Tool | Use it for | Important boundary |
| --- | --- | --- |
| `fused_search` | A precise lookup or a few distinct web-search angles, with merged/ranked results. | One search operation; the parent decides any follow-up. |
| `fetch_page` | Reading a known public URL, optionally keeping paragraphs matching `focus`. | Not a logged-in browser or a private-network fetcher. |
| `x_search` | Available X posts, account material or thread material. | Coverage may be delayed, partial or empty; not a complete sentiment sample. |
| `adaptive_search` | Optional automatic follow-up and per-question evidence assessment using Jev. | Not a subagent runner, a final-answer generator or an independent fact checker. |
| `search_layer` | Inspecting/changing the compatibility default in MCP. | `show` reads; `free` / `api` persist a change and require authorization. |
| `search_stats` | Read-only MCP/DSH diagnostics: engines, cache and recent activity. | Configuration readiness is not a successful network probe. |

Pi exposes `/web_change` and `/search-audit` for its corresponding host controls. DSH exposes `/web_change` for the layer. Do not assume every host has identical command names.

A tool call might look like this; these are **tool arguments**, not shell commands:

```json
{
  "query": "AbortSignal.any Node.js documentation",
  "include_domains": ["nodejs.org"],
  "engine_pool": "free",
  "complexity": "simple",
  "max_results": 5
}
```

Then call `fetch_page` with a returned source URL:

```json
{
  "url": "https://nodejs.org/api/globals.html",
  "focus": "AbortSignal.any"
}
```

A `focus` miss does not establish absence: retry without focus when the full page is needed. The reader tries Jina first and a guarded local HTML fetch second. It removes CSS/JS/ad chrome, caches usable pages in memory, and enforces raw response-size limits rather than promising to retrieve arbitrary-sized pages.

### Engine pools, ranking and budget

| Parameter | Meaning |
| --- | --- |
| `engine_pool: free` | Keyless Bing, DuckDuckGo, Yahoo and Exa-free. |
| `engine_pool: api` | **Only** configured, enabled Tavily / Brave / Exa engines. |
| `engine_pool: hybrid` | The free pool plus configured, enabled API engines. |
| `engines` | Optional explicit engine selection; unavailable/disabled engines are reported, not enabled automatically. |
| `ranking` | `balanced`, `research` or `fresh`: final engine-weight preset only. |
| `complexity` | `simple`, `medium` or `complex`: search budget, variants and depth. |
| `community` | Opt-in X/community material mixed into the final result limit; default `false`. |

Normally omit `engines`. `engine_weights` customizes scores, not engine selection. Domain filters restrict results; `recency` favors recent dated evidence, not a guarantee that every returned page is within a strict date interval. Read `enginesUsed`, `effectiveWeights`, `communityUsed` and `warnings`.

The older persistent **layer** is a compatibility setting: `free → free` pool, **`api → hybrid`** pool. It is not the same as the strict `engine_pool: api`. Prefer per-call parameters over changing a user's default.

MCP exposes live configuration at `search-boost://capabilities`. Pi and DSH inject the same computed status into their host prompts. The optional MCP `search-boost://policy` resource supplies examples and limitations; neither that resource, the `search_routing` planning prompt nor a skill is required before calling a tool.

### Jev-assisted collection

```bash
search-boost config jev
search-boost config jev --show
```

Then call `adaptive_search`:

```json
{
  "questions": [
    "What cancellation behavior does the documented API guarantee?",
    "Which version introduced the behavior our code relies on?"
  ]
}
```

Accepts 1–6 nonblank questions, each at most 400 characters. Duplicate questions share execution but keep their output positions. Jev selects permitted searches and evaluates snippets, engine-returned material and fetched fragments; code enforces the budgets, engine restrictions and response validation.

The result preserves every question with `covered`, `insufficient`, `unassessed`, `not_searched` or `failed`, reviewed evidence and explicit gaps. **`covered` is a model judgment about those fragments, not verified truth.** Inspect conflicts and missing requirements. Without configured Jev credentials, the tool returns `not_configured` without network requests. A Jev failure may permit a bounded plain-search fallback whose new findings remain unassessed. Direct search/read/X tools do not require Jev.

### Optional parallel research

Pi's `search-parallel-subagent` and DSH's `research_parallel` execute children; they do not replace the parent agent's judgment. Searchers collect evidence with search/read tools; summarizers receive reports and have no tools. Fast mode uses one wave and parent synthesis. Complex mode adds gap review and only material follow-up waves.

Delegation must be authorized. Pi's runner leaves wave size to the caller and has no concurrency cap: choose a sensible task budget. DSH uses its native provider and reports missing capabilities rather than launching Pi. Neither a skill nor a tool description grants permission to bypass a failed runtime, denied tool or cancellation.

## Configuration and privacy

```bash
search-boost config keys           # search-engine credentials and routing
search-boost config layer          # compatibility default
search-boost config x              # optional X authentication
search-boost config jev            # optional Jev endpoint and credential
```

Prefer interactive entry over placing secrets in command arguments or chat history.

Runtime configuration lives in `~/.search-boost/config/`: `keys.json` (engines and Jev), `layer.json`, and `xauth.json`. `SEARCH_BOOST_HOME` relocates the SearchBoost directory. Legacy flat files can be adopted on first write; once a canonical store is initialized, clearing it does not revive an older backup. Corrupt authoritative stores are reported, not silently replaced. `enabledEngines: []` intentionally disables all keyed engines; omitting the field uses configured engines that are not individually disabled.

**Jev is config-only:** its endpoint/key pair comes from the canonical `config/keys.json`. `TYPESAFE_API_KEY`, project files, old adapter files and `SEARCH_BOOST_KEYS_FILE` cannot supply Jev credentials. Clearing Jev does not absorb or reactivate an environment key. Other providers keep their compatibility policy: Tavily / Brave / Exa can use their documented environment-key fallbacks, and X can use `XAI_API_KEY`. Jev is not a search engine or a substitute API-engine credential.

Private configuration writes are atomic with restrictive permissions on POSIX. Files are **not encrypted**; Windows protection also depends on account/file ACLs. Do not publish configuration files or paste raw keys into diagnostics.

Search queries go to selected engines; Jina receives the requested page URL. Enabling Jev sends the questions and necessary evidence fragments to the configured endpoint, default `https://api.typesafe.ai/v1`. Engine keys/fingerprints are not included in the Jev body. The core evidence pool is in memory, but **the host can save conversation and audit history**. Pi maintains `search-boost-audit.jsonl` under its agent directory and logs search queries/URLs and activity; `/search-audit clear` clears that audit, not host conversation history.

X credentials are optional. `search-boost config x --import-grok` copies an existing Grok login; `--logout` removes SearchBoost's local copy without signing Grok itself out. Pi/DSH also provide `/x-login` and `/x-logout`; these are not MCP slash commands. X date bounds are inclusive UTC calendar dates; in user mode they filter recent posts. Unverifiable author/date/engagement metadata can cause candidates to be omitted.

## Updating existing installations

### Already using `search-boost`

Open `search-boost` and choose **Update**, or use:

```bash
search-boost upgrade --dry-run
search-boost upgrade -y
```

Update checks the published release, updates the package when necessary and refreshes **existing configured integrations**, including recognized old Pi/DSH registrations. It does not install every merely detected host. Keep host disabled state, model settings and permissions under user control; inspect reported failures instead of assuming every host updated.

```bash
search-boost upgrade --sync-only -y                    # refresh installed assets, no npm update
search-boost upgrade --workspace /path/to/project -y   # include a particular project
```

Discovery covers known user configs, DSH profiles and current/recorded/explicit workspaces, not an entire disk. Backups are under `~/.search-boost/backups/`; update results and source-ownership receipts are in `state/last-upgrade.json` and `state/package-sources.json`. A stale receipt alone must not reinstall an integration you removed. Reload affected hosts afterward.

### Still using `search-boost-mcp`

After the unified package is published, run its migration code explicitly:

```bash
npx --yes --package=search-boost@latest -- search-boost migrate --dry-run
npx --yes --package=search-boost@latest -- search-boost migrate -y
search-boost upgrade -y
```

`migrate` does **only the one-time global npm rename**. It installs/verifies the new package before removing the old one, handles the shared command safely, and leaves agent configuration unchanged. The following **Update / `upgrade` step** refreshes those integrations. No transition release of the old package, `postinstall` migration or blind manual uninstall is required. A failed handoff retains the old installation where rollback is possible and reports the failure.

### Still using standalone Pi/DSH adapters

Install the unified CLI, then use TUI **Update** or `search-boost upgrade -y`. The host-upgrade path recognizes supported legacy registrations and refreshes the native adapter/assets; `migrate` is not the Pi/DSH migration command. Review [host upgrade details](./docs/host-upgrades.md) for source types, project/profile discovery and retryable failures. Keep backups until the new tools work.

## Diagnostics, network limits and uninstall

```bash
search-boost doctor
search-boost doctor --json
search-boost doctor --strict
search-boost status
```

`doctor` currently performs offline checks. **`--probe` is reserved and reports pending; it is not a live connectivity test.** Exit codes: `0` healthy, `1` failure (or warnings with `--strict`), `2` warnings only. Confirm an actual tool call in the host before concluding that a provider is reachable.

Fixed-service transport honors `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY` and lowercase equivalents; nonempty lowercase values take precedence. `NO_PROXY` / `no_proxy` applies to these service requests. SOCKS URLs are rejected explicitly; use an HTTP/mixed proxy port supported by the transport rather than expecting silent direct access.

For arbitrary pages, the direct fallback resolves and validates addresses once, pins the connection to them, and repeats validation at redirects. Cache hits and Jina do not require a local lookup of the target page. A configured HTTP proxy cannot currently provide equivalent target-address pinning with the locked transport, so that local fallback reports `proxy_unsupported` instead of bypassing the proxy. The Jina path may still work. TUN fake-IP compatibility requires explicit `SEARCH_BOOST_TRUSTED_TUN=1` and trust in the TUN's real routing; it is not enabled automatically.

On failed/empty searches, inspect returned warnings and `search_stats` or the host audit. DNS failure, provider throttling, filters and missing credentials are different causes. Do not disable safety checks or change persistent layers merely because a request failed.

```bash
search-boost uninstall -t cursor,codex,claude --dry-run -y
search-boost uninstall -t cursor,codex,claude -y
```

Uninstall targets SearchBoost-owned registrations, blocks and assets, retaining unrelated user content. Native search restoration depends on the owned settings and the host; Grok plugin removal is best-effort when its CLI is unavailable. Remove the npm package only after removing the integrations that depend on it.

## Architecture and development

`lib/runtime.mjs` is the host-neutral facade. `lib/search/` owns retrieval, ranking, network policy and adaptive evidence; `lib/jev/` owns the Jev protocol client. `adapters/` translates those results to each host. `agents/` contains the authored prompt/skill templates; generated host bundles should be refreshed rather than edited independently.

**Prompt responsibilities:** tool descriptions explain when to call and what is returned; schemas explain parameters; injection explains verification policy and boundaries; live capabilities explain configuration; optional skills/templates explain workflows; child-role prompts explain the assigned subtask. See [the prompt contract](./docs/prompt-contract.md).

```bash
npm ci
npm run prepublishOnly    # sync generated assets + all offline test gates; does not publish
npm run test:network      # DNS/proxy/pinning plus release-audit regressions
npm run test:adaptive
npm run test:adapters
npm run smoke            # MCP protocol smoke
npm pack --dry-run
```

CI runs the gates on Linux and Windows. Mocked provider responses and local network fixtures do not prove paid-service availability or every host version's live behavior; test those separately before publishing a release.

[MIT License](./LICENSE)
