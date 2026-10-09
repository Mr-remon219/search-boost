# 独立全屏控制台 / Independent console TUI

两套界面共用配置，但定位不同：默认 TUI 是**快速配置**，侧重直接修改；`tui` 是**控制台**，侧重查看当前状态和某份配置。快速配置 TUI 只调整新增的 Community 与判断模型选项，其他老选项的操作习惯保持不变；控制台使用独立的三栏焦点导航。API 额度查询位于引擎页。

```bash
search-boost                 # 快速配置 TUI（保留 Clack 与原有入口）
search-boost tui             # 新的全屏控制台
node cli.mjs tui             # 从源码启动
search-boost tui --dry-run   # 预览，不写入配置或接入
search-boost tui --no-color  # 关闭颜色，保留全屏布局
search-boost tui --preview   # 输出只读快照；无需交互终端
search-boost tui --help
```

新界面独立实现于 `lib/console-tui.mjs`，不调用旧 `runTui`、Clack 菜单或配置向导。共用底层配置、Agent adapter 与刷新 / 诊断服务，不复制存储协议。没有新增运行时依赖。

## 布局

- 顶部：品牌、包版本、当前分类与 dry-run 标记。
- 固定侧栏：总览、搜索引擎、搜索层、工具开关、社区检索、判断模型、Agent 接入、界面设置。顺序不随配置状态变化。
- 三栏分工：第一栏为分类导航，第二栏为该分类的条目列表，第三栏为选中条目的详情与操作；当前条目和键盘焦点分别高亮。
- 宽终端（至少 112 列）：第二栏按 Enter 直接打开单操作条目（如语言、主题、搜索层），多操作条目进入详情选择；→ 始终仅将焦点移到第三栏，不弹出放大的操作菜单。第三栏用 ↑↓ 选择底部操作、Enter 执行，PgUp / PgDn 滚动上方详情。表单、选择和确认仍留在第三栏，第二栏不消失、不改宽。
- 窄终端：保留同样的三层焦点逻辑；列表先显示简短预览，进入详情后使用主区显示第三栏内容，← / Esc 返回原列表。缩放不改变当前焦点、选中项或表单草稿。
- 底部：结果提示与上下文快捷键。按条目记忆详情滚动与操作选择；刷新按条目 ID 保留选择，避免判断配置重新排序后选中别的配置。操作消失后回到第一项，不误落到删除按钮。
- 多步配置按 Esc 返回上一步；确认页的取消也返回原表单并保留本次会话草稿，不保存。关闭整个操作后恢复原先的栏焦点。确认默认选中取消。
- 最小尺寸为 54 × 16；小于此尺寸提示调整大小，Q / Ctrl+C 仍可退出。窗口缩放自动重绘。小于最小尺寸时阻止不可见输入与确认，保留草稿；恢复尺寸后可继续，Esc 可取消，Q / Ctrl+C 可退出。中文和 emoji 按显示宽度裁切，内容不越栏。

建议使用 UTF-8 的 Windows Terminal、PowerShell、现代 macOS / Linux 终端，尺寸 120 × 32 或更大。无 TTY 时明确报错，不自动启动另一套向导；使用 `--preview` 可查看无 ANSI 的只读快照。

## 快捷键

