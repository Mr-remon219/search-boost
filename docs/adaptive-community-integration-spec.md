# Adaptive 经 fused 底座接入社区：滚动实施设计

状态：共享接入及二次自审修复完成，最新代码最终离线门禁通过。真实连接/已安装宿主不在此次验收内。工作起点包含前序未提交社区、分页和旧 X 入口移除改动；不整合新 v0.2.5 基线，不提交/推送，不部署真实账号或修改宿主权限。

## 实际调用链与缺口

现有 runAdaptiveSearch 的 search 依赖已调用 runFused；screening 显式平台数组透传已存在，fused 调用未分页 communitySearch，五个平台的获取适配器无需重新实现。实施前缺口为 fused/Adaptive 未接受 platform_options、最终 X 聚合只收到公共 keyword 参数、non-X softDates 会吞掉新增显式日期硬条件、Adaptive 的 no_engines 前置判断阻断社区独立来源，以及响应只保留平台/状态/原因而选中材料丢失候选出处。

## 统一方向

- 平台选择仍为 community 的唯一平台名数组；true 仍为 X-only、false/[] 为 off。省略 Adaptive 选择时沿用现有模型 X-only 决策，不自动扩到五平台。
- fused 与 Adaptive 使用同一 nullable platform_options 契约和共享预处理，参数语义与直接 community_search 一致。非空 options 必须有明确社区选择；参数不隐式开启平台。非法/错投/矛盾参数必须在配置、判断或获取前拒绝。
- 公共 Web 查询保持原问题；只有调用者明确给出的平台 query 可覆盖该平台获取查询，不由模型扩写，不将 intent/preferences 混入查询。自动策略只负责原有 ranking/community 决策。
- 最终候选融合使用实际平台请求，X keyword/semantic/user/thread 各自正确处理；硬作者/日期/类别/范围不能由普通 Web 支路绕过。fused recency 对非 X 仍为软偏好，显式日期逐边界硬校验；null 不取消已有条件。
- 社区和 Web 共用候选额度、去重、原来源票、评分、正贡献权重和判断流程。不调用分页 community facade，不生成社区游标，不多做判断、检索或审计。
- 无 Web 引擎时，明确选择社区仍通过 fused 获取/报告真实渠道状态；自动 X-only 不凭空制造可用来源。判断配置锁、实例 readiness、host block、域名限制和取消不变。
- v6 增加可选的有类型出处与社区路线/诊断，保留旧 v5/v6 保存记录可读；不塞 raw provider/config/session。选中证据仍是被判断的共同材料投影，不将整个平台原始 payload 当作判断内容。直接 community_search 的 typed data/c1 分页保持独立。
- 保存/分页重放原筛选结果与执行记录；不是刷新。模型可见 schema、description、policy、资源/提示词、生成资产和三个宿主执行测试同步。

## 决策点与验证

先复现参数拒绝、账户聚合及无 Web 引擎障碍，再据接口证据选择最小共享实现；测试揭示行为冲突时记录调整，不机械扩大平台能力。关键验证包括五平台参数/null、错误参数零依赖调用、实际 fused→社区候选→判断链、账户/线程/非 X unsupported、硬过滤与软 recency、Web/社区同 URL 合并不加票、候选 cap、来源权重、部分失败/禁用、缓存参数隔离/usage、实际 MCP/Pi/DSH schema/执行、保存及零网络读页。最终完整隔离门禁与语法/CI/生成资产检查。

## 交付入口

- `lib/community/parameters.mjs`：直接/Fused/Adaptive 共用纯 schema；`fused-input.mjs`：共享零 I/O 语义预检/逐边界条件；`fusion.mjs`：同一聚合与硬过滤；`evidence.mjs`：有限白名单路线/出处投影。
- `lib/runtime.mjs` 与 `lib/search/screening/{input,run,controller,schema,pages}.js`：Adaptive 只用原有 search 依赖调用一次 runFused；直接社区 c1、Adaptive s6/v3 分页互不混用；候选缓存/普通缓存按新合同隔离。
- `scripts/test-adaptive-community.mjs`：实际五平台共享核心、X 四模式、无 Web 独立来源、零依赖拒绝、软/硬日期、scope/author/category、缓存/复用计数、原来源票/route、真实私有保存/离线读页和元数据 byte 边界。真实宿主执行扩展位于 `test-screening-hosts.mjs`；原 frozen baseline fixtures 未重写。
- 已同步 MCP/Pi/DSH 参数与描述、能力 integration 摘要、policy/injection、README/当前使用文档及生成资产。未新增依赖、未修改 lockfile。本轮及前序改动仍未提交/推送，无 PR。

