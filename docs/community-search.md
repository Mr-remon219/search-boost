# Community Search：五平台检索与后端管理

SearchBoost 自己实现社区路由、平台 adapter、证据归一化与融合，不调用第三方 CLI，也不把 Agent Reach 当运行时 SDK。所有 MCP、Pi、DSH 宿主使用同一核心。第三方项目仅作为策略/API 的研究参考，没有复制非商业许可代码。

## 平台与路线

| 平台 | 默认实例 | 已实现的可注册 provider | 实际材料/限制 |
|---|---|---|---|
| X | `x-default` | `existing-x` | 复用既有关键词、语义、账号、线程、认证、过滤、缓存、single-flight 和 fallback；不保证完整线程或全平台舆论 |
| Reddit | `reddit-default` | `reddit-arctic`, `reddit-web` | 显式/配置 subreddit 或有界网页发现 → Arctic Shift 有界采集 → 私有 checkpoint → 本地相关性检索；不是实时全 Reddit 搜索 |
| Bilibili | `bilibili-default` | `bilibili-web`, `bilibili-public`, `bilibili-browser` | 默认索引片段；可选公开视频 API（可能被风控拒绝）或自有浏览器桥的可见搜索卡片；不是字幕/完整弹幕 |
| Zhihu | `zhihu-default` | `zhihu-web`, `zhihu-browser` | 索引片段或用户现有会话下的可见搜索卡片；不自动登录或解验证码 |
| Xiaohongshu | `xiaohongshu-default` | `xiaohongshu-web`, `xiaohongshu-browser` | 索引片段或可见笔记搜索卡片；不逆向生成签名、不导出 cookie，不声称获取完整笔记/评论 |

`archive/native/web-index/mixed` 在每个 channel/item 中披露。浏览器 adapter 的 `native` 表示在目标平台页面读取，不意味着官方 API、完整正文或实时完整覆盖。公开 Bilibili API 是独立可选路线，尚无真实平台可靠性承诺；拒绝/风控不会触发签名绕过、登录或其他实例的自动轮询。

## 工具与平台选择

```json
{"engines":["reddit","x","bilibili","zhihu","xiaohongshu"],"query":"Node.js 迁移体验","max_results":10}
```

`community_search.engines` 必填、唯一名称数组。keyword 为所有平台的默认操作；semantic/user/thread 继续使用 X 四模式，必须 `engines:["x"]`。总结果默认 5、最大 30；多平台先公平交错、去重，再应用最终限额。

```json
{"engines":["x"],"type":"user","username":"OpenAI","max_results":5}
```

`fused_search.community` 和 `adaptive_search.community` 共用表示法：

- `false` 或 `[]`：关闭社区支路。
- `true`：**仅 X，兼容旧语义**，不扩为全部平台。
- `["reddit","zhihu"]`：仅选这些平台。
- 不接受固定位置 0/1 数组、重复名称、未知名称、null 或 `"auto"`。
- fused 省略时仍关闭；Adaptive 省略时同一次 ranking 策略判断决定是否启用旧 X 支路，不自动扩大到其他平台。

选择不会启用实例、改变网页引擎池、放宽 include/exclude domains、取消作者/日期验证、安装依赖或设置判断模型。fused/web-index 路线调用底层检索，不递归调用 community-enabled facade。索引包装保留原引擎票，不冒充一个新的独立来源。网页与社区共用最终排序/限额；Adaptive 仍完整审查声明快照后选择，不增加隐式追搜或补读。schema-v5/v1 历史结果保持原样，新 v6 可以记录显式平台数组和逐平台状态。

## Reddit：有界采集、范围、断点与检索

```json
{"engines":["reddit"],"query":"llama memory benchmark","subreddits":["LocalLLaMA"],"from_date":"2026-01-01","to_date":"2026-02-01","max_pages":3,"max_results":10}
```

