# 1856 发布前审查：修复与复验

对应《SearchBoost发布前审查报告1856》（2026-10-01 北京时间），基线 `1856ce14d890f3d608531986fcae0c747b1074a4`。候选版本为 **0.2.4-beta.5**；不是重复发布 beta.4。本轮只修复报告问题与复审发现的相关回归，产品设计草稿仍独立，不包含在验收中。

## 修复对应

| 报告项 | 修复 | 自动回归 |
| --- | --- | --- |
| CLIENT-01 | 按解码后的 TOML 表路径识别裸键、双引号、单引号及转义键；更新已有 launch，不追加等价表；保留未知字段、env、禁用和自定义超时。字符串中的表/assignment 示例不是配置。 | `test-release-review-clients.mjs`：公开 CLI install ×2 → upgrade → uninstall，独立 Python `tomllib` 解析 |
| CLIENT-02 | 卸载完整的 SearchBoost 表子树，含被其他服务器隔开的 env 子表；不删除近似名字。旧卸载的孤立 env 子表不被 upgrade 当作服务器重新注册。 | 同上，含交错子表、孤立子表 |
| CLIENT-03 | 外层 MCP 配置备份解析有效文件链接，按目标身份拒绝别名，回滚目标字节/权限且保留链接；升级成功保留原权限。空 JSON/TOML 链接配置卸载时清空目标，不遗留旧内容。 | 同上：绝对、相对、链式链接的公开 upgrade，陈旧 launch 实际改写、回滚、无效链接拒绝、卸载/重装 |
| CLIENT-04 | 普通和交互安装包装器均转发 `antigravityConfig`；选择成功后持久化，dry-run 不保存。 | 同上：公开 legacy → 持久刷新 → dry-run modern → modern，以及交互包装器 |
| RUNTIME-01 | 最后一个等待者退出时同步退休并取消 flight；新调用排除已取消 flight；旧清理按对象身份判断，不能删掉新请求。 | `test-release-review-runtime.mjs`：公开 Pi execute，HTTP 同步 abort → 立即重试；`test-x-pipeline.mjs`：多个等待者的独立取消 |
| RUNTIME-02 | 缓存保存实际抓取时间；命中/focus/offset 使用原时间，过期重新抓取才更新。历史无时间缓存返回 null/unknown，DSH schema 同步允许 null。 | 同上：Pi 正文/details 一致、12 小时缓存、25 小时真实重新抓取；`test-dsh-schema.mjs`：真实 SDK 输出验证 |

独立复审另外发现并修复了 Codex 自动授权单向粘滞：交互明确拒绝自动授权时撤回此前的 `auto`，但保留用户 `ask`/`never`。公开/交互回归覆盖该方向。status、doctor、Grok scope 的配置识别也统一采用解码表路径；只有残留子表时不称为已配置，但卸载仍清理它，避免假成功。两轮定向复审已关闭两个 P1，最终客户端和运行时审查均为 OK（只读审查，测试由主代理执行）。打包前核对文件权限，代码/文档应为 0644，Git 标记可执行入口为 0755，不携带会话暂存产生的 0600 源文件。

## CLIENT-01 残留 P2：内联表与点键

`77e0114` 的复验覆盖了表头的三种等价写法，**没有覆盖全部合法 TOML 表示，也不构成整体发布放行**。后续用户指出的内联表/点键是 CLIENT-01 的残留边界，不另增问题编号。

本次采用最小安全处理，不自动转换这些表示：