| 按键 | 行为 |
| --- | --- |
| Tab / Shift+Tab | 正向 / 反向切换分类 → 列表 → 详情；表单内切换字段，选择页内切换选项 |
| ↑↓ / J K | 移动分类、条目或第三栏操作；只读详情内滚动。上下边界不循环跳转 |
| ← / → | 主界面切换相邻栏；只读 / 选择页的 ← 返回上一步；输入框内移动光标 |
| 1–8 | 跳到对应分类 |
| Home / End | 当前列表 / 操作首尾；只读详情首尾；输入框内移到开头 / 末尾 |
| Enter | 单操作条目直接打开；多操作条目进入第三栏；表单下一项 / 继续确认 |
| Space | 切换当前项支持的开关，仍需明确确认 |
| E | 编辑当前项 |
| U | 搜索引擎页查询当前引擎额度；额度总览中查询全部支持项（联网前确认） |
| D | 删除当前项，默认取消 |
| R | 重新读取配置、保留选中条目，不执行网络检测 |
| L | 打开简体中文 / English 选择，选择后确认 |
| ? | 完整帮助 |
| Esc | 操作内返回上一步，不保存；主界面依次详情 → 列表 → 分类，不直接退出 |
| Q / Ctrl+C | 退出；输入框中 Q 是普通文字 |
| Ctrl+U / Backspace / Delete | 清空当前输入框 / 删除光标前一个字符 / 删除光标位置字符（中文、emoji 按完整字符处理） |
| PageUp / PageDown | 列表按实际可见行翻页；第三栏详情滚动；表单 / 确认页查看完整说明，不改变当前字段或确认选项 |

接入发现与执行期间明确显示工作中提示，不再显示无效的返回 / 退出快捷键；完成结果取代工作中页面，关闭后不会回到过期的等待提示。忙碌时忽略重复操作，Ctrl+C 请求当前操作结束后退出，避免中断配置写入。退出、EOF 与输出错误会清理监听器、恢复 raw mode、显示光标并退出备用屏幕，不留下全屏内容污染 shell 历史。

## 功能与边界

- **引擎**：隐藏 Key 的设置 / 更换 / 删除、Base URL 编辑 / 恢复、API 引擎路由开关。只修改相关字段，保留其他引擎和判断凭据；保存 Key 不暗中扩张路由。已有环境变量不会被删除。Key 输入不回显，状态只显示存在性与来源。
- **搜索层**：明确确认 `free` / `api` 默认值，不设置单次查询参数。
- **工具**：读取真实状态，锁定未配置判断模型的 `adaptive_search`；切换前确认，不自动提升权限。
- **社区**：平台列表先显示启停与配置就绪状态，详情显示所有已保存方式、Reddit 默认社区、浏览器桥地址和令牌环境变量名、X 凭据来源。Enter 进入第三栏，第一项操作为只读“查看完整配置”，E 直接启用 / 更换检索方式；可编辑 Reddit 范围与浏览器接入、删除额外配置、停用整个平台。X 页可设置隐藏的 xAI Key、明确导入已有 Grok 登录、移除本地副本，均不改变平台路由或源登录。浏览器缺令牌环境变量时仅保存未启用设置，不替换当前来源；不自动启动服务、读取浏览器会话或绕过验证。多实例注册仍由 `community_backend` 管理。修改使用原子事务与并发冲突保护。平台开关不等于每次搜索自动加入社区，仍由单次 `community` 参数决定。
- **判断模型**：先显示“当前判断状态”，当前配置排在其他已保存配置之前，最后是添加入口。详情可查看模型、Base URL、真实协议 / 端点、认证存在性和保存的 Laya 预算；当前 Laya 状态还显示离线容量证据状态。第三栏操作先提供只读查看，另可编辑、使用或删除某份配置。新建 Jev 明确区分 TypeSafe、Vercel AI Gateway 与自定义 System One；Gateway 使用自己的 Key 与评估接口。编辑不切换当前配置；同址 Key 留空保留，换址不继承旧 Key，Laya 输入 `-` 可清除可选认证。同址编辑保留模型与预算。新建保存后使用，切换需确认发送目的地；删除当前 profile 不自动选择另一个。Laya 的离线容量证据要求仍保留。
- **接入**：指定单个宿主安装 / 卸载，刷新时选择精确已有 scope / profile。安装不自动预授权工具、不替换原生搜索；已有接入建议刷新以保留选择。DSH 输入精确 profile，`desktop` 操作前完全退出 Desktop（含托盘）。Grok 仅管理 user-scope MCP / rule / skill，不安装、删除或重建原生插件；完整插件、项目级与复杂接入流程继续使用现有 CLI / 旧向导。失败不假定成功。
- **总览 / 诊断**：只读配置统计与 quick doctor，不发起搜索或网络探测。配置状态不是实时连接、宿主加载版本或覆盖率的证明。
- **语言**：共用 `config/tui.json` 的 language 字段，但保留旧 TUI layout；新界面不使用旧平铺 / 文件夹布局。
- **表单**：长字段说明自动换行；超过 4096 长度的输入整次拒绝并提示，不静默截断 Key / 地址。已知并发配置变更明确提示按 R 刷新，未知错误仍不回显可能含凭据的原文。
- **安全**：浏览不创建默认配置；修改显式确认；损坏配置展示修复提示而不是当作空配置覆盖。控制字符经过清理，任意底层错误不直接回显到界面。`--dry-run` 不保存任何配置或接入，包括显示语言与控制台主题。

