# v3 → v5 adaptive_search 迁移与退役清单

本文记录 `adaptive_search` 从开发基底 `0a0ce082` 的 v3 关键词循环迁移到 N_off 单流程（schema v5）时，实际发生的输入/输出/行为变化、退役的执行路径，以及调用方必须自行完成的迁移。当前契约权威说明见 `docs/jev-adaptive-search.md`。

## 1. 调用方需要做的迁移

| 旧用法 | 现在 | 迁移动作 |
| --- | --- | --- |
| `questions` 一项 + 可选 `intent`，缺失时由问题填补 | `intent` **必填** | 显式提供完整研究方向；缺 intent 在任何网络前报 `intent is required` |
| `keywords` 作为搜索点 / AND 硬条件 | 退役 | 把真正需要满足的方向保留在完整 question 与 intent；不要期望服务端把关键词变成硬过滤 |
| `constraints` 逐材料硬门槛 | 退役 | 省略或 `[]`；非空数组得到 `adaptive_constraints_removed`；硬域名限制改用 `site:`/`-site:` 或 fused_search 的 `include_domains`/`exclude_domains` |
| 多 `questions`、`tasks/targets/facts/time_range` | 明确拒绝 | 独立问题分开调用 |
| `cursor`（裸 UUID.offset）、`s4:` 实验 cursor | 拒绝 | 新运行用 `s5:`；历史文件用 `h1:`（由 `saved_result_id` 生成，不能手工伪造） |
| 读 `retrievalSufficient`/`coverageComplete`/`keywordProgress`/`scopeSummary`/`convergence`/`finalReview` 判断进度 | 新响应不再包含 | 用 `selection.targetMet`（数量）、`selection.incomplete`、`diagnostics`、`stopReason`、`warnings` |
| 用 `valueScore`/`tier`/`directionMatch` 阅读结果 | 新响应使用 `valueLevel`/`valueLabel`/`finalScore`/分数组件 | 按 `docs/jev-adaptive-search.md` 的字段表阅读 |

调用方 schema、示例、调用模板与缓存必须刷新：旧模板继续发送 `keywords`/`constraints` 会被明确拒绝（MCP/Pi/DSH 的输入 schema 均为严格对象，不会静默 strip 后执行新语义）。

## 2. 新增的契约

- 搜索前一次固定策略请求：`strategy.ranking`（`balanced`/`research`/`fresh`）与（省略 `community` 时）`strategy.community`（`enable`/`disable`/`unknown`）。显式 boolean 覆盖且不提问；unknown/缺失回退 false 并披露。普通 `fused_search` 的 `community` 默认仍为 false，且不会调用 Jev。
- 唯一检索形态：一次 `runFused`（`complexity=medium`，`candidateSelection=snapshot`，query 为原问题），至多 32 条候选（网页与社区行共用），按原融合分与稳定 key 全局截断。
- 输出 `run.community` 结构化执行状态，以及 `usage` 观测计数；没有自设的累计成本/token/请求次数/整次时限停止。MCP/DSH 的 fused 与 X 搜索入口也不另加整次搜索计时器；真实单请求保护和外部宿主硬限制保留。
- MCP SDK 要求发现阶段的 output schema 是单个 object，因而 tools/list 使用两种输出分支的字段投影；这并不替代完整 union 校验。handler 返回正文/structuredContent 前独立校验严格 v5 或历史分支，拒绝缺失分支必填字段和混合记录；DSH 与持久存储同样校验共享契约。
- 新运行 `schemaVersion=5`、`s5:` 分页；`save_results:true` 写入 `search-boost-research-v2`；旧 v1 文件以只读 `h1:` 历史分支恢复。

## 3. 退役的执行路径（已删除）

