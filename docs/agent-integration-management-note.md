# beta.7：管理 Agent 接入与 Grok 缓存刷新 note

## 已确认的产品决定

- 删除首页“更新 SearchBoost”和独立“卸载 Agent 接入”；原安装入口更名“管理 Agent 接入”，包含安装、刷新、卸载。
- SearchBoost 软件包版本由用户通过 npm 更新：`npm install -g search-boost@beta --prefer-online`。管理模块只使用当前安装版本，不查询 npm dist-tag、不启动全局安装器或 npx 软件包更新接力。
- 移除 `upgrade` 自更新命令；提供 `refresh` 作为已有接入同步命令，TUI 与 CLI 共用同步能力。`install` / `uninstall` 保留直接操作兼容性。显式旧 npm 包名迁移 `migrate` 是独立的一次性操作，不在管理菜单中自动触发。
- 操作优先：先选安装、刷新、卸载，再选 Agent / workspace / profile。取消勾选仅表示本次不处理，不隐含删除。
- 安装用于新接入及用户明确选择的配置；刷新只同步已有接入并保留权限、凭据、启停状态与无关字段；卸载预览实际目标后明确确认，默认取消，执行不扩大已预览范围。
- 保留 flat / folder 布局、显示语言、作用域与 Esc 导航；安装/刷新不重复配置 API Keys、搜索层和 X 凭据。

## 原有逻辑与现场证据

beta.6 的软件包更新与安装走不同编排。更新扫描已安装接入、工作区和 DSH profiles，包含受管备份/验收；安装仅处理选中目标，重新应用用户选择。两者不应以无提示重装互相替代。

安装统计失败后仍用“安装完成”结束 spinner；嵌入首页时独立 outro 被隐藏。因此部分失败被成功样式掩盖。管理模块须返回结构化结果并统一显示完成、部分完成或失败。

用户级 Grok 与 HOME 工作区都可能指向 `~/.grok/config.toml`。发现阶段应按实际管理资源去重，不以显示标签判定两个目标，也不丢弃不同工作区/作用域。

DSH 已同步快路径只验来源、版本、payload、bundle 与 owning-host resolver，不进行包安装。安装事务需要 owning host 的 `@deepseek-ai/dsh-plugin-manager/operations`。旧宿主能加载已有 bundle，不代表支持重新安装；不因 UI 改名而绕过此边界。

本机 Grok 从 1.0.5 升级至 **1.0.46 (2765805b9442)**。只读帮助显示 `plugin update` 无 `--force` / 专门缓存重建选项；`install` 支持 `--trust`，`uninstall` 支持 `--keep-data`。这不证明内部 update 行为不变，需隔离实测。

只读现场：登记 `grok-plugin-23a3506e` 的 source 指向当前 beta.6，但安装缓存为 0.2.0；源与缓存各五个文件，仅 README.md / plugin.json 不同。新版 `plugin validate` 对当前源通过，对缓存拒绝：`invalid type: string "search-boost", expected struct Author at line 5 column 26`。`plugin list` 仍报告 installed / version:null，不能以登记或退出码作为载荷有效证据。

## Grok 刷新的实现边界

1. 共用新旧登记发现、来源与实际缓存验收；安装已有同源插件时不盲目重复 `plugin install`。
2. 缓存完全一致则跳过；不一致先使用宿主支持的原生更新并再次验收。
3. 在隔离 HOME / socket、无真实凭据或服务的 fixture 中验证 1.0.46 对旧 author 格式与本地源修改的更新行为。
4. 若原生更新仍无法恢复，仅提供明确确认的保留数据重建流程；没有确认不得卸载/重装、重新启用或追加 `--trust`。不能直接覆盖真实宿主缓存或猜测其内部登记格式。
5. 子进程成功但验收失败应显示阶段与安全原因，不输出配置/凭据正文，不以降低验收掩盖错误。

## 本次执行和发布约束

父进程负责源码整合、版本、提交、推送、tag 和发布；真实 Grok / DSH / 配置保持不动，实验只操作已确认隔离的私有 fixture。独立审查针对冻结后的实际 diff，结论由父进程验证。

版本采用仓库已有 semver 格式 **0.2.4-beta.7**（用户称 beta7），npm 只推进 `beta`，稳定 `latest=0.2.3` 不动。发布前通过语法、CI 策略、依赖审计、完整 poisoned-caller isolation、生成资产与 tarball 核验；推送后要求准确最终 SHA 的四格 CI 成功，再发布审核过的 tarball 和 GitHub prerelease。

不改变搜索/Adaptive 架构、评分、容量或翻页语义。历史 beta.5 / beta.6 报告及原始日志作为历史保留，不将其旧命令批量改写成新版本行为。

## 执行结果

### 实现与隔离验证

- 核心实现提交 `b66088c`；独立审查后的修复提交 `ef82e53`。已删除普通自更新 CLI/菜单，新增当前版本 refresh 与管理子菜单；旧 npm 包名 migrate 独立保留。
- 安装与刷新共用 Grok 身份/源/缓存验收。原生更新退出 0 不足以判定完成；陈旧缓存默认拒绝隐式重装/信任，明确同意后只通过宿主 keep-data/trust 流程重建，确认绑定源、缓存、登记和仓库身份。共享仓库、缺失身份与别名拒绝；禁用登记不重装、不启用。
- Grok 1.0.46 私有 HOME/socket 实验：原生 local-source update 不替换陈旧缓存；重复 install 被宿主拒绝。当前实现的集成实验先在合法 1.0.46 登记中**人工模拟**旧 0.2.0 / author string 缓存，再验证无同意不重建、literal true 后宿主重建与字节验收通过。它不是历史缓存来源证明；旧 slug 身份仍以隔离替身覆盖。未修复真实用户缓存，未运行付费模型或真实工具会话。
- 两项独立只读审查均完成。确认并修复：非交互安装中的未定义确认变量、刷新中 Esc 的直接成功退出、未勾选原生插件仍派发、取消原因空白及 doctor 的旧命令提示；补齐仓库身份/变化、移除后失败恢复提示和 truthful dry-run 文案。拒绝缓存重建仍报告刷新不完整，因为陈旧缓存未通过验收；不把拒绝同意当作成功，也不谎称其他成功目标未变。
- 有针对性红→绿证据：未勾选插件原先 `1 !== 0`；缓存确认 Esc 原先调用硬退出。修复后验证没有隐式插件派发、普通安装无交互回调、CLI 取消后兄弟事务完成、失败记录写入、未执行卸载/信任。保留既有卸载默认取消及预览范围复用。
- 完整 `npm run prepublishOnly` 在 `ef82e53` 通过：语法 240 文件、CI 策略、依赖审计 0 漏洞、72 个 poisoned-caller 隔离入口；模拟用户文件和源码树不变。生成资产字节核验包含在门禁中。搜索/Adaptive 架构、评分、容量和翻页未改动。

### 发布验收与边界

本地门禁不替代最终发布提交的四格 CI、实际 tarball 核验或公共 registry/tag 验证。发布采用 `0.2.4-beta.7`，仅推进 beta；最终远端状态以对应 GitHub prerelease、精确 tag 与 npm dist-tags 为准，不能以此 note 代替发布回执。

当前 Grok 插件内 `.mcp.json` 的 `npx -y search-boost serve` 仍是原有未固定版本配置；缓存版本验证不证明这一独立 MCP 进程运行 beta.7。此轮未改它或搜索运行架构。真实 Grok/DSH 配置、GUI 重启、历史 Windows 异常归因及付费服务可用性未作为隔离测试成功的推论。
