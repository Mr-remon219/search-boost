# 独立全屏控制台 / Independent console TUI

两套界面并行存在：

```bash
search-boost                 # 原有 Clack 向导，不改变行为
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
- 主区：实际配置列表；当前条目和键盘焦点分别高亮。
- 宽终端（至少 112 列）：右侧显示当前条目的配置来源、说明和操作。窄终端合并到主区；Enter 始终可查看完整详情 / 操作。
- 底部：结果提示与上下文快捷键。选中项按分类记忆，取消或完成后回到原列表。
- 表单、操作菜单和确认在同一全屏界面内完成。确认默认选中取消。
- 最小尺寸为 54 × 16；小于此尺寸提示调整大小，Q / Ctrl+C 仍可退出。窗口缩放自动重绘。中文和 emoji 按显示宽度裁切，内容不越栏。

建议使用 UTF-8 的 Windows Terminal、PowerShell、现代 macOS / Linux 终端，尺寸 120 × 32 或更大。无 TTY 时明确报错，不自动启动另一套向导；使用 `--preview` 可查看无 ANSI 的只读快照。

## 快捷键

| 按键 | 行为 |
| --- | --- |
| Tab / Shift+Tab | 切换侧栏 / 主列表焦点；表单内切换字段 |
| ↑↓ / J K | 移动当前栏的选择；弹窗内使用 ↑↓ |
| ← / → | 聚焦侧栏 / 主列表 |
| 1–8 | 跳到对应分类 |
| Home / End | 主界面跳到当前列表首尾 |
| Enter | 操作菜单、查看详情；表单下一项 / 继续确认 |
| Space | 切换当前项支持的开关，仍需明确确认 |
| E | 编辑当前项 |
| D | 删除当前项，默认取消 |
| R | 重新读取配置，不执行网络检测 |
| L | 确认切换简体中文 / English |
| ? | 完整帮助 |
| Esc | 取消弹窗 / 表单；主列表返回侧栏，不直接退出 |
| Q / Ctrl+C | 退出；输入框中 Q 是普通文字 |
| Ctrl+U / Backspace | 清空当前输入框 / 删除最后一个字符 |
| ↑↓ / PageUp / PageDown | 详情弹窗滚动 |

忙碌时忽略重复操作，Ctrl+C 请求当前操作结束后退出，避免中断配置写入。退出、EOF 与输出错误会清理监听器、恢复 raw mode、显示光标并退出备用屏幕，不留下全屏内容污染 shell 历史。

## 功能与边界

- **引擎**：隐藏 Key 的设置 / 更换 / 删除、Base URL 编辑 / 恢复、API 引擎路由开关。只修改相关字段，保留其他引擎和判断凭据；保存 Key 不暗中扩张路由。已有环境变量不会被删除。Key 输入不回显，状态只显示存在性与来源。
- **搜索层**：明确确认 `free` / `api` 默认值，不设置单次查询参数。
- **工具**：读取真实状态，锁定未配置判断模型的 `adaptive_search`；切换前确认，不自动提升权限。
- **社区**：平台方式选择与停用使用原子事务和并发冲突保护。X 页可设置隐藏的 xAI Key / 移除本地副本，不改变平台路由或 Grok 登录。浏览器接入、高级参数和多实例注册使用现有 `community_backend`；未配置本地桥时不直接启用浏览器方式。不启动浏览器、不读取登录会话或绕过验证。
- **判断模型**：在独立表单中添加 Jev / Laya、选择已有配置、删除配置与 Key。明确提示材料发送目的地；删除当前 profile 不自动选择另一个。Laya 的离线容量证据要求仍保留。
- **接入**：指定单个宿主安装 / 卸载，刷新时选择精确已有 scope / profile。安装不自动预授权工具、不替换原生搜索；已有接入建议刷新以保留选择。DSH 输入精确 profile，`desktop` 操作前完全退出 Desktop（含托盘）。Grok 仅管理 user-scope MCP / rule / skill，不安装、删除或重建原生插件；完整插件、项目级与复杂接入流程继续使用现有 CLI / 旧向导。失败不假定成功。
- **总览 / 诊断**：只读配置统计与 quick doctor，不发起搜索或网络探测。配置状态不是实时连接、宿主加载版本或覆盖率的证明。
- **语言**：共用 `config/tui.json` 的 language 字段，但保留旧 TUI layout；新界面不使用旧平铺 / 文件夹布局。
- **安全**：浏览不创建默认配置；修改显式确认；损坏配置展示修复提示而不是当作空配置覆盖。控制字符经过清理，任意底层错误不直接回显到界面。`--dry-run` 不保存任何配置或接入，包括显示语言。

## English summary

`search-boost tui` opens an independent full-screen console; `search-boost` keeps the existing Clack wizard. The new module owns rendering, navigation, inline forms and confirmation dialogs, sharing only backend services. The sidebar has eight stable sections; wide terminals show list and details side by side, while smaller terminals merge details into the main pane. Minimum size: 54 × 16; recommended: 120 × 32.

Use Tab to switch panes, arrows or J/K to navigate, 1–8 to jump sections, Enter for actions, E to edit, Space to toggle, D to delete, R to reload, L for language, ? for help, Esc to cancel, and Q / Ctrl+C to exit. Confirmation defaults to cancel. Passwords remain hidden. `--dry-run` makes no writes; `--preview` prints an offline snapshot without a TTY. Configuration readiness never claims live connectivity or host loading.

Advanced browser/community parameters and registration remain in `community_backend`. Full Grok native plugin management and complex host setup remain in the existing CLI/wizard. The new console does not jump into those older prompts during an operation.

## 测试 / Tests

```bash
npm run test:console
npm run test:tui
npm run test:cli
npm run check
```

测试隔离 HOME / 配置；覆盖独立入口、只读浏览、快捷键、宽窄布局、隐藏输入、默认取消、并发变更、dry-run、真实配置写入、接入参数与失败、旧布局保留、终端清理以及忙碌退出。
