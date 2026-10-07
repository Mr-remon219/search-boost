<p align="center">
  <img src="./assets/banner.png" alt="SearchBoost" width="860">
</p>

<p align="center">
  <strong>Multi-engine web search & evidence synthesis for AI coding agents</strong><br>
  <em>One shared core runtime, deeply adapted for MCP, Pi, and DeepSeek Harness</em>
</p>

<p align="center">
  <a href="#"><img src="https://img.shields.io/badge/version-v0.2.5--beta1-orange?style=flat-square" alt="version"></a>
  <a href="https://www.npmjs.com/package/search-boost"><img src="https://img.shields.io/badge/npm-search--boost-cb3837?style=flat-square&logo=npm" alt="npm version"></a>
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/node-%3E%3D22.13-339933?style=flat-square&logo=node.js" alt="Node version"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" alt="License"></a>
  <a href="#"><img src="https://img.shields.io/badge/architecture-unified%20core-8a2be2?style=flat-square" alt="Architecture"></a>
  <a href="#"><img src="https://img.shields.io/badge/free%20tier-zero%20key%20required-success?style=flat-square" alt="Free tier"></a>
</p>

<p align="center">
  <a href="./README.md">English</a> · <a href="./README_zh.md">中文文档</a>
</p>

---

> [!NOTE]
> **Release & Branch Notice**: The formerly standalone `pi-search-boost` and `dsh-search-boost` projects are merged into one codebase under `lib/`. Documented commands specifying `@latest` retrieve the official published npm package. To test code that is not in a published release, check out the branch or tag you need and follow [Installation from Source & Development](#installation-from-source--development).

---

> **v0.2.5-beta1**: unified dedicated judgment adapters for Jev and self-hosted Laya, named profiles, truthful schema V6 identity and compatible private snapshot recovery. See the [release and configuration notes](./docs/v0.2.5-release.md). Laya requires complete diagnostics and pinned offline head-capacity evidence; registration is not a live-service or model-quality claim. This source version does not imply npm publication; `@latest` follows the published registry.

## Table of Contents

- [Key Features](#key-features)
- [System Architecture](#system-architecture)
- [Supported Hosts Matrix](#supported-hosts-matrix)
- [Quick Start (30 Seconds)](#quick-start-30-seconds)
- [Upgrade & Migration Guide](#upgrade--migration-guide)
- [Interactive Console (TUI)](#interactive-console-tui)
- [Tool Suite & Usage Guide](#tool-suite--usage-guide)
  - [Tool Responsibilities & Boundaries](#tool-responsibilities--boundaries)
  - [1. `fused_search` Multi-Engine Search](#1-fused_search-multi-engine-search)
  - [2. `fetch_page` Smart Content Reader](#2-fetch_page-smart-content-reader)
  - [3. `x_search` X (Twitter) Intelligence](#3-x_search-x-twitter-intelligence)
  - [4. `adaptive_search` Jev / Laya Intent-Guided Search (Experimental)](#4-adaptive_search-jev--laya-intent-guided-search-experimental)
  - [Engine Pools & Scoring Presets](#engine-pools--scoring-presets)
- [Parallel Multi-Agent Research Workflows](#parallel-multi-agent-research-workflows)
- [Security](#security)
- [CLI Command Reference (Headless & CI)](#cli-command-reference-headless--ci)
- [Installation from Source & Development](#installation-from-source--development)
- [Friendly Links](#friendly-links)
- [License](#license)

---

## Key Features

- **Multi-Engine Parallel Fusion (`fused_search`)**  
  Queries multiple search providers in parallel. Features an out-of-the-box **keyless free pool** (Bing, DuckDuckGo, Yahoo, Exa-free, AnySearch) and a keyed **API pool** (Tavily, Brave, Exa, AnySearch). Automatically performs cross-engine URL deduplication, domain routing, and relevance re-ranking.
- **Clean Webpage Content Extractor (`fetch_page`)**  
  Fetches the origin first for low latency, with optional same-route curl compatibility fallback and Jina Reader backup. Strips CSS, JS, and ad clutter. Supports focused contextual paragraph extraction via `focus`, backed by in-memory caching and size limits.
- **X / Twitter Community Intelligence (`x_search`)**  
  Retrieves public posts, user timelines, and discussion threads via official xAI API or an anonymous fallback channel. Derives UTC timestamps from verifiable Snowflake post IDs and applies author/date filters only when metadata can be verified. Coverage may be incomplete, stale or empty; a retrieved sample does not establish platform-wide sentiment.
- **Jev / Laya Intent-Guided Search (`adaptive_search` · Experimental)**
  Supply one full question and a required research intent. One pre-search judgment strategy request selects the fixed ranking preset and (when community is omitted) whether to add the already-wired community branch; one bounded fused snapshot (32 candidates for targets up to 10; larger targets keep the same headroom ratio, at most 160) is then screened with fixed safety, prototype value 3/4/5 and source-discount options. No keyword planning, no constraints gate, no language check, no automatic page read, and no self-set cumulative budget stop; cursor and saved-result pagination only replay stored results. No claim of verified or complete answers.
- **Native Multi-Agent Parallel Research**  
  Bundles `search-boost` and `search-boost-parallel-research` skills. In hosts supporting subagents (Cursor, Claude Code, Pi, DSH), tasks can be dispatched to parallel Searchers (gathering evidence) and Summarizers (pure synthesis without tools), supporting both Fast and Complex waves.
- **Unified Core Across All Host Ecosystems**  
  A single, host-neutral core runtime powering standard Model Context Protocol (MCP) servers, alongside native extensions for Pi and Cordis plugin bundles for DeepSeek Harness (DSH).
- **Zero-Config Onboarding & Strict Security**  
  **Requires zero API keys to start** using the free engine pool. Sensitive credentials are stored as plaintext in local private configs with restricted file permissions (POSIX `0600`); this is not encryption at rest. Uses local networking and proxy DNS, with bounded requests and explicit fallback. Configured credentials are kept out of model prompts and diagnostic output.

---

## System Architecture

SearchBoost follows a **"One Core, Three Adapters"** architecture. All search logic, content parsing, deduplication algorithms, and network safety mechanisms reside in the shared core:

```text
                    SearchBoost TUI / CLI
             installation · configuration · refresh
                              │
                    Shared SearchBoost Core
                    lib/runtime.mjs facade
              search · fetch · X · adaptive evidence
                              │
              ┌───────────────┼───────────────┐
              │               │               │
         MCP Adapter      Pi Adapter     DSH Adapter
         stdio server     extension      Cordis bundle
              │               │               │
     ┌────────┴────────┐      ▼               ▼
     │ Cursor / Claude │      Pi       DeepSeek Harness
     │ Codex / Grok    │
     │ Antigravity     │
     └─────────────────┘
```

- **Core (`lib/`)**: Host-neutral algorithms, engine orchestration, dedicated judgment adapter protocol, and network safety policies.
- **Adapters (`adapters/`)**: Maps core operations into host-specific protocols (MCP JSON-RPC, Pi Extension API, DSH Cordis lifecycle).
- **Agents (`agents/`)**: Host prompt contracts, workflow templates, and native skill definitions. See the [prompt responsibility contract](docs/prompt-contract.md) and [beta.8 release notes](docs/v0.2.4-beta.8-release.md) for the Agent-facing routing update.

---

## Supported Hosts Matrix

| Host | Integration Type | Files / Mechanism | Capabilities & Notes |
| :--- | :--- | :--- | :--- |
| **Cursor / Cursor CLI** | MCP + Skills | `~/.cursor/mcp.json` / `skills/` | Supports CLI auto-approval (`cli-config.json`), session start injection, parallel research skill |
| **Claude Code** | MCP + Prompts | Official `claude` MCP config | Full multi-engine search and page extraction tools with prompt boundaries |
| **Codex** | MCP + Prompts | Host MCP configuration | Seamless access to fused search, X retrieval, and reader tools |
| **Grok Build** | MCP + Plugin | MCP config + bundled plugin | Automatically syncs and installs companion plugin when `grok` CLI is available |
| **Google Antigravity** | MCP + Workspace | Workspace MCP configuration | Per-project workspace guidance and full search tool suite |
| **Pi** | Native Extension | `~/.pi/agent/extensions/` / `prompts/` | Registers native extension, `/fast-parallel`, `/complex-parallel`, searcher/summarizer roles |
| **DeepSeek Harness** | Native Bundle | `cordis.patch.yml` / `dsh plugin` | Integrated with Cordis runtime; provides native `research_parallel` subagents and call cards |

---

## Quick Start (30 Seconds)

### Prerequisites
- **Node.js**: `>= 22.13.0`
- **Package Manager**: `npm` (or `pnpm`)

### 1. Install & Launch the Dashboard

```bash
# Install globally
npm install -g search-boost

# Launch the interactive terminal UI (TUI)
search-boost
```

> [!TIP]
> **Zero API Keys Required to Start**: SearchBoost includes a keyless free pool (Bing, DuckDuckGo, Yahoo, Exa-free, AnySearch). No paid-provider signup is required; availability and result coverage depend on the providers and your network.

### 2. 3-Step Setup Wizard
1. Select **Setup wizard** on the default flat TUI home (folder layout: Installation & integrations → Setup). Configure engine keys (or skip to use free tier) and optional X credentials.
2. Check the agents you want to integrate (Cursor, Claude Code, Pi, etc.), confirming auto-approval and native search replacement.
3. Restart or reload your chosen agents, then ask them to research anything in conversation!

---

## Upgrade & Migration Guide

### 1. Routine Updates: npm First, Then Refresh Integrations

The commands below describe v0.2.4. Before it is published, `@latest` may still install an older release without `refresh` or `research`; use a v0.2.4 source checkout as described below. Use npm to update the package; the TUI no longer updates SearchBoost itself. Installation, refresh and removal live under **Manage agent integrations** (folder layout: Installation & integrations → Manage agent integrations).

```bash
npm install -g search-boost@latest --prefer-online
search-boost
# → Manage agent integrations → Refresh existing integrations → select scopes
# Or refresh all existing integrations:
search-boost refresh -y
# Preview only:
search-boost refresh --dry-run
```

Refresh uses the current package and preserves credentials, permissions, disabled states and unrelated configuration. It does not install unconfigured hosts. Unchecking a target means no operation, not removal. The old `upgrade` command and `--sync-only` option are removed.

If a Grok local cache remains stale after native update, fully quit Grok and separately approve data-retaining reconstruction and trust of the displayed source. `-y` alone is not approval; explicit CLI approval is `search-boost refresh -y --repair-grok-cache`. This requests native `uninstall --keep-data`, then `install --trust`; legacy-name data reuse is not guaranteed. Restart affected hosts afterward. See [integration refresh](docs/host-upgrades.md).

---

### 2. Migrating from Legacy `search-boost-mcp`

> [!IMPORTANT]
> If you have the old global package `search-boost-mcp` installed, npm cannot automatically replace the global binary across package renames. **Use the one-line npx migration command**. The refresh step below requires v0.2.4 or later:

```bash
# Execute safe migration via npx
npx --yes --package=search-boost@latest -- search-boost migrate -y

# For v0.2.4 and later, update the package before refreshing integrations:
npm install -g search-boost@latest --prefer-online
search-boost
# -> Manage agent integrations → Refresh existing integrations (or search-boost refresh -y)
```

---

## Interactive Console (TUI)

Launch `search-boost` without arguments to access the interactive dashboard built with Clack. Manage host integrations, search configuration and credentials here; package updates are handled by npm:

The default **flat** home lists these actions in order:

| Home entries | Behavior |
| :--- | :--- |
| Setup wizard; Manage agent integrations; Status | Guided setup; install / scoped refresh / confirmed uninstall; read-only status |
| Search engine configuration; Default search layer; Tool switches | Choose individual engines; `free` / `api`; shared MCP / Pi / DSH switches |
| X credentials; judgment models (Jev / Laya) | Masked credential management |
| Native web search; Print MCP snippet | Explicit permission choices; read-only snippets |
| TUI settings; Exit | Menu layout before display language; close the console |

**TUI settings → Menu layout** offers flat / folder. Folder mode retains Installation & integrations, Search & tools, Services & credentials and Status. Completed actions return to the same flat home entry or their folder submenu. Escape cancels/navigates back; Ctrl+C exits. A layout switch immediately returns to the new home. Management returns to its own submenu; interactive uninstall and Grok cache reconstruction default to cancel. Partial failures are reported, not styled as success.

Layout and language changes apply immediately and are saved in `~/.search-boost/config/tui.json` (or `$SEARCH_BOOST_HOME/config/tui.json`). Missing layout (including legacy language-only settings) defaults to flat. Without a saved language preference, Chinese system locales select Simplified Chinese; other locales select English. The preference also applies to standalone interactive setup/config commands, not non-interactive CLI output, search results or agent replies. Tool names, commands, paths, MCP snippets and raw upstream errors remain unchanged. Dry-run previews layout/language without saving; malformed settings are warned about, not overwritten. See [TUI navigation and language settings](docs/tui.md).

### Tool switches

Open **Tool switches** (folder layout: Search & tools → Tool switches), toggle with Space, press Enter to review, then confirm. Esc or declining confirmation writes nothing; an empty selection disables all tools. Locked `adaptive_search` appears struck through in the status panel and is excluded from selectable choices until a judgment profile is configured. Configuring a profile makes it available by default; an explicit OFF preference is preserved.

Preferences are shared through `~/.search-boost/config/tools.json` (or `$SEARCH_BOOST_HOME/config/tools.json`), using atomic, locked writes. No host restart or reinstall is needed once the updated adapters are loaded:

- **MCP:** tool-list updates within approximately 300ms, with `tools/list_changed` notification; clients ignoring notifications may need reconnecting.
- **Pi:** active tools refresh within approximately 300ms; unrelated and initially excluded tools are preserved. Watchers stop on session shutdown.
- **DSH:** registrations remain present but disabled calls fail immediately; the native search/fetch provider paths obey the same switches.

Every new invocation checks the current preference, including stale tool handles. Existing requests finish normally. An unavailable selected judgment profile locks adaptive calls (including pagination and saved-result recovery); restoring configuration does not override explicit OFF. These are **tool-entry switches**, not engine permissions: enabled adaptive research screens one internal fused snapshot and does not read pages automatically, and fused community search may still use internal X retrieval. Searcher waves in Pi/DSH also require the shared fused_search and fetch_page entries and DSH scoped tools: disabled dependencies prevent initial dispatch, and are checked again before each child starts. Started children finish normally; tool-free summarizers do not require these entries. Checks never enable tools or expand permissions. Slash commands remain available for recovery. Existing processes running older adapter code require one reload/update first. Hosts sharing these settings must use the same SearchBoost home.

---

## Tool Suite & Usage Guide

When integrated, agents automatically receive standard tool definitions and autonomously determine when to call them.

### Tool Responsibilities & Boundaries

| Tool | Best Used For | Boundary / Non-Goals |
| :--- | :--- | :--- |
| `fused_search` | Parallel multi-engine querying, deduplication, and diversity re-ranking | A single search step; follow-up decisions remain with the parent agent |
| `fetch_page` | Reading clean content from public URLs with optional keyword focus | Not an authenticated browser; local network and proxy policy still apply |
| `x_search` | Retrieving public X posts, author timelines, or discussion threads | Does not guarantee exhaustive comment threads or total sentiment sampling |
| `adaptive_search` | **Experimental**: one bounded fused snapshot + fixed-option judgment screening for one question and a required intent | Selected URLs with reviewed extracts and value labels; targetMet is quantity only, not verified answers |
| `search_stats` | Reading engine status, memory cache hits, and recent diagnostic stats | Read-only; configuration readiness does not guarantee active external network reachability |
| `search_layer` | Viewing or switching compatibility search layer in MCP | `show` is read-only; changing layers mutates persistent configuration on disk |

---

### 1. `fused_search` Multi-Engine Search

Dispatches queries across engines concurrently, normalizes URLs, strips redirects, and applies diversity filters.

**Tool Arguments Example (JSON)**:
```json
{
  "query": "Node.js 22 built-in WebSocket API guide",
  "include_domains": ["nodejs.org", "developer.mozilla.org"],
  "engine_pool": "free",
  "ranking": "balanced",
  "complexity": "simple",
  "max_results": 5
}
```

- **`engine_pool`**: `free` (keyless Bing, DuckDuckGo, Yahoo, Exa-free, AnySearch), `api` (configured API engines), or `hybrid` (both pools). Unavailable or disabled engines are skipped. When omitted, the compatibility layer maps `free` to the free pool and `api` to hybrid.
- **`ranking`**: Final engine-weight presets: `balanced` (default), `research`, or `fresh`. They do not change query variants, search depth or recency filters, and do not establish source authority or freshness.
- **`complexity`**: `simple` (1 query variant), `medium` (up to 2 variants), `complex` (up to 3 deep variants).
- **`community`**: Boolean (`false` by default). Set to `true` to blend real-time X developer discussions into the final result quota.

---

### 2. `fetch_page` Smart Content Reader

Reads webpage content from search URLs. Reads and cleans the origin first; PDFs are extracted to text locally and only fall back to Jina Reader when that fails; curl handles transport compatibility when installed.

**Tool Arguments Example**:
```json
{
  "url": "https://nodejs.org/api/globals.html",
  "focus": "AbortSignal.any"
}
```

- **`focus` (Optional)**: Filters and retains paragraphs matching the target keywords.
  > [!TIP]
  > A `focus` miss does **not** prove the information is absent from the page. If in doubt, re-fetch without `focus` to inspect the full context.
- **`offset` (Optional)**: Long bodies are returned in bounded windows (60,000 characters by default). The result reports `totalChars` and, while more content follows, `nextOffset`; pass that back as `offset` to continue reading. Continuations are served from the 24h cache without another request.
  > [!TIP]
  > Binary responses (images, archives, PDFs with no extractable text) raise a clear error instead of being returned as page text.

---

### 3. `x_search` X (Twitter) Intelligence

Designed for real-time technical tracking and first-party developer updates. Supports keyword search, author timelines, and thread conversations.

**Tool Arguments Example**:
```json
{
  "query": "Claude 3.7 Sonnet hybrid reasoning from:AnthropicAI",
  "type": "keyword",
  "max_results": 5
}
```

- **Timestamp derivation**: When a valid Snowflake post ID is available, it can supply a UTC creation timestamp if platform metadata is missing or inconsistent; this does not verify the post text.
- **Filters**: Keyword mode accepts X operators such as `from:username`, `since:YYYY-MM-DD`, and `until:YYYY-MM-DD`. Use `from_date` / `to_date` for explicit date bounds; candidates without verifiable author/date metadata are omitted when those filters apply.

---

### 4. `adaptive_search` Jev / Laya Intent-Guided Search (Experimental)

**Simplified setup**: TUI → Judgment models (Jev / Laya) (folder layout: Services & credentials → Judgment models) starts with Existing configuration or Change configuration. With no saved configuration, only Change configuration appears; Escape exits. Select Jev / Laya, set the Base URL and API key, then confirm. First-time setup offers this optional step, skipped by default; ordinary search needs no judgment model.

**Vercel support**: choose Change configuration → Jev → Vercel AI Gateway. The Base URL is fixed to `https://ai-gateway.vercel.sh/v1`; enter a Vercel AI Gateway key, not a TypeSafe key. SearchBoost selects the official SDK evaluation model `typesafe-ai/jev`, not chat completions. The default TypeSafe `/systemone` path remains supported. Both paths use only the selected canonical user judgment profile, not environment keys, and respect server rate-limit delays.

**Laya support**: choose Change configuration → Laya and enter the self-hosted API prefix (without `/systemone`) and an optional API key. New configurations use `multilingual` and server-default token budgets; changes to an existing destination preserve its model and budgets. Leave the key empty to keep a stored key, or enter `-` to clear an optional Laya key. No empty Bearer is sent. Profile names are automatic; Existing configuration still supports switching and deletion. Missing diagnostics, truncation, collapsed options, abstention or absent offline head-capacity evidence make judgments unavailable, never model-approved residual choices. See [capacity evidence and migration](docs/v0.2.5-release.md). New runs identify the selected provider in `run.judgment`; historical records are never silently upgraded.

Supply **one question** (`questions` has exactly one item) plus a **required research `intent`** and optional soft `preferences`. Write them in English as a caller instruction: the server never language-checks, rejects or translates them, and any language is searched exactly as written. The original question is the only query — there is no keyword planning and no query expansion. One pre-search judgment strategy request selects the fixed `balanced`/`research`/`fresh` ranking and, when `community` is omitted, `enable`/`disable`/`unknown` for the already-wired community (X) branch; an explicit `community` true/false overrides that choice and is never asked back. That single fused call collects a **bounded snapshot: 32 candidates for targets up to 10, ceil(max_results×32/10) for larger targets (at most 160)** (web and community rows share it), and every declared candidate is screened with fixed options: safety `clear`/`violation`/`unavailable`, prototype value levels 0-5, source discounts from real positive-contribution engines, and one match per preference. Only safe material with an established value 3/4/5 is delivered, ranked by the versioned screening formula; confidence is audit-only. There is no early stop at the first K acceptable links, no automatic page read, and no self-imposed cumulative cost, token, request-count or whole-run time budget — real single-request timeouts, limited retries, authentication/rate-limit failures, safety refusals and explicit cancellation still apply.

```json
{
  "questions": ["What are the migration risks from ExampleDB 4.1 to 4.2?"],
  "intent": "Find migration steps and concrete incompatibilities, including counterexamples.",
  "preferences": ["Official migration guides"],
  "max_results": 8,
  "page_size": 3
}
```

- `intent` is required (it is no longer filled in from the question) and `preferences` are independent soft ranking bonuses, deduplicated exactly.
- `constraints` is retired as a per-material hard gate: omit it or pass `[]` (a `deprecated_constraints_empty` warning); a non-empty array is refused with `adaptive_constraints_removed` before any network call. Keep every direction and condition in the question/intent; for hard domain limits use `site:`/`-site:` or fused_search `include_domains`/`exclude_domains`, and verify required document properties by reading.
- Multi-question lists, `tasks/targets/facts/time_range`, `keywords` and nested keyword arrays are refused as legacy inputs; independent questions require separate calls.
- `max_results` caps the selected and saved set (default 10, max 50); `page_size` only changes the page (default 20, max 50) and never re-orders or re-filters.
- Results contain selected URLs, titles, reviewed extracts, `valueLevel`/`valueLabel`, rank, real provenance and score components — never generated answers. `selection.targetMet` means quantity only, never research completion or verification; `selection.incomplete`, `diagnostics`, `stopReason`, `outsideReview` and `unreviewed` disclose what was not finished rather than treating it as low value.
- `run.community` reports the finite community decision and the actual execution status (`not_requested`/`domain_excluded`/`unavailable`/`blocked`/`succeeded`/`empty`/`failed`/`partial`/`not_run`), never model reasoning. A failed or partial community branch keeps valid web results and marks the run incomplete.
- Read saved pages with `{"cursor":"<s6:…>"}` (optional `page_size`) only: no new search, strategy, Jev, community or value call. Default 20/max 50 per page with a byte budget. Cursors last up to 30 minutes/32 recent sets in the current process and are not exhaustive search.
- With explicit `save_results:true`, the complete final selected set plus typed metadata is stored privately under the SearchBoost home (`search-boost-research-v3`, schema version 6) and you receive a `savedResultId`. After a restart or cache clear, read `{"saved_result_id":"<savedResultId>"}` (optional `page_size`) without another search or Jev call. Older v2/schema-5 files stay unchanged and readable with `s5:` cursors; older `search-boost-research-v1` files stay readable in a marked read-only `h1:` historical branch (`restoration.historical: true`, original schema version preserved, no invented v5 fields). Public tool switches and the judgment-profile configuration lock still apply to reads; `search-boost research list` / `research export <id> --output <new-file.json>` work offline without Jev. See [integration and acceptance boundaries](docs/research-status-acceptance.md).
- Thresholds remain uncalibrated engineering starting points. See the [contract, budgets and migration notes](docs/jev-adaptive-search.md).

---

### Engine Pools & Scoring Presets

`engine_pool` selects engines, `ranking` selects shared cross-pool weights, and `complexity` controls query breadth and depth, not scoring weights. AnySearch is one logical engine: anonymous in free, key-required in api, and key-preferred in hybrid. Configure `ANYSEARCH_API_KEY` or `config keys --set anysearch=KEY`.

| Engine | balanced | research | fresh |
| --- | ---: | ---: | ---: |
| bing | 0.957 | 0.927 | 1.020 |
| ddg | 0.981 | 0.903 | 0.927 |
| yahoo | 0.957 | 0.877 | 0.902 |
| exa-free | 1.004 | 1.085 | 0.951 |
| tavily | 1.049 | 1.105 | 1.084 |
| brave | 1.004 | 0.951 | 1.125 |
| exa | 1.049 | 1.146 | 1.063 |
| anysearch | 1.004 | 1.042 | 0.951 |

These are uncalibrated cold-start priors, not measured quality rankings. `consensus-v2.1` combines original ranks, related-provider discounts and max+log consensus, with metadata adjustments capped at 20%. Quality and list-selection scores stay separate; zero-weight sources cannot vote. Recalibrate old `min_score` thresholds. See [scoring and migration](docs/fusion-scoring.md) and [pool routing](docs/search-routing.md).

---

## Parallel Multi-Agent Research Workflows

One shared workflow with three host bindings. The parent agent splits a question into independent tracks; each searcher gathers evidence with `fused_search` and `fetch_page`; a tool-less summarizer (or the parent itself) then turns the reports into one answer.

```text
                        [ Parent Agent ]
                   splits tracks · owns the answer
                              │
              ┌───────────────┴───────────────┐
              ▼                               ▼
       [ Searcher A ]                  [ Searcher B ]
   fused_search · fetch_page       fused_search · fetch_page
              │                               │
              └───────────────┬───────────────┘
                              ▼
                      [ Summarizer ]
                   no tools · synthesis only
                              ▼
                     [ Parent Report ]
```

| Host | Entry point | How children run |
| :--- | :--- | :--- |
| **Pi** | `/fast-parallel` and `/complex-parallel` prompts; the `search-parallel-subagent` tool; `searcher` / `summarizer` roles | Each searcher is a child process that explicitly loads the SearchBoost Pi extension (`adapters/pi/index.js`) and may call only `fused_search` and `fetch_page`; summarizers launch with `--no-tools`. The caller chooses the wave size — this runner sets no concurrency cap. |
| **DeepSeek Harness** | Native `research_parallel` tool | Children spawn on the same Cordis context through the host's subagent service. Searchers receive `toolFilter.allow = ['fused_search','fetch_page']`; summarizers receive an empty allowlist. Before a wave, `research_parallel` verifies both tools are registered and refuses to spawn otherwise. Handles are disposed on success and failure, and `maxDepth` stays at 1, so children cannot nest further research. |
| **MCP hosts** (Cursor, Claude Code, Codex, Grok, Antigravity) | Bundled `search-boost-parallel-research` skill | The skill embeds the same roles and workflow and runs them through whatever subagent mechanism the host provides. A host without usable delegation falls back to serial research by the parent. |

Installing into an MCP host also installs the companion **`search-boost`** router skill for optional workflows. Ordinary tool selection uses the registered descriptions and schemas directly; no skill load is required.

- **Fast mode**: one searcher wave, then parent synthesis — no summarizer and no second wave.
- **Complex mode**: one to three waves with a gap review in between; another wave starts only when a material gap remains, and the run stops early when the evidence is sufficient. These wave limits are workflow instructions, not global quotas enforced across independent tool calls.
- **Unavailable delegation**: the parent may research serially when browsing is allowed and parallelism is not a strict requirement, and discloses that choice. A denied or failed runtime is a blocker, not permission for a silent fallback.

> [!IMPORTANT]
> A child returning `ok` means it finished with non-empty text, **not** that its claims are verified. Failed or partial reports stay visible, but their URLs are excluded from the successful aggregate, and final judgment always belongs to the parent.

For Pi/DSH child-tool loading, stale `pi-search-boost` references, and the retired `deep_research` tool, see [Subagent tool setup and diagnosis](docs/subagent-tools.md).

---

## Security

### Custom search API bases

Open **Search engine configuration** on the flat TUI home (folder layout: Services & credentials). Each engine shows its masked key and default/custom Base URL. Choose **Set / replace Base URL**, then keep or edit the key; **Restore default Base URL** resets only the address. Choose any individual engine without stepping through all credential slots; unrelated keys and routing selections are preserved. Status and `config keys --show` also show the effective bases. Standalone `search-boost config keys` and first setup retain the sequential guided wizard.

```bash
search-boost config keys --base-url exa=https://gateway.example/exa
search-boost config keys --reset-base-url exa
```

| Engine | Default Base URL | Appended path |
|---|---|---|
| Tavily | `https://api.tavily.com` | `/search` |
| Exa | `https://api.exa.ai` | `/search` |
| Brave | `https://api.search.brave.com/res/v1` | `/web/search` |
| AnySearch | `https://api.anysearch.com/v1` | `/search` |

Supply an API base, **not a full search endpoint**; gateway prefixes are preserved. Overrides live in `engines.<name>.baseUrl` in the keys file; existing key strings and routing flags are unchanged. Use only trusted API-compatible gateways: queries and configured keys are sent there (AnySearch remains anonymous in the free pool). Prefer HTTPS; HTTP is supported for local gateways. Credentials, query strings and fragments in URLs are rejected. Exa-free is unaffected. Changing a base invalidates the search cache partition.

API keys use a credential store this tool owns. They are not written into prompts, tool results or shell profiles:

- **Private file permissions**: keys live in `~/.search-boost/config/keys.json` (redirect the root with `SEARCH_BOOST_HOME`). On POSIX the store directory is `0700` and the file is `0600`; a rewrite is built from a fresh `0600` temporary file rather than written in place, so an existing file is never widened. Backups and upgrade receipts under the same root are `0600` as well. An env-overridden directory keeps its own mode, while the credential file is still created `0600`. Windows has no POSIX mode bits — ACL inheritance applies there.
- **Atomic, locked writes**: replacement uses an `O_EXCL` temporary file plus rename, so a reader sees either the old or the new file and never a partial one; a failed write cleans up after itself and leaves the previous file untouched. Read-modify-write cycles take an exclusive lock, so two writers cannot silently lose each other's update, and a rejected change does not touch the file at all.
- **Never echoed back**: a key is only sent to the engine it belongs to (Tavily, Brave, Exa and AnySearch request parameters/headers). Status output, `search-boost config keys --show` and the doctor report print masked values (`abcd****wxyz`); error messages are tested not to contain credential material, and Jev evaluation payloads deliberately carry no key, masked key or fingerprint. AnySearch uses anonymous quota in free, requires a key in api, and prefers a configured key in hybrid. Its potentially credential-bearing error envelopes are never echoed or persisted.


---

## CLI Command Reference (Headless & CI)

The following CLI reference describes v0.2.4. `refresh` and `research` require that version or later; merging source does not publish it to npm. Use a source checkout until the required version is published.

**DeepSeek Harness Desktop:** interactive installation offers Desktop / CLI / All, then **Automatic (default)** or **Local directory** for Desktop. Automatic setup retains bundled-command discovery through Windows installer registry metadata (including custom destinations), default directories and PATH; launch Desktop once, then fully quit it including its tray. Local setup runs last, after all other integrations including Grok, and displays the current durable package directory to paste into the running app's Plugins → Add plugin dialog. The TUI observes saved installation read-only and finishes after stable verification; Escape / Ctrl+C or timeout marks Desktop unfinished while retaining earlier results. Saved installation is not proof of live activation; missing bundled launchers explicitly leave runtime verification unknown. Temporary `_npx` paths are refused as persistent local links. The app also accepts `search-boost` for a registry install. Automatic install/update still verifies the owning resolver and rejects shadow copies. Disabled bundles stay disabled unless explicitly requested; local setup with `--enable-dsh-bundle` waits for the user to enable it in Desktop. See [Desktop integration](docs/dsh-desktop.md) for ownership and validation limits.

```bash
# ----------------- Core & Interactive -----------------
search-boost                                # Launch interactive dashboard (TUI)
search-boost status                         # Disk/configuration evidence; running host version remains unknown
search-boost status --json                  # Structured read-only installation evidence
search-boost research list                  # List opt-in private result snapshots
search-boost research export <id> --output <new-file.json> # Explicit export; never overwrite
search-boost --help                         # Display full CLI documentation
search-boost refresh --dry-run              # Preview refreshing existing integrations
search-boost refresh -y                     # Refresh all existing integrations from this package
search-boost migrate --dry-run              # Preview the legacy global package rename

# ----------------- Headless Installation -----------------
search-boost install -t cursor -y           # Install for Cursor with auto-approval
search-boost install -t claude,codex --keep-native  # Install while preserving host native search
search-boost install -t antigravity --workspace /path/to/project # Target a specific workspace
search-boost install -t antigravity -y --antigravity-config legacy # Explicit old-client compatibility; modern switches back
search-boost install -t pi -y               # Mount Pi extension and prompt templates
search-boost install -t dsh --profile web   # Connect to DeepSeek Harness CLI web profile
search-boost install -t dsh --dsh-surface desktop -y # Desktop bundled command + local package
search-boost install -t dsh --dsh-surface all -y     # Manage Desktop and CLI independently
# No global search-boost / dsh / pnpm required (Windows, Linux, macOS):
npx --yes search-boost@latest install -t dsh --profile web -y
search-boost install -t cursor --dry-run    # Preview installation without writing files

# ----------------- Configuration Management -----------------
search-boost config keys                    # Manage API keys from CLI
search-boost config keys --set anysearch=KEY  # Configure the AnySearch key (ANYSEARCH_API_KEY)
search-boost config layer                   # Switch default layer (free / api)
search-boost config x --import-grok         # Import X credentials from local Grok login
search-boost config jev                     # Configure Jev endpoint and token

# ----------------- Diagnostics & Health -----------------
search-boost doctor                         # Run offline diagnostic checks
search-boost doctor --strict                # Strict mode (exits non-zero on warnings)
search-boost doctor --json                  # Output machine-readable JSON report

# ----------------- Uninstall -----------------
search-boost uninstall -t cursor,claude -y  # Remove integrations from selected hosts
```

---

## Installation from Source & Development

Use this path to contribute to SearchBoost, or to test code that is not in a published release yet. Everywhere else, `@latest` refers to the published package.

### Prerequisites

- **Node.js** `>= 22.13.0` (matching `package.json`)
- **git** and **npm**
- Optional: **`curl`**, for the same-route transport-compatibility fallback in `fetch_page`
- Optional: **`pdfjs-dist`** (optionalDependency) to extract PDF text locally; without it, PDF reads fall back to Jina Reader

### Set up a checkout

```bash
# 1. Clone the repository
git clone https://github.com/Mr-remon219/search-boost.git
cd search-boost

# 2. Install dependencies exactly as CI does
npm ci

# 3. Regenerate the bundled Grok plugin assets
npm run plugin:sync-grok
```

The clone lands on the repository's default branch. To test a different branch or tag, check it out before installing dependencies (`git checkout BRANCH_OR_TAG`).

### Run it without a global install

```bash
node cli.mjs                  # interactive TUI straight from the checkout
node cli.mjs status           # one-shot status summary
node cli.mjs install -t pi -y # mount the Pi extension from this checkout
node cli.mjs install -t dsh --profile web
```

`node cli.mjs` accepts the same commands as the installed `search-boost` binary. If you want the bare command in your terminal, link the checkout instead of installing from npm:

```bash
npm link        # or: npm install -g .
search-boost
```

After changing adapter or agent assets, re-run the same install command for that host (`node cli.mjs install -t HOST`) so the host picks up the new files, then restart or reload that host.

### Test gates before a PR

| Command | What it covers |
| :--- | :--- |
| `npm run check` | Syntax check across the CLI, core, adapters and scripts |
| `npm run prepublishOnly` | Syntax and CI policy checks, exact-lock dependency audit (registry access required), then every isolated regression entrypoint, including generated assets, install / refresh / migration, search, adapters and MCP |
| `npm run test:network` | Proxy retries, curl fallback, request bounds and compatibility regressions |
| `npm run test:adapters` | MCP, Pi and DSH adapter protocol suites plus Pi subagent settings migration/diagnosis |
| `npm run test:parallel` | Searcher/summarizer contracts, DSH dispatch preflight, cancellation and tool isolation |
| `npm run test:adaptive` | Single-snapshot V5 screening, capacity boundaries and MCP/Pi/DSH adapter fixtures (not live host sessions) |
| `npm run smoke` | MCP JSON-RPC protocol smoke test |

Regression suites use isolated state, loopback fixtures and process doubles; no engine keys are needed. The dependency audit requires registry access. A green `npm run prepublishOnly` is the local PR gate, not proof of live host loading, paid-service behaviour or evidence quality.

---

## Friendly Links

- [LINUX DO](https://linux.do/)

---

## License

This project is licensed under the [MIT License](./LICENSE).
