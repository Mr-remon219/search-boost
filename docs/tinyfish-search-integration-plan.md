# 搜索引擎调整计划：移除 Yahoo、接入 TinyFish、下调 DDG

> 状态：已实施，离线回归完成；TinyFish 真实服务调用尚未验证。
> 决策与证据核对日期：2026-10-07。
> 定位：轻量 SPEC / 执行依据。确定目标行为、建议参数与完成依据，不规定固定开发顺序。

## 目标与范围

本次用户决定：

- **彻底移除 Yahoo**，不保留适配器、隐藏入口、显式调用能力或兼容别名。
- **TinyFish Search 加入 API 引擎池**；不加入默认 free 池。hybrid 作为去重并集自然包含它。
- **降低 DuckDuckGo（`ddg`）的默认融合权重**，保留它的检索能力。
- **不接入 TinyFetch，不改 `fetch_page` 或 Jina 回退链。**

不借本次工作重构融合算法、重设其他引擎权重、修改用户已有凭据或扩展到 TinyFish Agent / Browser / Research。更广泛的健康调度优化可以另行处理。

## 目标逻辑

### 引擎集合与路由

```text
free   = bing, ddg, exa-free, anysearch
api    = tavily, brave, exa, anysearch, tinyfish
hybrid = free 与 api 的去重并集
```

- TinyFish 使用唯一逻辑名称 `tinyfish`，需要 key 且未被显式禁用才可调用。
- `engine_pool=free` 的默认集合不包含 TinyFish，即使已配置 key。
- 沿用现有显式 `engines` 覆盖池集合的规则：显式选择 `tinyfish` 时，只要配置可用就能调用，不额外发明跨池禁令。
- api / hybrid 缺 key 或禁用 TinyFish 时正常跳过并披露；不临时启用其他引擎补偿。
- 保留兼容层语义：旧 `layer=free → free`，旧 `layer=api → hybrid`。不要把旧 api layer 与严格 api pool 混为一谈。
- AnySearch 的匿名/keyed 行为保持原样。
- 新请求里的 `engines: ["yahoo"]` 或 `engine_weights: { yahoo: ... }` 属于已不支持的输入，明确拒绝，不转译成 TinyFish。

Yahoo 的运行时注册、HTML 抓取与 URL 解码、池成员、默认权重、评分 family、公开 schema、当前能力提示和诊断列表都应删除。历史审计、已保存快照、历史设计记录可以保留原始 Yahoo provenance；这不构成继续支持 Yahoo，也不应为了全文零命中篡改历史证据。

### 权重

推荐实施默认值：

| 引擎 | balanced | research | fresh |
| --- | ---: | ---: | ---: |
| tinyfish | 1.000000 | 1.000000 | 1.000000 |
| ddg | 0.588522 | 0.541545 | 0.556109 |

DDG 新值为当前三个共享预设值分别乘 **0.60**，上表仅做显示舍入，实现保留足够精度。这样是明确的降权，同时保留已有策略间的相对差异。该系数是产品侧保守默认，不是根据断连比例推导的质量概率。

TinyFish 以中性权重 1.0 冷启动，不用供应商 benchmark 给它高权重。其他引擎保持当前数值，不因删除 Yahoo、增加 TinyFish或本次可用集合变化重新归一化。

现有“固定八引擎 GM / 所有当前权重几何均值为 1”的说明与公式断言需要调整：保留原权重的历史来源说明，但新的默认表是在该基础上的显式修改，不再声称整张当前表仍满足旧归一化公式。

权重仍只影响成功结果的评分；DDG 调低后仍会被调用，也不会自动改善它的连通性或超时。用户的单次合法 `engine_weights` 覆盖仍可生效。

DDG 保留在 Bing family；删除 Yahoo family 项。TinyFish Search 按官方公开的 Google 上游说明可标为 `google` family；目前只有一个明确成员，无需为了接入增加新的折扣参数。不要未经证据把 AnySearch 等其他提供商也归到 Google，也不要把不同 API 名称当作独立信息源的证明。

