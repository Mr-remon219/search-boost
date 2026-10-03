# Pi / DSH：可连续复用的 SearchBoost 升级

这里升级的是 **SearchBoost 在 Pi/DSH 中的集成**，不升级宿主 CLI 本身。

## 用户入口（beta.7 起）

```bash
npm install -g search-boost@beta --prefer-online  # 用户更新软件包
search-boost                         # 管理 Agent 接入 → 刷新已有接入 → 选范围
search-boost refresh --dry-run
search-boost refresh -y              # 全部已有接入
search-boost refresh --workspace /path/to/project -y
```

刷新只使用当前持久安装的包，不查询 npm 最新版本、不自动更新 SearchBoost，不更新宿主 CLI。临时 npx 路径不能成为持久接入目标。`upgrade` / `--sync-only` 已移除。

旧 Pi/DSH 适配器来源迁移属于接入刷新；`migrate` 仅服务全局 `search-boost-mcp` npm 包更名，见[迁移说明](migration.md)。TUI 可选择精确 scope/profile；取消勾选不卸载，之后新发现的目标不会扩大选择。成功后重启/重新加载宿主；不要将宿主更新 npm 扩展当作本地资产也已同步的证据。

Grok 原生插件是单独可选项。原生更新后缓存仍不一致时，默认明确失败；完全退出 Grok后，可以单独确认 `--keep-data` / `--trust` 重建。CLI 显式同意为 `search-boost refresh -y --repair-grok-cache`，`-y` 本身不授予信任或重建同意。禁用插件不重装、不启用；不同来源、无法验证的仓库身份、共享仓库插件或危险别名拒绝自动重建。重建先验证源、绑定确认时的指纹，再验移除与新缓存；失败后报告实际阶段，不宣称回滚。旧名称数据保留原址，不保证自动迁移复用。刷新不会安装已不存在的插件，需审核源后通过安装入口重新接入。

## 共用流程

1. `lib/upgrade/index.mjs` 从当前软件包发现已有接入、按用户选择过滤，使用锁、备份、事务与载荷验收刷新；记录 `state/last-refresh.json`，部分成功不会显示为全部成功。
2. `lib/package-identity.mjs` 统一识别来源：npm/git 名称、本地包根目录、manifest 声明的 Pi extension、相对路径、file URL、受管 shim。版本不参与身份匹配；最近的外部 package.json 是边界，不能因为上层目录属于 SearchBoost 就接管用户扩展。
3. `lib/upgrade/integrations.mjs` 读取实际注册、校验目标包、拒绝降级，备份后更新；不触碰凭据、权限、用户模型配置。
4. 成功写入的准确路径与版本保存在 `~/.search-boost/state/package-sources.json`（支持 `SEARCH_BOOST_HOME`）。下一次旧目录失效时，只按**相同作用域、相同路径**恢复身份，不按文件名猜测。
5. 只有仍存在的宿主注册会成为升级目标。记录不能使已经卸载的集成重新出现；已有外部包/用户文件也不能被记录强行认领。

来源记录采用版本化 schema 和原子写入，并纳入注册事务的备份/恢复。全局 npm 更名另会记录已验证的旧包根目录/扩展入口，因此即使 migrate 先删除了全局旧包，后续 TUI 刷新 仍可识别其本地注册；migrate 本身不改 agent 配置。损坏或不支持的 schema 会明确报错，而不是猜测内容。已有安装在首次成功同步后获得记录；在此之前已经删除、且没有其他归属证据的任意本地路径不能安全自动认领。

## Pi

- 按用户和项目 scope 处理 `packages`、`extensions`、受管 shim，以及可证实归属的旧手工拷贝。
- 直接登记 `adapters/pi/index.js` 后，下次仍能找到包根目录，不依赖当前进程的安装路径。
- 保留对象形式的资源过滤、`autoload`、`[]` 禁用和直接 extension 的精确 include/exclude 前缀。冲突的双重注册会阻止升级，不擅自选一份启用。
- 检查实际来源版本，而不是用无关的 npm 缓存版本替代当前生效来源。受管目录被删除后仍可用记录中的版本拒绝降级。
- 从目标发行目录复制拥有标记的 agent/prompt 模板；用户自有文件不覆盖。手工目录整体归档到备份中，不删除其中用户添加的文件。
- 来源解析同时供状态检测、安装去重和卸载使用，升级后不会失去管理能力。

