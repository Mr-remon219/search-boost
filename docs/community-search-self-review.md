# Community Search 交付前自审

日期：2026-10-07。范围：本次新增五平台社区实现、X 兼容迁移、MCP/Pi/DSH、fused/Adaptive、提示词/注入、browser bridge、配置和交付资产。

## 审查方法

- 逐项检查配置、注册、能力、调度、原始 rank/provenance、融合、缓存和 host schema 的调用边界。
- 对 failure/empty/partial、未知日期、域名别名、disable、取消和迟到回包做独立负向 fixture。
- 使用真实 MCP SDK 内存协议、真实 pinned DSH SDK schema/注册，以及真实 loopback HTTP bridge（仅测试进程）。
- 运行完整 poisoned-caller 环境隔离门禁，观察用户文件/源文件树与敏感输出，不以单一测试返回 0 替代这些检查。
- 核对 npm 交付文件和自动生成资产；没有修改用户实际配置/权限/账号。

## 自审发现并修复

1. **X 诊断不能由 warning/notes 推断 partial**：继续采用原 X execution record；oEmbed enhancement 失败保留有效 base posts，不伪装成主支路 partial。
2. **旧 snapshot 使用计数/未知状态契约**：保留 X 的 bounded counters/null、缓存和 single-flight 语义；无 attested record 不报成功。完整原 N_off 社区快照回归覆盖。
3. **fused 缓存逐平台诊断**：缓存命中标记 reused channels，并清掉 nested execution 的 fresh-dispatch 计数；partial 有有效结果仅短暂缓存，failed 不缓存。
4. **实例禁用与 scope/credential 改变**：私有 fingerprint 包含实例配置/credential 变化摘要；内部 X 核心遵守 readiness（后续已移除公开 x_search 注册）。能力资源不泄漏配置/credential/hash。
5. **web-index 全失败 vs 空结果**：保留底层引擎 trace，全部失败不报告成功 empty；异常说明脱敏。
6. **Reddit 私有语料与并发**：校验 scope/窗口，剔除非法/越范围缓存行、恢复无效游标；锁内合并并发语料/进度。cursor_stalled 保持未完成并披露，不永久变成假穷尽。
7. **模型可见 provenance**：MCP/Pi/DSH 文本及结构化结果显示 retrieval route；web 包装不新增独立票；签名/跟踪 URL query 不进入卡片证据。
8. **schema 投影文案**：JSON-Schema union/enum 投影保留共享 description；平台数组契约在所有 host 一致。
9. **安装权限枚举与发布文件**：更新既有工具计数，断言 Grok 枚举不加入 backend 管理；bridge/扩展文件明确随包交付。已有用户 server-wide/wildcard trust 未被擅自修改。

