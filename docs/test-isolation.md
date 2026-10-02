# 自动测试与用户环境隔离

## 入口与门禁

```bash
npm run test:isolation  # 全部自动测试 + smoke + fixture；入口数由门禁动态统计
npm run test:install    # 同一门禁，运行安装/删除/更新 Desktop 等安装子集
npm run check          # 语法检查
```

`test:isolation` 自动发现 `scripts/test-*.mjs`（排除门禁自身），并包含 MCP smoke、doctor smoke、Cursor fixture。Codex fixture 默认运行 `round-trip`；其余场景仍由 installer 测试执行。任何失败都会使门禁失败，不因某一套失败而跳过后续测试；可选工具缺失产生的 skip 仍显示。

所有自动测试及 fixture 的第一条语句（shebang 之后）必须是：

```js
import './isolate-tests.mjs'
```

这是静态 import 顺序要求，不是在函数体里临时设置 HOME。`lib/paths.mjs`、Grok 模型信息等会在模块求值时缓存路径，晚改 HOME 不能修复已经绑定的真实路径。新增入口必须遵循此规则，门禁同时核对 package.json 和 CI 中的直接 Node 测试入口。需要命令行参数的新 fixture 必须在门禁中显式配置。

CI 的 Linux / Windows / macOS 与 Linux Node 24 cell 各运行一次完整门禁；`prepublishOnly` 在语法、CI 策略与依赖审计后执行同一门禁，不再先改写生成资产。生成资产在临时副本重建并核对字节；工程标准见 [ci-cd-standard.md](ci-cd-standard.md)。各个 `test:*` 命令仍可单独运行，其入口也自行隔离，不能依赖调用者提前设置 HOME。

## 统一隔离边界

`scripts/isolate-tests.mjs` 在每个测试进程里创建唯一、私有的 `sb-test-*` 目录：

| 对象 | 隔离方式 |
| --- | --- |
| HOME、USERPROFILE、Windows 用户路径 | 指向独立测试 home |
| 当前项目 cwd | 指向空的测试 workspace，避免读取项目级凭据或写入当前仓库 |
| SEARCH_BOOST / Pi / DSH / CODEX_HOME / CLAUDE_CONFIG_DIR 配置覆盖与凭据 | 不继承；只保留 OS、工具链定位、语言与终端等少量环境变量 |
| XDG、APPDATA、CURL_HOME、pnpm/Corepack 路径 | 指向测试目录 |
| npm 用户／全局配置、缓存、全局安装 prefix | 使用私有空配置和测试目录，不继承 registry token |
| Git 全局／系统配置 | 空的测试全局配置，禁用系统配置 |
| TMPDIR、TMP、TEMP | 指向本次测试的子目录，连失败用例遗留的临时文件一起回收 |
| Grok、DSH、Pi 等宿主 CLI | PATH 前置拒绝执行的保护脚本，误调用返回 97 |
| Desktop 的绝对 bundled command | 权威命令覆盖指向测试目录中的缺失路径，阻止扫描/执行真实 `/Applications` 或 Windows 安装；测试启动命令必须显式替换为 fixture |

测试可以在这个外层边界内创建多个 HOME、切换配置或注入假凭据，以验证生产逻辑的覆盖优先级。原有局部 fixture 隔离仍可保留，但不再承担保护真实用户环境的责任。

测试宿主启动逻辑时，必须显式提供 fixture PATH／注入 runner；保护脚本会使 `commandExists()` 返回 true，不能用默认保护 PATH 证明“机器没有安装宿主”。源码读取使用模块相对的绝对路径／file URL，不应为了相对 import 把子进程 cwd 切回开发仓库。

每个入口独立建立隔离目录，不接受环境变量形式的“关闭隔离”或任意外部写入根目录。Cursor/Codex fixture 单独运行时也使用自己的 HOME，不再信任调用者提供的真实 HOME。进程正常结束、断言失败或显式 `process.exit()` 都清理本次目录。

## 验证不是只看测试返回 0

`scripts/test-environment.mjs` 在临时目录内模拟用户环境，放置：

- 已有升级项目记录、Cursor 安装记录、Pi 设置和 DSH profile；
- 重定位存储、规范／旧式配置、项目级密钥、Grok 登录文件；
- 假 provider 凭据、npm token、代理及 npm / XDG / 宿主路径覆盖；
- Desktop profile 与调用者绝对命令覆盖，证明它们不绕过测试 bootstrap。

然后逐个执行测试，并检查：

1. 所有自动测试先初始化隔离，再加载应用模块。
2. 模拟用户文件的内容哈希、模式、目录结构与符号链接保持不变。
3. 源码、测试、文档、发布资产、包清单等源文件树保持不变。
4. 测试输出没有携带模拟调用者的凭据。
5. 实际模块绑定到测试 HOME/cwd；真实宿主执行被阻止；失败退出也清理目录。
6. 负向对照：一个**仅存在于临时目录中的无隔离子进程**调用生产 `recordUpgradeProject`，观察器必须发现外部记录变化。之后恢复模拟文件，再执行正式测试。生产 bootstrap 没有绕过开关。

这能复现并拦住原来的问题：只修改 HOME，却继承 `SEARCH_BOOST_HOME`，测试通过且删除了项目目录，但把项目登记到了调用者的状态文件。

## 审查中封住的路径

- skill-bundles、startup-hooks 原先只替换部分环境变量。
- 多套测试只清理已知 API key，遗漏 `*_FILE`、Cursor 状态路径或其他宿主覆盖。
- CLI、doctor、MCP smoke 和可直接运行的 fixture 原先依赖调用者环境。
- 先静态导入应用、再设置 HOME，可能缓存真实用户路径。
- 子进程为相对 import 切回仓库，可能读取仓库中的兼容密钥文件。
- `npm pack` 在源码目录执行，可能读取开发者的项目 `.npmrc`；现在先将声明的包文件复制到干净目录再打包。

本次不改变生产配置的路径规则、不删除用户项目或 profile，也不依赖隐藏 Update 警告来掩盖污染。

## 有意保留的边界

- 这是**测试环境隔离与回归门禁，不是操作系统安全沙箱**。不防恶意测试代码显式访问绝对路径、第三方工具自行读取系统数据库，或 Node 在首条 import 之前执行的外部预加载代码。源码快照不包括依赖目录和 Git 内部文件。
- `SIGKILL`、系统崩溃或强制终止可能留下临时目录；这些目录内部的记录不会进入真实用户存储。不要使用宽泛的 `/tmp` 清理命令。
- 测试默认不继承用户的代理、CA、registry 或认证设置。DSH 打包 smoke 下载公开 npm 依赖，需要可用的公开 registry 网络；迁移测试使用本地 fixture registry。网络受限时应报告失败，不自动恢复真实凭据或偷偷绕过网络限制。
- `jev-probe.mjs` 是明确 opt-in 的真实联网操作，刻意不纳入自动测试，不能加入 CI／发布测试门禁。构建／发布资产脚本也不是隔离测试，不应混入 fixture。
- 本地通过不能替代 Windows/macOS CI 结果，也不能证明真实宿主已重启并加载新包。
