# 社区浏览器与 TUI 扫码登录

## 用户流程

每个平台仍只有一个免费接入。**浏览器来源选择不是额外的免费接口**，只是选择运行内置接入的浏览器程序。

- 快速配置：`search-boost` → Community → 小红书 / 知乎 / B站 → 安装 / 登录。
- 首次配置：完成 Agent 配置后，最后多选要连接的平台，空选跳过；有可用浏览器时直接连续扫码，否则只选择一次浏览器来源。
- 控制台：`search-boost tui` → 社区检索 → 平台 → 安装 / 登录。末尾的「社区浏览器」条目管理程序来源和独立下载。

先选择：

1. **本机 Chrome / Chromium**：只复用程序，不连接用户正在运行的浏览器，不读取个人 profile、Cookie、扩展或账号。Playwright 启动 SearchBoost 自己的、按平台隔离的持久会话。
2. **SearchBoost 独立 Chromium**：明确选择「下载独立 Chromium」后下载固定 Playwright 版本对应的 Chromium，不再逐平台重复确认。下载目录、来源选择和登录数据均在 SearchBoost home 内；不会写入共享 Playwright 缓存，不执行 `install-deps` 或提权安装。

选择连接后在后台启动隔离浏览器，立即显示准备进度并取得平台登录二维码。快速配置打印 **PNG 完整路径**；控制台优先显示高对比度二维码，空间不足、无颜色或解码不支持时保留原 PNG。二维码不会被缩小或裁切。

用相应平台 App 扫码并确认。程序验证账号身份后自动保存会话、只启用该平台一份接入，不需要再手动声明「已登录」。有效的已有会话通过身份检查后可直接复用，无需重复扫码。

## 二维码操作与终端兼容

- 控制台 **O / Enter**：通过系统图片查看器打开 PNG；不执行 shell，不打开来自平台的任意 URL。
- 控制台 **Ctrl+左击 PNG 链接行**：处理终端上报的 SGR 鼠标事件并打开图片。
- 同时提供 **OSC 8 `file://` 超链接**：Windows Terminal 通常用 Ctrl+单击；macOS 的 iTerm2 等终端一般用 Cmd+单击。终端若拦截 Ctrl+单击、禁用鼠标上报或不支持文件超链接，应用无法强制改变该行为，使用 O / Enter 或路径即可。
- PowerShell 是 shell，是否可点击取决于其终端宿主；推荐 Windows Terminal。macOS 推荐支持 OSC 8 / SGR 的终端。
- WSL / Linux 不保证宿主文件链接或图片打开；仍显示完整路径。不会自动通过 PowerShell / Windows 接口跨越 WSL 边界。
- 控制台 **R**：取消当前登录尝试并重新取得二维码；**Esc** 取消当前尝试；**Q / Ctrl+C** 退出。快速配置等待期间 Ctrl+C 取消并退出。
- 终端缩小到无法完整显示时，回退 PNG，不让用户扫描残缺二维码。鼠标模式仅在二维码页启用，退出 / EOF / 错误时关闭并恢复终端。

登录 PNG 是私有的临时凭据材料，文件权限为 0600（POSIX），目录为 0700；正常成功、取消、超时或失败后自动移除。强制终止进程或断电无法执行退出清理；下次为同一平台获取二维码时，会在持有会话锁的情况下清理遗留的 UUID PNG，不触碰其他平台或不明文件。不要公开图片、截图或会话目录。平台二维码到期或出现滑块 / 验证挑战时，流程不会伪造成功、解验证码或绕过访问限制。

## 扫描本机浏览器

只查找程序，不扫描个人浏览器数据；读取有边界、重复界面渲染使用短期缓存：

- **Windows**：Program Files / Program Files (x86) / LocalAppData 的 Chrome、Beta、Dev、Canary、Chromium；读取 HKCU / HKLM 的 App Paths，分别查询 32 / 64 位注册表视图。使用系统 `reg.exe query`，不运行工作目录里的同名程序；支持默认值中的已知环境变量。
- **macOS**：`/Applications` 和 `~/Applications` 中的 Chrome 各渠道及 Chromium；补充有界 Spotlight bundle 查询。各渠道使用实际的 `Contents/MacOS` 程序名；查询系统 `/usr/bin/mdfind`，不扫描 profile。
- **Linux**：已知绝对位置和有界 PATH 候选；不全盘递归扫描。WSL 不把 Windows Chrome 当作 Linux Playwright 程序使用。
- 可通过 `SEARCH_BOOST_BROWSER_EXECUTABLE` 显式指定程序参与自动发现。TUI 的明确来源选择优先，所选程序缺失时不悄悄换到另一个浏览器。