## Theme / 主题

按 **8 → 主题 → Enter**，选择并确认后立即生效：

- **Ayu Dark**（默认）：深色底、暖金强调，Logo 使用金色 / 橙色。
- **TokyoNight Dark**：深蓝底、蓝紫强调，Logo 使用蓝色 / 紫色。

配色覆盖背景、文字、焦点高亮、分隔线、表单、确认页与额度卡片，不只是改一个强调色。使用 24-bit ANSI 颜色，建议使用支持 True Color 的现代终端。`--no-color` / `NO_COLOR` / `--preview` 保留无颜色布局与 Logo；颜色不支持时可使用 `--no-color`。

主题独立保存在 `$SEARCH_BOOST_HOME/config/console-tui.json` 的 `theme` 字段，值为 `ayu` / `tokyonight`；不修改快速配置 TUI 的语言或布局。浏览不会创建此文件；取消与 dry-run 不保存。保存保留其他字段、检查并发变更，损坏 / 不支持的设置不会被覆盖。按 R 也会重读主题。

左上角使用标准的 **SearchBoost** 大小写，前方是 `assets/icon.png` 分叉上升箭头的三行 Braille 终端版。它与用户提供的 PNG 一致；运行时无需读取临时图片、不使用图片终端协议或额外依赖，配色随主题切换，三栏可用高度保持不变。

