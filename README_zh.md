<p align="center">
  <img src="./assets/banner.png" alt="SearchBoost" width="860">
</p>

<p align="center">
  <strong>面向 AI Coding Agent 的多引擎网络搜索与证据聚合工具箱</strong><br>
  <em>一个核心代码库，深度适配 MCP、Pi 与 DeepSeek Harness 三大生态</em>
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
> **版本与发布说明**：以往的 `pi-search-boost` 与 `dsh-search-boost` 已合并为单一代码库，统一维护在 `lib/` 核心层中。文档中包含 `@latest` 的命令指向 npm 正式发布的版本；如需验证尚未进入正式发布的代码，请检出你所需的分支或标签，并参考[源码安装与本地开发](#源码安装与本地开发)。

---

> **v0.2.5-beta1**：统一专用判断适配器 Jev / 自部署 Laya、命名配置、真实 Schema V6 身份及兼容的私有快照恢复。详见[发布、配置与容量证据说明](./docs/v0.2.5-release.md)。Laya 要求完整诊断与固定版本离线题头容量证据；已注册不等于服务已联通或质量已验证。源码版本不代表 npm 已发布；`@latest` 以实际 registry 为准。

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
  - [4. `adaptive_search` Jev / Laya 意图导向搜索（实验功能）](#4-adaptive_search-jev--laya-意图导向搜索实验功能)
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
  同时聚合多个搜索引擎的实时结果。内置**免密钥免费池**（Bing、DuckDuckGo、Exa-free、AnySearch）与**API 池**（Tavily、Brave、Exa、AnySearch、TinyFish），自动执行跨引擎 URL 规范化去重、域名过滤与权重重排。
- **高净度网页正文提取 (`fetch_page`)**  
  优先抓取原站降低等待；必要时使用同线路 curl 兼容兜底，Jina Reader 作为备用读取方式。自动剔除 CSS、JS 及广告噪音，支持 `focus` 关键词段落提炼，具备内存缓存与大体积熔断保护。
- **X / Twitter 社区情报检索 (`x_search`)**  
  支持通过官方 xAI API 或免登录回退通道获取推文、作者动态与讨论串。根据可核验的 Snowflake ID 推导 UTC 发布时间，仅在元数据可核验时执行作者与日期过滤。覆盖可能不完整、过时或为空；检索样本不能代表全平台舆论。
- **Jev / Laya 意图导向搜索 (`adaptive_search` · 实验功能)**
  提供一个完整问题与必填研究方向。检索前一次判断模型策略请求选择固定排序预设，并在省略 community 时决定是否追加既有社区支路；随后对有界 fused 快照（目标≤10 时最多 32 条，更大目标按原余量比例扩至最高 160 条）做固定选项筛选（安全、原型价值 3/4/5、来源折扣）。没有关键词规划、没有逐材料 constraints 门槛、没有语言校验、没有自动补读，也没有自设的累计预算停止；cursor 与 saved_result_id 只重放已保存结果。不宣称答案已核实或完整。
- **原生多智能体并行研究工作流**  
  随包提供 `search-boost` 与 `search-boost-parallel-research` Skills。在支持子代理的宿主（如 Cursor、Claude Code、Pi、DSH）中，可将复杂调研拆分为多路 Searcher（抓取证据）与 Summarizer（无工具综合），提供 Fast 与 Complex 两种研究波次。
- **统一架构，全宿主覆盖**  
  单一核心运行时（Host-neutral Core Runtime），向上提供通用的 Model Context Protocol (MCP) 标准服务，同时深度定制 Pi 原生扩展与 DeepSeek Harness (DSH) 原生插件包。
- **开箱即用与严苛安全策略**  
  **无需配置任何 API Key** 即可直接使用免费引擎池；敏感凭证以明文存储于本地受限权限配置文件（POSIX `0600`），不等于静态加密；网络访问交给本机网络和代理，保留请求边界与明确的失败兜底，严禁向模型上下文泄露凭证。

---

## 系统架构

SearchBoost 采用“**单核三适配**”设计，所有搜索算法、分词、抓取策略、去重逻辑与网络安全防护均统一收拢于核心层：

```text
                    SearchBoost TUI / CLI
                      安装 · 配置 · 刷新
                              │
                    Shared SearchBoost Core
                     lib/runtime.mjs 核心门面
               搜索 · 抓取 · X · Jev / Laya 意图导向搜索
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

- **Core (`lib/`)**：宿主无关的算法与网络引擎，负责引擎调用、数据清洗、专用判断适配器协议交互及安全策略。
- **Adapters (`adapters/`)**：负责将核心能力翻译为具体协议（MCP JSON-RPC、Pi Extension API、DSH Cordis 生命周期）。
- **Agents (`agents/`)**：受控提示词、工作流模板与原生 Skills 定义。面向 Agent 的工具选择与分层职责见[提示词职责契约](docs/prompt-contract.md)及 [beta.8 发布说明](docs/v0.2.4-beta.8-release.md)。

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
> **零 Key 即可起步**：SearchBoost 默认提供免费引擎池（Bing、DuckDuckGo、Exa-free、AnySearch）。无需注册付费服务即可开始检索；实际可用性与结果覆盖取决于引擎及本机网络。

### 2. 三步完成配置
1. 在默认平铺 TUI 首页选择 **首次配置向导**（文件夹模式：安装与接入 → 首次配置向导），跟随向导配置搜索引擎（可选填 API Key，或直接跳过使用免费池）。
2. 勾选需要接入的 Agent（如 Cursor、Claude Code、Pi 等），确认是否自动设置免审批权限与替换原生搜索。
3. 重启或重新载入对应的 Agent，即可在对话中直接让模型进行网络检索！

---

## 升级与迁移指南

### 1. 日常更新：npm 更新软件包，再刷新接入

以下命令适用于 v0.2.4。在该版本发布前，`@latest` 可能仍安装不支持 `refresh` / `research` 的旧版；可先按下文从 v0.2.4 源码运行。软件包更新交给 npm；TUI 不再提供自更新功能。安装、刷新与卸载统一位于 **管理 Agent 接入**（文件夹模式：安装与接入 → 管理 Agent 接入）。

```bash
npm install -g search-boost@latest --prefer-online
search-boost
# → 管理 Agent 接入 → 刷新已有接入 → 选择实际范围
# 或刷新全部已有接入：
search-boost refresh -y
# 只预览：
search-boost refresh --dry-run
```

刷新只使用当前软件包，保留凭据、权限、禁用状态及无关配置，不安装未接入的宿主。取消勾选表示本次不处理，不表示卸载。旧 `upgrade` / `--sync-only` 已移除。

Grok 本地缓存若原生更新后仍陈旧，需要完全退出 Grok，再独立确认保留数据重建和对当前源的信任。`-y` 本身不授予重建同意；显式 CLI 同意为 `search-boost refresh -y --repair-grok-cache`。这会请求宿主 `uninstall --keep-data` 后 `install --trust`，不保证旧名称数据自动迁移。成功后重启宿主。详见 [接入刷新](docs/host-upgrades.md)。

---

### 2. 从旧全局包 `search-boost-mcp` 迁移

> [!IMPORTANT]
> 如果你的全局环境中仍安装着旧包名 `search-boost-mcp`，由于 npm 不允许不同名包互相覆盖全局同名 bin 命令，**必须使用一次性 npx 命令平滑交接**。下方的刷新步骤需要 v0.2.4 或更新版本：

```bash
# 一次性旧全局包更名迁移；不代替日常更新或接入刷新
npx --yes --package=search-boost@latest -- search-boost migrate -y

# v0.2.4 及后续版本：先更新软件包，再刷新接入
npm install -g search-boost@latest --prefer-online
search-boost
# -> 管理 Agent 接入 → 刷新已有接入（或 search-boost refresh -y）
```

---

## 交互式控制台 (TUI)

直接在终端执行 `search-boost` 即可进入基于 Clack 的交互式控制面板。可在此管理宿主接入、搜索配置与凭据；软件包本身仍通过 npm 更新：

默认**平铺首页**按以下顺序直接提供全部入口：

| 首页入口 | 行为 |
| :--- | :--- |
| 首次配置向导；管理 Agent 接入；查看当前状态 | 连续首次配置；安装 / 按范围刷新 / 确认卸载；只读状态 |
| 搜索引擎配置；默认搜索层；工具开关 | 任选引擎；`free` / `api`；MCP / Pi / DSH 共用开关 |
| X 凭据；判断模型（Jev / Laya） | 脱敏凭据管理 |
| 原生搜索替换；输出 MCP 配置片段 | 保留权限选择；只读片段 |
| TUI 设置；退出 | 菜单布局位于显示语言之前；关闭控制台 |

「TUI 设置 → 菜单布局」可选平铺 / 文件夹。文件夹模式保留安装与接入、搜索与工具、服务与凭据、状态分类。操作完成后，平铺模式返回首页原选中项，文件夹模式返回所属分类；Esc 取消 / 返回，Ctrl+C 退出。切换布局立即返回新首页。管理操作完成后返回管理子菜单；交互式卸载和 Grok 缓存重建默认取消，部分失败不会被显示成安装成功。

布局和显示语言切换立即生效，保存于 `~/.search-boost/config/tui.json`（或 `$SEARCH_BOOST_HOME/config/tui.json`）。未保存布局（包括仅有语言的旧设置）默认平铺；未保存语言时，中文系统环境使用简体中文，其他环境使用 English。偏好同样适用于独立启动的交互式 setup/config 向导，不影响非交互 CLI 输出、搜索结果或 Agent 回复。工具名、命令、路径、MCP 配置片段与底层原始错误保持原样。dry-run 只预览布局 / 语言，不保存；设置损坏时告警且不覆盖。详见 [TUI 导航与语言设置](docs/tui.md)。

### 工具开关

进入 **工具开关**（文件夹模式：搜索与工具 → 工具开关），空格勾选，回车查看变更并确认保存。Esc 或取消确认不写入配置；允许全部关闭。未配置判断模型时，`adaptive_search` 在状态面板中显示删除线和锁定原因，不进入可选列表。配置判断模型后默认可用，但此前明确关闭的偏好不会被覆盖。

开关统一保存于 `~/.search-boost/config/tools.json`（或 `$SEARCH_BOOST_HOME/config/tools.json`），采用文件锁和原子写入。加载新版适配器后无需重启、重装宿主：

- **MCP**：约 300ms 内刷新工具列表并发送 `tools/list_changed`；忽略通知的客户端可能需要重连。
- **Pi**：约 300ms 内更新活跃工具，保留其他插件工具和原本被宿主排除的工具；会话结束时清理监听。
- **DSH**：保留注册但立即拒绝关闭工具的新调用；原生搜索/抓取 provider 也遵守对应开关。

每次调用都会重新检查开关，旧工具句柄也不能绕过；正在执行的请求正常完成。选中判断模型配置不可用会锁定 adaptive 调用（包括分页和保存结果恢复），恢复配置不覆盖明确关闭的偏好。这里开关的是**工具入口**，不是底层引擎权限：已开启的 adaptive 只筛选一次内部融合快照，不自动抓取页面，融合搜索的 community 模式仍可内部检索 X。Pi/DSH 的 searcher 波次还要求共享 fused_search、fetch_page 入口及 DSH 范围内工具可用：初始依赖关闭时零派发，每个子进程启动前再次检查；已启动子任务正常完成，无工具 summarizer 不受这两个依赖限制。检查不自动启用工具、不扩大权限。Slash 命令保留用于恢复配置。正在运行旧适配器代码的进程需先更新/重载一次；各宿主需使用同一 SearchBoost 配置目录。

---

## 工具箱与使用指南

安装完成后，宿主中的 Agent 会自动获得以下标准化工具。Agent 会根据用户提问自主决定调用时机。

### 工具职责与边界

| 工具名称 | 适用场景 | 职责边界（不适用的场景） |
| :--- | :--- | :--- |
| `fused_search` | 多引擎多角度并行查询、结果合并与去重排序 | 仅完成单次搜索；后续是否需要继续检索由主 Agent 判断 |
| `fetch_page` | 读取已知公开 URL 的完整正文或特定关注段落 | 不是带登录态的浏览器；仍遵守本机网络与代理策略 |
| `x_search` | 检索 X 平台的公开推文、博主资料或单篇讨论串 | 不承诺完整抓取所有回复，无法代表全平台完整舆论倾向 |
| `adaptive_search` | **实验功能**：对单个问题与必填研究方向进行单次快照筛选 | 返回选中 URL、审查摘录与价值标签；targetMet 只表示数量，不代表答案已核实 |
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

- **`engine_pool`**：`free`（免密钥免费池）、`api`（已配置的 API 引擎）、`hybrid`（两池合并）。不可用或已关闭的引擎会跳过。省略时按兼容层映射：`free` → 免费池，`api` → hybrid。
- **`ranking`**：最终引擎权重预设：`balanced`（默认）、`research`、`fresh`。不改变查询变体、检索深度或时间过滤，也不证明来源权威性或时效性。
- **`complexity`**：`simple`（1 组查询变体）、`medium`（最多 2 组变体）、`complex`（最多 3 组深度变体）。
- **`community`**：布尔值（默认 `false`）。设为 `true` 时会将 X 社区一手开发者的讨论混入结果限额中。

---

### 2. `fetch_page` 智能网页提炼

获取搜索结果中的链接正文。优先抓取原站并清理正文；PDF 会先在本地抽取正文，抽取不到时才回退到 Jina Reader；安装了 curl 时可用于传输兼容兜底。

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
- **`offset`（可选）**：长正文按有界窗口返回（默认 60000 字符）。结果中的 `totalChars` 与 `nextOffset` 说明是否还有后续内容，把 `nextOffset` 传给 `offset` 即可继续读；续读命中 24 小时缓存，不会再次请求网络。
  > [!TIP]
  > 二进制响应（图片、压缩包、无法解析的 PDF）会明确报错，不会当作网页正文交给模型。

---

### 3. `x_search` X (Twitter) 动态检索

专为技术追踪与一手动态设计。支持关键字检索、用户时间线（User 模式）与推文讨论串（Thread 模式）。

**调用参数范例**：
```json
{
  "query": "Claude 3.7 Sonnet hybrid reasoning from:AnthropicAI",
  "type": "keyword",
  "max_results": 5
}
```

- **时间戳推导**：平台元数据缺失或不一致时，可根据有效的 Snowflake 推文 ID 推导 UTC 创建时间；这不核实推文内容。
- **过滤条件**：keyword 模式接受 `from:username`、`since:YYYY-MM-DD`、`until:YYYY-MM-DD` 等 X 操作符；显式日期范围可用 `from_date` / `to_date`。应用作者或日期过滤时，无法核验相应元数据的候选会被省略。

---

### 4. `adaptive_search` Jev / Laya 意图导向搜索（实验功能）

**Vercel 接入**：在 TUI → 判断模型（Jev / Laya）（文件夹模式：服务与凭据 → 判断模型）填写 `https://ai-gateway.vercel.sh/v1` 和 Vercel AI Gateway Key。系统自动选择官方 SDK 的 `typesafe-ai/jev` 评估接口；不要使用聊天补全端点。默认 TypeSafe `/systemone` 保持兼容。两条路径都只使用用户级选中判断模型配置中的 Key，不读取环境变量；服务端限流等待不会被缩短。

**Laya 接入**：在同一 TUI 新增自部署 profile，明确选择模型与可选认证；无 Key 时不发送空 Bearer，预算留空沿用服务默认值。诊断缺失、截断、选项坍缩、弃答或缺少离线题头容量证据时，判断保持不可用，不把残存选项当作通过。详见[容量证据与迁移](docs/v0.2.5-release.md)。新运行用 `run.judgment` 记录真实提供方，旧记录不静默升级。

调用方提供**一个问题**（`questions` 恰好一项）、**必填的研究方向 `intent`** 以及 0-8 条可选软偏好 `preferences`。工具描述要求用英文书写，但这是给调用方的提示，服务端不做语言校验、拒绝或翻译，任何语言都按原文检索。原文问题就是唯一查询：不再规划关键词、不做查询扩展。检索前的一次判断模型策略请求选择固定 `balanced`/`research`/`fresh` 排序，并在省略 `community` 时决定是否启用既有社区（X）支路；显式 `community` true/false 覆盖该选择，且不重复提问。随后这次 fused 调用收集**有界快照：目标≤10 时最多 32 条，更大目标为 ceil(max_results×32/10)，最高 160 条**（网页与社区行共用），每条声明候选都以固定选项判断：安全 clear/violation/unavailable、原型价值 0-5、来自真实正贡献引擎的来源折扣，以及每条偏好一次匹配。只有安全且价值已建立为 3/4/5 的材料会被交付，并按版本化筛选公式排序；置信度仅用于审计。不会在凑够前若干条可接受链接后提前停止，没有自动补读，也没有自设的累计成本、token、请求次数或整次时限停止——真实单请求超时、有限重试、认证/限流失败、安全拒绝与显式取消照常生效。

```json
{
  "questions": ["ExampleDB 从 4.1 升级到 4.2 有哪些兼容风险？"],
  "intent": "寻找实际迁移步骤、具体不兼容案例及反证，不需要营销介绍。",
  "preferences": ["官方迁移指南"],
  "max_results": 8,
  "page_size": 3
}
```

- `intent` 为必填（不再由问题自动填补），`preferences` 是独立软加分并按键精确去重后取平均。
- `constraints` 已退役为逐材料硬门槛：省略或传 `[]`（返回 `deprecated_constraints_empty` 告警）；非空数组在任何网络调用前以 `adaptive_constraints_removed` 拒绝。请把完整研究方向与条件写进 questions/intent；硬域名限制用 `site:`/`-site:` 或 fused_search 的 `include_domains`/`exclude_domains`，必须满足的文档属性由主 Agent 阅读核验。
- 多问题列表、`tasks/targets/facts/time_range`、`keywords` 与二维关键词都按旧字段拒绝；独立问题请分次调用。
- `max_results` 限制本次选中并保存的数量（默认 10，最大 50）；`page_size` 只影响每页（默认 20，最大 50），不重排、不重新筛选。
- 返回选中材料的 URL、标题、审查摘录、`valueLevel`/`valueLabel`、rank、真实来源与分数组件，不生成答案。`selection.targetMet` 只表示数量，绝不代表研究完成或已核实；`selection.incomplete`、`diagnostics`、`stopReason`、`outsideReview`、`unreviewed` 如实披露未完成部分，而不是当作低价值。
- `run.community` 返回有限的社区决策与实际执行状态（`not_requested`/`domain_excluded`/`unavailable`/`blocked`/`succeeded`/`empty`/`failed`/`partial`/`not_run`），不输出模型推理；社区支路失败或部分失败时仍交付有效网页结果，并把本次标记为 incomplete。
- 用 `{"cursor":"<s6:…>"}`（可附 `page_size`）读取已保存页：不发起新的检索、策略、Jev、社区或价值判断。每页默认 20、最大 50，并有字节预算；cursor 在当前进程内最多保留 30 分钟/32 份结果，翻页结束不等于穷尽检索。
- 显式 `save_results:true` 时，完整的最终选中集与类型化元数据会私有保存到 SearchBoost home（`search-boost-research-v3`，schema version 6），并返回 `savedResultId`。重启或清缓存后用 `{"saved_result_id":"<savedResultId>"}`（可附 `page_size`）读取，不再重新检索或询问 Jev。旧 v2/schema-5 文件不升级，继续按原合同及 `s5:` 读取；旧的 `search-boost-research-v1` 文件继续可读，进入带标记的只读 `h1:` 历史分支（`restoration.historical: true`，保留原 schema 版本，不伪造 v5 字段）。公开工具开关与判断模型配置锁同样作用于读取；`search-boost research list` / `research export <id> --output <new-file.json>` 无需 Jev、可离线使用。参见[接入与验收边界](docs/research-status-acceptance.md)。
- 阈值仍是未标定工程起点。完整契约、预算和迁移说明见 [Jev 单问题研究检索](docs/jev-adaptive-search.md)。

---

### 引擎池与评分预设

`engine_pool` 选择调用集合，`ranking` 选择跨池共享权重；`complexity` 控制查询广度与深度，不改变评分权重。AnySearch 是单一逻辑引擎：free 匿名、api 要求 key、hybrid 优先用已配置 key。使用 `ANYSEARCH_API_KEY` 或 `config keys --set anysearch=KEY` 配置。

TinyFish Search 是需要 key 的 API 引擎：使用 `TINYFISH_API_KEY` 或 `config keys --set tinyfish=KEY` 配置，默认加入 api/hybrid，不加入 free 池（显式 `engines` 仍可覆盖池选择）。Search 在钱包 $0 时仍零费用，当前限额为 30 请求/分钟、500 请求/小时，每个查询变体各计一次；不自动翻页或启用内嵌 Fetch。请求沿用服务默认 US/en 地区/语言。Yahoo 已移除，显式 Yahoo 引擎/权重输入会被拒绝。

| 引擎 | balanced | research | fresh |
| --- | ---: | ---: | ---: |
| bing | 0.957 | 0.927 | 1.020 |
| ddg | 0.589 | 0.542 | 0.556 |
| exa-free | 1.004 | 1.085 | 0.951 |
| tavily | 1.049 | 1.105 | 1.084 |
| brave | 1.004 | 0.951 | 1.125 |
| exa | 1.049 | 1.146 | 1.063 |
| anysearch | 1.004 | 1.042 | 0.951 |
| tinyfish | 1.000 | 1.000 | 1.000 |

权重是未经实测标注校准的冷启动默认值。DDG 使用此前权重的 60%，TinyFish 从中性权重开始，其他默认值保持不变，不重新归一化。`consensus-v2.1` 使用原始排名、相关来源组折扣和 max+log 共识，元数据修正最多 20%；质量分与列表选择分分离。零权重不投票，旧 `min_score` 阈值需重新校准。详见 [评分设计与迁移](docs/fusion-scoring.md) 和 [引擎池](docs/search-routing.md)。

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

安装到 MCP 宿主时还会同时安装配套的 **`search-boost`** 路由 Skill，用于可选工作流。普通工具选择直接依据已注册的描述与 schema，不需要先加载 Skill。

- **Fast 模式**：只跑一波 Searcher，随后由主 Agent 收敛，不启动 Summarizer，也不补第二波。
- **Complex 模式**：1~3 波，波次之间做证据缺口复核；只有存在实质性缺口时才追加下一波，证据足够就提前停止。需注意：波次上限是提示词层面的工作流约束，不是跨独立工具调用的全局配额。
- **派生能力缺失**：允许联网且用户不严格要求并行时，可由主 Agent 串行调研并披露该选择。权限拒绝或运行时失败应报告阻塞，不授权静默换机制。

> [!IMPORTANT]
> 子代理返回 `ok` 只代表执行完成且文本非空，**不代表结论已被证实**。失败或部分完成的报告仍会保留可见，但其 URL 不计入成功聚合；最终判断始终由主 Agent 负责。

Pi/DSH 子代理工具加载、旧 `pi-search-boost` 路径与已移除的 `deep_research` 排查，见[子代理工具配置与诊断](docs/subagent-tools.md)。

---

## 安全

### 自定义搜索 API 地址

TUI 默认首页进入 **搜索引擎配置**（文件夹模式：服务与凭据），每个引擎同时显示密钥掩码、当前 Base URL 和 default/custom 标记。选择 **Set / replace Base URL** 修改地址后，可继续保留或修改密钥；**Restore default Base URL** 只恢复地址。可任选单个引擎，无须依次经过所有凭据项；保留其他引擎的密钥与路由选择。状态页和 `config keys --show` 也会显示生效地址。独立 CLI `search-boost config keys` 和首次配置仍保留逐项引导。

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
| TinyFish Search | `https://api.search.tinyfish.ai` | `/` |

填写 API 基础地址，**不要填写完整搜索端点**；网关路径前缀会保留。地址存放在 keys 文件的 `engines.<name>.baseUrl`，兼容现有密钥字符串和路由开关。请仅使用可信、兼容对应引擎 API 的网关：搜索词与已配置密钥会发送到该地址（AnySearch 在 free 池仍不发送密钥）。推荐 HTTPS，也支持本地网关的 HTTP；拒绝包含用户名密码、查询参数或片段的地址。不影响 Exa-free；地址变更后不会复用旧地址的搜索缓存。

API Key 存放在由 SearchBoost 自己管理的凭据文件中，不写入提示词、工具结果或 shell 配置：

- **文件权限**：密钥存放在 `~/.search-boost/config/keys.json`（可用 `SEARCH_BOOST_HOME` 重定向根目录）。在 POSIX 系统上目录为 `0700`、文件为 `0600`；覆盖写入时先生成全新的 `0600` 临时文件再改名替换，已存在的文件不会被放宽权限。同一根目录下的备份与升级状态同样为 `0600`。环境变量指定的自定义目录会保留其原有权限，但凭据文件仍以 `0600` 创建。Windows 没有 POSIX 权限位，由 ACL 继承决定。
- **原子写入与加锁**：写入使用 `O_EXCL` 临时文件加改名替换，读取方只会看到旧文件或新文件，不会读到写了一半的内容；写入失败会自行清理临时文件并保留原文件。读改写流程持有独占锁，两个写入者不会静默互相覆盖，被拒绝的修改也不会触碰原文件。
- **不回显**：API Key 只在调用所属引擎时随请求发送（Tavily、Brave、Exa、AnySearch、TinyFish 的请求参数或请求头）。状态输出、`search-boost config keys --show` 与 doctor 报告只显示掩码（`abcd****wxyz`）；错误信息经过测试不会包含凭据内容，Jev 评测请求中也不含 Key、掩码 Key 或指纹。AnySearch 已参与引擎路由：free 使用匿名额度，api 要求 key，hybrid 优先使用已配置 key；同次融合只计一票。


---

## CLI 命令参考（自动化与进阶）

以下 CLI 参考对应 v0.2.4；`refresh` 与 `research` 需要该版本或更新版本。源码合并不等于 npm 发布，在所需版本发布前请从源码运行。

**DeepSeek Harness Desktop**：交互安装选中 DSH 后，可选择 Desktop / CLI / All，再为 Desktop 选择 **自动安装（默认）** 或 **本地目录接入**。自动方式通过注册表（含自定义安装目录）、默认目录及 PATH 找到桌面版内置命令；先启动一次再完全退出（包括托盘）。本地方式在其他接入（包括 Grok）结束后，最后显示当前包的完整持久目录，由用户粘贴到运行中的 Desktop「插件 → 添加插件」；TUI 等待只读检测，稳定完成后结束，Esc / Ctrl+C 或超时则报告未完成并保留其他结果。检测到保存的安装不代表运行中的插件已加载；没有内置启动器时会明确提示运行时未验证。临时 `_npx` 缓存不能作为本地链接来源。也可直接在应用输入 `search-boost` 从 npm 安装。自动安装/更新仍验证宿主解析器，遮蔽副本不能报成功；禁用状态保留，`--enable-dsh-bundle` 明确要求启用（本地方式由用户在 Desktop 启用）。所有权与验证限制见 [Desktop 接入说明](docs/dsh-desktop.md)。

```bash
# ----------------- 启动与基础 -----------------
search-boost                                # 打开交互式控制面板 (TUI)
search-boost status                         # 只读磁盘/配置证据；运行中宿主版本仍未知
search-boost status --json                  # 结构化安装证据
search-boost research list                  # 列出显式保存的私有研究结果
search-boost research export <id> --output <new-file.json> # 显式导出，不覆盖
search-boost --help                         # 查看完整命令行帮助文档
search-boost refresh --dry-run              # 预览已有接入刷新
search-boost refresh -y                     # 使用当前包刷新全部已有接入
search-boost migrate --dry-run              # 预览旧全局包更名迁移

# ----------------- 非交互式安装 -----------------
search-boost install -t cursor -y           # 为 Cursor 安装并自动同意权限
search-boost install -t claude,codex --keep-native  # 安装并保留宿主原生搜索
search-boost install -t antigravity --workspace /path/to/project # 为指定工作区配置
search-boost install -t antigravity -y --antigravity-config legacy # 显式兼容旧宿主；modern 切回现代路径
search-boost install -t pi -y               # 为 Pi 挂载原生扩展及提示词
search-boost install -t dsh --profile web   # 为 DeepSeek Harness CLI 接入 web profile
search-boost install -t dsh --dsh-surface desktop -y # Desktop 原生命令 + 本地包接入
search-boost install -t dsh --dsh-surface all -y     # Desktop 与 CLI 分别安装
# 无需全局安装 search-boost / dsh / pnpm（Windows、Linux、macOS）：
npx --yes search-boost@latest install -t dsh --profile web -y
search-boost install -t cursor --dry-run    # 仅演练安装过程，不写磁盘

# ----------------- 凭据与配置管理 -----------------
search-boost config keys                    # 命令行配置/查看搜索引擎 Keys
search-boost config keys --set anysearch=KEY  # 配置 AnySearch 密钥（ANYSEARCH_API_KEY）
search-boost config keys --set tinyfish=KEY   # 配置 TinyFish Search（TINYFISH_API_KEY）
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
- 可选：**`pdfjs-dist`**（optionalDependency），在本地把 PDF 抽取为正文；未安装时 PDF 读取回退到 Jina Reader

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
| `npm run prepublishOnly` | 语法与 CI 策略检查、精确依赖锁审计（需要 registry 联网），再运行全部隔离回归入口，含生成资产、安装 / 刷新 / 迁移、搜索、适配器与 MCP |
| `npm run test:network` | 代理重试、curl 兜底、请求边界与兼容性回归 |
| `npm run test:adapters` | MCP / Pi / DSH 适配器协议测试，以及 Pi 子代理配置迁移诊断 |
| `npm run test:parallel` | Searcher/Summarizer 契约、DSH 派发预检、取消与工具隔离 |
| `npm run test:adaptive` | 单次快照 V6 筛选（保留 V5 历史读取）、候选容量边界及 MCP / Pi / DSH 适配器夹具（非真实宿主会话） |
| `npm run smoke` | MCP JSON-RPC 协议冒烟测试 |

回归套件使用隔离状态、本地回环夹具与进程替身，不需要真实引擎 Key；依赖审计需要访问 registry。`npm run prepublishOnly` 全绿是本地 PR 门禁，不证明真实宿主加载、付费服务行为或证据质量。

---

## 友情链接

- [LINUX DO](https://linux.do/)

---

## 开源协议

本项目基于 [MIT License](./LICENSE) 协议开源。