- 对根级 `mcp_servers.search-boost.command = ...`、`mcp_servers.search-boost = {...}`，以及 `[mcp_servers]` 下的 `search-boost = {...}` / `search-boost.command = ...` 明确拒绝；识别单/双引号、转义键和点两侧空白。
- 根级 `mcp_servers = {...}` 是封闭内联容器，即使只有其他服务器也不能向它追加子表，因此同样拒绝。错误提示要求**转换而不是追加**表头，不输出配置值或凭据。
- 安装/卸载在写配置、改 skill/hook/rule、调用 Grok 插件管理器之前检查；Grok `--scope all` 先检查全部 scope，不能先删除一部分再报错。公开 CLI 和 dry-run 返回非零，交互入口也报告失败；原配置字节和现有资产权限保持不变。
- upgrade 的 discovery 对此产生 blocked 诊断和非零退出，不能把配置漏掉后声称完成。其他目标按原有逐目标策略处理，不承诺跨宿主全局事务。
- 支持的显式服务器表内，`env = {...}`、`env.TOKEN = ...` 和未知内联值仍保留；注释/字符串中的示例、近似服务器名、单个包含点的字面键及非全局 profile 路径不误判。两个字符串扫描器统一消耗合法的 3–5 连续引号结束串，避免多行字符串末尾的内容引号藏住后续真实登记，或误拒绝含此字符串的其他服务器。

回归 `scripts/test-toml-boundaries.mjs` 先用独立 Python `tomllib` 验证合法性，再验证编辑器拒绝、公开 Codex/Grok install/uninstall/dry-run、交互入口、upgrade、全 scope 预检和文件/资产字节权限不变。补充后共 **58 个隔离测试入口**通过。Linux 原生 Codex **0.157.0** 另验证 7 种内联/点键登记（含基本/字面多行字符串引号绕过样例）：原生 `mcp list --json` 在拒绝操作前后均成功，登记仍在且原文件字节/权限不变；没有真实凭据、MCP 执行或模型请求。拒绝不等于新增完整 TOML 编辑支持；本次不据此给整体发布放行结论。

## 验证层次与边界

- 定向回归、全部 **57 个隔离测试入口**、语法和 diff 检查。隔离测试验证模拟用户状态和源码未被修改；不代表所有供应商的在线行为。
- Linux 原生 **Codex 0.157.0**、**Grok 1.0.5**：三种表名的公开重装/卸载后宿主解析成功；原生 Codex `mcp add --env` → 公开卸载 → `mcp list --json` 成功且条目消失。只有合成凭据，没有模型或付费调用。这些版本不同于原报告，不冒充原报告的版本复测。
- `npm pack` 精确候选逐文件与源码核对，并检查入口、hooks/prompts/skills/templates、可选 PDF 依赖、敏感文件排除和权限。最终 tgz SHA256 与最终 Git SHA 保存在交付记录中，不能复用中间包哈希。
- 使用**真实 npm/npx**和隔离 HOME/global prefix/cache/registry，将公开 `0.2.3`、`0.2.4-beta.4` 升级到精确 beta.5 tgz；核对完整载荷、配置/合成凭据/禁用偏好，并在新的 Node 进程重新注册 Pi 工具。registry 的 `latest` 仍指向 `0.2.3`，测试入口显式选择 `beta`；没有手工替换文件冒充升级。
- 正常 `upgrade` 读取 `latest`，不是 beta 订阅。测试用户应在 beta 发布后显式使用 `npx --yes --package=search-boost@beta -- search-boost upgrade -y`。本轮没有执行 npm publish 或 dist-tag 修改。
- 推送后必须检查**最终 SHA**的 Windows/macOS/Linux CI，不能继承 1856 的结果。首轮 `1a1b549` 的 Linux/macOS 通过，Windows 暴露普通 Number 文件 ID 的精度碰撞；补丁改用 BigInt 精确 ID，同时保留 canonical path 去重、零 ID 保护和硬链接拒绝。回归注入相邻的 64 位 ID 与零 ID，且核对真实硬链接；最终以补丁 SHA 的三平台 CI 为准。CI 成功不是原生 GUI 或长期在线实测。

配置链接支持范围为 MCP 配置路径；其他升级管理资产（hooks、skills、指令文件）仍要求普通文件。Grok 陈旧本地缓存仍需用户明确批准来源后的保留数据重装，不自动授予 trust。Codex 云端执行、Antigravity 登录会话、真实付费搜索/Jev/xAI、原生 Windows/macOS Desktop GUI 和长期外部并发编辑不在本轮实测放行范围。

发布 npm 及发布后 beta/latest/tarball 核验仍须另行授权。本轮完成仅意味着报告所列修复、有限复验和 GitHub 提交完成，不宣称零缺陷或全部宿主组合均已认证。
