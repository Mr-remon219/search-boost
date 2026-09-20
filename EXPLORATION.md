# 探索笔记 — search-boost-mcp

> **Maintainer-only** — internal design notes, not end-user documentation. See [README.md](./README.md) for user docs.

> 2026-08-18 · 独立 MCP 项目

## 完成度

**Phase 1 已完成** — 可安装、可冒烟、协议合规。

| 项 | 状态 |
|----|------|
| 独立目录 `search-boost-mcp/` | ✅ |
| 引擎逻辑 vendored（无 dsh npm 依赖） | ✅ |
| MCP registerTool + outputSchema | ✅ |
| server instructions | ✅ |
| resource + prompt | ✅ |
| install-cursor 五件套 (MCP+hook+skill+cli-config) | ✅ |
| npm run smoke | ✅ |
| GitHub Actions CI | ✅ |

## 架构（2026-09 三仓库合并后）

```
                    SearchBoost Core
        lib/runtime.mjs (facade) + lib/search/*.js
   engines / fusion / fetch / evidence / research
            xsearch / xauth / xfallback / audit / text / ssrf
                            │
        ┌───────────────────┼───────────────────┐
        │                   │                   │
  adapters/mcp        adapters/pi         adapters/dsh
  server + register   index.js (pi         index.js (Cordis
  + schemas (zod)     ExtensionAPI)        apply/ctx) + patch
        │                   │                   │
        └── agents/<host>/  宿主级 prompt 策略 ──┘
```

**边界规则**：搜索算法只在 `lib/search/`；`lib/runtime.mjs` 是唯一 facade（`runFused` / `runFetchPage` / `runXSearch` / `describeLayer` / `switchLayer` / `xAuthCommands`）；adapter 只做宿主注册、参数映射、渲染、生命周期；`agents/pi/inject.md`、`agents/dsh/policy.md` 是照抄旧仓库的宿主定制，不影响 MCP 路径的 model-discretion 文案。

**由旧仓库反向迁入 Core 的能力**：DSH `xsearch.js`（hosted-tool filters、`salvageJsonForKind`、`readGrokClientInfo`、entitlement 拒绝、`reasoning_effort`）、DSH `fetch.js`（`focusMiss`、Jina URL encode、短正文不缓存）、pi `extract.ts`（`pickParagraphs` / `pickExcerpts` → `evidence.js`）、pi `util.ts`（CJK 分词 / `countWords` → `text.js`）、pi `audit.ts`（→ `audit.js`）、x_search 编排（三份 → `runXSearch`，含按 kind TTL 缓存 + auth 指纹 + single-flight）。

**留在 adapter 的宿主差异**：pi `search-parallel-subagent` 派生 `pi` 子进程（`adapters/pi/search-parallel-subagent.js`；install 把 `agents/pi/agents/*.md` / `prompts/*.md` 注入 `~/.pi/agent/{agents,prompts}`）；DSH `research_parallel` 走 `ctx.get('subagents')`（Core `parallelResearch`）；DSH `web` seam provider / presentCall 卡片 / `cleanJsonValue`；pi `promptGuidelines` / `onUpdate` 进度 / `/search-cache` `/search-audit`。

**不迁**：DSH `plugin-host.js`（会话级动态插件，完整复制一份核心）、pi 的持久化 `JsonCache`（Core 统一内存缓存）、pi `PI_SEARCH_*` env / Windows 注册表读 key（key 只经 TUI 写入 Core keys 文件）、DSH `antigravity/agy` 引擎（本仓库已移除）。

**安装面**：`search-boost install -t pi` 写 `~/.pi/agent/extensions/search-boost.js` shim（re-export `adapters/pi/index.js`，pi 支持纯 JSON Schema 参数，adapter 零 pi 依赖），并把 searcher/summarizer 与 `/fast-parallel` `/complex-parallel` 注入 `~/.pi/agent/{agents,prompts}`；`-t dsh --profile <p>` 转发 `dsh plugin --profile <p> add <pkg>`（DSH 通过包 `dsh.bundle.patch` 发现 bundle，patch 行 `name: search-boost-mcp/dsh` 由 Cordis loader 直接 `import()`）。

## 配置路径（独立 + 向后兼容）

| 用途 | 主路径 | 旧路径（仍可读） |
|------|--------|------------------|
| API keys | `~/.search-boost-keys.json` | `~/.dsh-search-boost-keys.json` |
| 搜索层 | `~/.search-boost-layer.json` | `~/.dsh-search-boost-layer.json` |
| X 凭据 | `~/.search-boost-xauth.json` | `~/.dsh-search-boost-xauth.json` |
| X guest 缓存 | `~/.search-boost-xguest.json` | `~/.dsh-search-boost-xguest.json` |
| Antigravity workspace 标记 | `~/.search-boost-antigravity-workspaces.json` | — |

环境变量：`SEARCH_BOOST_KEYS_FILE`、`SEARCH_BOOST_LAYER_FILE`（可选覆盖文件路径）。

## 安装面（Cursor / Cursor CLI）

| 目标 | 机制 |
|------|------|
| MCP | `~/.cursor/mcp.json` — `serverUseInstructions` + stdio entry |
| 主动策略 | `~/.cursor/hooks.json` → `sessionStart`（能力摘要，非强制） |
| Skill | `~/.cursor/skills/search-boost/SKILL.md` |
| CLI 免审批 | `~/.cursor/cli-config.json` → `Mcp(search-boost:*)` |
| Policy runtime | MCP resource `search-boost://policy` |

`~/.cursor/AGENTS.md` 仅 uninstall 时清理遗留块；Cursor CLI 不加载该路径。

Layer 默认读 `~/.search-boost-layer.json`（旧 `~/.dsh-search-boost-layer.json` 仍可读）；安装时**不再**烘焙 `SEARCH_BOOST_LAYER` env。

## 后续

1. npm 发布 v0.2.0（含 pi/dsh adapter）/ Cursor Plugin 包
2. 在真实 DSH 宿主验证 `search-boost-mcp/dsh` bundle 行（本机无 dsh CLI；loader 语义已按 cordis-plugin-loader 源码核对）
3. MCP deeplink 一键安装链接
4. 集成测试：live fused_search 走网络（optional，慢；本机直连出网被阻断，只能经代理）
