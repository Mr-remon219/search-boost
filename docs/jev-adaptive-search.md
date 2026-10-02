# Jev 单流程筛选：当前契约（N_off, schema v5）

本文是 `adaptive_search` 生产契约的当前说明，对应 N_off 单流程：一次有界 fused 候选快照 + 一次固定选项 Jev 策略请求 + 一次固定选项筛选。它取代此前的 v3 关键词循环说明；历史文档（`adaptive-keyword-index.md`、`adaptive-history-aware-audit.md`、`adaptive-review-points.md`、`adaptive-fused-screening-plan.md`）只对应旧版本或原型设计，其中被本流程替代的部分不再生效。

- 数值公式与价值等级沿用 screening 原型（`fused-screening-mix-v2-prototype`），本文不重复公式推导，见 `docs/adaptive-fused-screening-plan.md` 与 `lib/search/screening/scoring.js`。
- 预算语义以 2026-10-02 的补充修正为准：**没有任何自设的累计成本、token、请求次数或整次调用时限可以停止本流程**；用量只做观测与披露。

## 1. 输入契约与旧字段迁移

正常新研究：

| 字段 | 契约 |
| --- | --- |
| `questions` | 恰好一个非空字符串，最长 400 字符。就是唯一检索 query，不做关键词规划或查询扩展。 |
| `intent` | **必填**非空字符串，最长 2000 字符；不再由问题自动填补。 |
| `preferences` | 可选 0-8 条非空软偏好，每条最长 300 字符；按键精确去重后等权平均，只加分。 |
| `community` | 可选严格 boolean，无 schema 默认值。省略 = 由同一次策略请求选择 `enable`/`disable`/`unknown`；显式 true/false 覆盖且不再提问该题。 |
| `save_results` | 可选严格 boolean，默认 false。true 时私有保存**完整的最终选中集**与类型化元数据。 |
| `max_results` | 保存/交付的目标条数，默认 10，范围 1-50。 |
| `page_size` | 每页条数，默认 20，范围 1-50；不改变排序、selection、totalResults 或 targetMet。 |

只读输入：`cursor`（`s5:` 本次运行页 / `h1:` 历史只读页）或 `saved_result_id`（36 位小写 UUID），只可搭配 `page_size`。

迁移规则：

- `constraints` 作为逐材料硬门槛已退役。省略或传 `[]`（返回 `deprecated_constraints_empty` 警告）；非空合法数组在任何检索/Jev 调用前以 `adaptive_constraints_removed` 拒绝；类型/长度/元素无效按输入错误拒绝。
- `keywords`、`tasks`、`targets`、`facts`、`time_range`、嵌套关键词数组等旧字段一律零网络拒绝，不做静默丢弃。
- `cursor` / `saved_result_id` 不得与任何新研究字段（包括 `save_results:false`、`community:false`、`constraints:[]`）混用，两个读取 ID 也不能并用。
- 结构与旧字段检查在配置读取、工具状态检查与所有网络之前完成。工具描述继续提示 questions 与 intent 必须使用英文，但这是调用方提示，不做语言校验、拒绝、翻译或诊断；任何语言都按原文检索。

## 2. 唯一执行流程

```
结构与迁移校验（零网络）
→ 公开入口门控（显式 OFF / Jev 配置锁）+ 外部 signal
→ cursor / saved_result_id 只读分支在此结束（不建 Jev 客户端、不问策略、不检索、不判断）
→ 一次固定策略请求：选 ranking；community 省略时同一次选 enable/disable/unknown
→ 代码解析显式覆盖 / 模型选择 / unknown 与缺失回退，落实能力与域名限制
→ 调用共享 runFused：query=原问题，medium，candidateSelection=snapshot，community=解析后的布尔值
→ 有界快照（目标 ≤10 时最多 32 条；更大目标为 ceil(max_results × 32 / 10)，最高 160；网页与社区行共用）按原融合分与稳定 key 全局排序后截取
→ prepareMaterial 校验/哈希并标记 pending → 分批固定选项 safety/value/source discount/preferences
→ 代码排除安全失败、基础分无效、不可判断、value 未建立与 value<3
→ 原型 screeningScore + 稳定 tie-break + max_results 截断 → schema v5 结果
→ save_results:true 时保存完整最终选中集，然后建立进程内 s5: 分页
```

没有第二轮检索、没有关键词续搜、没有自动补读（`rescueReads` 固定为 0）、没有 N_on/N_off 开关、没有第二个 adaptive 入口。

## 3. 搜索前策略与 community 优先级

