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
> **Release & Branch Notice**: The `v0.2.0` branch unifies the formerly standalone `pi-search-boost` and `dsh-search-boost` projects into a single codebase under `lib/`. Documented commands specifying `@latest` retrieve the official published npm package. To explore or test the latest branch code, please follow [Installation from Source & Development](#installation-from-source--development).

---

> **v0.2.1 repair branch**: fixes Pi transport isolation, configuration preservation, updater process cleanup, page-version identity and Jev accounting/retries; adds Vercel Jev support. This branch is not an npm release: `@latest` does not guarantee these repairs. See the [repair and verification record](./docs/v0.2.1-repair-audit.md).

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
- [Configuration, Security & Privacy](#configuration-security--privacy)
- [CLI Command Reference (Headless & CI)](#cli-command-reference-headless--ci)
- [Installation from Source & Development](#installation-from-source--development)
- [License](#license)

---

## Key Features

- **Multi-Engine Parallel Fusion (`fused_search`)**  
  Queries multiple search providers in parallel. Features an out-of-the-box **keyless free pool** (Bing, DuckDuckGo, Yahoo, Exa-free) and a high-tier **API pool** (Tavily, Brave, Exa). Automatically performs cross-engine URL deduplication, domain routing, and relevance re-ranking.
- **Clean Webpage Content Extractor (`fetch_page`)**  
  Uses Jina Reader by default for clean markdown extraction, backed by a guarded local HTML reader fallback. Strips CSS, JS, and ad clutter. Supports focused contextual paragraph extraction via `focus`, backed by in-memory caching and size limits.
- **X / Twitter Community Intelligence (`x_search`)**  
  Retrieves public posts, user timelines, and discussion threads via official xAI API or an anonymous fallback channel. Recovers accurate UTC timestamps from Snowflake post IDs and enforces local author/date filtering without hallucination.
- **Jev Adaptive Evidence Loop (`adaptive_search` · Experimental)**  
  Connects with TypeSafe Jev to orchestrate multi-step search loops and evaluate evidence fragments across 1–6 targeted questions. Operates under strict token/step budgets and returns deterministic coverage states (`covered`, `insufficient`, `unassessed`, `not_searched`, `failed`).
- **Native Multi-Agent Parallel Research**  
  Bundles `search-boost` and `search-boost-parallel-research` skills. In hosts supporting subagents (Cursor, Claude Code, Pi, DSH), tasks can be dispatched to parallel Searchers (gathering evidence) and Summarizers (pure synthesis without tools), supporting both Fast and Complex waves.
- **Unified Core Across All Host Ecosystems**  
  A single, host-neutral core runtime powering standard Model Context Protocol (MCP) servers, alongside native extensions for Pi and Cordis plugin bundles for DeepSeek Harness (DSH).
- **Zero-Config Onboarding & Strict Security**  
  **Requires zero API keys to start** using the free engine pool. Sensitive credentials are encrypted in local private configs (POSIX `0600`). Enforces local SSRF protection, target IP address pinning, and proxy compliance, with zero credential leakage into model prompts.

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

Reads webpage content from search URLs. Prioritizes Jina Reader for clean Markdown, with an internal guarded HTTP fetcher fallback.

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

For Pi/DSH child-tool loading, stale `pi-search-boost` references, and the retired `deep_research` tool, see [Subagent tool setup and diagnosis](docs/subagent-tools.md).

Installing SearchBoost into an MCP host automatically installs two bundled skills:

1. **`search-boost`**: Research routing skill guiding the agent to select optimal tools for open-ended questions.
2. **`search-boost-parallel-research`**: **Multi-agent parallel workflow** delegating independent research tracks to host subagents:

```text
                           [ Parent Agent ]
                     Deconstructs Research Goals
                                   │
                 ┌─────────────────┴─────────────────┐
                 ▼                                   ▼
        [ Searcher Agent A ]               [ Searcher Agent B ]
     Gathers Evidence via Tools         Gathers Evidence via Tools
                 │                                   │
                 └─────────────────┬─────────────────┘
                                   ▼
                         [ Summarizer Agent ]
                      No Tools · Pure Synthesis
                                   │
                                   ▼
                       [ Final Parent Report ]
```

- **Two Workflow Modes**:
  - **Fast Mode**: Single concurrent wave (1 Wave) followed immediately by parent synthesis.
  - **Complex Mode**: Adds a "Gap Review" step, launching a second wave only if critical information is missing.
- **Graceful Degradation**: If the host lacks subagent capabilities, the workflow gracefully falls back to serial deep research without infinite loops.

---

## Configuration, Security & Privacy

### Configuration Layout

Local configuration is stored in `~/.search-boost/config/` (configurable via `SEARCH_BOOST_HOME`):

```text
~/.search-boost/
├── config/
│   ├── keys.json        # Search engine API keys & Jev credentials (mode 0600)
│   ├── layer.json       # Search layer compatibility mode (free / api)
│   └── xauth.json       # X (Twitter) authentication tokens
├── backups/             # Automatic configuration backups
└── state/               # Upgrade receipts and package tracking
```

### Security & Privacy Guarantees

- **Private File Permissions**: On POSIX systems, configuration files are written atomically with strict `0600` permissions (read/write by owner only).
- **SSRF Protection & IP Pinning**: The direct HTML reader resolves and validates target IP addresses against private/loopback CIDRs, pinning the connection to prevent DNS rebinding attacks.
- **Proxy Support**: Fully respects `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, and `NO_PROXY`. **Explicitly rejects SOCKS proxies** with clear error messages to prevent accidental direct network leaks.
- **TUN Fake-IP Compatibility**: When operating behind a TUN interface utilizing Fake-IP ranges, set `SEARCH_BOOST_TRUSTED_TUN=1` to allow trusted gateway routing.

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

To contribute to SearchBoost or test the latest unreleased changes on the `v0.2.0` branch:

### Source Setup

```bash
# 1. Clone repository
git clone https://github.com/Mr-remon219/search-boost.git
cd search-boost

# 2. Switch to v0.2.0 branch and install dependencies
git switch v0.2.0
npm ci

# 3. Synchronize Grok plugin assets
npm run plugin:sync-grok

# 4. Link globally
npm install -g .

# 5. Launch and test
search-boost
```

### Development Test Gates

Before submitting a PR, verify your changes against the complete test suite:

```bash
npm run prepublishOnly    # Syntax check + asset sync + full offline test suite
npm run test:network      # DNS, proxy, IP pinning, and security regressions
npm run test:adaptive     # Jev adaptive search loop evaluation
npm run test:adapters     # MCP, Pi, and DSH adapter protocol suites
npm run smoke             # MCP JSON-RPC protocol smoke test
```

---

## License

This project is licensed under the [MIT License](./LICENSE).