## 二次自审：AR1–AR6 与 DOC1

首轮 85/288 门禁通过不能替代独立边界审查。本轮新增 `scripts/test-adaptive-community-review.mjs`，先观察 6 项失败，再修复，不用旧成功结果冒充此轮验收。

- **AR1**：日日期被 Date.parse 当作午夜，导致 native 日内超界条目能从普通 Web 的 day 投影回流；改为按观测时间区间包含关系验证，部分重叠按未知。追加索引/重复身份日期与作者的矛盾检测、保留原引擎观察，未知不 first-wins。第一次修复后的 86 门禁成功后，又用带 +08:00 的跨日 ISO 复现 UTC 下界回流；将 qualified instant 投影为 UTC 日（而非原文日期前缀），无时区 ISO 与缺日的月观察不猜时区/每月第一天。追加回归又复现原观察使 X Snowflake 日期被公共融合冲突抹掉；最终融合从真实 post-id 恢复更强日期权威，不改写原观察、不对 account id 推帖子日期。
- **AR2**：最终硬过滤只覆盖 platformUrl 认可的内容路径，主页/people 路径可绕过 answer 条件；改为覆盖所选平台整个匹配域名，未知内容身份排除。非平台 Web 正常保留。
- **AR3**：normalizeUsers 可用帖子/外站 URL 加 username 造账户 URL；拒绝非账户证据 URL，真正账户 URL 优先，原生无 URL 的合法 username 合同保留。
- **AR4**：整体 fused 未命中但嵌套渠道命中时，Adaptive 将旧 engineStats.attempts 重复算为新请求（fixture 10 而应为 3）；snapshot 引入本次 engineRequestsNow，保留旧渠道观察、排除 cache/in-flight 派发计数。多渠道 aggregate 同修；Reddit 范围发现请求补入 stats，warm archive + fresh discovery 不冒充全通道缓存。候选/社区 cache 合同版本递增。
- **AR5**：合法五渠道长说明可使筛选完成后因 16KiB metadata 报错；仅本页按阶梯裁剪说明/逐渠道 stats，以 details_truncated 和告警披露；状态、usage、计数、覆盖、全局统计及私有快照保留。h1 旧历史不裁剪。
- **AR6**：追加身份/URL 交叉检查复现同一小红书 note 在 Web 签名 URI、discovery alias 和 native URI 被当成 3 份候选，且普通 Web 出处保留 xsec_token。对明确所选非 X 的已识别内容 URL 按平台身份合并到安全 canonical URL，移除相应结构化 URI 的 query/fragment，保留每引擎原最佳 rank 和其他域名的合法 ref 参数；不靠标题合并、不清除所有 Web 查询参数。
- **DOC1**：此前文档错误地把直接入口 30 总结果上限套给 candidateMode。已通过两平台 50 获取候选/直接 30 结果/fused 40 声明快照复核，改为描述真正的获取预算与全局选取，不更改已验证的延后 cap 行为。

定向 12 组自审回归、shared community/Adaptive、真实 MCP/Pi/DSH schema/执行、cache/snapshot 和 7+5 frozen fused 原 hash 已通过；第一轮修复完整隔离 86 入口/289 文件通过；补充跨时区日投影后，定向请求/数学/融合/宿主回归及冻结 hash 通过，最新代码（含跨时区投影）再次完整执行 exit 0：86 个隔离入口全部通过，模拟用户状态/source tree 未改变；289 文件语法、CI policy、generated assets/包交付、git diff --check 通过，依赖 audit 0 vulnerabilities。7+5 frozen fused 原 hash 未重写；保留 Windows POSIX/EPERM skips 和原 DEP0190。未改依赖/lockfile、未实际安装/登录或扩权，仍未提交/推送或创建 PR。仍未提交/推送，不部署真实账号。