| 移除对象 | 原因 |
| --- | --- |
| `lib/search/adaptive/**`（`loop.mjs`、`planning.js`、`keyword-progress.js`、`input.js`、`legacy-input.js`、`pages.js`、`describe.js`、`limits.js`、`scope.js`、`convergence.js`、`retrieval-score.js`、`material.js`、`output.js`、`facts.js`、`evidence.js`、`prompts.js`、`temporal.js`、`engine-brief.js`） | 关键词循环、scope/info 门槛、补读与旧分页全部退役；唯一入口 `lib/runtime.mjs#runAdaptiveSearch` 只调用 `lib/search/screening/run.js` |
| `runFused` 的 `candidateSelection='per_engine'` 与 `selectEngineCandidates` 依赖 | snapshot 取代 per-engine 配额；无其他生产消费者 |
| 旧测试入口 `test-retrieval*.mjs`、`test-keywords.mjs`、`test-fact-score.mjs`、`test-funnel.mjs`、`test-recursion.mjs`、`test-single-target.mjs`、`test-adaptive-eval.mjs` | 只证明已退役算法；已替换为同名的 v5 验收入口（见第 4 节） |
| `scripts/eval-adaptive-search.mjs`、`scripts/eval-questions.mjs`（以及 `eval:adaptive` npm 入口） | 它们是 opt-in 的真实联网评测驱动，绑定 v3 协议；未来质量评估需按新版固定 SHA/提示另行冻结（`docs/jev-adaptive-search.md` 第 8 节） |
| 旧 `adaptive/material.js` | 迁移为 `lib/search/screening/material.js`（精确片段复用与请求尺寸预留不变） |
| 旧公共纯数据 shape `adaptive/output.js` | 冻结为 `lib/search/screening/legacy-snapshot.js`（只解码 v1 历史文件与只读 `h1:` 分支，不含任何执行逻辑） |

`package.json` 的 `exports` 使用通配 `./lib/*`，因此删除旧深路径属于破坏性迁移；不再提供自动回落到旧算法的兼容 shim。历史文档与审计证据（`docs/adaptive-*.md`、`docs/design-assets/**`、旧评测结果）按原样保留并标明适用版本，本次未批量删除。

## 4. 测试入口迁移

| 旧入口 | 现在 |
| --- | --- |
| `scripts/test-adaptive-search.mjs` | N_off 核心流程契约（输入迁移、策略/community、预算计量、持久化、分页） |
| `scripts/test-screening*.mjs` | 原型数学、judgment 解码、screening 控制器、冻结数值、消融 |
| `scripts/test-screening-hosts.mjs` | 真实 MCP/Pi/DSH 入口 + 共享 schema union + 严格迁移 + 分页/恢复 |
| `scripts/test-fused-baseline.mjs`、`test-noff-community-snapshot.mjs` | 普通 fused 冻结基线与 snapshot/community 执行记录 |
| `scripts/test-research-persistence.mjs` | v2 写入、v1/v2 恢复、双格式 CLI、存储加固 |
| `scripts/test-retrieval-score.mjs`、`test-retrieval.mjs`、`test-retrieval-interface.mjs` | 版本化排序数学 / 单次快照检索契约 / 共享输入输出 union（原 CI 入口名保持可运行） |
| `scripts/test-keywords.mjs`、`test-fact-score.mjs`、`test-funnel.mjs`、`test-recursion.mjs` | 关键词退役、价值 rubric、计数守恒、单次通过（无递归/补读） |

安全、材料、网络与预算断言未随旧测试删除：它们分别由 `test-network-safety.mjs`、`test-screening.mjs`（材料/请求尺寸）、`test-adaptive-search.mjs` 与 `test-jev-client.mjs`（计量、取消、单请求超时）继续覆盖；`test:isolation` 自动发现全部入口，门禁同时核对 CI 中的直接 Node 入口。

## 5. 已知边界

- 本轮没有创建 PR、发布、部署、修改全局安装或启动/改动任何质量实验；开发分支的提交与推送单独依调用方授权进行，不表示生产宿主已加载新版。
- 冻结的 21f 两臂实验与本实现无关：其 SHA、补丁、候选池与协议未变，本实现不引用其结果作为质量证据。
- 离线 fixture 只证明机制与契约；线上策略质量、语义准确率与真实宿主加载状态仍需另行冻结与验证。
