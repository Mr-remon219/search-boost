# Search routing、X 聚合与 runtime capability

## 调用链与边界

```text
MCP / Pi / DSH fused_search
  → runtime.runFused
      → runtimeSnapshot / resolveSearchRoute
      → fusion.fusedSearch → engineRegistry（Web 候选）
      → community=true: runXSearch（同一 X Core，内部候选模式）
          → official xAI ∥ fallbackXSearch
              → domainSearch → engineRegistry（不调用 runFused）
              → GraphQL / oEmbed（按 X mode 路由）
      → mergeCommunityResults / createXPipeline
      → selectDiverse → 最终 max_results

MCP / Pi / DSH x_search
  → runtime.runXSearch
      → official / fallback retrieval
      → createXPipeline：normalize → dedupe → filter → max_results
```

没有 fused_search ↔ x_search 递归，也没有复制 X retrieval 实现。community 使用 keyword 模式；GraphQL user 与 oEmbed thread 路径仍供直接 x_search 使用。

主要模块：

- `lib/search/results.js`：Web URL/日期规范化、X URL 身份、域名过滤、通用去重、三态过滤、domain/author 多样性选择。
- `lib/search/routing.js`：引擎池、9 组权重、路由校验、共用 description / 原生参数定义。
- `lib/search/x/x-pipeline.js`：X 特有的数据结构、作者/日期/metadata operators；复用公共函数。
- `lib/search/x/community.js`：只做 Web/X 最终聚合，不负责检索。
- `lib/search/capability.js`：所有宿主与运行时共用的动态能力快照。
- `lib/runtime.mjs`：网络编排、缓存和最终诊断；适配器只映射参数、注册接口和渲染。

本次不改安装、全局 npm 迁移或宿主注册流程。

## 参数正交性

| 参数 | 默认 | 唯一职责 |
| --- | --- | --- |
| `complexity` | `medium` | `simple / medium / complex` 控制预算、至多 1/2/3 个 variants 和默认 basic/basic/advanced depth |
| `engine_pool` | 从兼容 layer 映射 | `free / api / hybrid` 选择默认调用集合 |
| `ranking` | `balanced` | `balanced / research / fresh` 只选择最终 engine-weight preset |
| `engines` | 省略 | 显式覆盖本次调用集合，可跨 pool；不绕过缺 key 或禁用状态 |
| `engine_weights` | 省略 | 覆盖指定引擎的评分权重；不增加或移除任何调用 |
| `community` | `false` | 需要近期开发者/社区声音时额外使用 X Core |

`queries` 是调用方提供的独立角度；query 中的 OR alternatives 也占 variant 预算。没有额外的 LLM 自动改写器。`ranking=fresh` 不隐式修改日期范围、搜索深度或请求参数；时效需求仍用 `recency`。

权重必须是有限非负数。权重为 0 仍调用该引擎；它只消除该引擎的加权贡献，相关性等其他评分项仍存在。未选择引擎的 override 不生效，也不会使其被调用。显式 `engines` 选到池外引擎时，采用该引擎所属 free/api 池的同名 ranking 权重，再应用 override。空 engines、未知引擎和无效权重直接报错。

### 引擎池与权重

| pool-ranking | bing | ddg | yahoo | exa-free | tavily | brave | exa |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| free-balanced | 1.00 | 1.05 | 1.00 | 1.10 | — | — | — |
| free-research | 0.95 | 0.90 | 0.85 | 1.30 | — | — | — |
| free-fresh | 1.15 | 0.95 | 0.90 | 1.00 | — | — | — |
| api-balanced | — | — | — | — | 1.20 | 1.10 | 1.20 |
| api-research | — | — | — | — | 1.35 | 1.00 | 1.45 |
| api-fresh | — | — | — | — | 1.30 | 1.40 | 1.25 |
| hybrid-balanced | 1.00 | 1.05 | 1.00 | 1.10 | 1.20 | 1.10 | 1.20 |
| hybrid-research | 0.90 | 0.85 | 0.80 | 1.20 | 1.35 | 1.00 | 1.45 |
| hybrid-fresh | 1.05 | 0.90 | 0.85 | 1.00 | 1.30 | 1.40 | 1.25 |

池成员固定，实际可用性动态读取。API-only 池没有可用 key 时返回空集合与 warnings，不偷偷启用免费池。

## 兼容方案

- 保留原 layer 配置、环境变量、`search_layer` 与 `/web_change`：旧 `free → free`，旧 `api → hybrid`。这是保留旧 api layer 原本包含免费引擎的语义，不是新 API-only 池的定义。
- 显式 `engine_pool` 优先于 layer；MCP/DSH 保留废弃的单次 `layer` alias。
- Core 暂时接受 `complexity=auto`，仍用旧 heuristic，但返回弃用 warning。公开工具 schema 仅列 simple/medium/complex；旧客户端应刷新 schema。
- 保留返回值中的 `layer`、`tier`、`engineStats` 等现有字段，增加 pool、ranking 和实际执行诊断。
- 保留 `fusion.js` 的公共 URL helper re-exports 和 tier table 导出；tier table 现在不再改变引擎集合。

