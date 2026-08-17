# search-boost · Grok Build 插件

把 **search-boost 的 MCP 服务**和 **skill** 装进 [Grok Build](https://x.ai/grok)。

> 同系列的另外两个插件：[dsh-search-boost](https://github.com/Mr-remon219/dsh-search-boost)（给 DSH 用）· [pi-search-boost](https://github.com/Mr-remon219/pi-search-boost)（给 pi 用）· [search-boost-mcp](https://github.com/Mr-remon219/search-boost-mcp)（Cursor / Codex / Claude 等）

---

## 怎么装

```bash
# 1. 安装插件包（含 MCP + skill）
grok plugin install ./grok-plugin --trust

# 2. 可选：写入搜索路由规则（什么时候搜，由模型自己判断）
search-boost install -t grok -y --auto-allow
```

如果已经 `npm i -g search-boost-mcp`，第二步直接用全局命令 `search-boost` 就行。

---

## 怎么确认装好了

```bash
grok inspect
grok mcp doctor search-boost
```

---

## 改 skill 后怎么同步

编辑完 `agents/grok/skill.md`，跑：

```bash
npm run plugin:sync-grok
```

想上架 Grok 官方插件市场：给 [xai-org/plugin-marketplace](https://github.com/xai-org/plugin-marketplace) 提 PR，remote 记得 pin 到具体 commit。

---

**友情链接：** [LINUX DO 社区](https://linux.do/)
