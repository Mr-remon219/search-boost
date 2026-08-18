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

---

## MCP 工具

| MCP 工具 | 干什么用 |
|----------|----------|
| `fused_search` | 多引擎并行搜、去重、综合排序 |
| `fetch_page` | 拉网页正文（Jina 优先，失败走 HTML；`focus` 可只留相关段落，省 token） |
| `x_search` | 搜 X / Twitter：关键词、用户、帖子串 |
| `deep_research` | 做一轮深度研究，告诉你还缺什么、下一步搜什么 |
| `search_layer` | 查看或切换搜索层：`free`（免 Key）/ `api`（带 Key 的引擎） |
| `search_stats` | 看缓存、各引擎是否可用等诊断信息 |

另外还有资源 `search-boost://policy` 和提示词 `search_routing`。

**两种搜索层**

- **free**：Bing + DuckDuckGo + Yahoo + Exa-free，**无需 API Key**。
- **api**：在 free 层基础上增加 Antigravity CLI（本机可用时）以及 Tavily / Brave / Exa，需配置 Key

配 Key：`search-boost config keys`，写到 `~/.search-boost-keys.json`（仍会读取旧路径 `~/.dsh-search-boost-keys.json`）；也可以设环境变量 `TAVILY_API_KEY`、`BRAVE_API_KEY`、`EXA_API_KEY`。

**配置文件路径覆盖：** 环境变量 `SEARCH_BOOST_KEYS_FILE`、`SEARCH_BOOST_LAYER_FILE`（可选，指向自定义路径）。

---

## 常用命令

| 命令 | 说明 |
|------|------|
| `search-boost` | 打开交互式菜单 |
| `search-boost setup` | 一条龙：密钥 + 搜索层 + 安装 |
| `search-boost install` / `uninstall` | 安装或卸载到各 Agent |
| `search-boost serve` | 启动 MCP 服务（Agent 调用的入口） |
| `search-boost status` | 看密钥、搜索层、各 Agent 是否已配置 |
| `search-boost config keys\|layer\|search` | 管密钥、默认层、是否替换内置搜索 |
| `search-boost print <agent>` | 只打印 MCP 配置片段，不改文件 |
| `search-boost agents` | 列出 Agent（适合脚本读） |

**安装时常用参数：** `-t` 指定 Agent · `-y` 全自动 · `--dry-run` 预览 · `--auto-allow` 免审批 MCP 工具 · `--replace-native` / `--keep-native` 是否关掉内置搜索 · `--scope`（Grok 用户级/项目级）· `--workspace`（Antigravity 工作区 `.agents/`）

---

## 支持哪些 Agent

| Agent | MCP 写在哪 | 还会注入什么 |
|-------|------------|--------------|
| Cursor IDE / CLI | `~/.cursor/mcp.json` | hook、skill，可选 CLI 免审批 |
| Codex CLI | `~/.codex/config.toml` | AGENTS.md、skill |
| Claude Code | `~/.claude.json` | CLAUDE.md、skill、权限规则 |
| Grok Build | `~/.grok/config.toml` | rule、skill · 另有 [grok-plugin](./grok-plugin/) |
| Antigravity | `~/.gemini/config/mcp_config.json` | AGENTS.md、GEMINI.md、skill，可选工作区配置 |

提示词的设计是**让模型自己决定要不要搜**，不是每轮都强制联网。各 Agent 的模板在 [`agents/`](./agents/) 里。

**和内置搜索的关系：** 加 `-y` 时，默认会关掉 Codex 的 `web_search` 和 Claude 的 `WebSearch`；想保留就加 `--keep-native`。Cursor、Antigravity 没有硬开关，靠 skill 和 hook 引导优先用 search-boost。Grok 自带的 browse **不会动**。

---

## Grok 插件

```bash
grok plugin install ./grok-plugin --trust
search-boost install -t grok -y --auto-allow
```

更多说明见 [grok-plugin/README.md](./grok-plugin/README.md)。

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
