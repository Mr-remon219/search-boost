# SearchBoost

**面向 Coding Agent 的多引擎网络证据工具：一个核心，三种适配。**

SearchBoost 提供网页搜索、页面读取、X/Twitter 检索，以及可选的 Jev 辅助证据收集。它负责合并搜索结果、去重，并报告实际使用的引擎、证据和警告；Agent 仍然决定调查什么、是否继续，以及如何形成最终答案。

[English](./README.md) · [搜索路由](./docs/search-routing.md) · [迁移说明](./docs/migration.md) · [宿主升级](./docs/host-upgrades.md)

```text
                   SearchBoost CLI / TUI
                     安装 · 配置 · 更新
                              │
                     共用 SearchBoost Core
                   搜索 · 抓取 · X · 自适应证据
                              │
              ┌───────────────┼───────────────┐
              MCP             Pi              DSH
              stdio 服务      原生扩展        原生插件包
```

原来的 `pi-search-boost`、`dsh-search-boost` 已整合到本仓库。搜索算法统一维护在 `lib/`，而不是维护三份实现。MCP 接入 Cursor / Cursor CLI、Codex、Claude Code、Grok Build 和 Antigravity；Pi、DeepSeek Harness 使用各自的原生适配层。

> **发布准备说明：** `v0.2.0` 分支不等于 npm 已发布版本。下面包含 `@latest` 的命令获取的是已发布包，不会自动跟随 Git 分支。统一版本尚未发布时，请按[源码安装](#源码安装)体验本分支；合并 PR 不会自动发布 npm。

## 快速开始

需要 **Node.js 22.13 或以上版本**以及 npm。先安装，再由向导配置引擎和你选择的宿主：

```bash
npm install -g search-boost
search-boost setup
search-boost doctor
```

免费引擎池不需要 API Key。安装后重启或重新加载相关 Agent，使工具和提示词资产生效。

已经配置好密钥时，也可以直接安装指定宿主：

```bash
search-boost install -t cursor --keep-native
search-boost install -t codex,claude --keep-native
search-boost install -t pi -y
search-boost install -t dsh -y --profile web
search-boost install -t antigravity --workspace /path/to/project --keep-native
```

**自动化前注意安装参数：** `-y` 会跳过向导，并隐含 `--auto-allow` 和 `--replace-native`。只指定 `-t`、不加 `-y`，同样属于非交互安装且默认替换原生搜索，但**不会**隐含自动批准。`--keep-native` 保留原生搜索；需要宿主继续弹出权限确认时，不要加 `--auto-allow`。实际修改取决于宿主支持的配置能力。

```bash
search-boost install -t cursor --dry-run --keep-native
search-boost status
search-boost print codex
```

支持的操作使用 `--dry-run` 可以只预览、不写入；`print` 只打印 MCP 配置片段，不执行安装。完整命令参考见 `search-boost --help`。

### 各宿主的接入方式

| 宿主 | 安装内容与检查方法 |
| --- | --- |
| Cursor / Cursor CLI | MCP 条目位于 `~/.cursor/mcp.json`；检查 `search-boost` 是否连接成功。 |
| Codex / Claude Code | MCP 工具以及对应提示词/skill；重启后确认工具可见。 |
| Grok Build | MCP、配置资产，以及存在 `grok` CLI 时安装的插件；`--skip-grok-plugin` 可跳过插件安装。 |
| Antigravity | MCP 和工作区指引；使用 `--workspace` 指定项目。 |
| Pi | 原生扩展、受管理的 searcher/summarizer 定义，以及 `/fast-parallel`、`/complex-parallel` 模板。 |
| DeepSeek Harness | 原生插件包；CLI 安装需要 `dsh` 和 `pnpm`。`--profile` 选择 DSH 配置档，默认 `web`。 |

也支持宿主原生包管理器：

```bash
pi install npm:search-boost
dsh plugin --profile web add search-boost
```

Pi 包清单负责加载扩展；需要完整的角色定义与提示词模板时，使用 `search-boost install -t pi -y`。不要把旧独立适配器与新包重复安装；受管理的更新流程会处理可识别的旧注册。

### 源码安装

使用源码关联安装期间，请保留这个仓库目录，不要将其放在随时清理的临时目录中：

```bash
git clone https://github.com/Mr-remon219/search-boost.git
cd search-boost
git switch v0.2.0
npm ci
npm run plugin:sync-grok
npm install -g .
search-boost setup
```

更新这个工作副本时，拉取目标分支，重新运行 `npm ci` 和 `npm run plugin:sync-grok`，再运行 `search-boost upgrade --sync-only -y` 刷新已安装资产。npm 更新不会自动跟随开发分支。

## 如何使用

在 Agent 对话中使用这些工具。CLI 用于安装、配置和更新，并不提供独立的 `search <query>` 搜索命令。例如：

> 核对这个依赖当前的官方 API 文档，读取相关页面，判断我们的代码是否需要修改。不要改变我的搜索配置。

### 工具之间如何分工

| 工具 | 负责什么 | 不负责什么 / 使用边界 |
| --- | --- | --- |
| `fused_search` | 单点查询或少量不同角度的网络搜索，合并、去重和排序。 | 一次搜索操作；后续是否继续由主 Agent 决定。 |
| `fetch_page` | 读取已知公开 URL，可用 `focus` 保留匹配段落。 | 不是登录浏览器，也不是内网访问工具。 |
| `x_search` | 获取可用的 X 帖子、账号资料或线程材料。 | 不保证实时、完整；样本不代表平台总体情绪。 |
| `adaptive_search` | 可选的自动补充检索与逐题证据判断，使用 Jev。 | 不是子代理调度器、最终答案生成器或独立事实核验器。 |
| `search_layer` | MCP 中查看或修改兼容默认层。 | `show` 只读；`free` / `api` 会持久化修改，需要授权。 |
| `search_stats` | MCP/DSH 中只读查看引擎、缓存和近期活动。 | 配置就绪不等于网络已经连通。 |

Pi 的相应宿主控制命令是 `/web_change`、`/search-audit`；DSH 使用 `/web_change` 修改层。不要假定所有宿主都具有相同的命令名。

下面是 `fused_search` 的**工具参数**示例，不是终端命令：

```json
{
  "query": "AbortSignal.any Node.js documentation",
  "include_domains": ["nodejs.org"],
  "engine_pool": "free",
  "complexity": "simple",
  "max_results": 5
}
```

找到来源后，直接调用 `fetch_page`：

```json
{
  "url": "https://nodejs.org/api/globals.html",
  "focus": "AbortSignal.any"
}
```

`focus` 没有命中不代表页面不存在答案；需要完整上下文时去掉它重读。读取器先使用 Jina，再尝试受保护的本地 HTML 抓取，去除 CSS/JS/广告杂项，并在内存中缓存可用正文。原始响应有大小上限，不承诺抓取任意大小的页面。

### 引擎池、排序与预算

| 参数 | 含义 |
| --- | --- |
| `engine_pool: free` | 无需 Key 的 Bing、DuckDuckGo、Yahoo、Exa-free。 |
| `engine_pool: api` | **仅**使用已配置且启用的 Tavily / Brave / Exa。 |
| `engine_pool: hybrid` | 免费池加上已配置且启用的 API 引擎。 |
| `engines` | 可选的明确引擎选择；缺失或禁用的引擎会被报告，不会自动启用。 |
| `ranking` | `balanced`、`research`、`fresh`，只改变最终引擎权重。 |
| `complexity` | `simple`、`medium`、`complex`，控制搜索预算、变体和深度。 |
| `community` | 将 X/社区材料混入最终结果限额，默认 `false`，按需开启。 |

通常不必手选 `engines`。`engine_weights` 只调整评分，不决定调用哪些引擎。域名参数限制结果；`recency` 偏向较新的已标日期材料，不是对所有结果执行严格日期截断。检查返回的 `enginesUsed`、`effectiveWeights`、`communityUsed` 和 `warnings`。

旧的持久化 **layer** 只保留兼容语义：`free → free` 池，**`api → hybrid`** 池。它与严格的 `engine_pool: api` 不同。一次搜索优先用参数控制，不要随意改变用户的默认配置。

MCP 在 `search-boost://capabilities` 提供动态配置状态；Pi、DSH 将同一份计算结果注入宿主提示词。可选的 `search-boost://policy` resource 提供示例和限制；调用工具前不必先读取它、调用 `search_routing` 规划 prompt 或加载 skill。

### Jev 辅助证据收集

```bash
search-boost config jev
search-boost config jev --show
```

然后调用 `adaptive_search`：

```json
{
  "questions": [
    "官方文档对这个 API 的取消行为作出了什么保证？",
    "我们依赖的这个行为是从哪个版本开始提供的？"
  ]
}
```

输入为 1–6 个非空问题，每题最多 400 字符。重复问题复用执行，但保留各自输出位置。Jev 选择允许的搜索动作，评估搜索摘要、引擎返回正文和抓取片段；代码负责预算、引擎限制和返回值校验。

每个问题都有独立状态：`covered`、`insufficient`、`unassessed`、`not_searched` 或 `failed`，并附上送审证据与明确缺口。**`covered` 只表示模型认为这些片段足够，不表示事实已经被独立核验。**仍需检查冲突和未满足条件。未配置 Jev 时返回 `not_configured`，不发网络请求；Jev 故障时可能执行一次受限的普通搜索回退，新结果保持未评估。普通搜索、读页和 X 工具不依赖 Jev。

### 可选的并行研究

Pi 的 `search-parallel-subagent`、DSH 的 `research_parallel` 负责运行子代理，不替代主 Agent 的判断。searcher 只使用搜索/读页工具收集材料，summarizer 只看报告、没有工具。fast 模式只运行一波，再由主代理综合；complex 模式增加缺口检查，仅在有实质缺口时继续。

委派必须获授权。Pi 运行器不限制并发数量，由调用方结合任务预算选择合理的任务数。DSH 使用原生 provider，能力缺失会明确失败，而不是偷偷启动 Pi。skill 或工具描述都不能授权绕过运行时故障、权限拒绝或用户取消。

## 配置与隐私

```bash
search-boost config keys           # 搜索引擎密钥及路由
search-boost config layer          # 兼容默认层
search-boost config x              # 可选 X 认证
search-boost config jev            # 可选 Jev 地址与密钥
```

优先通过交互界面输入密钥，避免把真实值放入命令行参数或聊天记录。

运行配置位于 `~/.search-boost/config/`：`keys.json` 保存引擎和 Jev 配置，另有 `layer.json`、`xauth.json`。`SEARCH_BOOST_HOME` 可迁移整个 SearchBoost 目录。旧平铺文件可在首次写入时被接纳；canonical 存储一旦初始化，清空它不会让旧副本重新生效。权威配置损坏会明确报错，不会悄悄用旧文件替代。`enabledEngines: []` 表示有意禁用全部带 Key 引擎；不写该字段则使用已配置且没有单独禁用的引擎。

**Jev 只认配置：** endpoint/key 组合来自 canonical `config/keys.json`。`TYPESAFE_API_KEY`、项目文件、旧适配器文件，以及 `SEARCH_BOOST_KEYS_FILE` 都不能为 Jev 提供凭据。清除 Jev 不会吸收或重新启用环境变量中的 Key。其他 provider 保留其兼容规则：Tavily / Brave / Exa 支持既有的环境变量 Key 回退，X 可使用 `XAI_API_KEY`。Jev 不是搜索引擎，也不能代替搜索引擎的 Key。

私有配置使用原子写入，并在 POSIX 上限制文件权限。文件**不是加密存储**；Windows 上的保护还取决于账户和文件 ACL。不要发布配置文件，也不要在诊断信息中粘贴原始密钥。

搜索问题会发往选定引擎；Jina 会收到待抓取的页面 URL。启用 Jev 后，问题和必要的证据片段会发往配置的 endpoint，默认 `https://api.typesafe.ai/v1`；请求正文不包含引擎 Key 或 fingerprint。核心证据池在内存中，但**宿主可以保存会话和审计历史**。Pi 在其 agent 目录维护 `search-boost-audit.jsonl`，其中包含搜索问题、URL 和活动记录；`/search-audit clear` 只清除该审计，不清除宿主对话历史。

X 认证是可选的。`search-boost config x --import-grok` 复制已有 Grok 登录，`--logout` 删除 SearchBoost 本地副本，不会让 Grok 本身退出。Pi/DSH 另有 `/x-login`、`/x-logout`，它们不是 MCP 的斜杠命令。X 日期上下界按 UTC 自然日包含两端；user 模式筛选近期帖子。无法验证作者、日期或互动量元数据的候选可能被排除。

## 老用户如何更新

### 已经使用 `search-boost`

运行 `search-boost`，进入 TUI 的 **Update**；或执行：

```bash
search-boost upgrade --dry-run
search-boost upgrade -y
```

更新流程检查已发布版本，必要时更新包，并刷新**已经配置的集成**，包括可识别的旧 Pi/DSH 注册。不会给所有“检测到但未配置”的宿主自动安装。宿主禁用状态、模型和权限配置仍由用户控制；出现失败时检查报告，不要默认每个宿主都已完成更新。

```bash
search-boost upgrade --sync-only -y                    # 只刷新已安装资产，不更新 npm 包
search-boost upgrade --workspace /path/to/project -y   # 纳入指定项目
```

发现范围包括已知用户配置、DSH profiles，以及当前、已记录和明确指定的工作区，不是全盘扫描。备份位于 `~/.search-boost/backups/`，更新报告与源码所有权收据位于 `state/last-upgrade.json`、`state/package-sources.json`。仅有过期收据不会重新安装你已移除的集成。完成后重新加载相关宿主。

### 仍在使用 `search-boost-mcp`

统一包发布后，通过新包显式运行迁移代码：

```bash
npx --yes --package=search-boost@latest -- search-boost migrate --dry-run
npx --yes --package=search-boost@latest -- search-boost migrate -y
search-boost upgrade -y
```

`migrate` **只做一次性的全局 npm 包改名迁移**：先安装并验证新包，再卸载旧包，安全处理共用命令名，保持 Agent 配置不变。后续的 **Update / `upgrade`** 才刷新这些集成。不需要发布旧包过渡版本、依靠 `postinstall` 自动迁移，或先盲目卸载旧包。交接失败时，在可回滚的范围内保留旧安装并明确报告。

### 仍在使用独立 Pi/DSH 适配器

安装统一 CLI，再通过 TUI **Update** 或 `search-boost upgrade -y` 更新。宿主升级流程识别受支持的旧注册，刷新原生适配器与资产；`migrate` 不是 Pi/DSH 的迁移命令。源码类型、项目/profile 发现范围、失败重试见[宿主升级说明](./docs/host-upgrades.md)。新工具确认正常后再清理备份。

## 诊断、网络限制与卸载

```bash
search-boost doctor
search-boost doctor --json
search-boost doctor --strict
search-boost status
```

`doctor` 当前执行离线检查。**`--probe` 是预留功能，会报告 pending，不是实时连通性测试。**退出码为：`0` 正常，`1` 失败或 `--strict` 下出现警告，`2` 仅警告。判断 provider 真正可达，需要在宿主中完成一次实际工具调用。

固定服务的传输支持 `HTTP_PROXY`、`HTTPS_PROXY`、`ALL_PROXY` 及小写形式，非空小写值优先；`NO_PROXY` / `no_proxy` 适用于这些服务请求。SOCKS URL 会明确报错，请使用传输层支持的 HTTP/混合代理端口，而不是期待它静默直连。

任意页面的直接回退抓取会解析、校验地址，并将连接固定到校验过的地址；重定向逐跳重新检查。缓存命中和 Jina 路径不要求本机先解析目标页面域名。当前锁定的传输依赖无法在 HTTP 代理后提供等价的目标地址固定，所以设置代理时，本地回退会报告 `proxy_unsupported`，而不是绕过代理；Jina 路径仍可能可用。TUN fake-IP 兼容需要显式设置 `SEARCH_BOOST_TRUSTED_TUN=1`，并信任 TUN 的实际路由，不会默认开启。

搜索失败或为空时，检查返回警告以及 `search_stats` 或宿主审计。DNS、provider 限流、过滤条件和缺 Key 是不同原因；不要因为一次失败就关闭安全检查或修改持久化层。

```bash
search-boost uninstall -t cursor,codex,claude --dry-run -y
search-boost uninstall -t cursor,codex,claude -y
```

卸载针对 SearchBoost 所属的注册、区块和资产，保留无关用户内容。原生搜索恢复取决于受管理设置及宿主能力；Grok CLI 不可用时，插件移除是尽力执行。先移除依赖这个包的宿主集成，再卸载 npm 包。

## 架构与开发

`lib/runtime.mjs` 是宿主无关入口。`lib/search/` 负责检索、排序、网络政策和自适应证据流程，`lib/jev/` 负责 Jev 协议客户端；`adapters/` 将结果转换为各宿主的接口。`agents/` 是提示词与 skill 的源模板，生成资产应由同步流程刷新，不要单独修改后让各份内容失配。

**提示词分工：**工具描述说明用途和结果，schema 说明参数，inject 说明验证原则与边界，动态 capability 说明配置，按需 skill/template 说明工作流，角色提示词只说明该子任务。详细约定见[提示词契约](./docs/prompt-contract.md)。

```bash
npm ci
npm run prepublishOnly    # 同步生成资产并执行全部离线测试，不会发布
npm run test:network      # DNS/代理/地址固定，以及发布审计回归
npm run test:adaptive
npm run test:adapters
npm run smoke            # MCP 协议冒烟测试
npm pack --dry-run
```

CI 在 Linux 和 Windows 上运行测试。模拟 provider 响应和本地网络夹具不能证明付费服务当前可用，也不能覆盖所有宿主版本的真实行为；正式发布前仍需单独验证这些环境。

[MIT License](./LICENSE)
