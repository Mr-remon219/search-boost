# search-boost · Grok Build Plugin

Install **search-boost MCP** and **skill** into [Grok Build](https://x.ai/grok).

> Siblings: [dsh-search-boost](https://github.com/Mr-remon219/dsh-search-boost) (DSH) · [pi-search-boost](https://github.com/Mr-remon219/pi-search-boost) (pi) · [search-boost](https://github.com/Mr-remon219/search-boost) (Cursor / Codex / Claude / …)

---

## Install

**Recommended** — one command installs the plugin (when `grok` is on PATH) plus config, rule, and skill:

```bash
npm install -g search-boost-mcp
search-boost install -t grok -y --auto-allow
```

If `grok` is not on PATH, the plugin step is skipped with a warning; config/rule/skill still install. Use `--skip-grok-plugin` to skip the plugin step explicitly.

**Manual plugin only** (advanced — e.g. marketplace path install without `search-boost` CLI):

```bash
# From a git clone:
grok plugin install ./grok-plugin --trust
# Or from the global npm package:
#   grok plugin install "$(npm root -g)/search-boost-mcp/grok-plugin" --trust
# Windows PowerShell: "$(npm root -g)\search-boost-mcp\grok-plugin"

# Then optional routing rules:
search-boost install -t grok -y --auto-allow --skip-grok-plugin
```

The bundled `.mcp.json` uses `npx -y search-boost-mcp serve` (portable). A separate `[mcp_servers.search-boost]` in `config.toml` from `search-boost install` may also exist — both work.

---

## Verify

```bash
grok inspect
grok mcp doctor search-boost
```

---

## Sync skill after edits

After editing `agents/grok/skill.md`, run:

```bash
npm run plugin:sync-grok
```

To publish on the Grok plugin marketplace: open a PR to [xai-org/plugin-marketplace](https://github.com/xai-org/plugin-marketplace) and pin the remote to a specific commit.

---

## 安装 · Grok Build 插件

把 **search-boost 的 MCP 服务**和 **skill** 装进 [Grok Build](https://x.ai/grok)。

> 同系列的另外两个插件：[dsh-search-boost](https://github.com/Mr-remon219/dsh-search-boost)（给 DSH 用）· [pi-search-boost](https://github.com/Mr-remon219/pi-search-boost)（给 pi 用）· [search-boost](https://github.com/Mr-remon219/search-boost)（Cursor / Codex / Claude 等）

### 怎么装

**推荐** — 一条命令（`grok` 在 PATH 时）自动装插件 + config、rule、skill：

```bash
npm install -g search-boost-mcp
search-boost install -t grok -y --auto-allow
```

PATH 中没有 `grok` 时，插件步骤会跳过并警告，config/rule/skill 仍会安装。显式跳过插件：加 `--skip-grok-plugin`。

**仅手动装插件**（进阶 — 例如不走 search-boost CLI 的市场路径）：

```bash
# 从仓库克隆：
grok plugin install ./grok-plugin --trust
# 或全局 npm 包：
#   grok plugin install "$(npm root -g)/search-boost-mcp/grok-plugin" --trust
# Windows PowerShell: "$(npm root -g)\search-boost-mcp\grok-plugin"

# 再可选写入路由规则：
search-boost install -t grok -y --auto-allow --skip-grok-plugin
```

包内 `.mcp.json` 使用 `npx -y search-boost-mcp serve`（可移植）。`search-boost install` 写入的 `config.toml` 里也可能有 `[mcp_servers.search-boost]` — 两者均可工作。

### 怎么确认装好了

```bash
grok inspect
grok mcp doctor search-boost
```

### 改 skill 后怎么同步

编辑完 `agents/grok/skill.md`，跑：

```bash
npm run plugin:sync-grok
```

想上架 Grok 官方插件市场：给 [xai-org/plugin-marketplace](https://github.com/xai-org/plugin-marketplace) 提 PR，remote 记得 pin 到具体 commit。

---

**Friendly link:** [LINUX DO 社区](https://linux.do/)