## 边界

保持 /x-login、/x-logout 与 xAI/Grok 托管/免凭据 X 核心；不恢复独立 x_search，不自动登录/安装/启用 backend，不扩大子工具白名单。非 X 未实现模式照常 unsupported，浏览器只读取可见卡片，archive 覆盖未知。离线 fixture/协议验证不代表真实平台连接或宿主安装验收。

## 证据日志

- 初始代码核对：lib/runtime.mjs 的 runAdaptiveSearch 默认 search 调用 runFused；screening/run.js 数组已透传。runFused 构造公共 keyword communityArgs，未接收 platform_options；screening/input.js 也拒绝该字段。community/service.mjs 已有各平台能力与处理，因此复用而非创建第二套获取。
- 复现证据：新增隔离测试在最初实现上观察到 Reddit subreddits 为 undefined，即 fused 静默丢掉平台参数。已引入共享 fused-input 纯预检，Adaptive 在配置/判断前调用同一语义校验；宿主 fused 注册均透传同一参数。
- 聚合决策：X user 原 normalizeUsers 丢失 engineRanks，导致账号无法进入正贡献候选；补齐原来源排名/出处保留，账户时间不伪装推文发布时间，thread 的普通 Web 候选只接受可核实目标帖。非 X 的显式日期逐边界硬校验，原生成 recency 仍软；历史硬上界优先，Reddit 使用截止该日期的自身有界采集窗口。硬条件覆盖普通 Web 匹配条目，不以索引 display author 造 native 身份。
- 新测试发现 ISO 与 day 出处格式可能被聚合误判为日期冲突：共同出处用既有 day 投影，精确 native 时间仍只用于真实硬边界验证。修复后旧 X recency/作者/OR 回归通过。
- 首轮定向证据：实际 shared fused→community→Adaptive 五平台、X 四模式/账号排名、无 Web 引擎独立来源、参数零依赖拒绝、per-edge 日期/缓存、真实 private v3 保存与零检索分页恢复已通过。扩展真实 MCP/Pi/DSH 网络 fixture 中发现默认路由的缺键/不可用 engine 会诚实报告 partial，断言按实际 ok/partial 分支核对而非改成成功。随后真实 MCP/Pi/DSH fused 与 Adaptive 参数/路线/正贡献出处、v1/v2/v3 读页、schema 编译和生成资产核对通过。
- 首次完整隔离枚举 85 入口，但在 420 秒外部执行超时前已发现安装回归：routing 静态引入 fused-input，把 Ajv 校验依赖带入无 node_modules 的维护包复制 fixture，3 项 DSH layer payload 检查提前 ERR_MODULE_NOT_FOUND。该运行失败/中断，不计通过。将平台参数 schema 移至依赖自由的 parameters.mjs，routing/schema 仅引用纯常量，检索入口继续共享 Ajv/语义校验；不弱化安装检查、不为维护命令加载 provider 或额外依赖。定向 11 项 layer 回归全过；不安装依赖、不改测试替身。
- 随后的完整隔离运行执行完所有入口，但 3 项失败：两个 schema 字段名单漏了新增 platform_options；普通旧 boolean-X 的冻结 digest 被新增 route 出处改变。字段名单按明确接口增加更新；route 出处只增强 snapshot/显式平台数组或新参数合同，旧普通 boolean-X 返回保留原出处，未重写任何 golden digest。7 个冻结普通 fused + 5 个社区 on/off replay 的 scores/list/selectionScore/provenance 全部原 hash 通过。新投影单测还将来源 helper 本身收束到 64 条，上层保留原长度截断标记。最终代码重新执行完整隔离 exit 0：全部 85 个入口通过，模拟用户状态及 source tree 未改变。语法 288 文件、CI policy、generated assets/包交付、git diff --check 通过；audit 0 vulnerabilities，保留原 Windows POSIX/EPERM skips 和 DEP0190 披露。
