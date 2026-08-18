# search-boost-mcp

面向编程 Agent 的**多引擎联网搜索 MCP 服务**。安装 CLI 后即可接入 **Cursor**、**Cursor CLI**、**Codex**、**Claude Code**、**Grok Build** 和 **Antigravity**。

> **search-boost 系列**
>
> | 项目 | 用在哪 | 链接 |
> |------|--------|------|
> | **search-boost-mcp**（本仓库） | Cursor · Codex · Claude · Grok · Antigravity | 当前仓库 |
> | [**dsh-search-boost**](https://github.com/Mr-remon219/dsh-search-boost) | [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) | [GitHub](https://github.com/Mr-remon219/dsh-search-boost) · [npm](https://www.npmjs.com/package/dsh-search-boost) |
> | [**pi-search-boost**](https://github.com/Mr-remon219/pi-search-boost) | [pi](https://github.com/earendil-works/pi-coding-agent) | [GitHub](https://github.com/Mr-remon219/pi-search-boost) · [npm](https://www.npmjs.com/package/pi-search-boost) |

底层搜索引擎**内置于 [`lib/search/`](./lib/search/)**（源自 [dsh-search-boost](https://github.com/Mr-remon219/dsh-search-boost)）：**free** 层并行调用 Bing、DuckDuckGo、Yahoo 与 Exa-free；**api** 层在此基础上增加 Antigravity CLI（本机可用时）以及配置了 Key 的 Tavily / Brave / Exa。此外还提供 X 搜索降级、Jina 正文抓取和深度研究多轮检索。

English → [README.md](./README.md)

### v0.1.2 更新

- **自包含引擎池**（`lib/search/`）：常规搜索用 Bing + DuckDuckGo + Yahoo + Exa-free；同一引擎池也用于 `x_search` 降级时的 `site:` 查询。
- **`x_search` 降级**在多引擎域名搜索时会自动加上 `site:x.com`，无 XAI 凭据时关键词搜索也能返回结果。
- **无需外部 dsh 仓库或 npm 依赖** — 引擎逻辑已 vendored 到本仓库。

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

### 按 Agent 单独安装

```bash
search-boost install -t cursor -y
search-boost install -t codex,claude -y --auto-allow
search-boost install -t grok -y --auto-allow
search-boost install -t antigravity --workspace --auto-allow -y
```

只想看看会改哪些文件、不真正写入：加 `--dry-run`。

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
| `-t`, `--target` | 指定 Agent（`cursor`、`codex`、`claude`、`grok`、`antigravity`、`cursor-cli`、`auto`、`all`） |
| `-y`, `--yes` | 非交互：跳过密钥/搜索层向导、默认 `--target=auto`，**同时隐含** `--auto-allow` 与 `--replace-native` |
| 仅 `-t`、不加 `-y` | 对该目标非交互安装，**默认仍会替换内置搜索**，但**不会**自动加 `--auto-allow`；需要免审批请显式加上 |
| `--auto-allow` | 在 Agent 配置里预批准 search-boost 的 MCP 工具（Cursor CLI 白名单、Codex 自动审批、Claude/Grok/Antigravity 权限规则），避免每轮都弹审批 |
| `--replace-native` / `--keep-native` | 关闭或保留内置联网（Codex `web_search`、Claude `WebSearch`）。非交互安装时默认替换 |
| `--dry-run` | 只打印将要修改的内容，不写文件 |

若要完整走密钥 + 搜索层选择，请用 `search-boost setup`，或不加 `-y` 的 `search-boost install`。

---

## MCP 工具

| MCP 工具 | 干什么用 |
|----------|----------|
| `fused_search` | 多引擎并行搜、去重、综合排序 |
| `fetch_page` | 拉网页正文（Jina 优先，失败走 HTML；`focus` 可只留相关段落，省 token） |
| `x_search` | 搜 X / Twitter：关键词、用户、帖子串 |
| `deep_research` | 每轮一次深度研究 — 按 `suggested_queries` 重复调用直到 gaps 为空，再综合结论（建议最多 ~3 轮） |
| `search_layer` | 查看或切换搜索层：`free`（免 Key）/ `api`（带 Key 的引擎） |
| `search_stats` | 看缓存、各引擎是否可用等诊断信息 |

另外还有资源 `search-boost://policy` 和提示词 `search_routing`。

**两种搜索层**

- **free**：Bing + DuckDuckGo + Yahoo + Exa-free，**无需 API Key**。
- **api**：在 free 层基础上增加 Antigravity CLI（本机可用时）以及 Tavily / Brave / Exa，需配置 Key

配 Key：`search-boost config keys`，写到 `~/.search-boost-keys.json`（仍会读取旧路径 `~/.dsh-search-boost-keys.json`）；也可以设环境变量 `TAVILY_API_KEY`、`BRAVE_API_KEY`、`EXA_API_KEY`。

获取 Key：[Tavily](https://app.tavily.com/) · [Brave Search API](https://brave.com/search/api/) · [Exa](https://dashboard.exa.ai/)

**X/Twitter 凭据（可选）：** 配置后可走官方 `x_search` 路径。存储于 `~/.search-boost-xauth.json`（仍会读取旧路径 `~/.dsh-search-boost-xauth.json`），或通过 `XAI_API_KEY` / Grok `/x-login`。路径覆盖：`SEARCH_BOOST_XAUTH_FILE`。

**配置文件路径覆盖：** 环境变量 `SEARCH_BOOST_KEYS_FILE`、`SEARCH_BOOST_LAYER_FILE`、`SEARCH_BOOST_XAUTH_FILE`（可选，指向自定义路径）。

---

## 常用命令

| 命令 | 说明 |
|------|------|
| `search-boost` | 打开交互式菜单 |
| `search-boost setup` | 一条龙：密钥 + 搜索层 + 安装 |
| `search-boost install` / `uninstall` | 安装或卸载到各 Agent |
| `search-boost serve` | 启动 MCP 服务（Agent 调用的入口） |
| `search-boost status` | 看密钥、搜索层、各 Agent 是否已配置 |
| `search-boost doctor [--quick\|--probe] [--json] [--strict]` | 配置/Agent/引擎健康检查，含 pass/warn/fail 判定 |
| `search-boost status` | 密钥、搜索层、各 Agent 安装态（无 verdict） |
| `search-boost config keys\|layer\|search` | 管密钥、默认层、是否替换内置搜索 |
| `search-boost print <agent>` | 只打印 MCP 配置片段，不改文件 |
| `search-boost agents` | 列出 Agent（适合脚本读） |

**安装时常用参数：** `-t` 指定 Agent · `-y` 非交互（隐含 `--auto-allow` 与 `--replace-native`）· `--dry-run` 预览 · `--auto-allow` 预批准 MCP 工具（见上表）· `--replace-native` / `--keep-native` · `--scope`（Grok）· `--workspace`（Antigravity `.agents/`）

---

## 支持哪些 Agent

| Agent | MCP 写在哪 | 还会注入什么 |
|-------|------------|--------------|
| Cursor IDE | `~/.cursor/mcp.json` | hook、skill |
| Cursor CLI | `~/.cursor/mcp.json` | hook、skill（CLI 版）、可选 CLI 免审批 |
| Codex CLI | `~/.codex/config.toml` | AGENTS.md、skill |
| Claude Code | `~/.claude.json` | CLAUDE.md、skill、权限规则 |
| Grok Build | `~/.grok/config.toml` | rule、skill · 另有 [grok-plugin](./grok-plugin/) |
| Antigravity | `~/.gemini/config/mcp_config.json` | AGENTS.md、GEMINI.md、skill，可选工作区配置 |

提示词的设计是**让模型自己决定要不要搜**，不是每轮都强制联网。各 Agent 的模板在 [`agents/`](./agents/) 里。

**和内置搜索的关系：** 非交互安装时默认会关掉 Codex 的 `web_search` 和 Claude 的 `WebSearch`；想保留就加 `--keep-native`。Cursor、Antigravity 没有硬开关，靠 skill 和 hook 引导优先用 search-boost。Grok 自带的 browse **不会动**。

**Antigravity + `agy` CLI：** 在 **api** 层且本机 PATH 有 `agy` 时，Antigravity CLI 引擎仅在 **medium** / **complex** 档位的 `fused_search` 中参与，简单查询不会走它；依赖本机登录与平台配额，超时约 45 秒。

---

## Grok 插件

插件随 npm 包一起发布（MCP 用可移植的 `npx` 启动，含 skill）。

**从 git 克隆**（仓库根目录）：

```bash
grok plugin install ./grok-plugin --trust
search-boost install -t grok -y --auto-allow
```

**全局安装 `npm install -g search-boost-mcp` 后**（无需克隆）：

```bash
# bash / macOS / Linux
grok plugin install "$(npm root -g)/search-boost-mcp/grok-plugin" --trust

# Windows PowerShell
grok plugin install "$(npm root -g)\search-boost-mcp\grok-plugin" --trust

search-boost install -t grok -y --auto-allow
```

包内 `.mcp.json` 使用 `npx -y search-boost-mcp serve`，任意装有 Node ≥ 22.13 的机器均可使用。

更多说明见 [grok-plugin/README.md](./grok-plugin/README.md)。

---

## 故障排查

| 现象 | 建议 |
|------|------|
| search-boost 是否健康？ | `search-boost doctor` — pass/warn/fail 判定；脚本用 `--json` |
| 安装直接失败 | 确认 Node **≥ 22.13**（`node -v`） |
| Agent 里看不到 MCP | 重新安装并**重启 Agent**，执行 `search-boost status` |
| 每次调用都要审批 | 重装时加 `--auto-allow`，或在 Agent 里一次性批准 |
| 搜不到结果 / 引擎为空 | `search-boost doctor` — 看 layer/密钥/引擎检查；**free** 无需 Key；**api** 需 `search-boost config keys` 或环境变量 |
| 网络/代理问题 | Phase 2：`search-boost doctor --probe`（尚未实现） |
| MCP 起不来 | `search-boost doctor` → `mcp_launch_command`、`node_version`；再跑 `search-boost serve` |
| Grok 插件 MCP 起不来 | `grok mcp doctor search-boost`；确认 `npx` 与网络可用 |
| Antigravity 的 `agy` 从不运行 | 需 **api** 层、PATH 中有 `agy`，且 `complexity` 为 medium/complex |
| 超时 / 抓取失败 | 公司代理或防火墙可能拦截 Bing/DDG/Jina；本地跑 `search-boost serve` 看 stderr |

---

## 本地开发

```bash
git clone https://github.com/Mr-remon219/search-boost-mcp.git
cd search-boost-mcp && npm install
npm run check && npm run test:install && npm run smoke
node cli.mjs install --dry-run -y
```

从源码安装时，MCP 启动命令会写成 `node /你的路径/cli.mjs serve`。无需 sibling checkout 或 `SEARCH_BOOST_DSH_ROOT`。

---

## 许可证

MIT

---

**相关链接：** [Issues](https://github.com/Mr-remon219/search-boost-mcp/issues) · [dsh-search-boost](https://github.com/Mr-remon219/dsh-search-boost) · [pi-search-boost](https://github.com/Mr-remon219/pi-search-boost)

**友情链接：** [LINUX DO 社区](https://linux.do/)