## TinyFish Search 的接入依据

当前官方接口：

```text
GET https://api.search.tinyfish.ai/?query=...
X-API-Key: <TINYFISH_API_KEY>
```

配置字段建议与逻辑名称一致：`tinyfish`；环境变量为 `TINYFISH_API_KEY`。进入正式可路由 key 集合，不只是 pending / stored-only 槽位。

配置体验与已有 keyed engine 一致：文件或环境变量读取、保存/删除、脱敏展示、启停、白名单和自定义 Base URL。已有显式白名单不包含 TinyFish 时不自动扩张；只存有 TinyFish key 的权威配置文件也应被正确识别，而不是跳过后回读旧配置。

适配器采用现有受控 HTTP 传输，不需要为了这一个 GET 接入完整 SDK 或远程 MCP。

### 请求与返回映射

- 使用 `query`，默认 `domain_type=web`；不随 ranking 隐式改成 news / research_paper。
- 支持原生 `include_domains` / `exclude_domains`，对接现有 `nativeDomains` 能力；客户端域名硬过滤保留。
- `recency` 可映射到 `recency_minutes`：day=1440、week=10080、month=43200、year=525600。保持现有 Web 时效提示/软偏好语义，不宣称全部命中都已有可验证日期。
- 当前文档提供分页 `page`，未提供 `count` / `max_results` 请求参数。初始使用第一页，在客户端截取所需数量；不虚构请求参数，也不因候选数量不足自动翻页扩大调用量。
- `results[].position → providerRank`，`title / url / snippet` 对接标准命中，`date → published`；在过滤或去重前保留合法原始排名。不把清洗后数组下标冒充已有 provider position。
- 不默认启用 Search 内嵌 fetch；这会扩大本次范围并消耗另一产品的额度。
- 不默认发送额外 `purpose` 或由用户 focus 推导服务端提取意图；现有 search 契约不需要新增字段。
- TinyFish 未传 location/language 时默认为 US/en。初始可沿用服务默认并说明这一点；若实际中文样本显示明显偏差，再基于证据决定语言参数，而非在接入时添加隐式翻译或未经验证的语言推断。

### 额度与失败

当前 Search 零费用额度为 **30 请求/分钟、500 请求/小时**，需要 API key；钱包 $0 时仍免费。免费不等于免 key，也不意味着可持续无限调用。

一次 fused search 的实际 variants 都会占请求数，分页和重试也要计入；community / X 检索若走同一适配器也共享额度。是否需要轻量本地节流，执行者根据当前并发与测试证据判断，不预设必须建立跨进程配额平台。遇到 429 应及时披露并尊重可用的 Retry-After，不在当前调用里无限等待或重试。

缺 key、禁用、401、402、403、429、服务错误、畸形 JSON 与合法空结果保持可区分；合法空结果不伪造传输错误，失败也不伪造成功。错误信息保持安全简洁，不输出凭据或完整错误正文。Search 文档仍列有账户访问权限导致的 402，应报告而不是自动充值、改账户或调用付费产品。

## 代码联动地图

以下是调查起点，不是要求按表顺序编辑，也不是封闭的文件清单。

