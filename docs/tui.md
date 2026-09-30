# TUI 导航与显示语言

运行 `search-boost`（不带参数）打开控制台。保留现有 Clack 样式，只将功能入口分为两级。

| 一级菜单（English） | 二级功能 |
| --- | --- |
| 安装与接入（Installation & integrations） | 首次配置向导、安装 / 刷新 Agent 接入、原生搜索替换、输出 MCP 配置片段、卸载 Agent 接入 |
| 搜索与工具（Search & tools） | 默认搜索层、工具开关 |
| 服务与凭据（Services & credentials） | 搜索引擎 API Keys 与 Base URLs、X 凭据、Jev 配置（实验性） |
| 更新与状态（Update & status） | 更新 search-boost 与已安装接入、查看当前状态 |
| TUI 设置（TUI settings） | 显示语言：简体中文 / English |

主菜单另有「退出」。二级菜单末尾有「返回主菜单」。

## 导航行为

- 操作完成后留在所属二级菜单，方便继续配置同类功能。
- 向导内 Esc 取消当前操作，返回所属二级菜单；二级菜单内 Esc 返回主菜单；首页 Esc 退出。
- Ctrl+C 退出整个控制台。
- 取消不回滚之前已经完成并保存的独立配置步骤；未提交的凭据 / 工具开关变更不会保存。
- 安装 / 刷新接入不重复配置 Keys、搜索层或 X 凭据。首次配置向导继续依次询问这些设置。
- profile、Grok 作用域、工作区和自动授权等选项仍在安装操作中按需出现。
- 更新功能面向全部已有接入。若更新替换了运行模块，或更新操作抛出异常，旧 TUI 结束，不继续使用旧模块。
- `search-boost setup`、`install`、`config keys|layer|x|jev|search` 等直接命令保持可用；它们不经过首页分类菜单。

## 显示语言

从「TUI 设置 → 显示语言」选择简体中文或 English，立即生效。正常操作保存至：

```text
~/.search-boost/config/tui.json
# 设置 SEARCH_BOOST_HOME 时：
$SEARCH_BOOST_HOME/config/tui.json
```

示例：

```json
{ "language": "zh-CN" }
```

支持值为 `zh-CN`、`en`。这是显示偏好，不是搜索或模型配置；不保存凭据。

- 已保存的偏好优先，下次启动及独立交互式向导沿用。
- 无偏好时，按 `LC_ALL`、`LC_MESSAGES`、`LANG`、`LANGUAGE`（首项），最后系统 locale 判断；中文环境显示简体中文，其他环境显示英文。
- 只翻译应用拥有的菜单、说明、确认、状态和操作提示。工具名、服务品牌、命令、路径、URL、用户输入、MCP 片段、原始底层错误及外部子进程输出保持原样。
- 不影响查询语言、搜索结果、Agent 回复或非交互式 CLI 输出。
- dry-run 中允许即时预览另一种语言，但不写入显示偏好或其他配置。
- 设置文件损坏时，首页及独立交互式向导提示错误并临时使用系统语言；不会自动覆盖损坏文件。请修复该文件，或删除它以恢复默认检测。语言保存失败不会改变当前显示语言。

## 验证

```bash
npm run test:tui
npm run check
```

测试覆盖菜单归属、返回导航、取消与 Ctrl+C、语言即时切换及跨进程保存、配置并发 / 损坏保护、dry-run、非交互 CLI 不变，以及更新替换模块后的退出行为。测试通过 `scripts/isolate-tests.mjs` 使用临时 HOME 和工作区，不读写用户真实配置。
