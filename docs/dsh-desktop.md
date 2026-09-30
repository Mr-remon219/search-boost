# DeepSeek Harness Desktop / CLI 接入

## 两个安装入口

### SearchBoost TUI

运行 `search-boost`，进入「安装与接入」，选择首次配置向导 / 安装 / 卸载（英文：Setup / Install / Uninstall）；选中 DSH 后，若发现 Desktop 且未指定 profile/surface，会进入 **Desktop / CLI / All** 选择页。

- **Desktop**：`$DSH_HOME/profiles/desktop`，通过桌面安装附带的命令操作。现有持久 SearchBoost 安装使用绝对本地包路径，避免再下载一份；临时 `_npx` 缓存不能用作持久链接，改用当前精确 npm 版本。
- **CLI**：安装默认 `web` profile，`--profile` 可指定其他 CLI profile。卸载只处理选中的 CLI profile，或所有已登记 SearchBoost 的 CLI profiles。
- **All**：分别管理 Desktop 与 CLI，分别报告成功/失败；一个失败不会掩盖另一个的结果。

命令行等价入口：

```sh
search-boost install -t dsh --dsh-surface desktop -y
search-boost install -t dsh --dsh-surface cli --profile web -y
search-boost install -t dsh --dsh-surface all -y
# 明确启用此前已安装但禁用的 bundle（不带此参数则保留禁用）：
search-boost install -t dsh --profile web --enable-dsh-bundle -y
search-boost uninstall -t dsh --dsh-surface desktop -y
search-boost uninstall -t dsh --dsh-surface cli -y
search-boost uninstall -t dsh --dsh-surface all -y
search-boost print dsh --profile desktop
```

不指定 surface 的非交互安装保持旧行为：默认 CLI `web`；`--profile desktop` 明确选择 Desktop。未限定 profile/surface 的卸载处理所有已有 DSH 登记。安装和删除均不删除 profile、会话、用户 patch、其他插件或 SearchBoost 凭据。

### Desktop 内添加插件

在 **插件 → 添加插件** 输入：

```text
search-boost
```

Desktop 自带的 pnpm 从所选 npm registry 解析默认发布版本，安装到 Desktop profile；下载和安装不依赖系统 npm/pnpm。若要指定版本，可输入 `search-boost@<version>`。完成后选择启用，按宿主提示重启。

已安装 SearchBoost 且要直接复用其代码时，在同一输入框粘贴 **SearchBoost 包根目录的绝对路径**，不是 `cli.mjs` 文件，也不是另一个 profile 目录。`search-boost print dsh --profile desktop` 会显示当前包路径。本地链接依赖该目录持续存在；不要把会删除的项目依赖目录或临时 dlx 缓存当作持久安装。删除/移动来源后需重新接入；npm 包名入口的独立副本不依赖这个外部目录。

包名入口不会自动查找或安装全局 npm SearchBoost。它可能安装独立代码副本；同一操作系统用户、相同环境覆盖下，两种入口仍共用 `~/.search-boost` 的配置、密钥和开关。Windows 与 WSL 是不同的宿主环境，不能据 Linux HOME 推断 Windows 配置路径；请在目标 Desktop 所在的系统运行安装命令。

## Desktop 的所有权与检测

Desktop 独占自己的 profile 和包管理状态。先运行应用一次初始化 profile，然后 **完全退出应用（包括系统托盘）**，再从 SearchBoost 安装/删除/更新它的插件。

SearchBoost 只读取 profile/安装路径，不为检测启动 Desktop，也不创建 Desktop profile。原生平台发现位置包括：

- Windows：用户 `LOCALAPPDATA/Programs/DeepSeek Harness/resources/runtime/cli/bin/dsh.cmd`，以及可用的 Program Files 路径。
- macOS：`/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh` 和用户 `~/Applications`。
- PATH 中指向 Desktop `resources/runtime/cli/bin` 的命令；macOS 登记的符号链接也可解析。
- 自定义/移动安装可设置 `SEARCH_BOOST_DSH_DESKTOP_COMMAND` 为 Desktop 自带命令的绝对路径。此覆盖是权威来源；路径无效时不会改用其他安装。

`desktop` 是保留 profile，不能通过 CLI surface 操作。CLI 别名目录或单独 manifest 通过符号链接、junction、硬链接指向 Desktop 时，也会在宿主执行/备份之前拒绝；链接形式的 canonical Desktop profile 仍会正常发现。路径身份使用 realpath 及可用的设备/inode，不宣称能识别所有容器/overlay 映射。

缺少 Desktop 命令、未初始化的 profile 或现存应用锁会阻止实际操作，**不会回退到 npm DSH，也不会擅自删除锁**。一个陈旧锁也不会由 SearchBoost 自动接管；先检查宿主状态。

若 PATH 实际选中的 `dsh` 就是 Desktop 自带 launcher，普通 CLI profiles 也直接使用它及内置 pnpm，不要求系统 pnpm/npm。仅仅检测到另一个 Desktop 安装，不会替换 PATH 上优先选中的独立 CLI。

