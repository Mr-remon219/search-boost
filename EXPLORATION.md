# 探索笔记 — search-boost-mcp

> 2026-08-17 · 独立 MCP 项目

## 完成度

**Phase 1 已完成** — 可安装、可冒烟、协议合规。

| 项 | 状态 |
|----|------|
| 独立目录 `search-boost-mcp/` | ✅ |
| 不修改 dsh/pi git 仓库 | ✅ |
| MCP registerTool + outputSchema | ✅ |
| server instructions | ✅ |
| resource + prompt | ✅ |
| install-cursor 五件套 (MCP+hook+skill+cli-config) | ✅ |
| npm run smoke | ✅ |

## 架构

```
Cursor Agent
    │ GetMcpTools / CallMcpTool
    ▼
search-boost-mcp/server.mjs          (stdio MCP)
    │ importDsh() → ../dsh-search-boost/lib/*.js
    ▼
dsh-search-boost/lib/                  (只读，零依赖)
    engines / fusion / fetch / xsearch / research / ...
```

**不移植**：`research_parallel`（依赖 DSH subagent / pi 子进程）

## 安装面（Cursor / Cursor CLI）

| 目标 | 机制 |
|------|------|
| MCP | `~/.cursor/mcp.json` — `serverUseInstructions` + stdio entry |
| 主动策略 | `~/.cursor/hooks.json` → `sessionStart`（能力摘要，非强制） |
| Skill | `~/.cursor/skills/search-boost/SKILL.md` |
| CLI 免审批 | `~/.cursor/cli-config.json` → `Mcp(search-boost:*)` |
| Policy runtime | MCP resource `search-boost://policy` |

`~/.cursor/AGENTS.md` 仅 uninstall 时清理遗留块；Cursor CLI 不加载该路径。

## pi vs dsh 引擎差异

| | dsh (本 MCP 使用) | pi |
|--|-------------------|-----|
| free 层 | bing+ddg+exa-free | exa-free 单引擎 |
| api 层 | +agy+tavily+brave+exa | tavily+brave+exa |
| audit | search_stats 简版 | JSONL 完整 audit |

Phase 2：可选从 pi lib 合并 Tavily advanced 全文、CJK 分词。

## 后续

1. npm 发布 / Cursor Plugin 包
2. pi lib 差异合并（audit、Tavily advanced、CJK）
3. MCP deeplink 一键安装链接
4. 集成测试：live fused_search 走网络（optional，慢）