- 策略请求只含 `strategy.ranking` 与（省略 community 时）`strategy.community`；criteria 由代码提供，Jev 只返回选项，不产生平台名、引擎、查询变体、预算或系数。
- 优先级：显式 boolean（按字段是否存在识别，不被 truthy/默认值覆盖） > 模型选择 > 缺失/非法回退。`enable→true`、`disable→false`、`unknown→false`；缺失/坏形状/非法 option 同样 false，但状态记为 unavailable 并披露，不伪装成模型选择 disable。
- 能力处理基于同一个 runtime capability snapshot：官方 X 不可用但既有 fallback 可用时按原机制执行；已知整条支路不可执行或被授权边界禁止时跳过并返回结构化 `unavailable`/`blocked`；普通路由无可用引擎时仍 `no_engines` 失败。
- `run.community` 输出固定结构：`input`、`source`、`choice`、`requested`、`effective`、`outcome`、`cacheHit`、`reason`、`usage`；状态只来自共享核心的结构化执行记录，不解析 warnings 文案，也不从 `communityUsed` 推断成功。
- 公开 `x_search` 入口开关只关闭公开入口，不是内部引擎授权表；searcher 对 fused_search/fetch_page 的依赖检查也不适用于本流程。
- 当前内置 snapshot 没有独立的 X 禁用/宿主权限配置，`fallback.available` 表示既有无需凭据入口可尝试，不是联网成功保证。`blocked` 仅在宿主明确提供 `capability.x.blocked` 时产生，不会把公开工具 OFF 当作内部禁令；配置不足、实际失败与无引擎分别按真实路径披露，不能仅凭官方不可用关闭 fallback。
- `run.community.usage` 保留有限的 `officialAttempted` / `fallbackAttempted` / `dispatchedNow` / `inFlight` 布尔标记及计数。HTTP/账单 token 未观察到时为 null；共享缓存或 in-flight 复用的本次派发/请求计数为 0，原 `partial` 等执行状态仍保留，不重复计费式计数。

## 4. 判断、价值与来源

- safety 固定选项 `clear`/`violation`/`unavailable`，与语义相关性独立，missing 不作为 clear；结构有效只是 pending。
- value 固定 0-5 与 `unestablished`；只交付已建立且 ≥3 的等级，低价值、未建立与服务不可用分开披露。`qualityAssessed` 是原型口径：通过准入并获得 value≥3 的候选数，不等于拿到 value 答案的候选数。beta.6 新增 `diagnostics.valueJudged`，单独统计得到有效 value 等级或显式 unestablished 答案的候选（包括低价值和安全拒绝行），不可用答案不算；它与准入数不能混用。
- 来源折扣只对真实正贡献引擎的固定选项生效；缺失来源中性且披露；confidence 只做审计，不参与评分、阈值或准入。
- 偏好精确去重后取平均；反例可以有高 value 或匹配偏好；`valueGroups` 是最终结果标签索引，不改变排序。默认仅 URL 去重、`mu=0`、`dedupe=false`。

## 5. 资源边界与用量观测

容量/协议上限（不是累计预算）：`candidateLimit=max(32, ceil(max_results × 32 / 10))`（公开目标最高 50，对应容量最高 160）、`batchSize=4`、每次最多 1 次重试、Jev 响应最大 24000 字节、state/request 上限 48000/60000 字符、初始材料最多 8000 字符、单请求 20 秒、回退最多 4 秒、`rescueReads=0`。

beta.6 保留原先默认目标 10 / 容量 32 的筛选余量比例；12 条目标对应 39，50 条目标对应 160。该容量在一次检索前确定，并贯穿 engine 请求、共享快照截取、缓存键及 `run.limits.candidateLimit`。内部显式容量覆盖仍有权威性并校验整数 1–500；覆盖小于目标时仍披露 `targetExceedsReviewCap`。不追加检索，不因已够数量提前停止，也不保证上游能供足或筛选后必然足量。扩大目标会增加判断量；标准四条批次下，160 个实到候选需约 1 次策略 + 40 批 Jev 判断（长文本尺寸拆批、重试另计），默认 10 条目标仍为原容量。

网页与 X/community 共用全局快照上限，不表示两条支路各自都能供满该容量：既有 X 支路最多返回 30 个候选，beta.6 扩大全局容量不改变它。若 160 条容量被填满，其余至少 130 条须来自网页；实际供应和筛选后数量仍不保证。

