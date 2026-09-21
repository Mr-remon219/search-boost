# SearchBoost

**Multi-engine web search & evidence synthesis for AI coding agents**  
*One shared core runtime, deeply adapted for MCP, Pi, and DeepSeek Harness*

[![version](https://img.shields.io/badge/version-v0.2.1-orange?style=flat-square)](#)
[![npm version](https://img.shields.io/badge/npm-search--boost-cb3837?style=flat-square&logo=npm)](https://www.npmjs.com/package/search-boost)
[![Node version](https://img.shields.io/badge/node-%3E%3D22.13-339933?style=flat-square&logo=node.js)](https://nodejs.org/)
[![License](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](./LICENSE)
[![Architecture](https://img.shields.io/badge/architecture-unified%20core-8a2be2?style=flat-square)](#)
[![Free tier](https://img.shields.io/badge/free%20tier-zero%20key%20required-success?style=flat-square)](#)

[English](./README.md) · [中文文档](./README_zh.md)

---

> [!NOTE]
> **Release & Branch Notice**: The formerly standalone `pi-search-boost` and `dsh-search-boost` projects are merged into one codebase under `lib/`. Documented commands specifying `@latest` retrieve the official published npm package. To test code that is not in a published release, check out the branch or tag you need and follow [Installation from Source & Development](#installation-from-source--development).

---

> **v0.2.1 repairs**: fixes Pi transport isolation, configuration preservation, updater process cleanup, page-version identity and Jev accounting/retries; adds Vercel Jev support. This code is not an npm release: `@latest` does not guarantee these repairs. See the [delivery freeze notes](./docs/v0.2.1-delivery.md) for the current scope and the [earlier repair record](./docs/v0.2.1-repair-audit.md).

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
  - [4. `adaptive_search` Jev Evidence Loop (Experimental)](#4-adaptive_search-jev-evidence-loop-experimental)
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
  Queries multiple search providers in parallel. Features an out-of-the-box **keyless free pool** (Bing, DuckDuckGo, Yahoo, Exa-free) and a high-tier **API pool** (Tavily, Brave, Exa). Automatically performs cross-engine URL deduplication, domain routing, and relevance re-ranking.
- **Clean Webpage Content Extractor (`fetch_page`)**  
  Fetches the origin first for low latency, with optional same-route curl compatibility fallback and Jina Reader backup. Strips CSS, JS, and ad clutter. Supports focused contextual paragraph extraction via `focus`, backed by in-memory caching and size limits.
- **X / Twitter Community Intelligence (`x_search`)**  
  Retrieves public posts, user timelines, and discussion threads via official xAI API or an anonymous fallback channel. Recovers accurate UTC timestamps from Snowflake post IDs and enforces local author/date filtering without hallucination.
- **Jev Adaptive Evidence Loop (`adaptive_search` · Experimental)**  
  Connects with TypeSafe Jev to orchestrate multi-step search loops and evaluate evidence fragments across 1–6 targeted questions. Operates under strict token/step budgets and returns deterministic coverage states (`covered`, `insufficient`, `unassessed`, `not_searched`, `failed`).
- **Native Multi-Agent Parallel Research**  
  Bundles `search-boost` and `search-boost-parallel-research` skills. In hosts supporting subagents (Cursor, Claude Code, Pi, DSH), tasks can be dispatched to parallel Searchers (gathering evidence) and Summarizers (pure synthesis without tools), supporting both Fast and Complex waves.
- **Unified Core Across All Host Ecosystems**  
  A single, host-neutral core runtime powering standard Model Context Protocol (MCP) servers, alongside native extensions for Pi and Cordis plugin bundles for DeepSeek Harness (DSH).
- **Zero-Config Onboarding & Strict Security**  
  **Requires zero API keys to start** using the free engine pool. Sensitive credentials are encrypted in local private configs (POSIX `0600`). Uses local networking and proxy DNS, with bounded requests and explicit fallback, with zero credential leakage into model prompts.

---

## System Architecture

SearchBoost follows a **"One Core, Three Adapters"** architecture. All search logic, content parsing, deduplication algorithms, and network safety mechanisms reside in the shared core:

```text
                    SearchBoost TUI / CLI
             installation · configuration · updates
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

- **Core (`lib/`)**: Host-neutral algorithms, engine orchestration, Jev client protocol, and network safety policies.
- **Adapters (`adapters/`)**: Maps core operations into host-specific protocols (MCP JSON-RPC, Pi Extension API, DSH Cordis lifecycle).
- **Agents (`agents/`)**: Host prompt contracts, workflow templates, and native skill definitions.

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
> **Zero API Keys Required to Start**: SearchBoost includes a robust free engine pool (Bing, DuckDuckGo, Yahoo, Exa-free). You can begin searching immediately without signing up for any paid provider!

### 2. 3-Step Setup Wizard
1. Select **`Setup`** in the TUI menu. Configure engine keys (or skip to use free tier) and optional X credentials.
2. Check the agents you want to integrate (Cursor, Claude Code, Pi, etc.), confirming auto-approval and native search replacement.
3. Restart or reload your chosen agents, then ask them to research anything in conversation!

---

## Upgrade & Migration Guide

### 1. Routine Updates: Upgrading via TUI

Whether you run unified `search-boost` or have legacy `pi-search-boost` / `dsh-search-boost` installations, **select `Update` in the TUI to upgrade everything**:

```bash
# Option 1: Open the interactive menu
search-boost
# -> Select "Update"

# Option 2: Run headless update
search-boost upgrade -y
```

> **Update Behavior**: Fetches the latest published release, updates SearchBoost, and refreshes prompt assets across all configured agents while preserving existing keys, layer choices, and permission settings.

---

### 2. Migrating from Legacy `search-boost-mcp`

> [!IMPORTANT]
> If you have the old global package `search-boost-mcp` installed, npm cannot automatically replace the global binary across package renames. **Use the one-line npx migration command**:

```bash
# Execute safe migration via npx
npx --yes --package=search-boost@latest -- search-boost migrate -y

# Once migrated, routine updates only require:
search-boost
# -> Select "Update" (or search-boost upgrade -y)
```

---

## Interactive Console (TUI)

Launch `search-boost` without arguments to access the interactive dashboard built with Clack. Manage installation, updates, and credentials effortlessly:

| Menu Option | Purpose |
| :--- | :--- |
| **Setup** | Complete initial walkthrough: configure engines, search layers, X credentials, and install agents. |
| **Install / update agents** | Install or refresh selected host integrations, preserving existing credentials and layer settings. |
| **Update** | **One-click upgrade**: checks npm for updates, upgrades SearchBoost, and refreshes all installed agents (including legacy Pi/DSH adapters). |
| **API keys / Search layer** | Manage paid engine credentials (Tavily, Brave, Exa) and change the default search layer (`free` / `api`). |
| **X credentials** | Manage X (Twitter) authentication; supports one-click import from local Grok login. |
| **Jev credentials (experimental)** | Configure TypeSafe Jev cognitive engine endpoint and Bearer token. |
| **Native web search** | Enable or disable host-native search for hosts supporting config switches. |
| **Status** | Inspect current engine availability, configuration status, and active integrations. |
| **Print MCP snippet** | Print MCP JSON configuration snippets to stdout for manual setups. |
| **Uninstall** | Safely remove SearchBoost integrations from selected agents, keeping user configurations intact. |

---

## Tool Suite & Usage Guide

When integrated, agents automatically receive standard tool definitions and autonomously determine when to call them.

### Tool Responsibilities & Boundaries

| Tool | Best Used For | Boundary / Non-Goals |
| :--- | :--- | :--- |
| `fused_search` | Parallel multi-engine querying, deduplication, and diversity re-ranking | A single search step; follow-up decisions remain with the parent agent |
| `fetch_page` | Reading clean content from public URLs with optional keyword focus | Not a browser with login state; cannot access internal/private networks |
| `x_search` | Retrieving public X posts, author timelines, or discussion threads | Does not guarantee exhaustive comment threads or total sentiment sampling |
| `adaptive_search` | **Experimental**: Jev-guided autonomous follow-up and evidence evaluation | Not a final-answer generator; `covered` is model evaluation, not verified truth |
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

- **`engine_pool`**: `free` (keyless Bing, DuckDuckGo, Yahoo, Exa-free), `api` (configured paid engines only), or `hybrid` (all available engines).
- **`ranking`**: Scoring presets: `balanced` (default), `research` (favors authoritative/documentation sources), or `fresh` (favors recent publications).
- **`complexity`**: `simple` (1 query variant), `medium` (up to 2 variants), `complex` (up to 3 deep variants).
- **`community`**: Boolean (`false` by default). Set to `true` to blend real-time X developer discussions into the final result quota.

---

### 2. `fetch_page` Smart Content Reader

Reads webpage content from search URLs. Reads and cleans the origin first; curl handles transport compatibility when installed, and Jina Reader is the backup.

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

---

### 3. `x_search` X (Twitter) Intelligence

Designed for real-time technical tracking and first-party developer updates. Supports keyword search, author timelines, and thread conversations.

**Tool Arguments Example**:
```json
{
  "query": "Claude 3.7 Sonnet hybrid reasoning from:AnthropicAI",
  "mode": "keyword",
  "max_results": 5
}
```

- **Precise Timestamps**: When platform timestamps are missing or inconsistent, recovers true UTC creation times from 64-bit Snowflake IDs.
- **Native Operators**: Full support for `from:username`, `since:YYYY-MM-DD`, and `until:YYYY-MM-DD`.

---

### 4. `adaptive_search` Jev Evidence Loop (Experimental)

**Vercel support**: in TUI → Jev credentials, enter `https://ai-gateway.vercel.sh/v1` and a Vercel AI Gateway key. SearchBoost selects the official SDK evaluation model `typesafe-ai/jev`, not chat completions. The default TypeSafe `/systemone` path remains supported. Both paths use only the canonical user Jev credential, not environment keys, and respect server rate-limit delays.

When rigorous verification is required for complex technical claims, agents can call `adaptive_search`. The Jev cognitive loop formulates targeted queries, selects allowable engines, fetches relevant passages, and assesses coverage.

**Tool Arguments Example**:
```json
{
  "questions": [
    "What cancellation guarantees does the official documentation provide for this API?",
    "In which stable release was this behavior originally introduced?"
  ]
}
```

- Accepts 1–6 non-empty questions, each up to 400 characters.
- **Returns per-question coverage status**:
  - `covered`: Assessed fragments satisfy the question's criteria (model judgment).
  - `insufficient`: Retrieved material does not fully answer the claim.
  - `unassessed`: Intermediate state or evaluation not completed.
  - `not_searched`: Query budget or deadline exhausted before execution.
  - `failed`: An error occurred during retrieval or parsing.

---

### Engine Pools & Scoring Presets

In `fused_search`, base weights are governed by `engine_pool` and `ranking`:

| Pool-Ranking Preset | Bing | DuckDuckGo | Yahoo | Exa-free | Tavily | Brave | Exa (API) |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **free-balanced** | 1.00 | 1.05 | 1.00 | 1.10 | — | — | — |
| **free-research** | 0.95 | 0.90 | 0.85 | 1.30 | — | — | — |
| **free-fresh** | 1.15 | 0.95 | 0.90 | 1.00 | — | — | — |
| **api-balanced** | — | — | — | — | 1.20 | 1.10 | 1.20 |
| **api-research** | — | — | — | — | 1.35 | 1.00 | 1.45 |
| **api-fresh** | — | — | — | — | 1.30 | 1.40 | 1.25 |
| **hybrid-balanced** | 1.00 | 1.05 | 1.00 | 1.10 | 1.20 | 1.10 | 1.20 |

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

Installing into an MCP host also installs the companion **`search-boost`** routing skill, which picks the right tool for an open-ended question.

- **Fast mode**: one searcher wave, then parent synthesis — no summarizer and no second wave.
- **Complex mode**: one to three waves with a gap review in between; another wave starts only when a material gap remains, and the run stops early when the evidence is sufficient. These wave limits are workflow instructions, not global quotas enforced across independent tool calls.
- **Fallback**: if the host cannot delegate, the parent researches serially and says so instead of pretending a wave ran.

> [!IMPORTANT]
> A child returning `ok` means it finished with non-empty text, **not** that its claims are verified. Failed or partial reports stay visible, but their URLs are excluded from the successful aggregate, and final judgment always belongs to the parent.

For Pi/DSH child-tool loading, stale `pi-search-boost` references, and the retired `deep_research` tool, see [Subagent tool setup and diagnosis](docs/subagent-tools.md).

---

## Security

API keys use a credential store this tool owns. They are not written into prompts, tool results or shell profiles:

- **Private file permissions**: keys live in `~/.search-boost/config/keys.json` (redirect the root with `SEARCH_BOOST_HOME`). On POSIX the store directory is `0700` and the file is `0600`; a rewrite is built from a fresh `0600` temporary file rather than written in place, so an existing file is never widened. Backups and upgrade receipts under the same root are `0600` as well. An env-overridden directory keeps its own mode, while the credential file is still created `0600`. Windows has no POSIX mode bits — ACL inheritance applies there.
- **Atomic, locked writes**: replacement uses an `O_EXCL` temporary file plus rename, so a reader sees either the old or the new file and never a partial one; a failed write cleans up after itself and leaves the previous file untouched. Read-modify-write cycles take an exclusive lock, so two writers cannot silently lose each other's update, and a rejected change does not touch the file at all.
- **Never echoed back**: a key is only sent to the engine it belongs to (Tavily, Brave and Exa request parameters/headers). Status output, `search-boost config keys --show` and the doctor report print masked values (`abcd****wxyz`); error messages are tested not to contain credential material, and Jev evaluation payloads deliberately carry no key, masked key or fingerprint.


---

## CLI Command Reference (Headless & CI)

In addition to the interactive TUI, SearchBoost provides a comprehensive CLI for scripting and automation:

```bash
# ----------------- Core & Interactive -----------------
search-boost                                # Launch interactive dashboard (TUI)
search-boost status                         # Print active configuration and host summary
search-boost --help                         # Display full CLI documentation

# ----------------- Headless Installation -----------------
search-boost install -t cursor -y           # Install for Cursor with auto-approval
search-boost install -t claude,codex --keep-native  # Install while preserving host native search
search-boost install -t antigravity --workspace /path/to/project # Target a specific workspace
search-boost install -t pi -y               # Mount Pi extension and prompt templates
search-boost install -t dsh --profile web   # Connect to DeepSeek Harness web profile
search-boost install -t cursor --dry-run    # Preview installation without writing files

# ----------------- Configuration Management -----------------
search-boost config keys                    # Manage API keys from CLI
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
| `npm run prepublishOnly` | The full offline suite: plugin sync, syntax, CLI, install, doctor, fusion, X, engines, X auth, Jev, key authority, dry-run, network, search routing, adapters, parallel research, upgrade, MCP and smoke |
| `npm run test:network` | Proxy retries, curl fallback, request bounds and compatibility regressions |
| `npm run test:adapters` | MCP, Pi and DSH adapter protocol suites plus Pi subagent settings migration/diagnosis |
| `npm run test:parallel` | Searcher/summarizer contracts, DSH dispatch preflight, cancellation and tool isolation |
| `npm run test:adaptive` | Jev adaptive evidence loop |
| `npm run smoke` | MCP JSON-RPC protocol smoke test |

These suites run against loopback fixtures and process doubles, so no engine keys are needed; a green `npm run prepublishOnly` is the bar for a PR.

---

## Friendly Links

- [LINUX DO](https://linux.do/)

---

## License

This project is licensed under the [MIT License](./LICENSE).
