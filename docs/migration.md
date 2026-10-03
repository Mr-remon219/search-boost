# 一次性 npm 迁移与后续更新

## 三个明确的责任边界（beta.7 起）

| 操作 | 负责范围 |
| --- | --- |
| 用户执行 npm install | 更新 SearchBoost 软件包版本，beta 用 `search-boost@beta` |
| TUI 管理 Agent 接入 → 刷新，或 `search-boost refresh` | 以当前包同步已有接入；含 Pi/DSH 旧适配器身份迁移，保留用户配置 |
| CLI migrate | 一次性将全局 search-boost-mcp 更名为 search-boost；不编辑 Agent 配置 |

管理入口先选安装 / 刷新 / 卸载。TUI 刷新可选精确 scope/profile；未接入的宿主不自动安装，取消勾选不卸载。`upgrade` 自更新命令和 `--sync-only` 已移除。

## 旧 npm 包用户

只需要新 `search-boost` 已发布，不需要为旧包再发布过渡版：

```bash
npx --yes --package=search-boost@beta -- search-boost migrate --dry-run
npx --yes --package=search-boost@beta -- search-boost migrate -y
search-boost
# 以后在 TUI 选择管理 Agent 接入 → 刷新
```

不带 `-y` 会确认；`migrate` 不接受 `--sync-only`。可以附加 `--workspace /path/to/project`。不要先手动卸载旧包，也不要用 `--force` 覆盖冲突命令。

迁移不在 npm postinstall 中自动执行。`migrate.mjs` 随新包发布，但从非缓存目录执行时也会交给 npx 缓存工作进程，避免从将被 npm 替换的目录运行交接代码。

## 执行顺序与恢复

1. 确认当前 npm prefix 下的旧包身份、新版本可用性和操作锁。新旧 npm 包版本属于不同发布序列，不互相比较大小；已有更高版本的新包不会被降级。
2. 运行 npx 缓存中的更新代码。内部使用等价的 `npm exec --package=search-boost@精确版本`，在空工作目录中解析包以避免项目包/命令遮蔽；随后恢复原工作目录用于发现项目接入。
3. 若 `search-boost` 命令仍属于旧包，先核对链接/受支持的 npm shim 归属，再在同目录暂存它。只处理经确认的同名命令，不接管用户或其他包的文件。
4. 正常 npm 全局安装新包，校验包名、版本、必需适配器、命令归属和 `--version`。失败则恢复已暂存的旧命令；旧包尚未删除。
5. 在 `state/package-sources.json` 记录旧全局包经过验证的准确根目录和扩展入口。**不编辑任何 agent 配置，也不在 migrate 中升级 Pi/DSH。** 这些记录让随后 TUI 刷新 仍能识别指向已删除目录的本地注册。
6. 新包和命令验证通过后，执行 npm 全局卸载 `search-boost-mcp`。随后以 `npm rebuild --global --ignore-scripts --bin-links=true search-boost` 重建并验证新命令，防止旧包卸载顺带移除共享 bin。
7. 用户打开 `search-boost`，选择 TUI **管理 Agent 接入 → 刷新**，统一更新所有已接入 agents，包括 `pi-search-boost` / `dsh-search-boost`。这一步的目标冲突/部分失败明确报告，可修复后重试；不会把全局旧包重新装回去。
8. 已完成迁移后重跑 `migrate` 只核验/修复已有新命令，不变成日常版本更新。

暂存命令是同一 bin 目录下带唯一后缀的备份，正常成功或回滚后移除。若进程被强制终止，残留的 `.search-boost-migrate-*` 文件可用于诊断/恢复，脚本不会按通配符删除它们。配置备份仍位于 `~/.search-boost/backups/`。包管理器失败可能留下部分安装状态，错误不会被报告为完成；重试前应处理明确报告的冲突。

migrate 保持 agent 配置及 API keys、X token、认证文件、模型设置、搜索层、权限和禁用状态不变。之后的 TUI 刷新 才更新确认归属的接入路径/资产；私有 Pi/DSH 旧依赖也只有在这一步验证替代注册后才清理。请先完成接入刷新，再重启 agents；其旧路径在两步之间可能暂时不可用。

只操作当前 npm prefix。使用其他 Node/npm prefix 安装的旧包，需要切换到对应环境迁移。扫描已知用户配置、DSH profiles、当前/已记录项目及指定 workspace；不会遍历磁盘寻找无法验证归属的手工配置。

## 新包用户的日常更新

```bash
npm install -g search-boost@beta --prefer-online
search-boost                         # 管理 Agent 接入 → 刷新 → 选范围
search-boost refresh -y              # 刷新全部已有接入
search-boost refresh --dry-run       # 仅预览
```

刷新始终只用当前持久安装的包，不做软件包更新或下载新版本接力，不新增宿主。若要稳定频道，用 npm `search-boost@latest`；本 beta 发布不推进 stable dist-tag。Grok 额外的缓存重建需单独明确同意，不由 `-y` 自动授权。来源识别、禁用状态和失败恢复见 [host-upgrades.md](host-upgrades.md)。

## 发布与验证

只发布仓库根目录的 **`search-boost`**，不构建或发布 `search-boost-mcp` 过渡版。本版新管理行为需安装已发布的 `@beta`，稳定 `latest` 不随此 beta 发布更新；开发测试不执行 npm publish。

```bash
npm run test:refresh
```

- `test-upgrade.mjs`：全体已接入 agents、配置保护、dry-run、禁止普通软件包更新。
- `test-host-upgrade.mjs`：Pi/DSH 多版本、多目录升级、缺失旧目录、禁用状态和失败恢复。
- `test-migration.mjs`：临时 HOME/cache/global prefix、loopback fixture registry、真实 npm/npx 安装与卸载；从仍占用同名 bin 的旧包直接迁移，验证命令安装失败回滚、外部命令保护、新包可执行且旧包删除、所有 agent 配置字节未变；然后单独执行 refresh，验证全部接入、已删除旧目录的注册、部分失败重试及后续当前版本接入刷新。DSH CLI 是测试替身；不修改开发者的真实安装。
- `test-manage-tui.mjs`：两种布局、精确选择、并发中新目标不扩大范围、未勾选原生插件不派发、部分安装失败及 CLI 确认取消不硬退出。

npm 行为依据：[npm exec](https://docs.npmjs.com/cli/v11/commands/npm-exec)、[npm rebuild](https://docs.npmjs.com/cli/v11/commands/npm-rebuild)。Linux 与 Windows 均已验证真实 npm 链路（Windows 由 CI `windows-latest` 的 `test:refresh`/`test-migration` 覆盖，含 `.cmd` shim 所有权校验与 junction 软链）。
