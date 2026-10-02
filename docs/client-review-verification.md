# Antigravity / Grok 接入审查修复

本轮针对 `b744413` 的 9 月 30 日审查继续修复。没有发布 npm、改变用户真实接入配置或调用模型 API。GitHub 修复不代表 npm 的 `0.2.4-beta.4` 已包含这些代码；正式发布必须使用新版本号。

## Antigravity 路径与迁移

- 默认使用 `~/.gemini/config/mcp_config.json`，无论旧文件是否存在。旧文件存在不能证明用户正在使用旧宿主，也可能是以前安装器误写的结果。
- 安装、重装、正式 upgrade 和 `upgrade --sync-only` 都会迁移旧文件中的 SearchBoost 条目；只移除该条目，保留两边的无关服务器、偏好、环境变量、禁用状态和其他字段。现代文件中同名字段优先。远程或损坏的条目拒绝自动替换。
- 两份配置写入前均验证，私有备份；第二份写入失败时恢复原始字节。已有配置的符号链接保留；两个路径指向同一个文件时拒绝迁移。
- 真正仍读取旧路径的宿主需显式运行：
  ```sh
  search-boost install -t antigravity -y --antigravity-config legacy
  ```
  选择保存在 `$SEARCH_BOOST_HOME/config/antigravity.json`，之后的刷新沿用它。切回现代路径用 `--antigravity-config modern`。这是单一路径选择，不是同时配置两种宿主；选择 legacy 会移走现代文件中的本插件条目。无关配置不移动。`.migrated` 或文件存在性不会覆盖用户明确选择。

## Grok 名称、缓存与信任边界

- manifest 的 `author` 使用对象。卸载使用宿主列出的 `name`，不使用 `repo_key`；旧错误作者格式造成的 slug 通过来源或缓存 manifest 身份发现。
- 本地同来源刷新首先运行原生 `plugin update <name>`。成功还需名称、来源和缓存的实际文件集合/字节均匹配当前插件，不只比较版本号。额外旧文件、陈旧 skill、缺少缓存路径都不能报成功。
- 默认升级不加 `--trust`、不调用 enable、不先卸载已有插件。原生 update 不能换掉缓存时，升级明确失败并给出手动操作，而非声称已更新。
- **已确认的宿主限制**：Grok 1.0.5 对本地来源的 update 可退出 0 而不替换缓存；`uninstall --keep-data` 后，未带 `--trust` 的 install 会拒绝重装。因此无法在“不新增信任”的默认升级里自动完成这条路径。
- 仅在用户明确批准当前来源后，完全退出 Grok，先备份宿主数据，再执行错误信息里的准确名字/来源命令：
  ```sh
  grok plugin uninstall <列出的插件名> --keep-data
  grok plugin install <当前软件包的绝对 grok-plugin 路径> --trust
  search-boost upgrade --sync-only -y
  ```
  `--keep-data` 属于卸载；`--trust` 属于安装，必须显式批准。不同来源、旧 slug 迁移亦可能遇到此边界。默认流程不宣称这些安装已经迁移成功。

## 自动回归与 Windows 清理

`scripts/test-client-review-regressions.mjs` 覆盖首次安装、旧错路径重装/正式刷新迁移、显式旧宿主选择、跨文件回滚、作者对象、旧 slug、禁用保留、缓存字节与额外旧文件、无信任授予、原生卸载名字及零退出假成功。

测试使用临时 HOME 和假宿主，结束前先切回原工作目录，再删除包含 project 的临时 base，避免 Windows `EBUSY`。纳入安装与全量隔离门禁；Linux 本地通过不等于 Windows CI 已通过。

## 真实 Grok 验证边界

使用本机已有 **Grok 1.0.5 (`5115b46bc9`)**，在独立 HOME / GROK_HOME / 项目、空凭据环境下验证了：

- 对象作者通过 validate，并出现 2 个 skills / 1 个 MCP 的组件清单；名字卸载成功，仓库 key 卸载失败。
- 同来源更新退出 0 后，新 skill 标记仍未出现在缓存；不能据此前一轮原生更新成功记录声称载荷已换新。
- 卸载带 `--keep-data` 成功，随后不带信任的重装退出 1；明确批准的隔离重装才得到新缓存。未改用户真实信任、配置或已安装包。

这些是宿主管理与缓存证据，不是付费模型会话、实际工具调用或运行中热加载证明。Antigravity 登录会话、Codex 云限制、Windows/macOS 原生 Desktop GUI 仍不在本轮本机验证范围。审查方的实际跨版本结果不能替代本轮门禁，也不能证明公共 npm 已更新。
