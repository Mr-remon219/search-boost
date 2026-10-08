# 控制台 API 额度适配器

仅 `search-boost tui` 的控制台加载 `lib/engine-quota.mjs`。快速配置 TUI、搜索路由、MCP / Agent 搜索工具不加载或暴露此功能。查询结果不是本地 `search_stats`，也不是从搜索次数推算的账户余额。

## 官方协议与口径

### Tavily

- [官方 Usage 协议](https://docs.tavily.com/documentation/api-reference/endpoint/usage)：`GET https://api.tavily.com/usage`，`Authorization: Bearer <当前生效 Key>`。
- `key.usage / key.limit` 是当前计费周期的 credits 用量 / 上限；`limit: null` 明确表示该 **Key** 无上限，不表示账户无限。
- `account.plan_usage / plan_limit`、`paygo_usage / paygo_limit` 分开展示，不能与 Key 上限相加。整数计数必须有效；上限减用量低于零时展示剩余 0，同时保留实际用量，不能宣称超支不存在。
- [Usage 限流](https://docs.tavily.com/documentation/rate-limits)：文档给出的 Usage 频率为每十分钟十次；控制台至少间隔 60 秒，服务端更长的 Retry-After 优先。

### Brave

- [官方 rate-limit headers](https://api-dashboard.search.brave.com/documentation/guides/rate-limiting) 提供 `X-RateLimit-Limit / Remaining / Policy`。每秒限流不是剩余余额。
- 没有猜测一个独立余额接口。用户明确确认后，`GET https://api.search.brave.com/res/v1/web/search?q=Brave%20Search%20API&count=1` 发起一次真实搜索，使用 `X-Subscription-Token`。**成功请求消耗配额且可能计费**；界面不能将它称为免费余额探测。
- 只读取响应头，搜索正文取消、不显示、不存储。按 `Policy` 匹配各位置的 limit / remaining，选择最长的至少一天周期；不固定使用第二个字段，不用每秒余量冒充余额。
- 文档中的周期上限 0 表示无此周期上限，而不是剩余余额 0。缺少长周期字段时明确显示“未返回长周期配额”。

### TinyFish

- [官方 Get wallet](https://docs.tinyfish.ai/api-reference/wallet/get-wallet)：`GET https://agent.tinyfish.ai/v1/wallet`，`X-API-Key`。
- `available_balance` 为十进制字符串，`currency` 为 USD，`as_of` 为服务端快照时间。保留合法负余额。
- 这是**账户共享钱包**，不是单个搜索 Key 的每日剩余次数。查询端点与搜索端点不同，确认页明确展示 `agent.tinyfish.ai`。
- 只投影余额、货币和时间；忽略并不执行 `agent_top_up_url`、自动充值配置和其他响应指令。404 表示账户未开通钱包计费，不代表搜索余额为零。
- [List search usage](https://docs.tinyfish.ai/api-reference/list-search-usage) 是历史记录分页接口，其 `limit` 是分页大小、`total` 是历史记录数，不拿它们计算剩余额度。

### Exa / AnySearch

- [Exa Get API key usage](https://exa.ai/docs/reference/team-management/get-api-key-usage) 需要已开通 Team Management 的服务账号 Key 与查询 Key ID，返回指定周期消费，不是搜索 Key 可直接读取的剩余钱包。此版本不新增服务账号凭据存储，提示在 `https://dashboard.exa.ai` 查看。
- [AnySearch authentication](https://anysearch.com/docs/auth) 说明 API Key 付费配额，但当前未核实可直接读取余额的公开协议。此版本展示手动查看提示与 `https://www.anysearch.com/console/api-keys`，不发起探测或爬取登录后台。
- “未接入直接查询”不是断言供应商不存在任何额度 API。

## 安全与验证

- 所有请求使用已有 `ipv4Fetch` 网络 / 代理策略。调用者不能提供任意额度 URL；自定义搜索网关直接阻止官方额度请求，不转发第三方 Key。
- GET、12 秒超时、拒绝重定向；JSON 流最多 64 KiB。只接受核实的数值字段，不显示未知余额、异常原文、网页正文、账户详情或 Key。
- 不落盘缓存。缓存按当前有效 Key 与 Base URL 的内部哈希隔离，哈希不显示；配置改变后旧结果失效。只保留此次会话，取消后迟到结果不覆盖界面。
- 每引擎至少 60 秒间隔（取消也计入间隔），HTTP 429 的 Retry-After 完整遵守，不截短服务端等待时间。不同引擎查询互不阻塞成功结果。
- `--preview`、`--dry-run`、打开页面、切换分类、R 都不联网查询额度；必须通过显式查询确认。
- `npm run test:quota` 使用离线响应与隔离 HOME，覆盖协议投影、计费探测同意、官方目的地 / 网关拒绝、部分失败、隐藏凭据、缓存隔离 / 冷却、取消与迟到结果，以及中英文宽窄卡片。未使用真实 Key，未执行真实计费搜索。