用量计量（`screening-metering-v3-no-cumulative-cap`）只记录发生过的调用与估算，并在 `usage` 中披露：`fusedCalls`、`engineRequests`（null=未知）、`jevCalls`、`jevHttpAttempts`、`jevRetries`、`jevInputTokensEstimated`、`jevTokensEstimatedReserved`、`jevInputTokens`/`jevOutputTokens`（未上报即 null）、`serverUsageCalls`、`unknownUsageCalls`，以及本层 `fetch*` 的真实 0。达到任何旧上限都不会拒绝后续请求，也不会中止已有效结果。

真实单请求超时、有限重试、认证/限流/网络错误、SSRF/重定向与内容安全、显式取消继续生效；取消后不派发新请求，批次失败保留已有效材料。MCP/DSH 的 `adaptive_search`、`fused_search`、`x_search` 均不设置整次搜索总时限；SDK/宿主/提供商自身的外部硬限制仍可能存在，不能将它们描述为无限运行。`fetch_page` 的读取保护及研究子任务显式时限不因本补充取消。

## 6. 返回、分页与持久化

- 所有新研究直接 `schemaVersion=5`，策略版本：`fused-screening-mix-v2-prototype`、`screening-judgement-v4-no-scope-no-language`、`screening-strategy-v2-community-no-language`、`no-scope-v1`、计量 `screening-metering-v3-no-cumulative-cap`。
- 结果行含 ID/rank、URL/标题/准确摘录、basis/日期/文本与分数版本、真实来源、`valueLevel`/`valueLabel`、分数组件、来源折扣与偏好匹配、有意义的 value/discount confidence。
- `selection` 给出 `requested`/`returned`/`targetMet`/`stopReason`/`incomplete`；`diagnostics` 给出计数守恒与排除原因；`outsideReview`/`unreviewed` 明确未被审阅的候选，绝不当作低价值或不存在。`targetMet` 只表示数量。
- 新响应不返回 `keywordProgress`、`retrievalSufficient`、`coverageComplete`、`scopeSummary`、`convergence`、`finalReview`、`tier`/`valueScore` 等旧字段，也不填假零/假 true。
- 页面软容量为 96,000 UTF-8 字节（原先 45,000），元数据仍保留 16,000 字节预算；按三条 8,000 字符中文摘录（约 72,000 字节）及字段开销协调容量，避免常规长中文结果被迫每页一条。page_size 仍是条数上限，不保证装满；超软限单条仍完整交付并告警，绝不截改已审摘录。读取/完整保存集合的语义不变。
- 分页：进程内共享 30 分钟 / 32 份页面池，`s5:` 对应 v5 运行、`h1:` 对应历史只读恢复；拒绝裸 UUID.offset、`s4:`、过期/驱逐/越界 cursor，且零网络。`clearAllCaches` 只清内存/检索缓存，不删除持久快照。
- 持久化：新写入 `search-boost-research-v2` + `metadata.schemaVersion=5`；读取按 `format` 分派，v2 校验失败绝不降级 v1。旧 v1 文件只读恢复，返回 `restoration={historical:true, originalFormat, originalSchemaVersion}` 与 `h1:` cursor，保留原结果与元数据、不伪造 v5 字段、不就地升级、不刷新 `savedAt`。存储保留 64MiB 上限、UUID 文件名单硬链接与 NOFOLLOW 校验、0700/0600 私有原子写入、递归白名单清洗、取消不返回成功 ID、CLI 离线 `research list`/`research export` 与 `wx` 不覆盖。

## 7. 失败语义

真实结构错误、认证、网络、无引擎、安全拒绝、取消、超时按真实原因返回；社区支路失败或部分失败时仍交付已筛选的网页结果并把 `selection.incomplete=true`、`stopReason=community_incomplete`（除非已有更具体的停止原因）。空结果不证明不存在；被拒绝的旧 constraints 内容不发送给 Jev。成功读取一份原本 `stopReason=not_configured`/失败/空结果的历史文件表示本次读取成功，不触发新的配置诊断。

## 8. 验证边界

仓库内的离线 fixture 只证明机制、契约与失败语义，不证明线上策略质量、语义准确率或研究完成度。发布前按 `docs/test-isolation.md` 运行隔离门禁；`scripts/test-adaptive-capacity.mjs`、`scripts/test-screening*.mjs`、`scripts/test-adaptive-search.mjs`、`scripts/test-screening-hosts.mjs`、`scripts/test-fused-baseline.mjs`、`scripts/test-noff-community-snapshot.mjs` 与 `scripts/test-research-persistence.mjs` 是本文契约的自动化证据。迁移说明与退役清单见 `docs/adaptive-screening-migration.md`。