Pi 来源、作用域和过滤规则参考本机所装 Pi 的 `docs/packages.md`、`docs/settings.md`；不要依赖某个固定 CLI 版本的默认更新行为。

## DSH

逐一处理已登记 SearchBoost 的 profile，与 Install 共用包来源和启动逻辑。**Desktop 的保留 `desktop` profile 始终使用桌面版 bundled command**：先启动应用初始化，再完全退出后操作；缺失命令或应用锁时报告阻塞，不回退到 npm DSH。本地持久安装以绝对包路径复用，更新保留原来的启用/禁用选择；其他 CLI profiles 保持以下行为。详见 [Desktop 接入说明](dsh-desktop.md)。

CLI 源码 checkout 使用 `dsh plugin --profile <name> add <目标目录>`；npm 发布安装使用 `add search-boost@<版本>`，不把全局安装或 npx 缓存目录写成本地链接。缺少全局 `dsh` 或 `pnpm` 时，通过 `npm exec` 临时提供缺失命令，无需全局安装宿主。随后验证：

- profile manifest 的依赖来源切换到了目标目录或指定 npm 版本（允许 pnpm 保存的 `^` / `~` 前缀）；
- 源码链接的真实解析位置指向目标目录，而不是同版本旧副本；npm 安装的实际载荷版本必须与指定版本完全一致；
- 包名、版本以及必需 adapter 文件完整；
- bundle 顺序和原来的启用/禁用选择保留；
- 旧依赖清理后再次验证来源与载荷，不能只相信子进程退出码。

DSH 不一定会重新启用已经安装但禁用的 bundle；这不是失败。升级不以“出现在启用列表里”作为必要条件，也不会替用户启用它。

配置文件（含 `pnpm-workspace.yaml`）可回滚，包管理器对 `node_modules` 的副作用不能假装完全事务化。旧依赖清理发生在新注册验证通过之后；清理失败时保留新注册，报告部分失败及备份位置。解决阻塞后重跑相同命令。

宿主命令契约：[DSH CLI reference](https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/cli/reference/README.md)。

## 回归门禁

```bash
npm run test:refresh
```

包括旧包迁移、全局 npm 接管，以及 `scripts/test-host-upgrade.mjs`：

- 不使用仓库当前版本号作为唯一 fixture；模拟 `1.0.0 → 2.0.0 → 3.0.0`。
- 三个不同安装目录；删除所有旧目录后，用新进程验证下一次仍能发现注册。
- Pi package、直接路径、相对路径、file URL、排除前缀、shim、手工目录；DSH 启用和禁用 profile。
- 新进程实际 import fixture adapter，确认加载版本；不仅断言配置里出现新字符串。
- 同版本重试、dry-run、防降级、包管理器假成功、同版本错误链接、部分失败恢复、外部文件保护和卸载后不复活。

`scripts/test-dsh-desktop.mjs` 覆盖 Desktop / CLI 分别安装和删除、Desktop 更新和旧名迁移、禁用状态、缺失命令/应用锁阻塞、dry-run、失败回滚及诊断输出不泄密。绝对 Desktop 命令和 profile 全部位于测试目录，不操作真实桌面宿主。

`scripts/test-dsh-upgrade.mjs` 另外通过真实子进程启动器覆盖全局命令齐全、仅 npm、缺少 pnpm、缺少 dsh 四种环境，分别验证 checkout 和 npm 包来源；同时检查禁用状态、同版本重试、dry-run、错误版本/缺失文件及失败回滚。命令端点使用隔离 fixture，不下载真实 DSH。

`npm run test:isolation` 为全部自动测试提供模拟用户 HOME、重定位状态目录与假凭据，验证测试不会修改继承的配置、接入记录或源码树；`test:install` 执行其中的安装子集。所有入口统一使用 `scripts/isolate-tests.mjs`，详见[测试隔离说明](test-isolation.md)。真实项目目录不可用时仍阻止升级完成，不自动删除失效记录。

这些测试不证明用户机器上真实 Pi/DSH 已完成重启或加载；宿主行为由隔离替身模拟，全局 npm 迁移另通过本地 fixture registry 执行真实 npm。
