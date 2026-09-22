# Fused search：consensus-v2.1

本实现依据 2026-09-22 融合优化设计。它是**未经真实相关性标注校准的冷启动方案**，不是概率、事实可信度或 Jev 覆盖率；性质测试不证明 NDCG 改善。不新增在线 LLM 调用。

## AnySearch 接入

- 逻辑引擎名、keys.json 字段：`anysearch`；环境变量：`ANYSEARCH_API_KEY`。
- free：匿名请求（即使配置了 key）；api：必须有 key；hybrid：有 key 用 key，否则匿名。同次 variant 每个逻辑引擎只调用一次。
- 显式白名单/禁用也作用于匿名路径，不通过匿名回退绕过禁用。旧白名单没有 AnySearch 时不会自动加入。
- 请求 `POST https://api.anysearch.com/v1/search`，Bearer 可选；发送 `query`、`max_results`（1–10）、`format: json`。保留 `data.results` 的 snippet 和可选 cleaned content。
- 不发送未文档化的原生域名、recency 或 depth 参数；域名采用 site 提示和本地硬过滤。日期未知保持未知。
- HTTP 402 正文可能包含自动生成的用户名、密码和 key。错误路径取消响应体，不读取/回显/记录/保存正文，也不自动注册、重试或变更配置。HTTP 200 的业务错误只返回固定安全提示。
- 协议依据：[AnySearch 官方 /v1/search](https://anysearch.com/docs/api-endpoints/v1-search)，2026-09-22 核对。

## 权重与评分

权重见 [search-routing.md](search-routing.md)。对原生 free/api 策略先验及 AnySearch 先验，取固定八引擎几何均值 GM，应用 `sqrt(prior / GM)`。同策略权重跨池共享，失败、缺 key 或单引擎运行不重新归一化。ranking 只改权重，complexity 只改预算。

每个 URL 的有效观察使用一基排名 `r >= 1`：

```text
x_e = w_e * max_variant(10 / (10 + r - 1))
H_g = max(x_e in g) + eta_g * (sum(x_e in g) - max(x_e in g))
M = max(x_e)
E = M + log1p(sum(H_g) - M)
score = E * (1 + clip(0.10 * lexical + 0.15 * freshness, -0.2, 0.2))
```

- Bing/DDG/Yahoo 同组，额外证据保留 0.25；exa-free/Exa 同组，保留 0.20。其余提供商各为一组，并不表示已经证实索引独立。
- AnySearch 匿名/keyed 内部别名折叠为一个逻辑投票者。它内部聚合了多少来源，不增加票数。
- **M 是最大单引擎贡献，不是最大组贡献。**对数共识保留重复命中的价值，并压缩边际收益。
- 变体重复只取最佳排名，尾部排名不截断为零。失败、未返回和零权重不提供投票；零权重仍发起请求。全零证据不会被元数据恢复为合格结果。
- 去掉固定 0.8 共识奖励、单引擎 0.9 折扣、通用 TLD/域名权威奖励和无词面匹配的负分。
- lexical 是英文查询词/中文二元字符片段匹配比例，缺匹配中立，不能推断语义不相关。freshness 只在请求 recency 且日期有效时应用半衰期奖励；未知、冲突和未来日期中立。
- recency 在 Web 路径仍是**软偏好**及支持它的提供商提示，不升级为硬时间保证。显式域名限制打分前校验；X 继续执行作者/日期硬约束。

单位权重、无元数据时：单个第一名 1；两个独立组第一名约 1.693；三个独立组第一名约 2.099；Bing 组三个第一名约 1.405；Exa 组两个第一名约 1.182。

## 元数据与 provenance

`engineRanks` 现在明确是一基 provider rank，合并前记录；JSON API 提供商在清除非法条目之前保存 `providerRank`。同引擎不同 variant 保留最佳 rank，`provenance` 保留各 variant 的 URL/title/snippet/date 观察。

Web 元数据采用确定性词面匹配、排名和文本次序选取，不依赖网络完成顺序；不以正文长度当质量。互相冲突的发布日期不取先到者，输出 `dateStatus: conflicting` 且不获时效奖励。

X 路径也传递各引擎原始排名。official 排名在 normalize/filter/dedupe 前记录，忽略模型自报的 engines/ranks。oEmbed 扩充文本不另加检索票；没有 Web 来源的直接 fallback 才是一个中性来源。缺失来源排名不伪造为合并后排名。

## 输出与迁移

所有宿主共享 Core 的 `scoreVersion: consensus-v2.1`：

| 字段 | 意义 |
| --- | --- |
| `evidenceScore` | 上式 E；纯排名证据，不受列表多样性影响 |
| `rankScore` | 当前为 E 的兼容解释字段，与 evidenceScore 相同 |
| `consensusBoost` | `log1p(C)` |
| `score` | 有界元数据修正后的质量分，用于 min_score |
| `selectionScore` | 最终选入该条时的边际列表分，不覆盖 score |
| `metadataDelta` | 实际应用的有界修正 |
| `engineRanks` / `contributions` | 每个逻辑来源最佳一基排名 / 非零加权贡献 |
| `provenance` / `dateStatus` | 来源观察 / known、unknown 或 conflicting |

`min_score` 默认 0，支持 MCP/Pi/DSH，按质量分过滤。旧阈值不可直接照搬：非零阈值会返回版本迁移提醒；应以保存的候选和人工标签重新校准。分数不再按两位小数提前舍入。

搜索缓存键纳入完整评分配置及版本；capability 的私有指纹也纳入配置。X 候选缓存按版本隔离，不能复用缺失原始排名的旧候选。任何元数据系数、来源组、核或选择配置改动均需检查版本及迁移说明。

## 最终列表选择

先按质量分过滤，再基于**已经入选**的集合逐条选择：

```text
selectionScore = score - 0.15 * max_selected(title/snippet shingle Jaccard similarity)
```

shingle 只是重复文本近似，不声称衡量语义覆盖。少于 8 个词/中文字符时回退为每域最多两条；只指定一个站点时取消 Web 域名上限。X 仍按作者最多两条（未知作者共享保守桶）。未入选或低于 min_score 的条目不会消耗配额，也不影响后续折扣。`truncated` 表示有合格候选因限量或多样性未返回。

## 验证与后续校准

`npm run test:fusion`：10,000 个固定种子输入 × 8 项性质/独立参考计算检查，另外测试别名、零权重、非法输入、全零、元数据、失败中立、原始排名、Web/X 去重、域名限制和 MMR。引擎 HTTP 测试使用假 transport，不消耗真实额度。

这些检查只证明实现符合函数约束；尚无真实引擎质量 benchmark。后续应保存同一时刻的候选快照和盲评标签，按问题簇拆分数据，比较旧公式、加权 RRF、分组 RRF、max+log，并包含全 1 权重、关闭元数据、关闭共识、engine/group dropout 消融。报告 NDCG、真实分面覆盖与按查询簇 bootstrap 区间后再调参，不以融合分自身当标签。

Jev 的 coverage/停止状态仍由独立高层流程决定，不将融合分当覆盖概率；本次不改变其 balanced 策略选择。
