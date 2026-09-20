# Pi / DSH：可连续复用的 SearchBoost 升级

这里升级的是 **SearchBoost 在 Pi/DSH 中的集成**，不升级宿主 CLI 本身。

## 用户入口

```bash
search-boost                         # TUI → Update（所有已接入 agents，含 Pi/DSH）
search-boost upgrade --dry-run
search-boost upgrade -y
# npm 已更新，或使用本地版本且不需要下载：
search-boost upgrade --sync-only -y
# 未记录过的项目：
search-boost upgrade --workspace /path/to/project -y
```

`pi-search-boost`、`dsh-search-boost` 到 `search-boost` 的适配器升级也属于 TUI Update。`migrate` 仅服务全局 `search-boost-mcp` npm 包更名，见[迁移说明](migration.md)。

发布新版本后仍使用相同入口，不需要重新编写一次性迁移脚本。升级完成后重启/重新加载宿主。注册改成本地包路径后，应由 `search-boost upgrade` 管理后续升级；不要把宿主对 npm 扩展的更新当作这些本地路径也已同步的证据。

## 共用流程

1. `lib/upgrade/index.mjs` 检查 npm 版本；需要下载升级时，从 **npx 缓存中的新包进程**运行更新器，验证全局安装后交给新包同步所有已有 agents，避免继续运行内存中的旧升级代码。
2. `lib/package-identity.mjs` 统一识别来源：npm/git 名称、本地包根目录、manifest 声明的 Pi extension、相对路径、file URL、受管 shim。版本不参与身份匹配；最近的外部 package.json 是边界，不能因为上层目录属于 SearchBoost 就接管用户扩展。
3. `lib/upgrade/integrations.mjs` 读取实际注册、校验目标包、拒绝降级，备份后更新；不触碰凭据、权限、用户模型配置。
4. 成功写入的准确路径与版本保存在 `~/.search-boost/state/package-sources.json`（支持 `SEARCH_BOOST_HOME`）。下一次旧目录失效时，只按**相同作用域、相同路径**恢复身份，不按文件名猜测。
5. 只有仍存在的宿主注册会成为升级目标。记录不能使已经卸载的集成重新出现；已有外部包/用户文件也不能被记录强行认领。

来源记录采用版本化 schema 和原子写入，并纳入注册事务的备份/恢复。全局 npm 更名另会记录已验证的旧包根目录/扩展入口，因此即使 migrate 先删除了全局旧包，后续 TUI Update 仍可识别其本地注册；migrate 本身不改 agent 配置。损坏或不支持的 schema 会明确报错，而不是猜测内容。已有安装在首次成功同步后获得记录；在此之前已经删除、且没有其他归属证据的任意本地路径不能安全自动认领。

## Pi

- 按用户和项目 scope 处理 `packages`、`extensions`、受管 shim，以及可证实归属的旧手工拷贝。
- 直接登记 `adapters/pi/index.js` 后，下次仍能找到包根目录，不依赖当前进程的安装路径。
- 保留对象形式的资源过滤、`autoload`、`[]` 禁用和直接 extension 的精确 include/exclude 前缀。冲突的双重注册会阻止升级，不擅自选一份启用。
- 检查实际来源版本，而不是用无关的 npm 缓存版本替代当前生效来源。受管目录被删除后仍可用记录中的版本拒绝降级。
- 从目标发行目录复制拥有标记的 agent/prompt 模板；用户自有文件不覆盖。手工目录整体归档到备份中，不删除其中用户添加的文件。
- 来源解析同时供状态检测、安装去重和卸载使用，升级后不会失去管理能力。

Pi 来源、作用域和过滤规则参考本机所装 Pi 的 `docs/packages.md`、`docs/settings.md`；不要依赖某个固定 CLI 版本的默认更新行为。

## DSH

逐一处理已登记 SearchBoost 的 profile，用宿主的 `dsh plugin --profile <name> add <目标目录>` 更新本地链接，再验证：

- profile manifest 的依赖来源确实切换到了目标目录；
- `node_modules/search-boost` 的真实解析位置指向目标包，而不是同版本旧副本；
- 包名、版本以及必需 adapter 文件完整；
- bundle 顺序和原来的启用/禁用选择保留；
- 旧依赖清理后再次验证来源与载荷，不能只相信子进程退出码。

DSH 不一定会重新启用已经安装但禁用的 bundle；这不是失败。升级不以“出现在启用列表里”作为必要条件，也不会替用户启用它。

配置文件可回滚，包管理器对 `node_modules` 的副作用不能假装完全事务化。旧依赖清理发生在新注册验证通过之后；清理失败时保留新注册，报告部分失败及备份位置。解决阻塞后重跑相同命令。

宿主命令契约：[DSH CLI reference](https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/cli/reference/README.md)。

## 回归门禁

```bash
npm run test:upgrade
```

包括旧包迁移、全局 npm 接管，以及 `scripts/test-host-upgrade.mjs`：

- 不使用仓库当前版本号作为唯一 fixture；模拟 `1.0.0 → 2.0.0 → 3.0.0`。
- 三个不同安装目录；删除所有旧目录后，用新进程验证下一次仍能发现注册。
- Pi package、直接路径、相对路径、file URL、排除前缀、shim、手工目录；DSH 启用和禁用 profile。
- 新进程实际 import fixture adapter，确认加载版本；不仅断言配置里出现新字符串。
- 同版本重试、dry-run、防降级、包管理器假成功、同版本错误链接、部分失败恢复、外部文件保护和卸载后不复活。

这些是隔离的回归测试，宿主包管理命令被替身替换，不证明用户机器上真实 Pi/DSH 已完成重启或加载。
