# SearchBoost

**面向 AI Coding Agent 的多引擎网络搜索与证据聚合工具箱**  
*一个核心代码库，深度适配 MCP、Pi 与 DeepSeek Harness 三大生态*

[![version](https://img.shields.io/badge/version-v0.2.0-orange?style=flat-square)](#)
[![npm version](https://img.shields.io/badge/npm-search--boost-cb3837?style=flat-square&logo=npm)](https://www.npmjs.com/package/search-boost)
[![Node version](https://img.shields.io/badge/node-%3E%3D22.13-339933?style=flat-square&logo=node.js)](https://nodejs.org/)
[![License](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](./LICENSE)
[![Architecture](https://img.shields.io/badge/architecture-unified%20core-8a2be2?style=flat-square)](#)
[![Free tier](https://img.shields.io/badge/free%20tier-zero%20key%20required-success?style=flat-square)](#)

[English](./README.md) · [中文文档](./README_zh.md)

---

> [!NOTE]
> **版本与发布说明**：当前的 `v0.2.0` 分支已整合以往独立的 `pi-search-boost` 与 `dsh-search-boost` 代码，统一维护在 `lib/` 核心层中。文档中包含 `@latest` 的命令指向 npm 正式发布的版本；体验本分支最新代码请参考[源码安装与本地开发](#源码安装与本地开发)。

---

## 目录

- [核心特性](#核心特性)
- [系统架构](#系统架构)
- [宿主支持矩阵](#宿主支持矩阵)
- [快速开始（30 秒上手）](#快速开始30-秒上手)
- [升级与迁移指南](#升级与迁移指南)
- [交互式控制台 (TUI)](#交互式控制台-tui)
- [工具箱与使用指南](#工具箱与使用指南)
  - [工具职责与边界](#工具职责与边界)
  - [1. `fused_search` 多引擎融合搜索](#1-fused_search-多引擎融合搜索)
  - [2. `fetch_page` 智能网页提炼](#2-fetch_page-智能网页提炼)
  - [3. `x_search` X (Twitter) 动态检索](#3-x_search-x-twitter-动态检索)
  - [4. `adaptive_search` Jev 自适应证据链（实验功能）](#4-adaptive_search-jev-自适应证据链实验功能)
  - [引擎池与评分预设](#引擎池与评分预设)
- [多智能体并行研究工作流](#多智能体并行研究工作流)
- [配置、安全与隐私保障](#配置安全与隐私保障)
- [CLI 命令参考（自动化与进阶）](#cli-命令参考自动化与进阶)
- [源码安装与本地开发](#源码安装与本地开发)
- [开源协议](#开源协议)

---

## 核心特性

- **多引擎并行检索与去重 (`fused_search`)**  
  同时聚合多个搜索引擎的实时结果。内置**免密钥免费池**（Bing、DuckDuckGo、Yahoo、Exa-free）与**高质量 API 池**（Tavily、Brave、Exa），自动执行跨引擎 URL 规范化去重、域名过滤与权重重排。
- **高净度网页正文提取 (`fetch_page`)**  
  优先采用 Jina Reader 结构化提取，并提供受严格安全防护的本地 HTML 抓取作为回退。自动剔除 CSS、JS 及广告噪音，支持 `focus` 关键词段落提炼，具备内存缓存与大体积熔断保护。
- **X / Twitter 社区情报检索 (`x_search`)**  
  支持通过官方 xAI API 或免登录回退通道获取推文、作者动态与讨论串。基于 Snowflake ID 逆向还原精准发布时间戳，本地执行作者与日期范围过滤，杜绝幻觉。
- **Jev 辅助自适应证据闭环 (`adaptive_search` · 实验功能)**  
  连接 TypeSafe Jev 认知引擎，针对 1~6 个复杂问题进行自主多轮搜索与证据碎片评估。严格受控执行预算，输出明确的证据覆盖状态（`covered`、`insufficient`、`unassessed`、`not_searched`、`failed`），帮助 Agent 快速核实事实断言。
- **原生多智能体并行研究工作流**  
  随包提供 `search-boost` 与 `search-boost-parallel-research` Skills。在支持子代理的宿主（如 Cursor、Claude Code、Pi、DSH）中，可将复杂调研拆分为多路 Searcher（抓取证据）与 Summarizer（无工具综合），提供 Fast 与 Complex 两种研究波次。
- **统一架构，全宿主覆盖**  
  单一核心运行时（Host-neutral Core Runtime），向上提供通用的 Model Context Protocol (MCP) 标准服务，同时深度定制 Pi 原生扩展与 DeepSeek Harness (DSH) 原生插件包。
- **开箱即用与严苛安全策略**  
  **无需配置任何 API Key** 即可直接使用免费引擎池；敏感凭证严格存储于本地权限锁定的配置文件（POSIX `0600`）；内置 SSRF 防护、目标 IP 地址固定与透明代理支持，严禁向模型上下文泄露凭证。

---

## 系统架构

SearchBoost 采用“**单核三适配**”设计，所有搜索算法、分词、抓取策略、去重逻辑与网络安全防护均统一收拢于核心层：

```text
                    SearchBoost TUI / CLI
                      安装 · 配置 · 更新
                              │
                    Shared SearchBoost Core
                     lib/runtime.mjs 核心门面
               搜索 · 抓取 · X · Jev 自适应证据链
                              │
              ┌───────────────┼───────────────┐
              │               │               │
         MCP Adapter      Pi Adapter     DSH Adapter
         stdio 服务       原生扩展       Cordis Bundle
              │               │               │
     ┌────────┴────────┐      ▼               ▼
     │ Cursor / Claude │      Pi       DeepSeek Harness
     │ Codex / Grok    │
     │ Antigravity     │
     └─────────────────┘
```

- **Core (`lib/`)**：宿主无关的算法与网络引擎，负责引擎调用、数据清洗、Jev 协议交互及安全策略。
- **Adapters (`adapters/`)**：负责将核心能力翻译为具体协议（MCP JSON-RPC、Pi Extension API、DSH Cordis 生命周期）。
- **Agents (`agents/`)**：受控提示词、工作流模板与原生 Skills 定义。

---

## 宿主支持矩阵

| 宿主 (Host) | 接入类型 | 核心集成文件与机制 | 特性支持与说明 |
| :--- | :--- | :--- | :--- |
| **Cursor / Cursor CLI** | MCP + Skills | `~/.cursor/mcp.json` / `skills/` | 支持 CLI 免审批 (`cli-config.json`)、会话启动注入、并行研究 Skill |
| **Claude Code** | MCP + Prompts | `claude` 官方 MCP 配置 | 注入原生提示词契约，提供端到端多引擎搜索工具 |
| **Codex** | MCP + Prompts | 对应的 MCP 配置文件 | 提供无缝的多引擎及网页抓取工具支持 |
| **Grok Build** | MCP + Plugin | 包含打包的 Grok 插件 | 当检测到 `grok` CLI 时自动同步安装配套插件 |
| **Google Antigravity** | MCP + Workspace | 项目工作区 MCP 配置 | 支持在工作区内配置专属指导与多引擎检索能力 |
| **Pi** | 原生扩展 (Extension) | `~/.pi/agent/extensions/` / `prompts/` | 挂载 `/fast-parallel`、`/complex-parallel`，内置 searcher/summarizer 子代理 |
| **DeepSeek Harness** | 原生 Bundle | `cordis.patch.yml` / `dsh plugin` | 深度集成 Cordis 框架，支持 `research_parallel` 原生子代理调度与状态卡片 |

---

## 快速开始（30 秒上手）

### 环境要求
- **Node.js**：`>= 22.13.0`
- **包管理器**：`npm`（或 `pnpm`）

### 1. 全局安装与启动控制台

```bash
# 全局安装统一包
npm install -g search-boost

# 启动交互式控制台向导 (TUI)
search-boost
```

> [!TIP]
> **零 Key 即可起步**：SearchBoost 默认提供免费引擎池（Bing、DuckDuckGo、Yahoo、Exa-free）。即便不填写任何 API Key，也能立刻享受高质量多引擎聚合搜索！

### 2. 三步完成配置
1. 在 TUI 菜单中选择 **`Setup`**，跟随向导配置搜索引擎（可选填 API Key，或直接跳过使用免费池）。
2. 勾选需要接入的 Agent（如 Cursor、Claude Code、Pi 等），确认是否自动设置免审批权限与替换原生搜索。
3. 重启或重新载入对应的 Agent，即可在对话中直接让模型进行网络检索！

---

## 升级与迁移指南

### 1. 日常更新：直接在 TUI 中一键升级

无论你是使用标准的 `search-boost`，还是此前安装过旧版的 `pi-search-boost`、`dsh-search-boost`，**只需启动 TUI 并选择 `Update` 即可完成全部升级**：

```bash
# 方式一：进入交互式菜单一键更新
search-boost
# -> 选择 "Update"

# 方式二：命令行静默更新（推荐脚本或快捷操作使用）
search-boost upgrade -y
```

> **Update 行为说明**：检查 npm 最新版本并拉取更新，同时自动刷新所有已在系统中登记的 Agent 提示词与集成资产；保留用户已配置的所有 API Key、搜索层偏好及权限设置。

---

### 2. 从旧全局包 `search-boost-mcp` 迁移

> [!IMPORTANT]
> 如果你的全局环境中仍安装着旧包名 `search-boost-mcp`，由于 npm 不允许不同名包互相覆盖全局同名 bin 命令，**必须使用一次性 npx 命令平滑交接**：

```bash
# 一键迁移（自动安装新包、核验证书后安全卸载旧包，保持 Agent 配置完全不变）
npx --yes --package=search-boost@latest -- search-boost migrate -y

# 迁移完成后，后续日常更新只需执行：
search-boost
# -> 选择 Update (或 search-boost upgrade -y)
```

---

## 交互式控制台 (TUI)

直接在终端执行 `search-boost` 即可进入基于 Clack 的交互式控制面板。日常所有安装、维护与凭证管理均可在此完成：

| 菜单项 (Action) | 功能说明 |
| :--- | :--- |
| **Setup** | 首次引导式全流程配置，依次设置引擎、搜索层、X 凭据并安装 Agent 集成。 |
| **Install / update agents** | 快速安装或刷新指定 Agent 的集成文件，跳过凭据与搜索层设置。 |
| **Update** | **一键全量更新**：检查 npm 最新版本，更新 SearchBoost 并同步刷新所有已接入的 Agent（含 Pi/DSH 旧适配器）。 |
| **API keys / Search layer** | 管理 Tavily、Brave、Exa 等付费引擎密钥，切换默认搜索层 (`free` / `api`)。 |
| **X credentials** | 管理 X (Twitter) 认证，支持一键导入本机已有的 Grok 登录状态。 |
| **Jev credentials (experimental)** | 配置 TypeSafe Jev 认知引擎的端点与 Bearer Token。 |
| **Native web search** | 开启或关闭宿主自带的原生网页搜索（若宿主提供相应配置开关）。 |
| **Status** | 快速查看本地配置就绪状态、引擎启用情况及已接入的宿主清单。 |
| **Print MCP snippet** | 在终端打印 MCP 配置 JSON 片段，便于手动复制到自定义环境中。 |
| **Uninstall** | 安全卸载指定 Agent 中的 SearchBoost 配置与挂载，保留用户无关配置。 |

---

## 工具箱与使用指南

安装完成后，宿主中的 Agent 会自动获得以下标准化工具。Agent 会根据用户提问自主决定调用时机。

### 工具职责与边界

| 工具名称 | 适用场景 | 职责边界（不适用的场景） |
| :--- | :--- | :--- |
| `fused_search` | 多引擎多角度并行查询、结果合并与去重排序 | 仅完成单次搜索；后续是否需要继续检索由主 Agent 判断 |
| `fetch_page` | 读取已知公开 URL 的完整正文或特定关注段落 | 不是带登录态的无头浏览器，无法穿透内网私有地址 |
| `x_search` | 检索 X 平台的公开推文、博主资料或单篇讨论串 | 不承诺完整抓取所有回复，无法代表全平台完整舆论倾向 |
| `adaptive_search` | **实验功能**：由 Jev 驱动的自动多轮追问与碎片评测 | 并非最终答案生成器，`covered` 是模型评判而非不可动摇的事实 |
| `search_stats` | 查看引擎就绪状态、内存缓存命中与近期活动诊断 | 本地配置就绪不代表此时此刻外部网络一定通畅 |
| `search_layer` | 在 MCP 环境中查看或切换兼容搜索层模式 | 查看为只读；修改会持久化写入磁盘并需要用户授权 |

---

### 1. `fused_search` 多引擎融合搜索

并行向多个引擎分发查询，自动规整 URL、清洗重定向、并根据综合评分模型进行多样性截断。

**调用参数范例 (Tool Call JSON)**：
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

- **`engine_pool`**：`free`（默认纯免费引擎）、`api`（仅配置了 Key 的付费引擎）、`hybrid`（免费 + 付费全开）。
- **`ranking`**：评分权重预设。可选 `balanced`（均衡）、`research`（学术与深度优先）、`fresh`（时效性优先）。
- **`complexity`**：`simple`（1 组查询变体）、`medium`（最多 2 组变体）、`complex`（最多 3 组深度变体）。
- **`community`**：布尔值（默认 `false`）。设为 `true` 时会将 X 社区一手开发者的讨论混入结果限额中。

---

### 2. `fetch_page` 智能网页提炼

获取搜索结果中的链接正文。优先通过 Jina Reader 获取整洁 Markdown，失败时自动切入本地受保护的直接抓取。

**调用参数范例**：
```json
{
  "url": "https://nodejs.org/api/globals.html",
  "focus": "AbortSignal.any"
}
```

- **`focus`（可选）**：指定关键词或关注点，抓取器将重点保留匹配的相关上下文段落。
  > [!TIP]
  > 如果带有 `focus` 时未提取到内容，**并不代表原网页中不存在答案**；建议去掉 `focus` 重新抓取完整页面。

---

### 3. `x_search` X (Twitter) 动态检索

专为技术追踪与一手动态设计。支持关键字检索、用户时间线（User 模式）与推文讨论串（Thread 模式）。

**调用参数范例**：
```json
{
  "query": "Claude 3.7 Sonnet hybrid reasoning from:AnthropicAI",
  "mode": "keyword",
  "max_results": 5
}
```

- **时间戳精准还原**：若平台返回的时间缺失，算法会基于 Snowflake ID 逆向推导真实发帖时间（UTC）。
- **原生操作符支持**：支持 `from:username`、`since:YYYY-MM-DD`、`until:YYYY-MM-DD` 等精准过滤。

---

### 4. `adaptive_search` Jev 自适应证据链（实验功能）

当需要对高度专业的断言进行严格考证时，Agent 可调用 `adaptive_search`。Jev 认知内核会自动拆解问题、选择允许的引擎、抓取关键网页片段并评估证据充分性。

**调用参数范例**：
```json
{
  "questions": [
    "官方文档对该 API 的 AbortSignal 取消机制有何明确保证？",
    "该特性最早是在哪个稳定版本中引入的？"
  ]
}
```

- 接受 1~6 个非空问题，每题限长 400 字符以内。
- **返回结果包含逐题状态**：
  - `covered`：已有证据片段能够充分回答该问题（模型评判）。
  - `insufficient`：当前检索到的材料不足以支撑该结论。
  - `unassessed`：未完成全部评测的中间状态。
  - `not_searched`：因预算或时间耗尽而未执行搜索。
  - `failed`：网络或解析异常导致失败。

---

### 引擎池与评分预设

在 `fused_search` 中，各引擎的基础权重受 `engine_pool` 与 `ranking` 共同约束：

| 引擎组合 (Pool-Ranking) | Bing | DuckDuckGo | Yahoo | Exa-free | Tavily | Brave | Exa (API) |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **free-balanced** | 1.00 | 1.05 | 1.00 | 1.10 | — | — | — |
| **free-research** | 0.95 | 0.90 | 0.85 | 1.30 | — | — | — |
| **free-fresh** | 1.15 | 0.95 | 0.90 | 1.00 | — | — | — |
| **api-balanced** | — | — | — | — | 1.20 | 1.10 | 1.20 |
| **api-research** | — | — | — | — | 1.35 | 1.00 | 1.45 |
| **api-fresh** | — | — | — | — | 1.30 | 1.40 | 1.25 |
| **hybrid-balanced** | 1.00 | 1.05 | 1.00 | 1.10 | 1.20 | 1.10 | 1.20 |

---

## 多智能体并行研究工作流

在安装 MCP 宿主（如 Cursor、Claude Code、Codex、Grok、Antigravity）时，TUI 会同步安装两套官方 Skill：

1. **`search-boost`**：研究路由引导 Skill，帮助模型在面对复杂探索任务时选择最合适的工具策略。
2. **`search-boost-parallel-research`**：**多智能体并行研究工作流**，通过宿主子代理机制实现“分头调研、统一综合”：

```text
                           [ 主 Agent (Parent) ]
                         拆分研究目标 / 规划波次
                                     │
                 ┌───────────────────┴───────────────────┐
                 ▼                                       ▼
       [ Searcher 子代理 A ]                   [ Searcher 子代理 B ]
     专职使用搜索与读页工具                  专职使用搜索与读页工具
                 │                                       │
                 └───────────────────┬───────────────────┘
                                     ▼
                           [ Summarizer 子代理 ]
                         不授予工具 · 纯文本交叉比对
                                     │
                                     ▼
                           [ 主 Agent 输出最终报告 ]
```

- **两种工作流模式**：
  - **Fast 模式**：单波次并发搜集（1 Wave），搜集完毕后立即由主代理完成收敛报告。
  - **Complex 模式**：增加“证据缺口复核”环节，仅在发现实质性论据缺失时才发起第二波补充搜集。
- **降级保护**：当宿主不支持派生子代理时，Skill 会自动降级为单代理串行深度研究，绝不产生死循环。

---

## 配置、安全与隐私保障

### 配置文件结构

所有本地持久化数据统一存放在 `~/.search-boost/config/`（可通过环境变量 `SEARCH_BOOST_HOME` 整体重定向）：

```text
~/.search-boost/
├── config/
│   ├── keys.json        # 搜索引擎 API Keys 及 Jev 凭据 (权限 0600)
│   ├── layer.json       # 兼容搜索层设置 (free / api)
│   └── xauth.json       # X (Twitter) 认证凭据
├── backups/             # 自动配置备份目录
└── state/               # 来源登记与升级状态快照
```

### 安全规范与网络限制

- **文件权限**：在 POSIX 系统上，凭据文件均采用原子写入且权限严格限制为 `0600`（仅当前用户可读写）。
- **SSRF 防御与地址固定**：本地抓取网页时，解析器会校验目标 IP 是否属于私网/内网，并在建立 TCP 连接时锁定目标地址，防止 DNS 重绑定攻击。
- **代理支持**：完全遵循 `HTTP_PROXY`、`HTTPS_PROXY`、`ALL_PROXY` 及 `NO_PROXY` 规范；**显式拒绝 SOCKS 协议**（若检测到非 HTTP 代理将明确报错，杜绝静默直连泄漏）。
- **TUN 代理兼容**：在使用 Fake-IP 模式的虚拟网卡 (TUN) 时，需显式声明 `SEARCH_BOOST_TRUSTED_TUN=1` 以开启受信任的地址穿透。

---

## CLI 命令参考（自动化与进阶）

除交互式 TUI 外，SearchBoost 还提供了完整的命令行接口，非常适合脚本编写与 CI 自动化：

```bash
# ----------------- 启动与基础 -----------------
search-boost                                # 打开交互式控制面板 (TUI)
search-boost status                         # 打印当前配置与集成状态摘要
search-boost --help                         # 查看完整命令行帮助文档

# ----------------- 非交互式安装 -----------------
search-boost install -t cursor -y           # 为 Cursor 安装并自动同意权限
search-boost install -t claude,codex --keep-native  # 安装并保留宿主原生搜索
search-boost install -t antigravity --workspace /path/to/project # 为指定工作区配置
search-boost install -t pi -y               # 为 Pi 挂载原生扩展及提示词
search-boost install -t dsh --profile web   # 为 DeepSeek Harness 接入 web profile
search-boost install -t cursor --dry-run    # 仅演练安装过程，不写磁盘

# ----------------- 凭据与配置管理 -----------------
search-boost config keys                    # 命令行配置/查看搜索引擎 Keys
search-boost config layer                   # 切换默认搜索层 (free / api)
search-boost config x --import-grok         # 从本机 Grok 客户端快速导入 X 凭据
search-boost config jev                     # 配置 Jev 认知引擎端点与 Token

# ----------------- 健康检查与诊断 -----------------
search-boost doctor                         # 离线健康检查
search-boost doctor --strict                # 严格模式（有警告即返回非零退出码）
search-boost doctor --json                  # 输出 JSON 格式诊断报告

# ----------------- 卸载与清理 -----------------
search-boost uninstall -t cursor,claude -y  # 移除指定宿主的集成与注册
```

---

## 源码安装与本地开发

如果你希望对 SearchBoost 进行二次开发，或体验 `v0.2.0` 未发布的最新分支代码：

### 源码安装步骤

```bash
# 1. 克隆代码仓库
git clone https://github.com/Mr-remon219/search-boost.git
cd search-boost

# 2. 切换至目标分支并安装依赖
git switch v0.2.0
npm ci

# 3. 同步生成 Grok 插件资产
npm run plugin:sync-grok

# 4. 全局软链安装至系统
npm install -g .

# 5. 启动控制台体验
search-boost
```

### 开发验证门禁

在提交 PR 或发布前，建议在本地运行完整的测试套件：

```bash
npm run prepublishOnly    # 语法检查 + 同步资产 + 全套离线单元测试
npm run test:network      # DNS、代理、IP 固定与网络安全回归测试
npm run test:adaptive     # Jev 自适应证据收集循环评测
npm run test:adapters     # MCP / Pi / DSH 三大适配器协议测试
npm run smoke             # MCP JSON-RPC 协议冒烟测试
```

---

## 开源协议

本项目基于 [MIT License](./LICENSE) 协议开源。