优先使用请求 subreddits，再用实例配置，均最多 5 个。否则通过低层网页检索的 Reddit URL 发现最多 5 个 subreddit；找不到时说明 `no_scope`，不冒充全 Reddit 没有讨论。没有可靠的 archive 全站关键词假设：采集范围内的帖子标题/正文后按本地 token 匹配相关性排序，不承诺支持完整布尔查询语法。

默认最近 30 个 UTC 日历日；显式日期是包含两端的真实 YYYY-MM-DD，起始不得晚于终止。API 每页最多 100 条，`max_pages` 是所有 scope 合计的本次页数，默认 6、最大 20；轮流访问 scope，不让首个范围消耗所有配额。没有累计自设预算停止替代这些公开 collection bounds。

私有 checkpoint 位于 SearchBoost home 的 `cache/community/reddit/`，按 scope/window 绑定，保存有限语料和时间游标：最多 4000 条、有效期 1 小时、目录最多保留 64 个语料文件；后续调用可继续剩余范围或本地复用，不假装本次重新联网；达到 4000 条容量后不再派发采集，应缩小 scope/window 或等待到期。检查点读取是数据，不加载代码。锁与原子写入防止半文件；并发提交合并已采集记录和进度。

诊断包含发现方式、scope、UTC 窗口、页数、采集数量、停止原因、checkpoint 标识。**coverage 始终 unknown**：归档可能缺漏/延迟，时间戳翻页可能遗漏同秒边界，达到页数/语料上限不是穷尽。429、认证/访问失败和网络策略失败会停止本次采集，保留有效证据；取消向上抛出，不返回成功或保存新 checkpoint。不是完整评论采集、Reddit-wide 数据集或研究报告工作流。

## 后端管理与选择

`community_backend` 支持 `list/register/update/remove/check`。list/check 只读、不探测网络；check 是配置 readiness，不是账号权限/连接实测。配置在 SearchBoost home 的 `config/community.json`，只读首次查询不建文件。旧 v1 store 的缺失默认实例只在内存中补齐；损坏 store 不覆盖，能力降为不可用。

```json
{"action":"list"}
```

```json
{"action":"register","id":"reddit-scoped","provider":"reddit-arctic","config":{"subreddits":["LocalLLaMA"]}}
```

新注册实例置于列表前面，作为该平台优先候选。每次选首个 enabled 且 configuration-ready 的实例；不会因一次检索失败自动轮询其他实例。update 保留省略字段，不可更换 provider；默认实例 provider/id 保留，可禁用但不可移除。配置只接受显式实现的 provider 及其白名单字段，不接受 executable、shell、任意 remote tool 或 raw credential。

```json
{"action":"update","id":"x-default","enabled":false}
```

实例路由已贯通 community/fused/Adaptive；旧 `x_search` 也遵守 X 实例 readiness/host block，缓存不能绕过禁用。若另有 enabled X 实例，X 仍可用；禁用 x-default **不是**禁止该平台所有实例。工具入口开关与实例 enable 是两层：关闭 `community_search` 不等于禁止 fused 内部已选择的社区，正如关闭旧 x_search 入口不禁用内部 X。迁移时旧 x_search 明确关闭且尚未设置 community_search 偏好，新直接入口不会自动打开。

register/update/remove 需要用户授权。annotations 和提示词声明非只读，不代表服务端能从模型提供的参数证明用户同意。Grok 枚举 auto-allow 不包含管理工具；已有宿主 server-wide/wildcard trust 仍按用户原规则生效，本次不修改用户权限。research 子工具白名单未扩大，孩子不获得管理工具。

## 自有只读浏览器桥

这是可选、用户手动启用的 SearchBoost 组件，不启动/安装/登录浏览器，也不依赖 OpenCLI。