| 逻辑区域 | 主要位置 | 关注点 |
| --- | --- | --- |
| 池、权重与公开路由属性 | `lib/search/routing.js` | 删 Yahoo、加 API-only TinyFish、改 DDG、调整旧公式注释 |
| 实际搜索适配器 | `lib/search/engines.js` | 删除 Yahoo 实现；GET TinyFish；域名、时效、排名映射 |
| 凭据与路由配置 | `lib/keys.mjs`、`lib/config-paths.mjs` | 正式 key 槽位、ENV_MAP、单 key 权威存储识别、白名单行为 |
| API 端点 | `lib/engine-endpoints.mjs` | 根路径搜索端点、自定义 Base URL 前缀与斜杠行为 |
| 融合来源 | `lib/search/scoring.js` | 删除 Yahoo 分组；TinyFish 单一逻辑投票者 |
| 能力、缓存与执行 | `lib/search/capability.js`、`lib/runtime.mjs`、`lib/search/fusion.js` | 动态可用性、配置/权重变化缓存隔离、残留 Yahoo 说明 |
| 配置界面与诊断 | `lib/installer/keys-wizard.mjs`、`lib/layer-config.mjs`、`lib/doctor/checks/engines.mjs` | 正确展示五个 keyed engine、免费池不含 Yahoo、TinyFish 配置可用不等于联网成功 |
| 宿主契约 | MCP / Pi / DSH 相关 schema 与能力输出 | 尽量继承 Core 定义；排查手写列表、旧枚举和生成产物 |
| 当前使用说明 | `README.md`、`README_zh.md`、`docs/search-routing.md`、`docs/fusion-scoring.md` | 池/权重/配置/额度一致，说明 Yahoo 已移除 |
| 自动化测试与夹具 | `scripts/` | 适配器、路由、配置、评分、宿主、X/community、adaptive 共同联动 |

Yahoo 被一些测试用作“晚到的第二作者”“失败引擎”和同 family 第三个来源。不能只删断言让测试变绿，应换成仍受支持的来源或调整数学测试，保留原本要验证的行为。历史 fixture 与正在执行的 fixture 需要区分；若更新冻结输出，说明变化对应新的权重/集合，而不是无解释地重录基线。

## 动态执行策略

执行者每次依据**当前已完成状态、最新证据、暴露出的依赖和剩余风险**选择下一项工作，可以从适配器测试、配置联动、Yahoo 清理或路由调整任一有价值的入口开始。

下列关键点用于重新判断下一步，不是顺序阶段或打卡任务：

| 到达的关键点 / 新证据 | 当前应判断的问题 |
| --- | --- |
| 引擎集合变化已落地 | 是否还有运行时 Yahoo 入口？TinyFish 是否误入默认 free 池？下一步是清理残留还是验证真实调用链？ |
| TinyFish 适配器能返回标准结果 | key、Base URL、可用性与公开 schema 是否已打通？是补配置联动还是验证排名/过滤？ |
| 路由或评分测试失败 | 是预期的默认值变化，还是破坏了原语义？先查原因，再决定改实现、夹具还是基线。 |
| TinyFish key 配置测试通过 | 单 key 配置是否仍权威？已有白名单是否被误扩张？能力报告与缓存是否反映改变？ |
| 核心局部测试通过 | 剩余影响是否已扩散到宿主、X/community 或 adaptive？据此选择集成测试与说明更新。 |
| 有真实调用条件 | 根据明确授权与 key 可用性决定小规模 smoke；无 key 则保留“未实测”状态，不让模拟测试冒充联网质量结论。 |
| 新证据使原实现选择不合适 | 在不改变用户目标的前提下调整方案，记录依据；只有需要改变范围或产品目标时再询问用户。 |

实现细节、文件拆分、批次、测试顺序和局部回退由执行者决定。不要求每个普通操作都重写文档；在关键判断后简要更新“已完成 / 待验证 / 当前最有价值的下一项”。

## 完成依据

完成应有代码和测试证据支持下列结果，而不只是勾选文件列表：

- 新运行时、公开引擎选项和当前说明不再提供 Yahoo；显式 Yahoo 输入清晰失败。历史材料保留不被误认为活跃引擎。
- TinyFish 在 api / hybrid 中按 key 和启停状态参与，同 variant 只贡献一次；free 默认不调用，显式跨池覆盖行为与现有契约一致。
- TinyFish 请求、域名/时效参数、原始排名与日期映射、错误和空结果在隔离测试中可验证。
- DDG 三个默认权重确实下降；其他默认数值不被连带重算；用户 override 和缓存隔离仍有效。
- 配置保存、单 TinyFish key 权威读取、删除 key、禁用、旧白名单、自定义 Base URL、doctor 和能力展示保持一致。
- 有关的融合、X/community、adaptive、MCP/Pi/DSH 测试保留其原语义；`fetch_page` 不发生功能变化。