## X 约束、去重与最终选择

1. 所有 X retrieval 来源经过相同 normalize/merge/filter。URL 中的 post ID 优先；现代 Snowflake 可恢复真实时间，优先于模型给出的冲突日期。缺失日期/作者/计数不会被虚构成符合过滤条件的数据。
2. `allowed_x_handles` / `excluded_x_handles` / username 与字段日期做交集；字段 `to_date` 包含整天，query `until:` 仍为排他上界。可验证的 query metadata operators 统一在本地执行；无法验证的约束会提示或排除缺元数据项。
3. X 用 post ID 去重，所以 x.com、twitter.com、mobile、`i/web/status` 与带作者路径不会重复。Web 使用去 tracking/fragment 的 URL key，保留路径大小写、有意义的 query 和端口。
4. community 候选模式不提前执行最终过滤/限量；先与普通 Web leg 中的 X 帖子合并元数据，再统一执行 X 约束，防止普通 Web 结果绕过作者/日期过滤。候选模式有独立缓存键，不会污染公开 x_search。
5. 相同来源不重复计分：同引擎多个 variant 命中的 URL 只保留最佳 rank 贡献；Web/X 两条路都找到同一帖子时，每个引擎只贡献一次。official 或无 Web provenance 的 fallback 使用中性权重 1，不属于可自定义的七个 Web engine weights。
6. 最终 Web 按 domain、X 按 author 分桶；重复桶采用 0.7 衰减并最多保留两条，再统一截取 max_results。未知 X 作者使用同一保守桶，不允许靠缺元数据绕过作者多样性。
7. include/exclude domains（含 query 中的 site 规则）作用于全部结果。X/Twitter 域名 aliases 视为同一来源；排除 X 时跳过 community。显式 recency 在社区通道转为 UTC 日期下界，最终也检查普通 Web leg 的 X 帖子。Web recency 仍为原有时效评分/引擎提示。

这些约束不能使提供方返回未检索到的帖子。GraphQL、oEmbed 和匿名索引均是 best-effort；不会保证完整线程或全平台情绪代表性。

## 动态能力与诊断

统一 capability 包含：当前兼容 layer、默认 pool/ranking/complexity、可用引擎及不可用原因、各池可用成员、X official/fallback 状态。这里的 available 是本地配置就绪，不是实时 HTTP 探测成功。

- MCP：`search-boost://capabilities`，每次读取重新生成的 JSON Resource；不是调用工具的前置步骤。
- Pi：`before_agent_start` 每次更新 `search_capabilities` system-prompt section。已有 search policy 不阻止动态能力刷新，也不重复插入 section。
- DSH：`systemPrompt.section({ text: () => ... })` 每次组装读取同一 capability，保留现有 `search:status` section 名称。

工具静态 description 不写当前可用引擎，避免改 key/layer 后描述失真。

每次 fused 结果包含：

- `enginesUsed`：实际尝试的 Web 引擎（含 X fallback 直接调用的引擎）；失败不从列表隐藏。
- `effectiveWeights`：本次可用且已选择的引擎实际采用的权重。
- `communityUsed`：是否执行了社区通道；不是“找到了 X 证据”或“网络调用成功”的布尔值。
- `warnings`：缺 key/禁用、调用失败、community 降级、约束信息等。
- `engineStats`：attempts、successes、errors；部分 variant 失败不被误报为全部引擎失败。

缓存命中保留原始 provenance，不代表本次重新联网。缓存包含池、ranking、权重、community、参数与私有能力/凭据 fingerprint；credential 内容或 fingerprint 不会出现在 capability Resource/prompt 中。Web 缓存最长 6 小时，community 聚合缓存 5 分钟；保留原 X 各模式 TTL。取消不缓存为成功；失败的聚合不会作为完整成功长期缓存。

## 示例与验证

```json
{"query":"Node.js fetch API","complexity":"simple","engine_pool":"free"}
```

```json
{"query":"database vector indexing tradeoffs","queries":["vector index benchmark limitations","vector index official documentation"],"complexity":"complex","engine_pool":"api","ranking":"research","engine_weights":{"exa":1.6}}
```

```json
{"query":"Node.js migration developer experience","engine_pool":"hybrid","ranking":"fresh","community":true,"recency":"month","max_results":8}
```

```bash
npm run test:search
npm run test:x
npm run test:fusion
npm run test:adapters
npm run test:mcp
```

测试使用临时 HOME、假引擎/HTTP transport、真实 Core 编排和真实 MCP stdio 协议；不消耗真实 API 额度。原生 Pi/DSH 注册与动态 prompt 用宿主接口替身验证，不能代替真实宿主重载和当前公网服务的连通性测试。
