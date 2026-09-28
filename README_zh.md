# SearchBoost

**面向 AI Coding Agent 的多引擎网络搜索与证据聚合工具箱**  
*一个核心代码库，深度适配 MCP、Pi 与 DeepSeek Harness 三大生态*

[![version](https://img.shields.io/badge/version-v0.2.3-orange?style=flat-square)](#)
[![npm version](https://img.shields.io/badge/npm-search--boost-cb3837?style=flat-square&logo=npm)](https://www.npmjs.com/package/search-boost)
[![Node version](https://img.shields.io/badge/node-%3E%3D22.13-339933?style=flat-square&logo=node.js)](https://nodejs.org/)
[![License](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](./LICENSE)
[![Architecture](https://img.shields.io/badge/architecture-unified%20core-8a2be2?style=flat-square)](#)
[![Free tier](https://img.shields.io/badge/free%20tier-zero%20key%20required-success?style=flat-square)](#)

[English](./README.md) · [中文文档](./README_zh.md)

---

> [!NOTE]
> **版本与发布说明**：以往的 `pi-search-boost` 与 `dsh-search-boost` 已合并为单一代码库，统一维护在 `lib/` 核心层中。文档中包含 `@latest` 的命令指向 npm 正式发布的版本；如需验证尚未进入正式发布的代码，请检出你所需的分支或标签，并参考[源码安装与本地开发](#源码安装与本地开发)。

---

> **v0.2.3**：新增自定义 API Base URL、意图引导的 Jev 检索、共享工具开关与 MCP/Pi 热刷新，修复 DSH Schema 及 npm/npx 安装兼容性。详见[发布与迁移说明](./docs/v0.2.3-release.md)，特别注意 V3 的 `coverageComplete` / `retrievalSufficient` 语义变化。

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
  - [4. `adaptive_search` Jev 意图导向搜索（实验功能）](#4-adaptive_search-jev-意图导向搜索实验功能)
  - [引擎池与评分预设](#引擎池与评分预设)
- [多智能体并行研究工作流](#多智能体并行研究工作流)
- [安全](#安全)
- [CLI 命令参考（自动化与进阶）](#cli-命令参考自动化与进阶)
- [源码安装与本地开发](#源码安装与本地开发)
- [友情链接](#友情链接)
- [开源协议](#开源协议)

---

## 核心特性

- **多引擎并行检索与去重 (`fused_search`)**  
  同时聚合多个搜索引擎的实时结果。内置**免密钥免费池**（Bing、DuckDuckGo、Yahoo、Exa-free、AnySearch）与**高质量 API 池**（Tavily、Brave、Exa、AnySearch），自动执行跨引擎 URL 规范化去重、域名过滤与权重重排。
- **高净度网页正文提取 (`fetch_page`)**  
  优先抓取原站降低等待；必要时使用同线路 curl 兼容兜底，Jina Reader 作为备用读取方式。自动剔除 CSS、JS 及广告噪音，支持 `focus` 关键词段落提炼，具备内存缓存与大体积熔断保护。
- **X / Twitter 社区情报检索 (`x_search`)**  
  支持通过官方 xAI API 或免登录回退通道获取推文、作者动态与讨论串。基于 Snowflake ID 逆向还原精准发布时间戳，本地执行作者与日期范围过滤，杜绝幻觉。
- **Jev 意图导向搜索 (`adaptive_search` · 实验功能)**
  输入一个问题、研究倾向、搜索点和明确限制。Jev 先判限制再评质量，方向不符拒绝，各点就绪后整体终检。保留每轮500候选容量、有界页面补查与分页；不宣称答案已核实或完整。
- **原生多智能体并行研究工作流**  
  随包提供 `search-boost` 与 `search-boost-parallel-research` Skills。在支持子代理的宿主（如 Cursor、Claude Code、Pi、DSH）中，可将复杂调研拆分为多路 Searcher（抓取证据）与 Summarizer（无工具综合），提供 Fast 与 Complex 两种研究波次。
- **统一架构，全宿主覆盖**  
  单一核心运行时（Host-neutral Core Runtime），向上提供通用的 Model Context Protocol (MCP) 标准服务，同时深度定制 Pi 原生扩展与 DeepSeek Harness (DSH) 原生插件包。
- **开箱即用与严苛安全策略**  
  **无需配置任何 API Key** 即可直接使用免费引擎池；敏感凭证严格存储于本地权限锁定的配置文件（POSIX `0600`）；网络访问交给本机网络和代理，保留请求边界与明确的失败兜底，严禁向模型上下文泄露凭证。

---

## 系统架构

SearchBoost 采用“**单核三适配**”设计，所有搜索算法、分词、抓取策略、去重逻辑与网络安全防护均统一收拢于核心层：

```text
                    SearchBoost TUI / CLI
                      安装 · 配置 · 更新
                              │
                    Shared SearchBoost Core
                     lib/runtime.mjs 核心门面
               搜索 · 抓取 · X · Jev 意图导向搜索
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
> **零 Key 即可起步**：SearchBoost 默认提供免费引擎池（Bing、DuckDuckGo、Yahoo、Exa-free、AnySearch）。即便不填写任何 API Key，也能立刻享受高质量多引擎聚合搜索！

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
| **API keys & Base URLs / Search layer** | 管理 Tavily、Brave、Exa 等付费引擎密钥，以及 AnySearch 密钥（free 匿名、api 带 key、hybrid 优先已配置 key），切换默认搜索层 (`free` / `api`)。 |
| **X credentials** | 管理 X (Twitter) 认证，支持一键导入本机已有的 Grok 登录状态。 |
| **Jev credentials (experimental)** | 配置 TypeSafe Jev 认知引擎的端点与 Bearer Token。 |
| **Tool switches** | 统一开关 MCP / Pi / DSH 的 SearchBoost 工具；未配置 Jev 时锁定 `adaptive_search`。 |
| **Native web search** | 开启或关闭宿主自带的原生网页搜索（若宿主提供相应配置开关）。 |
| **Status** | 快速查看本地配置就绪状态、引擎启用情况及已接入的宿主清单。 |
| **Print MCP snippet** | 在终端打印 MCP 配置 JSON 片段，便于手动复制到自定义环境中。 |
| **Uninstall** | 安全卸载指定 Agent 中的 SearchBoost 配置与挂载，保留用户无关配置。 |

### 工具开关

进入 **Tool switches**，空格勾选，回车查看变更并确认保存。Esc 或取消确认不写入配置；允许全部关闭。未配置 Jev 时，`adaptive_search` 在状态面板中显示删除线和锁定原因，不进入可选列表。配置 Jev 后默认可用，但此前明确关闭的偏好不会被覆盖。

开关统一保存于 `~/.search-boost/config/tools.json`（或 `$SEARCH_BOOST_HOME/config/tools.json`），采用文件锁和原子写入。加载新版适配器后无需重启、重装宿主：

- **MCP**：约 300ms 内刷新工具列表并发送 `tools/list_changed`；忽略通知的客户端可能需要重连。
- **Pi**：约 300ms 内更新活跃工具，保留其他插件工具和原本被宿主排除的工具；会话结束时清理监听。
- **DSH**：保留注册但立即拒绝关闭工具的新调用；原生搜索/抓取 provider 也遵守对应开关。

每次调用都会重新检查开关，旧工具句柄也不能绕过；正在执行的请求正常完成。移除 Jev 凭据会锁定 adaptive 调用（包括分页），恢复凭据不覆盖明确关闭的偏好。这里开关的是**工具入口**，不是底层引擎权限：已开启的 adaptive 仍可在内部搜索和抓取，融合搜索的 community 模式仍可内部检索 X。Slash 命令保留用于恢复配置。正在运行旧适配器代码的进程需先更新/重载一次；各宿主需使用同一 SearchBoost 配置目录。

---

## 工具箱与使用指南

安装完成后，宿主中的 Agent 会自动获得以下标准化工具。Agent 会根据用户提问自主决定调用时机。

### 工具职责与边界

| 工具名称 | 适用场景 | 职责边界（不适用的场景） |
| :--- | :--- | :--- |
| `fused_search` | 多引擎多角度并行查询、结果合并与去重排序 | 仅完成单次搜索；后续是否需要继续检索由主 Agent 判断 |
| `fetch_page` | 读取已知公开 URL 的完整正文或特定关注段落 | 不是带登录态的无头浏览器，无法穿透内网私有地址 |
| `x_search` | 检索 X 平台的公开推文、博主资料或单篇讨论串 | 不承诺完整抓取所有回复，无法代表全平台完整舆论倾向 |
| `adaptive_search` | **实验功能**：意图导向筛选与关键词续搜 | 值得阅读的 URL 和摘录，不是已核实答案 |
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

获取搜索结果中的链接正文。优先抓取原站并清理正文；安装了 curl 时可用于传输兼容兜底，Jina Reader 作为备用。

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

### 4. `adaptive_search` Jev 意图导向搜索（实验功能）

**Vercel 接入**：在 TUI → Jev credentials 填写 `https://ai-gateway.vercel.sh/v1` 和 Vercel AI Gateway Key。系统自动选择官方 SDK 的 `typesafe-ai/jev` 评估接口；不要使用聊天补全端点。默认 TypeSafe `/systemone` 保持兼容。两条路径都只使用用户级配置中的 Jev Key，不读取环境变量；服务端限流等待不会被缩短。

调用方提供**一个问题**（`questions` 恰好一项）、研究目的 `intent`、研究点 `keywords` 和明确硬条件 `constraints`。每次实际搜索先依据缺口、材料与历史反馈选择查询，再针对选定查询选择引擎。候选入池后，**一个独立 Boolean 前筛判断全部显式条件**；条件为空则跳过。质量判断保留重点及有用补充材料，方向用于重点排序、关键词用于贡献归属，不再共同否决整篇材料。经过有界审查窗口且各点已有贡献后，终审按原问题与方向检查**全部当前有效入库材料**，不重审条件：通过则返回，不通过则指定一个已有关键词重新搜索。全量终审装不下或执行异常时明确未完成，不截取少量材料冒充全审。主 Agent 仍负责分析和事实核实。

```json
{
  "questions": ["ExampleDB 从 4.1 升级到 4.2 有哪些兼容风险？"],
  "intent": "寻找实际迁移步骤、具体不兼容案例及反证，不需要营销介绍。",
  "keywords": ["迁移步骤", "不兼容变更", "失败案例"],
  "constraints": ["仅使用官方资料"],
  "page_size": 20
}
```

- `constraints` 仅填明确可核验的完整硬条件，如适用版本、事件/发布日期范围、平台或仅限官方来源。**不要填研究方向、软偏好、关键词或期望结论**；没有明确限制则省略或传 `[]`。所有条件按AND判断；每项强制文档条件均须显式放入该字段，不暗中从问题补猜。有用补充材料不必命中列出的研究点。
- 多问题列表、`tasks/targets/facts/time_range` 和二维关键词不再是公开入口；独立问题请分次调用。
- 返回认可的 URL、标题、审查摘录及 valueScore/directionMatch/kind及focus/supporting分层，不生成答案，不混入尚未完成准入的候选；可选方向或关键词判断缺失仍单独披露。
- 查看 `reviewSummary`、`scopeSummary`、`finalReview`、`keywordProgress`、`pendingAssessments` 和警告。`retrievalSufficient` 需要整体终检通过，不等于事实核实或答案全集覆盖；`coverageComplete` 在 schemaVersion 3 中仍恒为 false。
- 用 `{"cursor":"<nextCursor>"}` 读取后续页，可选 page_size，不重搜或重问 Jev。默认20、最多50条/页并有字节预算，累计认可结果无固定条数帽；结果暂存本进程最多30分钟/32次，分页完毕不是全网穷尽。
- 阈值仍是未标定工程起点。完整契约、预算和迁移说明见 [Jev 单问题研究检索](docs/jev-adaptive-search.md)。

---

### 引擎池与评分预设

`engine_pool` 选择调用集合，`ranking` 选择跨池共享权重；`complexity` 只控制预算。AnySearch 是单一逻辑引擎：free 匿名、api 要求 key、hybrid 优先用已配置 key。使用 `ANYSEARCH_API_KEY` 或 `config keys --set anysearch=KEY` 配置。

| 引擎 | balanced | research | fresh |
| --- | ---: | ---: | ---: |
| bing | 0.957 | 0.927 | 1.020 |
| ddg | 0.981 | 0.903 | 0.927 |
| yahoo | 0.957 | 0.877 | 0.902 |
| exa-free | 1.004 | 1.085 | 0.951 |
| tavily | 1.049 | 1.105 | 1.084 |
| brave | 1.004 | 0.951 | 1.125 |
| exa | 1.049 | 1.146 | 1.063 |
| anysearch | 1.004 | 1.042 | 0.951 |

权重是未经实测标注校准的冷启动先验。`consensus-v2.1` 使用原始排名、相关来源组折扣和 max+log 共识，元数据修正最多 20%；质量分与列表选择分分离。零权重不投票，旧 `min_score` 阈值需重新校准。详见 [评分设计与迁移](docs/fusion-scoring.md) 和 [引擎池](docs/search-routing.md)。

---

## 多智能体并行研究工作流

同一套工作流，三种宿主接入方式。主 Agent 先把问题拆成互不依赖的调研线；每条线由一名 Searcher 子代理用 `fused_search` 与 `fetch_page` 收集证据，再由无工具的 Summarizer（或主 Agent 自己）收敛成一份答案。

```text
                        [ 主 Agent (Parent) ]
                    拆分调研线 · 持有最终结论
                                │
                ┌───────────────┴───────────────┐
                ▼                               ▼
         [ Searcher A ]                  [ Searcher B ]
     fused_search · fetch_page       fused_search · fetch_page
                │                               │
                └───────────────┬───────────────┘
                                ▼
                        [ Summarizer ]
                      无工具 · 只做证据综合
                                ▼
                       [ 主 Agent 报告 ]
```

| 宿主 | 入口 | 子代理如何运行 |
| :--- | :--- | :--- |
| **Pi** | `/fast-parallel`、`/complex-parallel` 提示词；`search-parallel-subagent` 工具；`searcher` / `summarizer` 角色 | 每个 Searcher 是独立子进程，显式加载 SearchBoost Pi 扩展（`adapters/pi/index.js`），工具白名单只有 `fused_search` 与 `fetch_page`；Summarizer 以 `--no-tools` 启动。波次规模由调用方决定，该 runner 不设并发上限。 |
| **DeepSeek Harness** | 原生 `research_parallel` 工具 | 子代理经宿主 subagent 服务在同一 Cordis 上下文中创建。Searcher 获得 `toolFilter.allow = ['fused_search','fetch_page']`，Summarizer 为空白名单。发起波次前 `research_parallel` 会确认两个工具已注册，否则拒绝派发；句柄在成功或失败后都会释放，`maxDepth` 为 1，子代理不能再次嵌套调研。 |
| **MCP 宿主**（Cursor、Claude Code、Codex、Grok、Antigravity） | 随包安装的 `search-boost-parallel-research` Skill | Skill 内嵌同一套角色与流程，用宿主自身的子代理机制执行；宿主无法派生子代理时，退回主 Agent 串行调研。 |

安装到 MCP 宿主时还会同时安装配套的 **`search-boost`** 路由 Skill，为开放式问题选择合适工具。

- **Fast 模式**：只跑一波 Searcher，随后由主 Agent 收敛，不启动 Summarizer，也不补第二波。
- **Complex 模式**：1~3 波，波次之间做证据缺口复核；只有存在实质性缺口时才追加下一波，证据足够就提前停止。需注意：波次上限是提示词层面的工作流约束，不是跨独立工具调用的全局配额。
- **降级保护**：宿主无法派生子代理时，由主 Agent 串行调研并如实说明，不会假装并行波次已经执行。

> [!IMPORTANT]
> 子代理返回 `ok` 只代表执行完成且文本非空，**不代表结论已被证实**。失败或部分完成的报告仍会保留可见，但其 URL 不计入成功聚合；最终判断始终由主 Agent 负责。

Pi/DSH 子代理工具加载、旧 `pi-search-boost` 路径与已移除的 `deep_research` 排查，见[子代理工具配置与诊断](docs/subagent-tools.md)。

---

## 安全

### 自定义搜索 API 地址

TUI 进入 **API keys & Base URLs**（或执行 `search-boost config keys`），每个引擎同时显示密钥掩码、当前 Base URL 和 default/custom 标记。选择 **Set / replace Base URL** 修改地址后，可继续保留或修改密钥；**Restore default Base URL** 只恢复地址。向导完成后统一保存。状态页和 `config keys --show` 也会显示生效地址。

```bash
search-boost config keys --base-url exa=https://gateway.example/exa
search-boost config keys --reset-base-url exa
```

| 引擎 | 默认 Base URL | 自动追加路径 |
|---|---|---|
| Tavily | `https://api.tavily.com` | `/search` |
| Exa | `https://api.exa.ai` | `/search` |
| Brave | `https://api.search.brave.com/res/v1` | `/web/search` |
| AnySearch | `https://api.anysearch.com/v1` | `/search` |

填写 API 基础地址，**不要填写完整搜索端点**；网关路径前缀会保留。地址存放在 keys 文件的 `engines.<name>.baseUrl`，兼容现有密钥字符串和路由开关。请仅使用可信、兼容对应引擎 API 的网关：搜索词与已配置密钥会发送到该地址（AnySearch 在 free 池仍不发送密钥）。推荐 HTTPS，也支持本地网关的 HTTP；拒绝包含用户名密码、查询参数或片段的地址。不影响 Exa-free；地址变更后不会复用旧地址的搜索缓存。

API Key 存放在由 SearchBoost 自己管理的凭据文件中，不写入提示词、工具结果或 shell 配置：

- **文件权限**：密钥存放在 `~/.search-boost/config/keys.json`（可用 `SEARCH_BOOST_HOME` 重定向根目录）。在 POSIX 系统上目录为 `0700`、文件为 `0600`；覆盖写入时先生成全新的 `0600` 临时文件再改名替换，已存在的文件不会被放宽权限。同一根目录下的备份与升级状态同样为 `0600`。环境变量指定的自定义目录会保留其原有权限，但凭据文件仍以 `0600` 创建。Windows 没有 POSIX 权限位，由 ACL 继承决定。
- **原子写入与加锁**：写入使用 `O_EXCL` 临时文件加改名替换，读取方只会看到旧文件或新文件，不会读到写了一半的内容；写入失败会自行清理临时文件并保留原文件。读改写流程持有独占锁，两个写入者不会静默互相覆盖，被拒绝的修改也不会触碰原文件。
- **不回显**：API Key 只在调用所属引擎时随请求发送（Tavily、Brave、Exa 的请求参数或请求头）。状态输出、`search-boost config keys --show` 与 doctor 报告只显示掩码（`abcd****wxyz`）；错误信息经过测试不会包含凭据内容，Jev 评测请求中也不含 Key、掩码 Key 或指纹。AnySearch 已参与引擎路由：free 使用匿名额度，api 要求 key，hybrid 优先使用已配置 key；同次融合只计一票。


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
# 无需全局安装 search-boost / dsh / pnpm（Windows、Linux、macOS）：
npx --yes search-boost@latest install -t dsh --profile web -y
search-boost install -t cursor --dry-run    # 仅演练安装过程，不写磁盘

# ----------------- 凭据与配置管理 -----------------
search-boost config keys                    # 命令行配置/查看搜索引擎 Keys
search-boost config keys --set anysearch=KEY  # 配置 AnySearch 密钥（ANYSEARCH_API_KEY）
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

适用于参与开发，或提前验证尚未进入 npm 正式发布的代码；文档其他位置的 `@latest` 命令指向 npm 已发布版本。

### 环境准备

- **Node.js** `>= 22.13.0`（与 `package.json` 声明一致）
- **git** 与 **npm**
- 可选：**`curl`**，用于 `fetch_page` 的同线路传输兼容兜底

### 检出并初始化

```bash
# 1. 克隆仓库
git clone https://github.com/Mr-remon219/search-boost.git
cd search-boost

# 2. 按 CI 的方式安装依赖
npm ci

# 3. 重新生成随包 Grok 插件资产
npm run plugin:sync-grok
```

克隆后位于仓库的默认分支。若要验证其他分支或标签，请在安装依赖前先检出（`git checkout BRANCH_OR_TAG`）。

### 不装全局包直接运行

```bash
node cli.mjs                  # 直接从检出目录启动交互式控制台 (TUI)
node cli.mjs status           # 查看当前状态摘要
node cli.mjs install -t pi -y # 从当前检出目录挂载 Pi 扩展
node cli.mjs install -t dsh --profile web
```

`node cli.mjs` 接受与全局安装后的 `search-boost` 完全相同的命令。若希望终端里直接使用 `search-boost`，用软链代替全局安装：

```bash
npm link        # 或：npm install -g .
search-boost
```

修改适配器或 Agent 资产后，重新执行该宿主对应的安装命令（`node cli.mjs install -t HOST`）让宿主加载新文件，然后重启或重载该宿主。

### 提交 PR 前的验证门禁

| 命令 | 覆盖范围 |
| :--- | :--- |
| `npm run check` | CLI、核心层、适配器与脚本的语法检查 |
| `npm run prepublishOnly` | 完整离线套件：插件同步、语法、CLI、安装、doctor、融合搜索、X、引擎、X 认证、Jev、密钥权限、dry-run、网络、搜索路由、适配器、并行研究、升级、MCP 与冒烟测试 |
| `npm run test:network` | 代理重试、curl 兜底、请求边界与兼容性回归 |
| `npm run test:adapters` | MCP / Pi / DSH 适配器协议测试，以及 Pi 子代理配置迁移诊断 |
| `npm run test:parallel` | Searcher/Summarizer 契约、DSH 派发预检、取消与工具隔离 |
| `npm run test:adaptive` | Jev 自适应证据收集循环 |
| `npm run smoke` | MCP JSON-RPC 协议冒烟测试 |

这些套件使用本地回环夹具与进程替身运行，不需要真实引擎 Key；`npm run prepublishOnly` 全绿即可提交 PR。

---

## 友情链接

- [LINUX DO](https://linux.do/)

---

## 开源协议

本项目基于 [MIT License](./LICENSE) 协议开源。