可用测试入口包括 `npm run check`、`test:engines`、`test:search`、`test:fusion`、`test:keys-authority`、`test:install`、`test:doctor`、`test:adapters`、`test:adaptive`、`test:x`。按影响选择并扩展，而不是把它们排成固定流水线。测试继续使用仓库隔离环境，不继承真实 key，也不写用户配置。真实 smoke 与自动化测试分别报告。

## 已有证据与执行记录

本机最近 30 天搜索审计：DDG 在 132 个参与事件中有 111 个错误事件，Yahoo 为 126/126。这里是搜索事件级统计，可能含多个 query variants，不是单请求失败率，也不是相关性评测。它支持用户淘汰 Yahoo 和对 DDG 保守降权的决定，不支持宣称 TinyFish 已实测更可靠。

外部依据（2026-10-07 已读取；实施时仅在版本或协议疑点出现时重新核对）：

- [TinyFish 官方定价](https://www.tinyfish.ai/pricing)：零费用、key、分钟及小时额度。
- [Search API Reference](https://docs.tinyfish.ai/search-api/reference.md)：GET、参数、返回与错误语义。
- [Search OpenAPI](https://docs.tinyfish.ai/api-reference/search-the-web.md)：`position`、`date`、分页、原生域名与时效参数。
- [TinyFish 官网](https://www.tinyfish.ai/)：Search 的 Google 实时索引上游说明；不等于本项目已经验证了来源独立性。

### 执行记录（2026-10-07）

- 已删除 Yahoo 搜索实现、注册入口、池成员、权重、family 与当前能力/诊断列表。公开枚举跟随 Core 更新，显式 Yahoo 引擎/权重输入拒绝；历史材料保留。
- TinyFish Search 已打通正式 key 槽位、`TINYFISH_API_KEY`、权威配置识别、白名单/禁用、Base URL、GET 适配器、原生域名和 recency 参数、原始 position/date 映射、api/hybrid 能力展示。默认 free 不调用它。
- DDG 三个默认值已按 0.60 倍采用，TinyFish 三个默认值已设为 1.0；其他引擎数值未重算。Google family 只有 TinyFish 明确成员，没有新增折扣参数。
- TinyFish 暂不新增跨调用节流器：沿用受控传输与 20 秒单请求预算，不自动分页或重试 HTTP 配额错误，数字型 Retry-After 安全披露。真实并发与长期限流数据仍不足以支撑更复杂调度。
- 新增 `scripts/test-tinyfish.mjs` 并纳入 `npm run test:engines`，包含 7 组隔离集成检查：池/schema、实际请求参数、排名/过滤、缓存与 key/Base URL 隔离、配置/CLI/doctor、取消/大小边界、安全错误与空结果。
- 按测试证据修正了公开未知日期应省略字段的预期，以及 Yahoo 删除/第五个 keyed engine 导致的宿主计数和向导交互夹具；没有修改这些行为的原契约。
- 历史冻结回放显式使用原 DDG 权重，继续验证融合算法与输出不变；冻结 JSON 与摘要未重录。`lib/search/fetch.js` 未修改。
- 验证通过：`npm run check`、`npm run check:ci`、相关引擎/路由/评分/配置/宿主/X/adaptive/抓取回归，以及最终 `npm run test:isolation` 的全部 **78 个隔离入口**。隔离测试确认模拟用户文件和源码树未被测试改写；Windows 的 POSIX 模式及缺少权限的符号链接检查按现有规则明确跳过。
- 首次全量隔离运行被外层 180 秒时限截断；提高外层执行时限后已完整通过，不将先前的部分运行记为完成。

剩余待验证：TinyFish 真实联网、中文检索质量、实际延迟及长期额度行为。本次未调用真实 TinyFish 服务、未修改用户凭据或持久化默认设置；未实现 TinyFetch。没有真实 key 时不把离线通过描述成服务可用性保证。
