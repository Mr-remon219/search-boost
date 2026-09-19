# search-boost-mcp

面向编程 Agent 的**多引擎联网搜索** —— **一份 SearchBoost 核心，三种宿主适配**。MCP 服务接入 **Cursor**、**Cursor CLI**、**Codex**、**Claude Code**、**Grok Build** 和 **Antigravity**；同一个包同时也是 **[pi](https://github.com/earendil-works/pi-coding-agent) 扩展**和 **[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) bundle 插件**。

```text
                SearchBoost Core  (lib/runtime.mjs + lib/search/)
                        │
          ┌─────────────┼─────────────┐
          │             │             │
     adapters/mcp   adapters/pi   adapters/dsh
     (stdio MCP)     (pi 扩展)    (Cordis bundle)
          │             │             │
          └── agents/<host> 宿主级提示词策略 ──┘
```

> 原独立仓库 **pi-search-boost** 与 **dsh-search-boost** 已并入本仓库，退化为两个宿主适配层。搜索引擎、融合排序、正文抓取与 X 搜索**只在本仓库的核心维护一份**。

**核心**（[`lib/search/`](./lib/search/)）：**free** 层并行调用 Bing、DuckDuckGo、Yahoo 与 Exa-free；**api** 层在此基础上增加**你已配置**的 Tavily / Brave / Exa（配一个 Key 即可运行；建议配齐三个以获得最佳融合）。此外还提供 X 搜索（xAI 托管工具 ∥ 多引擎，无凭据也可降级使用），以及带 `focus` 的 Jina 正文抓取。

English → [README.md](./README.md)

---

## 快速安装

环境要求：**Node ≥ 22.13**。

```bash
npm install -g search-boost-mcp
search-boost setup          # 交互式：配密钥 → 选搜索层 → 选 Agent
# 想省事、全自动：
search-boost install -y     # 给所有能检测到的 Agent 装上
```

装完后记得**重启**对应的 Agent，MCP 才会生效。

### 升级

已经在用 search-boost-mcp？先更新全局 CLI，再重装到各 Agent（`~/.search-boost/` 下的密钥与搜索层会保留）：

```bash
npm install -g search-boost-mcp@latest
search-boost install -y                 # 所有检测到的 Agent
# 或按 Agent，例如 Grok 一键（grok CLI 在 PATH 时含插件 + 配置）：
search-boost install -t grok -y --auto-allow
search-boost doctor
```

重装后**重启** Agent。首次写入时会从旧的 flat `~/.search-boost-*.json` 路径懒迁移配置。

### 按 Agent 单独安装

```bash
search-boost install -t cursor -y
search-boost install -t codex,claude -y --auto-allow
search-boost install -t grok -y --auto-allow   # grok CLI 在 PATH 时自动装插件 + 配置
search-boost install -t antigravity --workspace --auto-allow -y
search-boost install -t pi -y                  # pi shim + searcher/summarizer + /fast-parallel /complex-parallel
search-boost install -t dsh -y --profile web   # 执行 dsh plugin --profile web add …（需要 dsh + pnpm）
```

只想看看会改哪些文件、不真正写入：加 `--dry-run`。

**不经 CLI 直接装 pi / DSH：** `pi install npm:search-boost-mcp`（包清单 `pi.extensions`）或 `dsh plugin --profile web add search-boost-mcp`（包清单 `dsh.bundle`）。详见下文「宿主适配层」。

### 验证安装

```bash
search-boost doctor          # 健康检查（离线，pass/warn/fail）
search-boost doctor --json   # 机器可读报告，便于 CI/脚本
search-boost status          # 安装态仪表盘（密钥、搜索层、各 Agent）
```

退出码：**0** 正常 · **1** 失败（或 `--strict` 下警告也算失败）· **2** 仅警告。

可选：`search-boost doctor --probe` 增加联网冒烟（需网络；Phase 2）。

然后在对应 Agent 里确认：

| Agent | 快速检查 |
|-------|----------|
| **Cursor** | 设置 → MCP → `search-boost` 已连接且列出工具 |
| **Cursor CLI** | 同上，配置在 `~/.cursor/mcp.json` |
| **Codex** | 会话中能看到 `mcp__search-boost__*` 工具 |
| **Claude Code** | MCP 面板有 `search-boost`；若用了 `--auto-allow` 则无需每次审批 |
| **Grok Build** | `grok mcp doctor search-boost` · `grok inspect` |
| **Antigravity** | MCP 配置含 `search-boost`；安装后需重启 IDE |

工具能列出但调用失败时，可在终端跑 `search-boost serve` 看启动报错。

### 安装参数说明

| 参数 | 作用 |
|------|------|
| `-t`, `--target` | 指定 Agent（`cursor`、`codex`、`claude`、`grok`、`antigravity`、`cursor-cli`、`pi`、`dsh`、`auto`、`all`） |
| `--profile <name>` | 仅 DSH：`$DSH_HOME/profiles` 下的 profile（默认 `web`） |
| `-y`, `--yes` | 非交互：跳过密钥/搜索层向导、默认 `--target=auto`，**同时隐含** `--auto-allow` 与 `--replace-native` |
| 仅 `-t`、不加 `-y` | 对该目标非交互安装，**默认仍会替换内置搜索**，但**不会**自动加 `--auto-allow`；需要免审批请显式加上 |
| `--auto-allow` | 在 Agent 配置里预批准 search-boost 的 MCP 工具（Cursor CLI 白名单、Codex 自动审批、Claude/Grok/Antigravity 权限规则），避免每轮都弹审批 |
| `--replace-native` / `--keep-native` | 关闭或保留内置联网（Codex `web_search`、Claude `WebSearch`）。非交互安装时默认替换 |
| `--scope user\|project\|all` | 仅 Grok：user（`~/.grok`）、project（cwd 下 `.grok/`），卸载时可选 both |
| `--skip-grok-plugin` | 仅 Grok：跳过 bundled `grok plugin install`；仍会写入 config.toml、rule、skill |
| `--dry-run` | 只打印将要修改的内容，不写文件 |

若要完整走密钥 + 搜索层选择，请用 `search-boost setup`，或不加 `-y` 的 `search-boost install`。

### 卸载

```bash
search-boost uninstall -t codex -y
search-boost uninstall -t cursor,codex,claude -y
```

卸载只移除 **search-boost 拥有** 的配置块（带标记的 MCP、skill、hook、权限规则）。在 Agent 支持的情况下会恢复内置联网（Codex 顶层 `web_search`、Claude `WebSearch` deny），除非你安装时用了 `--keep-native`，或原本就有未标记的用户设置。若文件仅因 search-boost 而存在且清理后为空，会被删除。Grok 的 `grok plugin uninstall` 为**尽力而为**（CLI 缺失或失败时会警告并继续）。预览：加 `--dry-run`。

---

## MCP 工具

| MCP 工具 | 干什么用 |
|----------|----------|
| `fused_search` | 多引擎并行搜、去重、综合排序 |
| `fetch_page` | 拉网页正文（Jina 优先，失败走 HTML；先去掉样式/广告，不裁剪；`focus` 可只留相关段落） |
| `x_search` | 搜 X / Twitter：关键词、用户、帖子串 |
| `search_layer` | 查看或切换搜索层：`free`（免 Key）/ `api`（带 Key 的引擎） |
| `search_stats` | 看缓存、各引擎是否可用等诊断信息 |

另外还有资源 `search-boost://policy` 和提示词 `search_routing`。

**两种搜索层**

- **free**：Bing + DuckDuckGo + Yahoo + Exa-free，**无需 API Key**。
- **api**：在 free 层基础上增加**任意已配置**的 Tavily / Brave / Exa（一个 Key 即可；建议配齐三个以获得最佳多引擎融合）

配 Key：`search-boost config keys`，写到 `~/.search-boost/config/keys.json`（仍会读取 flat `~/.search-boost-keys.json` 与 legacy `~/.dsh-search-boost-keys.json`）；也可以设环境变量 `TAVILY_API_KEY`、`BRAVE_API_KEY`、`EXA_API_KEY`。可选路由：`enabledEngines: ["exa"]` 或 `"engines": { "brave": { "enabled": false } }`。

**配置目录：** 运行时数据位于 `~/.search-boost/` — `config/`（keys、layer、xauth）、`cache/`（xguest token）、`state/`（Antigravity 工作区注册表）。首次写入时从 flat `~/.search-boost-*.json` 与 legacy `~/.dsh-*` 懒迁移（旧文件保留）。覆盖根目录：`SEARCH_BOOST_HOME`；单文件：`SEARCH_BOOST_*_FILE`。

获取 Key：[Tavily](https://app.tavily.com/) · [Brave Search API](https://brave.com/search/api/) · [Exa](https://dashboard.exa.ai/)

**X/Twitter 凭据（可选）：** 配置后可走官方 `x_search` 路径。存储于 `~/.search-boost/config/xauth.json`（仍会读取 flat/legacy 路径），或通过 `XAI_API_KEY`。使用 `search-boost config x` 配置（见下方命令表）。MCP `/x-login` 与 `search-boost config x` 写入同一本地副本。路径覆盖：`SEARCH_BOOST_XAUTH_FILE`。

```bash
search-boost config x --show              # 查看 xauth 状态
search-boost config x --import-grok       # 从 grok CLI 导入登录
search-boost config x --set-xai-key KEY   # 保存 XAI API key
search-boost config x --logout            # 删除本地副本
```

**配置文件路径覆盖：** 环境变量 `SEARCH_BOOST_KEYS_FILE`、`SEARCH_BOOST_LAYER_FILE`、`SEARCH_BOOST_XAUTH_FILE`（可选，指向自定义路径）。

---

## 常用命令

| 命令 | 说明 |
|------|------|
| `search-boost` | 打开交互式菜单 |
| `search-boost setup` | 一条龙：密钥 + 搜索层 + 安装 |
| `search-boost install` / `uninstall` | 安装或卸载到各 Agent |
| `search-boost serve` | 启动 MCP 服务（Agent 调用的入口） |
| `search-boost status` | 看密钥、搜索层、X 凭据、各 Agent 是否已配置 |
| `search-boost doctor [--quick\|--probe] [--json] [--strict]` | 配置/Agent/引擎健康检查，含 pass/warn/fail 判定 |
| `search-boost config keys\|layer\|x\|search` | 管密钥、默认层、X 凭据、是否替换内置搜索 |
| `search-boost print <agent>` | 只打印 MCP 配置片段，不改文件 |
| `search-boost agents` | 列出 Agent（适合脚本读） |

**安装时常用参数：** `-t` 指定 Agent · `-y` 非交互（隐含 `--auto-allow` 与 `--replace-native`）· `--dry-run` 预览 · `--auto-allow` 预批准 MCP 工具（见上表）· `--replace-native` / `--keep-native` · `--scope user|project|all`（Grok）· `--skip-grok-plugin`（Grok）· `--workspace`（Antigravity `.agents/`）

---

## 支持哪些 Agent

| Agent | MCP 写在哪 | 还会注入什么 |
|-------|------------|--------------|
| Cursor IDE | `~/.cursor/mcp.json` | hook、skill |
| Cursor CLI | `~/.cursor/mcp.json`（与 IDE 共用 surface） | hook、skill（CLI 版）、可选 CLI 免审批 |
| Codex CLI | `~/.codex/config.toml` | SessionStart hook、AGENTS.md、skill |
| Claude Code | `~/.claude.json` | SessionStart hook、CLAUDE.md、skill、权限规则 |
| Grok Build | `~/.grok/config.toml` | rule、skill、随包 [grok-plugin](./grok-plugin/)（`grok` 在 PATH 时自动安装） |
| Antigravity | `~/.gemini/config/mcp_config.json` | 首次调用 hook、AGENTS.md、GEMINI.md、skill，可选工作区配置 |
| pi | —（进程内扩展，[`adapters/pi`](./adapters/pi/)） | `~/.pi/agent/extensions/search-boost.js` shim；`agents/` + `prompts/`（searcher、summarizer、`/fast-parallel`、`/complex-parallel`） |
| DeepSeek Harness | —（进程内 bundle，[`adapters/dsh`](./adapters/dsh/)） | `dsh plugin --profile <p> add` → profile 的 `package.json` |

MCP 接入现在会在启动时提醒模型**主动核实外部事实**：版本、API、不确定的技术行为、比较与选型，不必等用户要求搜索。纯本地代码、稳定概念、写作及用户禁止联网时跳过，不要求每轮搜索。共享策略在 [`agents/shared/startup-search.md`](./agents/shared/startup-search.md)；pi / DSH 的原有策略不变。

### 提示词职责与扩展入口

```text
hook：主动核实提醒       inject.md：简短的能力与宿主说明
                ↓
普通任务 → MCP description + schema → 直接调用
需要详细参考 → 可选 resource：search-boost://policy
复杂扩展流程 → search-boost skill router → 已注册的专项 skill
```

**MCP 宿主安装 `search-boost` router 和 `search-boost-parallel-research` 工作流 skill，两者都不是普通搜索的前置步骤。** 原来的 search/fetch/x/diagnostics 四个工具说明型 skill 已撤下：工具选择与参数说明归 MCP description/schema，示例、证据注意事项和排障归可选 resource。`search_routing` MCP prompt 保留为显式请求的规划助手，不在每次调用前自动运行。Resource 是否被读取、注入上下文由宿主决定。

Router 模板位于 `agents/<agent>/skill.md`；六份 `inject.md` 只提供基本认知。扩展注册表是 [`agents/router.mjs`](./agents/router.mjs) 的 `SKILL_EXTENSIONS`，目前登记了并行研究工作流。安装器和插件据此安装 skill 并生成 router 链接，支持宿主限制；具体宿主的委派说明渲染进 skill。支持 skill 不等于具备 subagent 能力。开发说明见 [`agents/shared/skills/README.md`](./agents/shared/skills/README.md)。Skill 只能编排宿主已有且获授权的能力，不能凭提示词创建 subagent 工具。

重新安装会保留 router、清理属于 search-boost 的旧工具说明型技能及其 Codex 元数据，保留用户文件；卸载也处理旧技能残留。插件同步：`npm run plugin:sync-grok` / `npm run build:plugin`。模板变更需重新安装目标。pi / DSH 保留原生集成；Grok 仍通过启动 rule 承载主动提醒。

### 共享并行研究

Pi、DSH 和 MCP 宿主的 skill 共用 [`agents/shared/research/`](./agents/shared/research/) 中的角色与流程规范，普通单点查询仍直接调用工具。

| 宿主 | 入口 | 执行方式 |
|------|------|----------|
| Pi | `search-parallel-subagent`；`/fast-parallel`、`/complex-parallel` | Pi 子进程；searcher 仅有 `fused_search` / `fetch_page`，summarizer 无工具 |
| DSH | 已有原生 `research_parallel` | DSH `spawn` provider；角色提示、工具白名单、深度限制、整波取消和资源释放；**不依赖 Pi** |
| Claude / Codex / Cursor IDE 与 CLI | `search-boost-parallel-research` skill | 使用当前会话真实且获授权的原生委派工具，先确认子代理 MCP 可用 |
| Grok / Antigravity | 同一 skill，按能力检查 | 不预设子代理 API；有可调用的原生能力才并行，否则明确说明串行研究 |

Pi 与 DSH 支持相同的角色/任务调用形状；DSH 也兼容旧的 `query` / `sub_queries`：

```json
{"tasks":[{"agent":"searcher","task":"目标版本的官方 API 行为"},{"agent":"searcher","task":"已知限制和冲突证据"}]}
```

```json
{"agent":"summarizer","task":"主问题、所有报告与执行状态、已有结论、剩余预算"}
```

快速模式只做一波，由主代理综合；复杂模式由 summarizer 判断重要缺口，默认 1–2 波，流程要求最多 3 波。原生工具一次只执行**一波**，不是自动循环研究。主代理负责最终验收，不能隐藏超时、拒绝、截断报告或单源证据。

DSH provider 必须声明独立上下文和 `toolFilter` / `depthLimit` / `persona` 能力，默认 `spawn`，可通过插件配置 `researchProvider` 显式指定其他兼容 provider。旧版或能力缺失时明确报错，不降为无限制子代理。`max_seconds`（1–300，默认 120）覆盖整波启动和执行；取消会请求宿主清理，不把未响应的 provider 宣称为已成功停止。`max_sources` 是提示词预算，不是强制工具调用配额。

Skill 不安装自定义宿主 agent，不开启被禁用的委派功能，也不能单靠文字强制隔离或取消。缺少委派或子代理 MCP 时，仅在仍符合用户要求的情况下明确转为串行；权限拒绝、运行故障和取消应报告为阻塞，不能启动另一个 CLI 绕过。详见[实现契约、宿主资料与验证边界](./agents/shared/research/README.md)。

### MCP 启动注入

| Agent | 注入机制与配置位置 |
|-------|--------------------|
| Claude Code | `~/.claude/settings.json` → `SessionStart` → `hookSpecificOutput.additionalContext` |
| Codex CLI | `~/.codex/hooks.json` → `SessionStart` → `hookSpecificOutput.additionalContext` |
| Cursor IDE / CLI | 复用 `~/.cursor/hooks.json` 的 `sessionStart`，合并提示词时只加入一份主动搜索策略 |
| Antigravity | `~/.gemini/config/hooks.json` 的 `PreInvocation`，仅 `invocationNum = 0` 时注入；`--workspace` 同步安装工作区副本，启用全局 hook 时副本不重复提醒 |
| Grok Build | 启动读取的 `search-boost.md` rule；官方规定被动 hook 的 stdout 被忽略，因此不安装无效的 SessionStart 注入 |

Hook 只读取本地提示词，不联网、不授予工具权限；提示词缺失或运行输入异常时放行。重复安装不会叠加 hook，卸载保留其他用户 hook。安装不会覆盖宿主禁用 hook 的设置，也不会绕过信任确认。**Codex 新版需要在 `/hooks` 中审阅并信任 hook；旧版可能需要升级或手动启用其实验 hooks 功能。** Cursor cloud agent 不支持这里的 `sessionStart`。

更新源码或提示词后，重新安装目标并重启对应 Agent（例如 `node cli.mjs install -t claude -y --keep-native`）。仅手工添加 MCP 配置或使用 `search-boost print` 不会安装 hook。

协议依据：[Claude](https://code.claude.com/docs/en/hooks)、[Codex](https://developers.openai.com/codex/hooks)、[Cursor](https://cursor.com/docs/agent/hooks)、[Antigravity](https://antigravity.google/docs/hooks)、[Grok](https://docs.x.ai/build/features/hooks)。

## 宿主适配层（pi / DeepSeek Harness）

两个宿主都在**进程内**直接调用与 MCP 服务相同的核心 —— 没有第二套引擎实现，也不经过 MCP。

| | pi（`adapters/pi`） | DSH（`adapters/dsh`） |
|---|---|---|
| 加载方式 | `pi install npm:search-boost-mcp`、`pi -e adapters/pi/index.js`，或 `search-boost install -t pi` 写入的 shim | `dsh plugin --profile web add search-boost-mcp`（自动应用 `adapters/dsh/cordis.patch.yml`，接管内置 `web_search` / `web_fetch`） |
| 工具 | `fused_search`（含 `site`/`min_score`/`depth`，最多 20 条）、`fetch_page`（不裁剪）、`search-parallel-subagent`（searcher/summarizer 子进程；`/fast-parallel` `/complex-parallel`）、`x_search` | `fused_search`、`fetch_page`、`x_search`、`research_parallel`（DSH 原生 subagents）、`search_stats`；原生引用卡片 |
| 命令 | `/web_change`、`/x-login`、`/x-logout`、`/search-cache`、`/search-audit` | `/web_change`、`/x-login`、`/x-logout` |
| 提示词 | `before_agent_start` 追加 `<search_balance>` + 当日搜索预算 | `systemPrompt.section` `search:policy`（115）+ 动态 `search:status`（116） |
| 状态 | 审计日志 `~/.pi/agent/search-boost-audit.jsonl`；旧的 `~/.pi/agent/search-boost-layer.json` / `xsearch-auth.json` 仍可读 | — |

Key、搜索层与 X 凭据与 MCP 服务共用：`search-boost config keys|layer|x`（或 TUI）—— 不再写 `PI_SEARCH_*` 环境变量与 `~/.dsh-search-boost-*.json`（旧文件仍会读取）。

**和内置搜索的关系：** 非交互安装且使用 `--replace-native`（默认）时，Codex 会在 `config.toml` **顶层**写入带标记的 `web_search = "disabled"`（不会写进 `[mcp_servers.*]`）；Claude 会在 `settings.json` 写入带 ownership 标记的 `WebSearch` deny。卸载时只移除 search-boost 拥有的项，并在安全时恢复内置搜索。想保留内置搜索就加 `--keep-native`。Cursor、Antigravity 没有硬开关，靠 skill 和 hook 引导优先用 search-boost。Grok 自带的 browse **不会动**。

**Cursor + Cursor CLI：** 两个 target 共用一套 `~/.cursor/` 配置。`-t cursor,cursor-cli` 会把 IDE 与 CLI 提示词合并写入一次；卸载会清理整份共用 surface。

**Grok Build：** `search-boost install -t grok -y --auto-allow` 在 Grok CLI 位于 PATH 时会执行 `grok plugin install <bundled grok-plugin> --trust`，随后写入 `config.toml`、rule 与 skill。若 PATH 中没有 `grok`，插件步骤会跳过并给出警告，配置安装仍会继续。仅需 config/rule/skill 时加 `--skip-grok-plugin`。重复安装对 `[permission]` 块（带标记或 legacy）是幂等的；卸载只剥离 search-boost 拥有的 permission 行。若已设 `[ui] permission_mode = "always-approve"`，`--auto-allow` 会跳过注入 `[permission]`。插件 `.mcp.json` 使用可移植的 `npx`；`config.toml` 使用 `resolveMcpLaunch()`（源码开发时为本地 `node`）——两者可并存。手动装插件（进阶）：`grok plugin install ./grok-plugin --trust` → [grok-plugin/README.md](./grok-plugin/README.md)。

---

## 故障排查

| 现象 | 建议 |
|------|------|
| search-boost 是否健康？ | `search-boost doctor` — pass/warn/fail 判定；脚本用 `--json` |
| 安装直接失败 | 确认 Node **≥ 22.13**（`node -v`） |
| Agent 里看不到 MCP | 重新安装并**重启 Agent**，执行 `search-boost status` |
| 每次调用都要审批 | 重装时加 `--auto-allow`，或在 Agent 里一次性批准 |
| 搜不到结果 / 引擎为空 | `search-boost doctor` — 看 layer/密钥/引擎检查；**free** 无需 Key；**api** 需**至少一个** keyed 引擎（`search-boost config keys` 或环境变量；建议配齐三个） |
| 网络/代理问题 | Phase 2：`search-boost doctor --probe`（尚未实现） |
| MCP 起不来 | `search-boost doctor` → `mcp_launch_command`、`node_version`；再跑 `search-boost serve` |
| Grok 插件 MCP 起不来 | `grok mcp doctor search-boost`；确认 `npx` 与网络可用 |
| 超时 / 抓取失败 | 公司代理或防火墙可能拦截 Bing/DDG/Jina；本地跑 `search-boost serve` 看 stderr |

---

## 本地开发

```bash
git clone https://github.com/Mr-remon219/search-boost.git
cd search-boost && npm install
npm run check && npm run test:install && npm run test:adapters && npm run smoke
node cli.mjs install --dry-run -y
```

从源码安装时，MCP 启动命令会写成 `node /你的路径/cli.mjs serve`。无需 sibling checkout 或 `SEARCH_BOOST_DSH_ROOT`。

目录边界：`lib/runtime.mjs` + `lib/search/` 是核心（与宿主无关）；`adapters/{mcp,pi,dsh}` 是宿主适配层（只做注册、渲染、生命周期）；`agents/<host>/` 放宿主级提示词策略；`lib/agents/` 是安装器。搜索逻辑只允许出现在核心里，适配层不得重新实现。

---

## 许可证

MIT

---

**相关链接：** [Issues](https://github.com/Mr-remon219/search-boost/issues) · 已并入本仓库的旧仓库：[dsh-search-boost](https://github.com/Mr-remon219/dsh-search-boost) · [pi-search-boost](https://github.com/Mr-remon219/pi-search-boost)

**友情链接：** [LINUX DO 社区](https://linux.do/)
