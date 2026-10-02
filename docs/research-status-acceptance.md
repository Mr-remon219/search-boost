# 研究结果与安装状态：接入、验收及边界

此前独立保留的产品草稿现已接入公开入口。它们分别属于可靠性修复、新增保存能力和诊断增强，不应统称为同一个 bug 修复。此前 CLIENT/RUNTIME 报告修复仍见 [1856 修复记录](release-review-1856-fixes.md)。

## 1. 研究派发依赖

- Pi `search-parallel-subagent`、DSH `research_parallel`：含 searcher 的波次先检查共享 `fused_search` / `fetch_page` 开关；DSH 同时检查父范围内的工具登记。
- 初始依赖关闭时零派发；每个 searcher 启动前再次检查，捕获后续偏好变化。已有子任务正常完成，尚未启动的任务报告失败，不丢弃已启动同伴的结果或清理。
- 无工具 summarizer 不要求这两个依赖。预取消不启动子任务。
- 不启用关闭的工具、不扩大权限。工具入口开关与内部引擎能力仍是不同概念。

## 2. 显式保存与恢复

```json
{"questions":["一个研究问题"],"intent":"研究方向（必填）","preferences":["官方来源"],"save_results":true}
```

新运行现在直接写 `search-boost-research-v2` 且 `metadata.schemaVersion=5`；旧的 `search-boost-research-v1` 文件仍按只读历史分支读取（`restoration.historical=true`、`h1:` cursor、保留原 schema 版本），不会就地升级，也不会伪造 v5 字段。返回 `inputSummary` 与成功保存后的 `savedResultId`。空结果也可显式保存，但会披露空快照警告；保存成功不代表搜索成功，应查看 stopReason。保存完整选中结果集，而不是首屏；快照只保留公开材料和类型化元数据，不保存活游标、未知字段、内部日志或配置密钥。问题、意图、偏好与摘录本身可能敏感，应按私有研究数据管理。`constraints` 作为逐材料硬门槛已退役：非空数组在任何网络前被拒绝，省略或 `[]` 仅告警。

```json
{"saved_result_id":"<savedResultId>","page_size":20}
```

在同一 SearchBoost home 中恢复本地结果并生成新游标；之后按 `nextCursor` 翻页。恢复不进行搜索或 Jev 请求。cursor 与 saved_result_id 不能混用，也不能混入新研究输入或 save_results。快照与原有进程内游标是不同能力：`s5:`/`h1:` 分页游标仍有30分钟/32份保留限制；快照不会因进程重启失效，也不会自动更新为最新资料。

**公开工具入口仍遵循显式开关和 Jev 配置锁。** 删除 Jev 配置时不会为了恢复而自动解锁/开启工具。下列 CLI 命令无需 Jev，可以离线列出和读取导出快照：

```sh
search-boost research list
search-boost research export <savedResultId> --output <new-file.json>
```

- 路径：`$SEARCH_BOOST_HOME/state/research/<UUID>.json`，默认 home 为 `~/.search-boost`。
- 单快照最多64MiB，原子私有写入；POSIX 文件0600、创建目录0700。Windows 权限依赖 ACL，不据此宣称完成原生 ACL 验收。
- 默认不保存。保存失败或取消不生成成功 ID；失败保留已算出的页面并给出警告。
- 缺失、损坏、超限、符号链接/硬链接文件及非普通状态目录被拒绝，不转为一次新搜索。读取和导出重新验证公共契约，递归剥离未知字段。
- 导出须显式指定新文件，以独占创建拒绝覆盖已有文件/链接。不自动上传、删除或清理快照；用户可自行删除对应文件。
- `inputSummary.constraintPolicy=explicit_per_material` 只说明显式文档约束语义，不代表结果已被事实核实。`retrievalSufficient`、进度及阈值仍不是答案完整性或真实性证明。

## 3. 安装状态入口

- CLI：`search-boost status`、`search-boost status --json`。
- 双语 TUI：更新与状态 → 查看当前状态。
- 显示当前命令所属包、宿主登记、可定位磁盘包版本及载荷比对。版本号相同不代表字节一致；旧版/缺失/不可核验证据分别披露。
- 只读配置、目录和磁盘载荷，不启动宿主、不调用插件安装命令、不改动禁用项、凭据或登记。配置诊断仅输出警告数量，不回显原始错误/配置内容。
- `loadedVersion:null`，重载/重连未证实。磁盘比对不是运行中宿主握手；DSH owning-host 解析、Grok 原生插件缓存不能由 profile 文件推断。

## 验证记录

- 本地60个隔离测试入口通过，模拟用户状态及源树未变化；230个 JS/MJS 文件语法检查通过，diff 检查通过。
- `test-parallel-research.mjs`：Pi/DSH 真实适配路径、初始零派发、DSH 范围限制、预取消、无工具摘要、晚变更拒绝及同伴清理。子进程/原生服务为确定性测试替身，无模型调用。
- `test-research-persistence.mjs`：选择器产生的认可材料（排除拒绝/待判材料）、全量快照与分页、重启/缓存清空、MCP/Pi/DSH 公开恢复、类型契约、未知字段/日志剥离、开关、CLI 导出、不覆盖、大小/损坏/链接/目录/失败保存/取消。
- `test-installation-status.mjs`：真实 CLI JSON/文本及双语 TUI，带注释的多行/转义 TOML、旧 Pi 磁盘包、禁用 DSH、含秘密的损坏配置、只读性和未知运行版本。
- 真实 DSH SDK 输出与 schema 编译回归通过。上述材料与服务均为隔离夹具，不是付费搜索/Jev 的质量、成本实验，也不是 Windows/macOS GUI 或已运行会话的加载证明。

独立只读审查已完成（工作流 `dc8725c8-726d-4007-b103-911e524228d5`、reviewer `ba322e77-45eb-4cf2-ae66-6f9bf655fe7a`），结论为 OK with notes，无源码阻断问题。依据审查补充空快照警告、状态检查路径/旧版标记及对应回归，并清理未用代码。提交时须显式包含新增模块和测试，防止缺失载荷。每快照64MiB不等于总存储限制；list 会读取各快照，用户需自行管理积累的数据。新提交的三平台 CI 结果另行记录。

这份记录不构成整体发布放行：不发布 npm、不修改 dist-tag、不自动合并、不更新用户已安装的宿主。
