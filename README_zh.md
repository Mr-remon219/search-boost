# SearchBoost

**面向 AI Coding Agent 的多引擎网络搜索与证据聚合工具箱**  
*一个核心代码库，深度适配 MCP、Pi 与 DeepSeek Harness 三大生态*

[![version](https://img.shields.io/badge/version-v0.2.1-orange?style=flat-square)](#)
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

> **v0.2.1 修复内容**：修复 Pi 网络适配、配置保护、更新进程清理、网页版本缓存和 Jev 统计/限流，并新增 Vercel Jev 适配。该版本尚未发布到 npm；`@latest` 不保证包含这些修复。当前交付范围见 [v0.2.1 交付冻结说明](./docs/v0.2.1-delivery.md)，此前修复见 [修复与验收记录](./docs/v0.2.1-repair-audit.md)。

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
- [安全](#安全)
- [CLI 命令参考（自动化与进阶）](#cli-命令参考自动化与进阶)
- [源码安装与本地开发](#源码安装与本地开发)
- [友情链接](#友情链接)
- [开源协议](#开源协议)

---

## 核心特性

- **多引擎并行检索与去重 (`fused_search`)**  
  同时聚合多个搜索引擎的实时结果。内置**免密钥免费池**（Bing、DuckDuckGo、Yahoo、Exa-free）与**高质量 API 池**（Tavily、Brave、Exa），自动执行跨引擎 URL 规范化去重、域名过滤与权重重排。
- **高净度网页正文提取 (`fetch_page`)**  
  优先抓取原站降低等待；必要时使用同线路 curl 兼容兜底，Jina Reader 作为备用读取方式。自动剔除 CSS、JS 及广告噪音，支持 `focus` 关键词段落提炼，具备内存缓存与大体积熔断保护。
- **X / Twitter 社区情报检索 (`x_search`)**  
  支持通过官方 xAI API 或免登录回退通道获取推文、作者动态与讨论串。基于 Snowflake ID 逆向还原精准发布时间戳，本地执行作者与日期范围过滤，杜绝幻觉。
- **Jev 辅助自适应证据闭环 (`adaptive_search` · 实验功能)**  
  输入任务背景、关键词和验收问题，每轮最多三次 Jev 调用：规划、评分、覆盖验收。只输出 Jev 认可的 URL、标题和简介，支持游标分页，不设固定的累计结果条数上限；检索仍受时间和请求预算约束。
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
| **API keys / Search layer** | 管理 Tavily、Brave、Exa 等付费引擎密钥，以及 AnySearch 密钥（free 匿名、api 带 key、hybrid 优先已配置 key），切换默认搜索层 (`free` / `api`)。 |
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
| `adaptive_search` | **实验功能**：由 Jev 驱动的自动多轮追问与碎片评测 | 返回认可的 URL 与简介；模型认可不等于独立事实核查 |
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

### 4. `adaptive_search` Jev 自适应证据链（实验功能）

**Vercel 接入**：在 TUI → Jev credentials 填写 `https://ai-gateway.vercel.sh/v1` 和 Vercel AI Gateway Key。系统自动选择官方 SDK 的 `typesafe-ai/jev` 评估接口；不要使用聊天补全端点。默认 TypeSafe `/systemone` 保持兼容。两条路径都只使用用户级配置中的 Jev Key，不读取环境变量；服务端限流等待不会被缩短。

调用方准备任务背景、关键词同义词和明确的验收问题。Jev 选择查询与引擎，系统检索、去重、清洗，然后 Jev 评分并判断哪些目标还需要继续。每轮最多三次逻辑调用，不按 URL 单独调用。

```json
{
  "tasks": [{
    "context": "ExampleDB 4.2 升级影响",
    "targets": [{
      "id": "migration",
      "keywords": ["migration guide", "升级指南"],
      "question": "从 4.1 升级到 4.2 需要做哪些迁移？"
    }]
  }],
  "page_size": 20
}
```

- 最多 6 个任务、每任务 4 个目标、总计 12 个目标；兼容旧 `questions` 输入。
- `results` 是扁平的 `{url, title, description}` 列表，只包含已经评估并认可的材料，不包含待评估或被排除的候选。
- 用 `{"cursor":"<nextCursor>"}` 读取后续页，不重新检索，也不调用 Jev。单页默认 20 条、最多 50 条，并有字节预算；累计认可结果不设固定条数上限。
- `coverageComplete` 和警告说明检索是否满足目标。读完分页不等于搜遍全网；Jev 认可不等于事实已经独立核实。
- 结果在当前服务进程中暂存，最多保留 30 分钟、32 次最近结果；过期、被淘汰或重启后游标失效。
- 时间敏感任务可设置 `time_range`，分别约束文章发布时间或事件时间；未知日期不计入“今日”证据。

完整输入输出、执行边界与已知限制见 [Jev 自适应搜索说明](./docs/jev-adaptive-search.md)。

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
