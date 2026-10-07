# 测试反馈定位与修复：X、Codex、DSH

## X：可选凭据提示不清晰（已确认）

`authStatus()` 在没有官方凭据时只提示导入登录或设置 Key，虽然运行时已经有免凭据备用通道。这容易让人误以为普通搜索或 X 搜索必须先购买 API。

修复：TUI 菜单提示、X 配置页、状态及首次向导统一说明 X/xAI API 凭据是可选项；不配置也可使用尽力获取的备用检索。覆盖可能不完整，不能保证实时性或每次成功。没有修改认证优先级、工具开关或检索规则。

## Codex：把目录当作已安装（已确认）

原检测仅检查 `$CODEX_HOME` 或 `~/.codex` 是否存在。空目录、卸载残留以及 SearchBoost 自己写入的配置都能触发 detected。

修复：对 Codex CLI 执行有界的 `--version` 检查，只接受成功退出且符合 Codex 版本格式的输出。不启动会话、不下载或安装宿主、不显示原始输出。30 秒缓存避免每次菜单刷新重复启动；PATH/PATHEXT/ComSpec 改变会重新检查。配置存在仍独立显示为 configured，不再作为 detected 的依据。未在 PATH 上或版本检查失败的 CLI 不自动选入安装目标，仍可手动选择。

## DSH：“能识别却未安装 / 改了 peer”（原现场根因待确认）

反馈没有提供 DSH 版本、具体报错或改动字段，不能认定缺少哪个 peer，更不能据此关闭兼容检查。当前 SearchBoost 适配器不直接导入 DSH 服务包，根 package.json 也没有 DSH peerDependencies 声明。

核对上游发现：DSH 插件管理器 `listBundles()` 用 profile 的 `dependencies` 判定 installed；读取到 bundle/选中 bundle 不等于具有这条生产依赖边。原 SearchBoost 安装只执行 `add <spec>`，并允许其他直接依赖字段通过安装校验，无法确保管理页面所需的依赖字段。

预防性修复：安装时显式传入 `--save-prod --save-dev=false --save-peer=false --save-optional=false`，只覆盖本次包操作；验证 profile 的 `dependencies.search-boost`，缺失则恢复原配置和模块树。不会修改 `.npmrc`、peer 版本、兼容豁免或已关闭的 bundle 偏好，也不会伪报安装成功。失败提示明确指出注册字段问题。

此修复覆盖“依赖保存字段不一致”，**不证明就是测试人员原现场的问题**。继续确认需要：DSH 版本、CLI/官方 Desktop/其他桌面封装及所用 profile、改动前后的字段名与值、界面显示或报错。不要提供完整凭据文件或真实 Key。

### 已核对的主来源

- [DSH 插件管理器 listBundles](https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/packages/boot/plugin-manager/src/index.ts)：installed 来源于 profile.dependencies。
- [DSH 包操作](https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/packages/boot/plugin-manager/src/operations.ts)：依赖操作及 peer 兼容检查。
- [DSH 插件版本兼容检查](https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/packages/boot/app-boot/src/plugin-compatibility.ts)：peer 范围的检查与精确版本豁免。
- [pnpm add](https://pnpm.io/cli/add)：生产、开发、可选及 peer 保存方式。

上述 master 文档与源码是定位参考，不替代测试人员实际版本的证据。

## 验证

`npm run test:feedback`：空目录/仅 SearchBoost 配置不触发 Codex 检测、正常版本识别与失败/超时、双语 X 引导、DSH 明确保存字段及失败回滚。DSH 使用隔离模拟宿主与本地 package 链接，不代表原现场已复现或真实线上宿主已经修好。

另跑 TUI、安装状态、X 凭据与管线、DSH 安装启动器、Doctor、CLI、语法及 CI 策略检查。未执行真实模型调用、真实宿主安装或 npm 发布。