10. **依赖安全门禁**：初次 npm audit 报告 SDK 与 proxy-addr 两项漏洞。核对官方 advisory 后，将 SDK 最低范围提高为 ^1.31.0（锁定并实测 1.32.1），proxy-addr override 为 ^2.0.8（锁定 2.0.8）；没有使用 audit fix，没有升级其他依赖。最终依赖审计为 0 vulnerabilities。SDK advisory 指出 server/stdio 不受该 OAuth client 问题影响；仍修复依赖以满足包的发布门禁，没有声称当前用户凭据已泄漏或擅自撤销/迁移登录。参考：[SDK advisory](https://github.com/advisories/GHSA-6qxp-vccf-f47h)、[proxy-addr advisory](https://github.com/advisories/GHSA-jqcg-44mw-7w3h)。
11. **语料容量耗尽**：满 4000 条时直接报告 corpus_capacity，不继续发请求并丢弃新记录；明确要求缩小范围/窗口或等待到期，而不是承诺满容量后还能无损继续。

12. **DOM 卡片边界**：仅收集识别出的卡片容器内的链接，每张卡片只保留一个候选；导航和正文引用链接不因 URL 形状符合就冒充独立搜索卡片。相应负向 fixture 已加入。

## 有意的能力边界，不是未披露的成功宣称

- Reddit 为有限归档帖子采集/本地 relevance，coverage unknown；不是完整评论采集、实时报表或全站穷尽。
- 中文平台默认是 indexed excerpts；浏览器是可见搜索卡片，Bilibili public 为可选 API。没有伪造正文、verified publication date、作者或签名。
- 浏览器由用户手动启动、加载/启用扩展、设置环境变量；只读固定任务，不自动安装/登录、导出 cookie、解 captcha 或发帖。
- 注册工具只改本地声明配置；annotations/提示词要求用户授权，但不能从模型参数证明用户真实同意。已有 broad host trust 按原规则生效。
- 子代理白名单保留 fused/fetch；新管理权限未发给孩子。
- 实际账号/Chrome/已安装 Pi 和 DSH 的各版本会话未测。离线测试不代表真实服务连接或全平台实时可用；这部分属于部署者验收。

## 49ecd7c 的历史验证结果（不代表 C1–C7 已通过）

最初交付的代码/依赖验证：

- `npm run check`：277 个源文件语法通过（含 browser extension）。
- `npm run check:ci`：CI 策略检查通过。
- `npm run audit:dependencies`：0 vulnerabilities。
- `npm run test:community`：三个入口全部通过。
- 完整 `test:isolation` 的同一入口 `node scripts/test-environment.mjs`：**80 个隔离入口全部通过**；模拟用户状态与 source tree 均未改变。包括安装/升级、npm package smoke/生成资产、MCP/DSH/Pi、X/fusion/Adaptive、网络/审计/持久化等回归。最终完整门禁在 SDK/proxy-addr 更新后重新运行并返回 0。
- 生成副本已执行 plugin:sync-grok/build:plugin，门禁中的 generated-assets 检查通过。
- Windows 的 POSIX mode/symlink privilege 用例由原门禁显式 skip：不把这些 skip 当成 Windows ACL 或其他 OS 验证。当前运行环境为 Windows、Node 24.21.0，不替代 Linux/macOS/Node 22 CI matrix。

中间发现并修复了 schema 文案、安装工具数量、X 诊断和 snapshot/cache 契约回归；另一次完整运行被工具的 600 秒执行超时中断，不能记为成功。最终使用充足命令超时重新完整执行，没有跳过失败入口或恢复真实用户凭据。当时的“未发现尚未修复问题”结论被外部审查 C1–C7 推翻，不能继续作为当前质量判断。上述 80 个入口/277 文件是历史证据，不可拿来代替新增行为边界验证。

## 外部审查 C1–C7 修复复核（2026-10-07）

范围仅为当前 community 分支；没有整合后续 v0.2.5/PR 32 基线，没有创建 PR。外部报告为 `SearchBoost-Community-Review-49ecd7c.md`。本轮再次完整读取报告，并在隔离环境读取固定提交源码、注入内存 IO 重现：

- C1：已 disabled 仍创建 1 个 tab；等待期间 Disable 后仍 executeScript 并返回 ok。
- C2：隐藏卡片配合可见安全验证文本仍返回 ok 和隐藏正文。
- C3：两个 scope、max_pages=1，连续四次只请求字母排序首个 scope。
- C4：30 个可用 X 帖、请求 20，只返回 10。
- C5：softDates=true 仍删去已知旧日期，只留下 unknown/new。
- C6：现行 MCP policy 含 X-only 和旧 disable 说明。
- C7：旧 worker 无载入恢复、无 onInstalled handler，仅有 onStartup；这是 mock 控制流与官方生命周期证据，不是真 Chrome Reload 实测。

### 修复与新增验证

| 项 | 修复 | 行为级回归 |
|---|---|---|
| C1 | 可取消运行代次、storage 配置变化监听、轮询 abort、多次授权/active guard；快速 re-enable 等旧代次与 tab 清理结束 | 晚到任务、等待期 Disable、提取前 Disable、提取中 Disable、快速关开、token 变化 |
| C2 | 可见 gate 优先；卡片/anchor/祖先布局和隐藏状态校验；innerText 排除隐藏文字 | hidden 卡片/祖先、无布局、背景卡片配验证遮罩、隐藏遮罩、普通 captcha 文章、无卡片登录页 |
| C3 | 私有 checkpoint 持久化单调 scope_turn；失败也保存轮转位置；锁内 max 合并防止旧 writer 回退 | 1/2 页预算多次恢复、旧 checkpoint、exhausted/failed scope、并发倒序完成及语料合并 |
| C4 | communityMode 独立控制 30 cap 和 execution facts，不改变 candidateMode 或放宽过滤 | 真实 runXSearch 编排的 11/20/30 cap、semantic、作者/日期过滤、cache usage、official 失败/fallback 成功 partial、legacy 10 cap/输出 |
| C5 | softDates 对整个非 X 结果层中性，而非仅对 unknown 中性 | 已知旧/未知/新日期同批；显式日期 strict；真实 fused fusionRows 与正常 diversity selection |
| C6 | MCP 资源更新为五平台、平台数组、实例 readiness/工具开关区分 | registry/schema/policy 一致性与真实 MCP readResource |
| C7 | worker 载入、update、startup 恢复既有 consent；创建前持久化唯一 URL 所有权标记以清理中断 tab | 首装 off、保存 enabled 后无需 popup 启动、update/start 多事件不重复循环、恢复只删已确认自建 tab |

新入口：`scripts/test-community-worker.mjs`、`scripts/test-community-review.mjs`；已有 bridge/MCP fixture 扩充，`test:community` 纳入全部五个入口。旧 X snapshot 和 prompt-contract 定向回归已通过。

Chrome 官方依据：[runtime unpacked reload/onInstalled](https://developer.chrome.com/docs/extensions/reference/api/runtime#unpacked-extension-behavior)、[worker lifecycle](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle)、[storage](https://developer.chrome.com/docs/extensions/reference/api/storage)。storage.session 在 Reload/update 时清空，不将其当持久恢复账本。恢复标记用 storage.local；站点去掉 fragment 或用户导航后不能可靠确认所有权，保守不关 tab，不承诺所有中断 tab 均能自动回收。Chrome 已开始的 native API 无法撤回；Disable 后拒绝采纳/提交旧结果并清理已建 tab。

第一次定向运行有两处 fixture 预期错误（snapshot 漏 availableEngines、忽略正常同域 diversity cap），已按真实契约修正，不计作通过。固定源码复现第一次因隔离 harness 切换 cwd 无法读取 Git；第二次显式指定只读仓库 cwd 完成，没有真实供应商/浏览器调用。

### 当前验证状态

最终代码修改后验证：

- `npm run test:community`：全部五个入口通过，包含新增 worker/review 行为回归。
- `node scripts/test-noff-community-snapshot.mjs`：14 个旧 X snapshot/community 分组通过；prompt-contract 定向通过，完整门禁中再次通过。
- `npm run check`：279 个源文件语法通过；`npm run check:ci` 通过。
- `npm run audit:dependencies`：0 vulnerabilities；仍有原脚本的 Node DEP0190 shell deprecation warning，本轮没有依赖/锁文件变更。
- `plugin:sync-grok` / `build:plugin` 已执行，生成内容无新增差异；完整门禁中 generated-assets、包交付、宿主/安装/升级/网络/持久化测试通过。
- `node scripts/test-environment.mjs`（test:isolation 同一入口）：**82 个隔离入口全部通过**，模拟用户状态和 source tree 未改变。明确记录的 Windows POSIX-mode/symlink skip 不算作这些边界的实测。
- `git diff --check` 通过；新增测试保持 isolate bootstrap 在应用导入前。

这些结果来自 C1–C7 修复当轮完整执行，不是旧 80 入口日志；也不能代替下述新增平台处理/分页的最终门禁。修复仍在当前工作树，尚未提交或推送。真实 Chrome、平台账号、安装宿主会话及 v0.2.5 基线整合仍未验证，不扩大离线测试结论。

## 平台独立处理与分页复核

滚动设计见 [community-platform-pipeline-spec.md](community-platform-pipeline-spec.md)。本轮关注：

- 平台分区/null 默认、参数优先级、精确 ISO 时间、错误条件零派发；不混淆默认与未实现能力。
- X 保留原有处理；非 X 独立身份/内容分类、合并后过滤、未知日期/作者诊断；web-index author display label 不充当账号身份。
- 类型化平台 data 的闭合 schema、数字版本 literal、nullable union；真实 MCP/Pi 读页、DSH 编译/执行，禁止 strip 平台内容。
- 独立 c1 只读分页、不可变快照、页/总量与上游预算区分、UTF-8 完整条目、home/TTL/容量/取消；读页零派发/零新检索审计/usage 重放。
- 显式 private persistence、普通文件/大小/ID/格式/闭合 payload 校验，跨进程恢复与原采集时间；不混入 Adaptive 格式、不保存 config/token/raw session。
- fused/Adaptive 继续直接获取全体有界候选，不因对外 page_size 丢候选或重复检索/加票。

定向 pipeline/pages 与既有社区、旧 X snapshot/DSH 验证已通过。发现并修复数字 enum 的旧 Zod 投影缺陷；新 fixture 修正了隔离 home 未必以环境 override 提供的假设。最终代码修改后的新执行结果：

- `npm run test:community`：七个入口全部通过，C1–C7 回归保留。
- 真实 DSH 编译/执行、MCP/Pi 读页、prompt-contract 和旧 X snapshot 14 分组通过；完整门禁中再次运行。
- `npm run check`：284 文件语法通过；`check:ci` 通过；`audit:dependencies`：0 vulnerabilities，原脚本 DEP0190 警告不掩盖。没有依赖/锁文件变更。
- `plugin:sync-grok` / `build:plugin` 已运行，更新生成的启动提醒；generated-assets/包交付回归通过。
- `node scripts/test-environment.mjs`：**84 个隔离入口全部通过，模拟用户状态和源文件树未改变**；POSIX/symlink 的已有 Windows skip 仍明确记录，不冒充跨系统验收。
- `git diff --check` 与文档相对链接/末尾换行核对通过。最终文档记录不改代码。

这不是此前 82 入口日志。本轮实现仍为未提交工作树；真实平台/账号/Chrome/安装宿主版本及新基线整合未测，不扩大结论。

## 后续：移除独立 X 工具，保留认证命令

按用户要求，MCP/Pi/DSH 不再注册 x_search；旧 schema、description、catalog、skill token 和 Grok 权限枚举同步移除，提示词/资源/文档示例统一使用 community_search 的 engines:["x"]。内部 X 检索核心、四模式、过滤、单飞缓存和 hosted/fallback 未删除。用户随后明确要求保留 /x-login、/x-logout：两宿主命令及 CLI config x 均保留，离线注册/本地 API key 登录与退出切换回归通过。

旧配置 x_search:false 只读继承到尚未显式设置的 community_search；旧工具不能重新注册或保存新偏好。对子 agent 旧白名单仅报告 retired_tool，不自动授予社区工具权限。第一次全量运行发现安装测试旧 auto-allow 数量断言，已按实际六条权限更新并增加旧 X 权限缺席验证，失败运行不计入成功结果。

该次代码修改后重新执行：84 个隔离入口全部通过，模拟用户状态和 source tree 未改变；284 文件语法、CI policy、git diff --check 通过；生成资产/包交付验证通过；依赖审计 0 vulnerabilities（原 DEP0190 警告保留）。真实 MCP 验证旧工具不在列表且旧调用被拒绝；DSH 实际七工具编译/执行通过。未登录真实账号、未修改实际安装宿主/权限，仍未提交、推送或创建 PR。

## 后续：Adaptive 通过 fused 底座共享社区

按新需求先分析既有调用链，再补齐 shared platform_options/纯预检、X 四模式、跨 Web 硬条件、无 Web 引擎的独立来源、渠道/原出处摘要及保存/零网络读页。Adaptive 没有新增检索链，不经过直接 c1 分页入口。真实 MCP/Pi/DSH 的 fused 与 Adaptive 执行/参数同构通过；检索/策略次数、原 engine 票、完整候选审查和 usage 复用保持同一核心。

完整门禁暴露了 schema 引入 Ajv 到无依赖维护包，以及新 route 出处误改旧 ordinary X 冻结 digest；前者拆为纯 parameters 常量，后者只增强 snapshot/显式新合同。未弱化安装检查，未更新原 frozen golden，7 普通 + 5 社区冻结回放全保留。详细失败/中断、修正与边界记录在 [Adaptive 滚动接入设计](adaptive-community-integration-spec.md)。

该轮重新执行：全部 85 隔离入口 exit 0、模拟用户状态/source tree 未改；288 源文件语法、CI policy、生成资产/包交付、git diff --check 通过，audit 0 vulnerabilities。保留现有 Windows POSIX/EPERM skips、DEP0190 和真实连接未验收边界。未改依赖/lockfile；没有真实安装、账号登录、授权扩展、提交/推送或 PR。

## Adaptive 社区二次自审与修复

独立边界审查复现并修复 AR1–AR6：日期粒度/跨时区投影与矛盾观察、未知平台路径绕过硬类别、非账户 URI 制造 X 账户、嵌套缓存重复计数/Reddit 发现漏计、多渠道长 metadata 导致交付失败、Web/native 平台别名重复及结构化签名 URI 暴露。补充 DOC1 撤回此前候选总量 30 的错误说明；不修改正确的 candidateMode 延后限额行为。

新增 `scripts/test-adaptive-community-review.mjs` 的 12 个独立回归组；先观察失败，再修复。第一次修复后的 86 门禁虽通过，补充跨时区检查仍揭示原文日期前缀错误；修复后对最新代码再次执行全量，不用旧通过结果覆盖新变更。详细证据/修正与格式兼容在 [接入设计的二次自审段](adaptive-community-integration-spec.md)。

最终最新代码：86 个隔离入口全部 exit 0，模拟用户状态/source tree 未改；289 文件语法、CI policy、生成资产/包交付、diff 检查通过，依赖 audit 0。7 普通 + 5 社区 frozen fused 仍为原 hash；保存/零网络读页、真实 MCP/Pi/DSH 编译/执行和认证命令回归通过。只代表隔离 fixtures/协议，不是实际平台连接/已安装宿主验收。现有 Windows POSIX/EPERM skips、DEP0190 保留；无新依赖/lockfile变更，无提交、推送或 PR。

## TUI：五平台配置与精简交互

按用户确认方案替换首页 X 入口，双布局共用 Community 配置。用户进一步要求每个选项有实际作用、信息简短易懂：一级只保留五个平台及返回；状态 / 限制就地显示，删除单独的检查、说明、凭据、浏览器指南和全局高级管理层。X 凭据直接执行，缺少会话 / 本地副本时不提供导入 / 移除；单一 X 来源重新启用、单份额外配置删除均直接预览确认，不套只有一个目标的选择器。多份额外配置才询问目标。浏览器步骤只在设置时出现，缺环境变量仅保存未启用配置，不替换现有来源。

新增平台级预览 / 原子事务：来源切换只启用选定实例、停用同平台其余实例，停用平台覆盖全部实例；配置、其他平台及凭据保留。配置修改不隐式切换来源，删除不启用默认实例。表单与确认期间配置变动拒绝旧计划；无变化无确认 / 写入，dry-run 不建目录或锁，取消不留半份表单。维护路径改用纯参数常量，避免配置 UI 间接加载 Ajv。

初次定向测试失败：UI 展示行的 platform / ready 字段误传入严格实例校验。已显式投影为配置字段，并加强测试，使菜单内部捕获的错误不能被当成成功。最终 `test:tui` 四入口、X 认证、community/provider 及 DSH 维护回归通过；全量 **87 隔离入口** exit 0，模拟用户状态和 source tree 未改。新测试通过真实菜单执行覆盖双语、双布局、所有实际操作、来源排他性、零网络、条件选项、凭据保密与过期状态、并发、dry-run、Esc / Ctrl+C。现有 Windows POSIX/EPERM 跳过项保留；未声称实际终端人工体验、Chrome 会话或平台连接已验收。无依赖 / lockfile 变更、真实部署、提交 / 推送或 PR。