## 安装验证与禁用状态

退出码为 0、profile 中有新包，都不足以证明宿主会加载新代码。官方 bundle 解析器先查 DSH 安装目录，再查 profile；安装目录旁的旧 SearchBoost 可能遮蔽 profile 的新版。

SearchBoost 在选定 launcher 的运行时调用它自带的 `resolveBundleDir`，检查实际解析路径、精确版本、bundle 元数据和 adapter 文件，并要求实际路径与刚安装的载荷具有相同 realpath。成功时显示路径和版本；旧包、同版本但不同目录的副本、缺失解析器或未返回探针结果，都不能报验证成功。冲突错误列出预期和实际路径/版本；请明确移除或更新宿主旁的冲突包后重试，SearchBoost 不自动改写宿主安装目录。

Desktop 验证复用官方 launcher 指向的应用二进制及 ASAR carrier，以 `ELECTRON_RUN_AS_NODE=1` 和显式 `--import` 运行一次性探针，不依赖打包 Electron 受限的 `NODE_OPTIONS`。非标准 Desktop launcher 布局会拒绝验证；覆盖变量仍须指向官方 bundled launcher。探针不会启动 profile 或导入 SearchBoost 工具。这是**下次启动的来源验证**，不是证明已有进程已热更新；代码变化仍需重启宿主。

已存在但禁用的 bundle 更新后，报告“已安装并验证，但禁用”，仍算安装成功，不自动启用。可在宿主插件管理器启用，或明确使用 `--enable-dsh-bundle`；后者通过宿主的 manifest 锁与原子写入 API 修改选择，并在启用前解析实际 bundle patch。其他 bundle 的顺序、用户配置与 patch 保留。

## 更新与删除

TUI Update / `search-boost upgrade` 自动发现所有已登记 SearchBoost 的 DSH profiles，并逐个选择其拥有者：Desktop 使用 bundled command，CLI 沿用普通 DSH / npm-exec 路径。不升级 Desktop 本身，不改变其他 profile 的宿主运行时。

更新同时验证依赖来源、profile 载荷与宿主实际解析的路径/版本及 adapter 文件；保留 bundle 顺序、启用/禁用选择和用户 patch。旧适配器依赖只在新包验证后清理。缺失命令或应用锁在 profile 备份/写入之前阻止同步；完整升级仍可能已完成全局 SearchBoost 更新，需按结果解决阻塞后重试同步。

卸载在宿主命令成功后重新读取 manifest，拒绝“退出码为 0 但仍登记”的假成功。卸载不移除共享的 SearchBoost 安装和配置。

宿主原始 stdout/stderr 可能含认证信息，不复制进 SearchBoost TUI 日志/异常；失败报告退出码和操作状态。需要详细诊断时，在本机直接运行相同宿主命令，分享输出前先检查秘密。

## 验证与限制

```sh
npm run test:dsh-desktop
npm run test:install
npm run test:isolation
```

全部测试先加载 `scripts/isolate-tests.mjs`。Desktop 绝对路径发现额外使用指向测试目录的缺失命令覆盖，不能绕过 PATH 防护执行真实桌面版命令。测试覆盖双宿主安装/删除、旧版及同版本副本遮蔽、禁用成功状态与 TUI/非交互 CLI 显式启用、坏 patch 与锁拒绝启用、Desktop PATH 无系统 npm/pnpm、旧名升级、错误退出与假成功、缺失解析器/命令、dry-run、保留配置和诊断输出不泄密。模拟调用者文件及源码树由隔离门禁做内容快照。

Desktop 探针测试使用 Node 模拟应用二进制、目录模拟 ASAR，并测试清空 NODE_OPTIONS 后仍可验证；这些不是 Electron 真机或真实 ASAR 解析测试。这些模拟宿主回归不代表真实 Desktop 已加载新插件。Windows/macOS 命令执行需对应平台 CI / 真机确认。DSH 开发预览版接口仍可能变化。

## 设计依据

核实于 2026-09-30 官方 master：

- [Desktop 所有权与 bundled command](https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/desktop/README.md#bundled-command-runtime)
- [Desktop 路径与应用锁](https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/desktop/src/paths.ts)
- [Web/Desktop 添加插件界面](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/client/ui-plugin-manager/README.md#installing-a-bundle)
- [插件管理、npm 与本地路径来源](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/boot/plugin-manager/README.md)
- [CLI 插件命令](https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/cli/reference/README.md#plugin-management)
- [官方 installation-first bundle 解析](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/boot/app-boot/src/profile.ts)
- [Desktop carrier 与内置 pnpm](https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/desktop-host/src/cli.ts)
- [Electron NODE_OPTIONS 限制](https://www.electronjs.org/docs/latest/api/environment-variables#node_options)

采用宿主原生入口，不增加全局 npm 引导层、安装生命周期脚本或另一套插件市场协议。
