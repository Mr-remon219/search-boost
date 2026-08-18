# search-boost · Grok Build Plugin

Install **search-boost MCP** and **skill** into [Grok Build](https://x.ai/grok).

> Siblings: [dsh-search-boost](https://github.com/Mr-remon219/dsh-search-boost) (DSH) · [pi-search-boost](https://github.com/Mr-remon219/pi-search-boost) (pi) · [search-boost](https://github.com/Mr-remon219/search-boost) (Cursor / Codex / Claude / …)

---

## Install

```bash
# 1. Install the plugin bundle (MCP + skill)
# From a git clone:
grok plugin install ./grok-plugin --trust
# Or from the global npm package (no clone):
#   grok plugin install "$(npm root -g)/search-boost-mcp/grok-plugin" --trust
# Windows PowerShell: "$(npm root -g)\search-boost-mcp\grok-plugin"

# 2. Optional: write search routing rules (model decides when to search)
search-boost install -t grok -y --auto-allow
```

If you already ran `npm i -g search-boost-mcp`, use the global `search-boost` command in step 2.

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

```bash
# 1. 安装插件包（含 MCP + skill）
# 从仓库克隆：
grok plugin install ./grok-plugin --trust
# 或全局 npm 包（无需克隆）：
#   grok plugin install "$(npm root -g)/search-boost-mcp/grok-plugin" --trust
# Windows PowerShell: "$(npm root -g)\search-boost-mcp\grok-plugin"

# 2. 可选：写入搜索路由规则（什么时候搜，由模型自己判断）
search-boost install -t grok -y --auto-allow
```

如果已经 `npm i -g search-boost-mcp`，第二步直接用全局命令 `search-boost` 就行。

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