配色参考：[Ayu Dark 官方色板](https://github.com/ayu-theme/ayu-colors/blob/master/themes/dark.yaml)、[TokyoNight 官方色板](https://github.com/folke/tokyonight.nvim/tree/main/lua/tokyonight/colors)。终端角色映射对正文 / 次要文字的可读性做了适配。

## API 额度

额度不另设侧栏，也不改变五个引擎原有顺序。选中引擎后，详情区显示同配色的轻量额度卡片：剩余数值、余量条和查询时间；低余量为黄 / 红色，未查询或未知为中性色。原有 Key / 地址 / 路由操作顺序保留，新增额度操作追加在后。

- **只读查看**：引擎第三栏 → 查看额度详情；搜索引擎列表末尾 → API 额度总览。进入不联网、不创建文件。详情区至少 78 列时总览自动双列，较窄时单列（不挤占第二栏）；↑↓ / PageUp / PageDown 滚动。单个引擎详情显示完整指标，不把总览的简短注释当作完整说明。
- **主动查询**：按 U 或选择查询额度，默认取消。确认页展示接收 Key 的官方端点；Brave 的一次真实搜索与可能计费提示置于首行和确认按钮；小终端可用 PgUp / PgDn 查看全部目的地与影响。查询中 Esc 取消、Q / Ctrl+C 退出；各引擎分别更新，单项失败不影响其他引擎。
- **缓存**：仅当前进程内存，Key / Base URL 改变后失效，退出不保存。最少间隔 60 秒；HTTP 429 的 Retry-After 更长时完整遵守。不自动刷新、不自动重新查询。R 仍仅重读本地配置。
- **安全**：使用当前生效的文件 / 环境变量 Key，仅发送至已核实的对应官方端点。自定义网关不猜测余额路径，也不把其 Key 转发给官方服务。查询遵循已有网络 / 代理策略，超时 12 秒、拒绝重定向、响应有大小上限。不回显响应原文、Key 或底层异常。dry-run 只预览，不联网。

| 引擎 | 当前展示 | 边界 |
| --- | --- | --- |
| Tavily | 当前周期 Key、套餐、PAYGO 上限剩余 credits | 独立上限分别展示，不相加；Key 无上限不等于账户余额无限 |
| Brave | 搜索响应头中的长周期剩余请求及周期 | 需要 1 次真实搜索，消耗配额且可能计费；非钱包余额 |
| TinyFish | 账户共享钱包 USD 余额（含负余额） | 不是单个 Key 剩余搜索次数；不充值、不修改自动充值 |
| Exa | 不支持查询 | 当前配置没有可用额度查询；不保留查看 / 查询按钮或 U 快捷键 |
| AnySearch | 不支持查询 | 不保留查看 / 查询按钮或 U 快捷键，不猜测余额接口 |

未配置、网关、认证失败、限流、超时、未开通钱包、返回格式变化都明确显示原因，不伪装为 0。接口与数据口径见 [额度适配器说明](engine-quota.md)。

## English summary

`search-boost tui` is the status-first console; `search-boost` is the configuration-first quick TUI, retaining Clack and existing entry points. The new module owns rendering, navigation, inline forms and confirmation dialogs, sharing only backend services. The console has its own Ayu Dark / TokyoNight Dark theme setting (section 8), persisted separately from the quick TUI. The standard SearchBoost name and a compact terminal logo appear in the header; logo colors follow the theme. The sidebar has eight stable sections. Enter opens single-action entries directly; multi-action entries enter details. The right arrow always moves focus to details. Forms and confirmations remain in the right pane, preserving the middle list and geometry. Smaller terminals show the same logical detail pane in the main area; Esc restores the list. Minimum size: 54 × 16; recommended: 120 × 32.

Use Tab / Shift+Tab to cycle the three panes, arrows or J/K to navigate, PgUp / PgDn to scroll details, 1–8 to jump sections, Enter to enter details or run the selected action, E to edit, Space to toggle, D to delete, R to reload, L for language, ? for help, Esc to cancel, and Q / Ctrl+C to exit. Esc steps back through dialogs and restores the previous focus. Confirmation defaults to cancel; cancel returns to the draft without saving. Passwords remain hidden. `--dry-run` makes no writes; `--preview` prints an offline snapshot without a TTY. Configuration readiness never claims live connectivity or host loading. Engine quota cards and the overview appear in the engine section; U explicitly requests verified provider data after consent. Brave requires one potentially billable search; TinyFish reports an account wallet, not search counts. Exa/AnySearch show “Query not supported” without query/detail buttons or a U shortcut. Results remain in memory, refresh at most once per minute (longer on rate limits), and invalidate on key/URL changes. Browsing, R, preview and dry-run never query quotas.

Community and judgment put read-only actions first in the details pane. The console also edits Reddit scopes and browser settings, manages X credentials, selects Jev destinations and edits saved judgment profiles without activating them. A changed judgment URL never inherits its old key. Arbitrary community instance registration remains in `community_backend`. Full Grok native plugin management and complex host setup remain in the existing CLI/wizard. The new console does not jump into those older prompts during an operation.

## 测试 / Tests

```bash
npm run test:console
npm run test:quota
npm run test:tui
npm run test:cli
npm run check
```

测试隔离 HOME / 配置；覆盖独立入口、只读浏览、三栏焦点、详情操作与固定栏宽、反向 Tab、逐级返回与草稿恢复、详情与长说明滚动边界、宽窄布局和缩放、隐藏输入与无效字段定位、默认取消、刷新 / 激活后的条目身份保持、并发变更、dry-run、真实配置写入、接入参数与失败、旧布局保留、终端清理以及忙碌退出。
