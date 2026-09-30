# Antigravity / Grok 接入审查修复

本轮工作基于 `b1a1da7`，保留同一工作树中未提交的 DSH 修复。没有发布 npm 包、修改用户实际接入配置或消耗模型 API。

## 修复行为

- **Antigravity 首装**：没有既有 MCP 文件时，写入 `~/.gemini/config/mcp_config.json`。仅存在旧文件 `~/.gemini/antigravity/mcp_config.json` 时仍沿用旧路径；现代文件或 `.migrated` 标记存在时优先现代路径。清理另一份配置时只删除 SearchBoost 条目，保留无关服务器与偏好。
- **Grok manifest**：`grok-plugin/plugin.json` 的 `author` 使用 `{ "name": "search-boost" }`，而不是字符串。发布资产同步保留该对象。
- **Grok 卸载**：使用 `grok plugin list --json` 返回的插件 `name`，不使用存储仓库的 `repo_key`。正常插件按 `search-boost` 删除；错误作者格式产生的旧安装按宿主实际登记的 slug 名删除。安装也校验宿主登记的 manifest 名字和当前来源，不只看退出码。卸载退出码为 0 后再查列表，仍有登记或无法验证时报告失败。
- **Grok 老安装发现**：安装、卸载和更新共用列表解析；卸载和更新共用身份判断；支持数组和 `{ plugins: [...] }` 格式。旧条目即使名字是 slug，也可通过来源或已安装目录中 manifest 的 `name` 识别，不把任意相似目录或 `repo_key` 当作所有权证据。
- **Grok 更新**：当前持久来源已经登记时使用宿主原生 `plugin update <name>`，避免 `plugin install` 的“already installed”错误。不添加 `--trust`，不调用 enable。来源改变或旧 slug 记录需要重新安装时，宿主可能要求显式信任；更新报告失败/未验证而不是漏报不存在或假成功，原有信任和启用决定不自动改写。必要时先用列表里的实际名字卸载旧记录，再显式运行安装。

## 自动回归

`scripts/test-client-review-regressions.mjs` 的 13 项回归覆盖：首次安装、旧路径与迁移标记、卸载重装保留无关配置、作者对象格式、旧 slug/已删除来源发现、禁用状态、原生更新、不授予信任、非本插件保护、错误列表、卸载名字及零退出假成功。

它同时纳入 `npm run test:install` 子集和 `npm run test:isolation` 全量门禁。测试先引入隔离 bootstrap，仅使用临时 HOME、假 Grok CLI 和模拟配置，不调用用户真实宿主。

## 真实 Grok 验证范围

另外手工使用本机已有的 **Grok 1.0.5 (`5115b46bc9`)**，在独立临时 HOME / GROK_HOME、空凭据环境和项目目录中验证了插件管理命令：

1. 原来的字符串作者产生目录 slug 登记；正确对象作者产生 `search-boost` 登记。
2. 正确作者 manifest 通过宿主 `plugin validate`，组件清单识别到 skills 和 MCP servers。
3. 正常插件的 `repo_key` 卸载被拒绝，插件名卸载成功；修复后的安装包装器确认正确名字与来源登记。
4. 修复后的 SearchBoost 更新包装器调用原生更新成功，Grok 配置字节不变。
5. 修复后的 SearchBoost 卸载包装器成功，再查真实宿主列表确认登记消失。

这些只证明真实 Grok 的 manifest 与插件管理接入，不是新的模型会话或工具执行证明。没有重复审查方的六客户端工具调用、Codex 云执行或 Antigravity 登录会话；Antigravity 路径行为由本地回归和审查方实测支持。跨版本升级的审查方结果也不等于本包已在 npm 正式发布。