## 隔离目录

默认 home 为 `~/.search-boost`；也可使用 `SEARCH_BOOST_HOME`：

```text
state/community/
  browser-preference.json       # 本机 / 独立来源选择
  browser/
    owned.json                  # SearchBoost 下载所有权标记
    ms-playwright/              # 专用 Chromium / headless shell 等
    leases/                     # 使用中的跨进程租约
    setup.lock                  # 安装 / 使用登记 / 卸载互斥
  sessions/<platform>/profile/  # 各平台专用登录数据
  qr/<platform>/<uuid>.png     # 本次登录的临时二维码
```

Playwright CLI 的子进程独立设置 `PLAYWRIGHT_BROWSERS_PATH`，不修改主进程环境，不使用默认共享缓存。下载完成标记和固定版本的浏览器清单共同决定就绪状态；部分下载不能当作可启动浏览器。

## 两种卸载

两套 TUI 都提供：

- **卸载平台接入与登录数据**：删除该平台原生配置与专用会话，保留本机浏览器、SearchBoost 独立浏览器和其他平台。不自动启用其他来源。
- **卸载 SearchBoost 独立浏览器**：删除仅由 SearchBoost 创建的下载目录，保留本机 Chrome / Chromium、共享 Playwright 缓存和平台登录数据。明确的独立来源选择保持不变，之后需要重新下载或明确更换来源，不暗中切换到个人浏览器程序。

下载、运行和卸载使用共享锁 / 进程租约；活动平台会话或浏览器租约阻止卸载。所有权不明、未知目录、损坏标记或链接根目录会保守拒绝；macOS 下载包内部合法符号链接在删除时仅被解除，不跟随到外部目录。损坏的浏览器选择文件不会被当成默认配置覆盖。

## 实现与验证边界

- `lib/community/native-setup.mjs`：发现、独立安装、来源选择、租约与卸载。
- `lib/community/native-session.mjs`：隔离 profile、请求策略和租约持有。
- `lib/community/qr-login.mjs`：平台二维码元素读取、自动身份检查、超时和取消。
- `lib/community/qr-image.mjs` / `qr-terminal.mjs`：私有 PNG、无损终端矩阵、可信本地图片链接和打开。

平台元素 / 身份接口参考：小红书 [login.go](https://github.com/xpzouying/xiaohongshu-mcp/blob/main/xiaohongshu/login.go)，知乎与 B站 [MediaCrawler 登录实现](https://github.com/NanmiCoder/MediaCrawler/tree/main/media_platform)（仅核对协议 / 选择器事实，不复制其非商业许可业务代码）。浏览器路径和下载布局核对项目固定版本 `playwright-core@1.64.0` 的本地清单 / 源码，以及 [Playwright 浏览器文档](https://playwright.dev/docs/browsers)。链接协议见 [OSC 8 说明](https://iterm2.com/feature-reporting/Hyperlinks_in_Terminal_Emulators.html)。

离线测试覆盖三系统扫描、来源选择、隔离下载、模拟扫码与身份检查、PNG 删除、二维码重新解码、窄屏 / 无颜色回退、鼠标输入和终端清理、跨进程租约及拒绝不安全卸载。离线通过**不等于**真实平台登录、验证码兼容、Windows / macOS 终端交互或系统图片打开已经验收；平台页面可能变更，仍需在相应系统用本人账号验证。

## 日常使用与恢复

- 已配置平台再次进入首次引导会跳过；普通搜索不再询问浏览器来源或扫码。仅平台明确报告登录失效时提示重新登录，限流只提示稍后重试。
- 两套 TUI 共用连接状态。已有登录但暂停时优先恢复；暂停、恢复和 Reddit 范围编辑直接保存，删除登录数据或独立浏览器仍确认。
- 快速配置扫码时支持 **O 打开 PNG、R 重发、Esc 返回、Ctrl+C 退出**；图片打不开时保留路径提示。等待倒计时不是二维码有效期承诺。失败可以原地重试。
- 普通状态展示不执行外部系统查询；浏览器设置中主动发现时先显示进度，系统查询总预算默认 1.2 秒。
- 社区工具关闭时单独提示，可明确选择开启；连接账号本身不会自动开启工具权限。