1. 在仓库运行 `npm run community:browser`，或安装包中运行 `search-boost community-browser`。服务只监听 `127.0.0.1:19826`（可用 `SEARCH_BOOST_BROWSER_PORT` 指定端口）。私有随机 token 存在控制台显示的 token **文件路径**；控制台不打印 token。
2. 用户在 Chrome 扩展管理页手动加载 `browser/community-bridge/` 的 unpacked extension。popup 配置 endpoint 和本地 token，然后明确 Enable。不会因加载插件而自动启用。
3. 在运行 SearchBoost 的进程中自行设置 `SEARCH_BOOST_BROWSER_TOKEN` 为 token 文件内容；**不要把值发给模型或放在工具参数中**。CLI/环境配置属于用户部署，不由搜索工具替你执行。
4. 注册所需平台，例如：

```json
{"action":"register","id":"zhihu-session","provider":"zhihu-browser","config":{"endpoint":"http://127.0.0.1:19826","token_env":"SEARCH_BOOST_BROWSER_TOKEN"}}
```

可以同样注册 bilibili-browser/xiaohongshu-browser。endpoint 仅允许无凭据、无 query/path 的 loopback HTTP origin，token_env 只接受变量名。provider 使用现有 policy-aware HTTP transport，保留代理/TLS/重定向/取消边界；配置代理时，用户需确保其部署允许连接所选本地 bridge，不会偷偷绕过策略。

bridge 有 bearer 认证、请求/响应大小界限、最多 8 个任务与单请求超时。仅传 platform/query/limit 数据，没有 arbitrary JS、cookie、外部执行或写平台的 remote tool。扩展按固定搜索 URL 创建自己的非活动 tab，用固定函数读可见卡片，最后关闭它；不操纵既有用户 tab，不点击/滚动/发帖/点赞，不解决 challenge。调用取消删除任务，worker 检查 active 状态并停止读取；迟到结果拒绝。Disable 可停止后续浏览器读取。

扩展仅请求 storage/scripting 和三个固定站点、本地 bridge 的 host permissions，不请求 cookies 或 all_urls。DOM 无卡片可能是空结果、换版或 gate，返回 unavailable 而非假穷尽；publication/author 未验证时为 null。小红书签名/跟踪 URL 参数不会进入模型证据。目标平台改版、真实会话及 Chrome版本需部署者验证。

## 证据与状态

输出包含整体 `ok/empty/partial/failed`、items、逐平台 channels、warnings 和耗时。平台未启用、不可用、域名排除、失败与成功空结果有不同状态。逐项保留原引擎 rank/provenance，并附 platform/provider/backend/retrieval_mode/content_type。纯网页片段、DOM 卡片、视频元数据不是完整正文；来源数/分数/样本不证明事实或平台舆论。

`from_date/to_date` 显式过滤对未知发布时间 fail closed，报告排除数量；X 保留既有验证规则。fused recency 仍是一般软偏好；未知非 X 日期不会为了 recency 被伪造成新内容。域名限制在派发前粗筛、最终 URL 再校验，X/Twitter 别名仍一致。

capability resource：`search-boost://community-capabilities`，总 resource 为 `search-boost://capabilities`。能力读取不会隐式联网，ready 不代表有 session/权限或已连接。私有 cache partition 包含实例/范围/凭据变更摘要，但资源/模型不暴露 token、cookie、配置原文或 credential hash。新直接调用记一次有界脱敏审计，不双记内部 X 调用。

## 验证边界

`npm run test:community` 包含 registry/config、五平台 fixture、scope/checkpoint、429/取消、过滤/公平限额、真实 loopback bridge transport、DOM 卡片 fixture、MCP SDK round trip、Pi 注册及融合/Adaptive 参数契约。DSH 用 pinned SDK 编译原始/投影 schema 并执行；完整隔离门禁自动收录新增测试。

这些是离线服务/协议/DOM fixture，不是五平台真实账号、真实 Chrome extension 安装会话或所有 Pi/DSH 安装版本的验收。X 原有四模式回归单独运行。最终完整隔离门禁为 80 个入口通过，依赖审计为 0 vulnerabilities；详见 [交付前自审](community-search-self-review.md)。浏览器/native/归档本身会随服务变化，不把配置状态和 fixture 测试写成真实连接/可用性保证。
