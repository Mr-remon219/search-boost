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

## 架构

```
Cursor Agent
    │ GetMcpTools / CallMcpTool
    ▼
search-boost-mcp/server.mjs          (stdio MCP)
    │ lib/runtime.mjs
    ▼
lib/search/                          (vendored; independent MCP runtime)
    engines / fusion / fetch / xsearch / research / ...
```

**不移植**：`research_parallel` / `parallelResearch`（依赖 DSH/pi 子代理运行时）

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

## pi vs 本仓库引擎差异

| | search-boost-mcp (lib/search) | pi |
|--|-------------------------------|-----|
| free 层 | bing+ddg+yahoo+exa-free | exa-free 单引擎 |
| api 层 | +antigravity+tavily+brave+exa | tavily+brave+exa |
| audit | search_stats 简版 | JSONL 完整 audit |

Phase 2：可选从 pi lib 合并 Tavily advanced 全文、CJK 分词。

## 后续

1. npm 发布 / Cursor Plugin 包
2. pi lib 差异合并（audit、Tavily advanced、CJK）
3. MCP deeplink 一键安装链接
4. 集成测试：live fused_search 走网络（optional，慢）
