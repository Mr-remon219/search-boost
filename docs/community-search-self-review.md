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
4. **实例禁用与 scope/credential 改变**：私有 fingerprint 包含实例配置/credential 变化摘要；旧 x_search 同样遵守 readiness。能力资源不泄漏配置/credential/hash。
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

## 验证结果

所有代码/依赖修复后最终验证：

- `npm run check`：277 个源文件语法通过（含 browser extension）。
- `npm run check:ci`：CI 策略检查通过。
- `npm run audit:dependencies`：0 vulnerabilities。
- `npm run test:community`：三个入口全部通过。
- 完整 `test:isolation` 的同一入口 `node scripts/test-environment.mjs`：**80 个隔离入口全部通过**；模拟用户状态与 source tree 均未改变。包括安装/升级、npm package smoke/生成资产、MCP/DSH/Pi、X/fusion/Adaptive、网络/审计/持久化等回归。最终完整门禁在 SDK/proxy-addr 更新后重新运行并返回 0。
- 生成副本已执行 plugin:sync-grok/build:plugin，门禁中的 generated-assets 检查通过。
- Windows 的 POSIX mode/symlink privilege 用例由原门禁显式 skip：不把这些 skip 当成 Windows ACL 或其他 OS 验证。当前运行环境为 Windows、Node 24.21.0，不替代 Linux/macOS/Node 22 CI matrix。

中间发现并修复了 schema 文案、安装工具数量、X 诊断和 snapshot/cache 契约回归；另一次完整运行被工具的 600 秒执行超时中断，不能记为成功。最终使用充足命令超时重新完整执行，没有跳过失败入口或恢复真实用户凭据。自审结论：在上述实现与离线验证范围内，未发现尚未修复的已知代码/回归问题，可交用户审查；真实平台/账号/浏览器/宿主会话仍按明确的部署验收边界处理。
