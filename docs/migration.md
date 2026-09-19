# 一次性 npm 迁移与后续更新

## 两个独立入口

| 操作 | 负责的范围 |
| --- | --- |
| TUI **Update**（或 `search-boost upgrade`） | 更新 SearchBoost，刷新全部已接入 agents；包括 `pi-search-boost` / `dsh-search-boost` 适配器到 `search-boost` 的升级 |
| CLI `migrate` | 仅将全局 npm 包 `search-boost-mcp` 换成 `search-boost`，保留用户配置，最终删除旧全局包 |

TUI 沿用现有英文 Clack 菜单，不增加单独的迁移页面，也不要求用户逐个选择待更新 agent。未接入的 agents 不会因为被检测到而自动安装。

## 旧 npm 包用户

只需要新 `search-boost` 已发布，不需要为旧包再发布过渡版：

```bash
npx --yes --package=search-boost@latest -- search-boost migrate --dry-run
npx --yes --package=search-boost@latest -- search-boost migrate -y
search-boost
# 以后在 TUI 选择 Update
```

不带 `-y` 会确认；`migrate` 不接受 `--sync-only`。可以附加 `--workspace /path/to/project`。不要先手动卸载旧包，也不要用 `--force` 覆盖冲突命令。

迁移不在 npm postinstall 中自动执行。`migrate.mjs` 随新包发布，但从非缓存目录执行时也会交给 npx 缓存工作进程，避免从将被 npm 替换的目录运行交接代码。

## 执行顺序与恢复

1. 确认当前 npm prefix 下的旧包身份、新版本可用性和操作锁。新旧 npm 包版本属于不同发布序列，不互相比较大小；已有更高版本的新包不会被降级。
2. 运行 npx 缓存中的更新代码。内部使用等价的 `npm exec --package=search-boost@精确版本`，在空工作目录中解析包以避免项目包/命令遮蔽；随后恢复原工作目录用于发现项目接入。
3. 若 `search-boost` 命令仍属于旧包，先核对链接/受支持的 npm shim 归属，再在同目录暂存它。只处理经确认的同名命令，不接管用户或其他包的文件。
4. 正常 npm 全局安装新包，校验包名、版本、必需适配器、命令归属和 `--version`。失败则恢复已暂存的旧命令；旧包尚未删除。
5. 在 `state/package-sources.json` 记录旧全局包经过验证的准确根目录和扩展入口。**不编辑任何 agent 配置，也不在 migrate 中升级 Pi/DSH。** 这些记录让随后 TUI Update 仍能识别指向已删除目录的本地注册。
6. 新包和命令验证通过后，执行 npm 全局卸载 `search-boost-mcp`。随后以 `npm rebuild --global --ignore-scripts --bin-links=true search-boost` 重建并验证新命令，防止旧包卸载顺带移除共享 bin。
7. 用户打开 `search-boost`，选择 TUI **Update**，统一更新所有已接入 agents，包括 `pi-search-boost` / `dsh-search-boost`。这一步的目标冲突/部分失败明确报告，可修复后重试；不会把全局旧包重新装回去。
8. 已完成迁移后重跑 `migrate` 只核验/修复已有新命令，不变成日常版本更新。

暂存命令是同一 bin 目录下带唯一后缀的备份，正常成功或回滚后移除。若进程被强制终止，残留的 `.search-boost-migrate-*` 文件可用于诊断/恢复，脚本不会按通配符删除它们。配置备份仍位于 `~/.search-boost/backups/`。包管理器失败可能留下部分安装状态，错误不会被报告为完成；重试前应处理明确报告的冲突。

migrate 保持 agent 配置及 API keys、X token、认证文件、模型设置、搜索层、权限和禁用状态不变。之后的 TUI Update 才更新确认归属的接入路径/资产；私有 Pi/DSH 旧依赖也只有在这一步验证替代注册后才清理。请先完成 Update，再重启 agents；其旧路径在两步之间可能暂时不可用。

只操作当前 npm prefix。使用其他 Node/npm prefix 安装的旧包，需要切换到对应环境迁移。扫描已知用户配置、DSH profiles、当前/已记录项目及指定 workspace；不会遍历磁盘寻找无法验证归属的手工配置。

## 新包用户的日常更新

```bash
search-boost                         # TUI → Update
search-boost upgrade -y              # CLI 等价入口
search-boost upgrade --sync-only -y  # 只刷新当前版本资产，不联网检查 npm
```

即使已是最新版本，Update 仍会刷新已接入 agents。需要更新程序时，先把执行权交给 npx 缓存中的新版本；全局安装完成后，用新包自己的代码更新 agent 资产，不继续使用内存中的旧模块。正在运行的旧 TUI 随后退出，重新打开即可。

Pi/DSH 的来源识别、禁用状态、失败重试及跨目录连续升级见 [host-upgrades.md](host-upgrades.md)。

## 发布与验证

只发布仓库根目录的 **`search-boost`**，不构建或发布 `search-boost-mcp` 过渡版。`@latest` 只有在真实发布后才提供这些功能；开发测试不执行 npm publish。

```bash
npm run test:upgrade
```

- `test-upgrade.mjs`：全体已接入 agents、配置保护、dry-run、缓存工作进程交接。
- `test-host-upgrade.mjs`：Pi/DSH 多版本、多目录升级、缺失旧目录、禁用状态和失败恢复。
- `test-migration.mjs`：临时 HOME/cache/global prefix、loopback fixture registry、真实 npm/npx 安装与卸载；从仍占用同名 bin 的旧包直接迁移，验证命令安装失败回滚、外部命令保护、新包可执行且旧包删除、所有 agent 配置字节未变；然后单独执行 Update，验证全部接入、已删除旧目录的注册、部分失败重试及后续普通版本更新。DSH CLI 是测试替身；不修改开发者的真实安装。
- `test-update-tui.mjs`：沿用菜单语言/样式，Update 不缩小到某一个 agent，也不混入 npm 迁移菜单。

npm 行为依据：[npm exec](https://docs.npmjs.com/cli/v11/commands/npm-exec)、[npm rebuild](https://docs.npmjs.com/cli/v11/commands/npm-rebuild)。Linux 下验证了真实 npm 链路；Windows shim 的全流程仍需 Windows 环境验证。
