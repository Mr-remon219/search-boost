# Community Search：五平台检索与后端管理

SearchBoost 自己实现社区路由、平台 adapter、证据归一化与融合，不调用第三方 CLI，也不把 Agent Reach 当运行时 SDK。所有 MCP、Pi、DSH 宿主使用同一核心。第三方项目作为策略/API 的研究参考，没有复制非商业许可代码；三个中文平台的 native adapter 在项目内部实现搜索与取数，使用可选 playwright-core 操作 SearchBoost 专用 Chromium 会话，不要求第三方 MCP 服务、额外端口或服务 token。

## 平台与路线

| 平台 | 默认实例 | 已实现的可注册 provider | 实际材料/限制 |
|---|---|---|---|
| X | `x-default` | `existing-x` | 复用既有关键词、语义、账号、线程、认证、过滤、缓存、single-flight 和 fallback；不保证完整线程或全平台舆论 |
| Reddit | `reddit-default` | `reddit-arctic`, `reddit-web` | 显式/配置 subreddit 或有界网页发现 → Arctic Shift 有界采集 → 私有 checkpoint → 本地相关性检索；不是实时全 Reddit 搜索 |
| Bilibili | `bilibili-default` | `bilibili-web`, `bilibili-public`, `bilibili-browser`, `bilibili-native` | 默认索引片段；native 读取公开笔记、专栏和 Opus 文字；视频块以公开笔记为主体、评论样本为补充，不转录视频 |
| Zhihu | `zhihu-default` | `zhihu-web`, `zhihu-browser`, `zhihu-native` | 默认索引片段；native 尝试完整问题、回答和评论/回复遍历，逐条报告完整性；不自动登录或解验证码 |
| Xiaohongshu | `xiaohongshu-default` | `xiaohongshu-web`, `xiaohongshu-browser`, `xiaohongshu-native` | 默认索引片段；native 读取笔记正文/时间并尝试完整主评论及回复遍历，逐条报告完整性；签名仅内部消费，不导出 cookie，不读取 OCR/转录 |

`archive/native/web-index/mixed` 在每个 channel/item 中披露。浏览器 adapter 的 `native` 表示在目标平台页面读取，不意味着官方 API、完整正文或实时完整覆盖。公开 Bilibili API 是独立可选路线，尚无真实平台可靠性承诺；拒绝/风控不会触发签名绕过、登录或其他实例的自动轮询。

## 工具与平台选择

```json
{"engines":["reddit","x","bilibili","zhihu","xiaohongshu"],"query":"Node.js 迁移体验","max_results":10}
```

`community_search.engines` 必填、唯一名称数组。keyword 为所有平台的默认操作；X 支持 semantic/user/thread，其他后端未实现的操作返回该 channel 的 unsupported，不降级为 keyword，也不阻断其他有效平台。`platform_options` 可独立覆盖操作。总结果默认 5、最大 30；多平台先公平交错、去重，再应用最终限额。直接工具返回分页快照，当前页条数与保存总数分开。

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

### Fused / Adaptive 共用平台条件

两个入口也接受下面相同的 nullable `platform_options`，须通过 `community` 明确选择对应平台；非空分区不隐式开启平台，省略 Adaptive community 仍只由策略决定 X。Adaptive → runFused → 未分页 communitySearch，社区和普通 Web 匹配行共用最后硬过滤、原来源票、全局候选容量与一次完整判断，不二次调用直接入口、不多做检索/审计。明确的 query 只覆盖该平台；无 Web engine 的独立 archive/hosted 来源可经同一 fused 底座执行，失败/未就绪如实报告。

Adaptive v6 记录类型化的 `run.community.channels` 和最终选中行 `provenance`（原 engine/rank 与 route；不塞 raw/session/checkpoint hash/未审全文），旧记录可读但不补造。多渠道说明过大时，仅本页省略说明/必要的逐渠道 engine_stats 明细，以 details_truncated 和告警披露；测量状态、usage、覆盖/后处理计数与全局统计保留，私有原记录不变。缓存旧观察不算本次新派发，Reddit Web 范围发现请求也保留计数。保存和读页仍是 Adaptive s6/v3，不使用直接社区 c1，重放零新检索/判断。接入初轮离线验收为 85 隔离入口/288 文件；二次自审 AR1–AR6/DOC1 修复后最新代码重新执行 86 入口/289 文件通过，既有 7+5 frozen fused 回放保留原 hash，真实平台/已安装宿主仍未验收。示例与决策证据见 [Adaptive 接入设计](adaptive-community-integration-spec.md) 和 [当前判断契约](jev-adaptive-search.md)。

## 平台独立参数与处理

公共 query/type/date 可以被 `platform_options` 中的非 null 值覆盖；分区/条件的 null 或省略表示继承公共值，没有公共值时使用平台默认。null 不清除已经明确给出的公共硬条件。支持只在分区给 query；只允许所选平台的分区，错别字、未知字段、非法默认值和矛盾条件在派发前报错。

| 分区 | 当前独立字段（全部可选/null） | 当前操作/解释 |
|---|---|---|
| x | query/type/from_date/to_date、username/post_id、allowed_x_handles/excluded_x_handles、model/reasoning_effort | 四模式；keyword username 可作为作者条件，与旧 X 核心兼容 |
| reddit | query/type/from_date/to_date、subreddits/max_pages、allowed_authors/excluded_authors | keyword；作者条件按 Reddit username 验证，索引 display label 不能冒充身份 |
| bilibili | query/type/from_date/to_date、content_type、note_limit、comment_limit | video/article/post；public 与 browser 当前仅 video，web-index 支持允许 URL 的其他分类 |
| zhihu | query/type/from_date/to_date、content_type | question/answer/article，按实际内容 URL 分类 |
| xiaohongshu | query/type/from_date/to_date、content_type | note，保留笔记身份；不伪造未实现的账号/线程功能 |

```json
{"engines":["reddit","zhihu"],"query":"Node.js 迁移体验","platform_options":{"reddit":{"subreddits":["node"],"max_pages":2},"zhihu":{"query":"Node.js 升级失败","content_type":"answer","from_date":null}},"max_results":10,"page_size":3}
```

日期兼容真实 YYYY-MM-DD 与带时区 ISO 时间戳；日期上界包含整天，时间戳上界包含该时刻。Reddit 精确条件先投影到采集日窗口，返回后再按原精度筛选。合并重复身份、补齐元数据后才做硬条件过滤；未知作者/日期与不符合条件分别诊断。带时区 instant 按 UTC 日投影，未声明时区的 ISO 或缺日的月观察不猜时区/第一天。日日期按整天观测，不虚构午夜；仅部分覆盖精确硬窗口则按日期未验证排除，互相矛盾的日期/作者保持未知。索引 Web 只有日粒度时不能证明任意日内时刻。平台硬条件也约束该域名的未知路径，主页/账号页不冒充符合 content_type 的内容。明确选择的非 X 内容在普通 Web 与 native 支路也按平台身份合并、安全化 URI（含出处 URI），不把签名/query 或别名路径当成独立内容；其他 Web 的有意义 ref/query 不被普遍删除。X 保留自己的 handle/URL/Snowflake/过滤 pipeline，不把其身份规则套给其他平台。

每项保留公共证据字段，并增加 `data:{schema_version:1,platform,kind,...}`。X 保留帖子/账号字段；Reddit 保留 subreddit/归档帖子；B站保留 content_id 与分类；知乎区分 question_id/answer_id/article_id；小红书保留 note_id。不是任意 raw 响应，不能装入 cookie/config。fused/Adaptive 只取共同投影，不通过对外分页工具获取候选；candidateMode 延后直接社区的总结果 cap，多平台获取可以超过 30，再服从 fused 的最终限额/Adaptive 的全局声明快照，而不是每条来源各占一份最终限额。

## 结果分页与私有恢复

直接 `community_search` 返回 schema_version:2；共同 items/channels/status/warnings 保留，`results`/`page_results` 为当前页数，`total_results` 为本次保存总数，附 `next_cursor`、`expires_at`、`captured_at`、`historical`、`reused`。`page_size` 默认 5、最大 50，不改变总 max_results、排序或上游采集预算。

```json
{"cursor":"<返回的 c1:…>","page_size":3}
```

cursor/saved_result_id 读取只能附 page_size，不能混入 engines/query 或新检索字段。读页零网络、零再处理、零新检索审计；重放 usage 不报告新派发。结果不可变，读页不是继续上游采集。内存快照限定当前进程与 SearchBoost home，30 分钟有效，最多 32 组/总 16 MiB；过期/淘汰不自动重搜。

`save_results:true` 才写私有 `state/community/<uuid>.json`，返回 saved_result_id；默认不写结果文件。独立 `search-boost-community-v1` 格式，不混用 Adaptive 的研究快照/cursor。单快照最多 4 MiB，持久目录最多 32 组/32 MiB，旧组按容量淘汰。恢复接受 `{"saved_result_id":"<id>","page_size":3}`，可跨进程，但材料和 captured_at 保留原样，明确 historical，不联网刷新或重筛。文件大小、格式、ID、普通文件/链接、类型化 payload 校验失败即拒绝。

单页使用约 96 KB UTF-8 软界限：减少条数，不截断已存证据；单条超软界限时完整返回并警告，整组超存储界限明确失败。存储是公共证据与诊断，不包含后端配置、token、浏览器会话或模型原始日志。工具入口授权仍由宿主执行，分页不是权限旁路。设计与滚动决策见 [platform pipeline SPEC](community-platform-pipeline-spec.md)。

## Reddit：有界采集、范围、断点与检索

```json
{"engines":["reddit"],"query":"llama memory benchmark","subreddits":["LocalLLaMA"],"from_date":"2026-01-01","to_date":"2026-02-01","max_pages":3,"max_results":10}
```

优先使用请求 subreddits，再用实例配置，均最多 5 个。否则通过低层网页检索的 Reddit URL 发现最多 5 个 subreddit；找不到时说明 `no_scope`，不冒充全 Reddit 没有讨论。没有可靠的 archive 全站关键词假设：采集范围内的帖子标题/正文后按本地 token 匹配相关性排序，不承诺支持完整布尔查询语法。

默认最近 30 个 UTC 日历日；显式日期/时区时间戳包含两端，起始不得晚于终止。API 每页最多 100 条，`max_pages` 是所有 scope 合计的本次页数，默认 6、最大 20；轮流访问 scope，不让首个范围消耗所有配额。没有累计自设预算停止替代这些公开 collection bounds。

私有 checkpoint 位于 SearchBoost home 的 `cache/community/reddit/`，按 scope/window 绑定，保存有限语料、各 scope 时间游标和跨调用轮转位置：最多 4000 条、有效期 1 小时、目录最多保留 64 个语料文件；后续调用可继续剩余范围或本地复用，不假装本次重新联网；达到 4000 条容量后不再派发采集，应缩小 scope/window 或等待到期。检查点读取是数据，不加载代码。锁与原子写入防止半文件；并发提交合并已采集记录和进度，旧 writer 不回退轮转位置。小预算续采从上次的下一个 scope 继续；失败停止本次调用但保存轮转位置，不在同一次失败后轮询其他 scope。

诊断包含发现方式、scope、UTC 窗口、页数、采集数量、停止原因、checkpoint 标识。**coverage 始终 unknown**：归档可能缺漏/延迟，时间戳翻页可能遗漏同秒边界，达到页数/语料上限不是穷尽。429、认证/访问失败和网络策略失败会停止本次采集，保留有效证据；取消向上抛出，不返回成功或保存新 checkpoint。不是完整评论采集、Reddit-wide 数据集或研究报告工作流。

## 后端管理与选择

TUI 首页「Community 配置」按平台显示状态，直接更换检索方式、停用平台，并提供当前方式需要的设置；X 凭据操作直接位于 X 页面。没有重复的状态 / 检查 / 指南子菜单；浏览器步骤在配置时显示。方式切换经预览确认后一次原子提交，保留其他平台和未选配置；停用会覆盖该平台全部实例，重新启用明确选定一份。配置状态不是实际连接测试。详见 [TUI 导航](tui.md#community-配置入口)。

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

实例路由已贯通 community/fused/Adaptive，缓存不能绕过 X 实例 readiness/host block。若另有 enabled X 实例，X 仍可用；禁用 x-default **不是**禁止该平台所有实例。对外 `x_search` 已从 MCP/Pi/DSH 注册、工具开关和权限枚举移除；X 的四模式、认证、fallback、过滤和缓存核心仍由 `community_search` 的 `engines:["x"]` 使用。Pi/DSH 的 `/x-login`（导入 Grok 登录、`-k` API key、`status`）与 `/x-logout` 命令完整保留；CLI 的 `search-boost config x` 仍可管理同一凭据。托管接入是 xAI/Grok Responses 的 X 检索能力，不冒称传统 X Developer API。`/x-logout` 仅移除本地导入凭据，显式环境变量凭据不受影响；不关闭平台或删除 backend。旧调用应增加 engines；输出使用社区 channels/data/分页契约，不再返回旧 X 顶层格式。工具入口开关与实例 enable 是两层：关闭 `community_search` 不等于禁止 fused 内部已选择的社区。旧配置的 x_search:false 只作为只读迁移信息：尚未设置 community_search 偏好时仍保持新入口关闭，明确设置新偏好后覆盖；不能保存新 x_search 偏好或重新注册旧工具。子 agent 白名单不自动替换或授予新工具；旧 x_search 配置由诊断报告为 retired_tool。已运行的宿主需更新并重载才能刷新工具列表，未修改实际用户权限或安装状态。

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

bridge 有 bearer 认证、请求/响应大小界限、最多 8 个任务与单请求超时。仅传 platform/query/limit 数据，没有 arbitrary JS、cookie、外部执行或写平台的 remote tool。扩展按固定搜索 URL 创建自己的非活动 tab，用固定函数读可见卡片，最后关闭它；不操纵既有用户 tab，不点击/滚动/发帖/点赞，不解决 challenge。调用取消删除任务，worker 检查 active 状态并停止读取；迟到结果拒绝。Disable 或 endpoint/token 变化会取消轮询与当前运行代次；取任务后、创建 tab 前、等待后、提取前后和提交前重新核对授权/任务状态。快速 Disable/Enable 不复用旧任务。已经提交给 Chrome 的建 tab/提取调用无法撤回，但其完成后的证据不提交，已建 tab 会清理。

worker 载入、Reload/update、浏览器启动只恢复已保存的 enabled=true，不把首次安装当授权。恢复时按创建前保存的唯一 URL fragment 标记清理中断遗留 tab；若站点去掉标记或用户导航导致无法确认所有权，保守保留该 tab（需用户自行检查），不猜测并关闭用户 tab。

扩展仅请求 storage/scripting 和三个固定站点、本地 bridge 的 host permissions，不请求 cookies 或 all_urls。DOM 提取先识别可见登录/安全 gate，再校验卡片、链接及祖先的可见性，使用 innerText 而非包含隐藏文字的 textContent；普通卡片讨论验证码不会单凭关键词被当作 gate。固定 gate/卡片选择器不保证识别所有未来站点变更。DOM 无卡片可能是空结果、换版或 gate，返回 unavailable 而非假穷尽；publication/author 未验证时为 null。小红书签名/跟踪 URL 参数不会进入模型证据。目标平台改版、真实会话及 Chrome版本需部署者验证。

## 项目内部原生读取：小红书、知乎、B站

网页索引不是站内搜索。已观察到的错误页/欢迎页会从 index 和选中平台的 fused Web 支路排除；日期未知仍 fail closed，通道报告 partial，而不是声称近期无讨论。默认来源保持原样，代码更新不自动注册、切换后端或登录。

内部来源为 `xiaohongshu-native`、`zhihu-native`、`bilibili-native`，配置均为 `{}`。它们不是外部 MCP 服务，也不调用第三方 CLI。

### 会话和接入

1. 显式准备兼容的 Chromium。可选 npm 依赖 `playwright-core` **不下载浏览器**；设置 `SEARCH_BOOST_BROWSER_EXECUTABLE` 指向浏览器可执行文件，或者自行安装与固定 Playwright 版本匹配的 Chromium。SearchBoost 不自动下载/安装浏览器。
2. 在交互终端执行 `search-boost community-login xiaohongshu`（也可为 `zhihu`、`bilibili`）。打开 SearchBoost 专用、有界面的浏览器；本人完成登录/平台验证，再输入 `yes` 确认。不会读取个人 Chrome profile 或导入 Cookie。
3. 重载 SearchBoost 宿主。在 Community 配置选择「站内正文 / Station content」。或通过管理工具显式注册 `{"action":"register","id":"xhs-native","provider":"xiaohongshu-native","config":{}}`，并明确停用该平台旧实例。TUI 的选择动作会只切换当前平台，不影响其他平台。

profile 按平台保存在 `$SEARCH_BOOST_HOME/state/community/sessions/<platform>/profile`，由私有目录保护；没有环境覆盖时 home 为 `~/.search-boost`。初始化只确认用户保存了专用会话，不证明平台认证或覆盖。取消确认不启用来源，但用户刚刚手动登录时 Chromium 可能已把状态写入自己的专用 profile。一个平台同一时间只有一个 profile 写入者；冲突返回失败，不争用真实浏览器。已死进程的锁可恢复；异常退出残留的 Chromium singleton/非普通文件会被拒绝，需要先关闭该专用浏览器并人工处理，不能冒险复用。

### 各平台实现与不同边界

- **小红书**：研究参考 [xpzouying/xiaohongshu-mcp/search.go](https://github.com/xpzouying/xiaohongshu-mcp/blob/main/xiaohongshu/search.go)、[feed_detail.go](https://github.com/xpzouying/xiaohongshu-mcp/blob/main/xiaohongshu/feed_detail.go) 和 [MediaCrawler XHS client](https://github.com/NanmiCoder/MediaCrawler/blob/main/media_platform/xhs/client.py)。读取站内搜索状态的 ID/签名，详情只取对应 noteId 的正文、作者及 Unix 毫秒发布时间。签名只在这次详情读取内部消费，不进入证据/快照。日期请求尝试页面「最新」排序并验证刷新；不能确认排序则告知不足，最终仍按真实详情时间过滤，不伪造新日期。
- **知乎**：参考 [MediaCrawler Zhihu client](https://github.com/NanmiCoder/MediaCrawler/blob/main/media_platform/zhihu/client.py)、[help.py](https://github.com/NanmiCoder/MediaCrawler/blob/main/media_platform/zhihu/help.py)。从搜索页发现问题/回答/文章链接，读取 initialState 中与 URL **精确匹配**的 question/answer/article 实体，不使用任意第一条推荐。取 content 和 created_time/created，而非更新时间。没有目标实体则停止，不用欢迎页/推荐内容补位。问题和回答命中均扩展到所属问题的可读线程，每个回答在自身详情页核实正文；显式 question 类别将回答命中归到问题主条目，文章只扩展自己的评论。
- **B站**：参考 [bilibili-api/article.py](https://github.com/fork-of-W1ndys/bilibili-api/blob/main/bilibili_api/article.py)、[note.json](https://github.com/fork-of-W1ndys/bilibili-api/blob/main/bilibili_api/data/api/note.json) 和 [Bilibili API collect 的笔记列表](https://github.com/pskdje/bilibili-API-collect/blob/main/docs/note/list.md)、[公开笔记详情](https://github.com/pskdje/bilibili-API-collect/blob/main/docs/note/info.md)。专栏与公开笔记分别解析；category 41/42 的公开笔记按 cvid 读取，Quill 图像/媒体嵌入不假装文字。Opus 使用动态详情文字/summary，当前不是展开全文保证；全局发现仍可依赖 index，明确标为混合覆盖。视频只作为笔记、评论的入口，不下载或转录视频。

### 小红书完整评论与知乎完整线程

两个 native 来源默认尝试遍历，而不是取固定数量的热门评论样本。小红书分别处理主评论页和每条主评论的回复页；知乎分别处理问题的回答列表、问题评论、每个回答的评论以及回复页，文章则处理自己的评论/回复。通过页面正常滚动、评论按钮和展开回复，监听当前目标的站点请求；没有复制签名算法或另开外部服务。知乎服务端改变分页 limit 不会单独导致失败，续页仍须保持同源、同端点并证明游标前进。

直接结果的 `data.discussion`、融合结果的 `community_data.discussion` 及保存快照共用闭合结构：

- `target_kind/target_id/target_url` 指定笔记、问题或文章；回答主条目的 discussion 指向所属问题，原主条目身份不变。
- `entities` 保留问题详情、全部已获取回答或文章的完整可读文字、作者及各自创建时间；`comments` 保留正文、作者、时间及 `entity_kind/entity_id/root_id/parent_id`，可重建回复关系。未读正文不借用推荐内容或摘录补位。
- `sections` 披露回答/评论/回复各段的完成状态、已取得数量、可验证的预期数量和局部中断原因；`pages` 是已观察分页数。不保存请求签名、原始响应、Cookie 或游标。
- `status:complete` 只表示 `scope:accessible_to_current_session`：此时会话可访问内容的分页/计数和正文检查都完成，**不意味着隐藏、已删、付费或平台未开放的内容已经取得，也不是整个平台搜索完整覆盖**。显式零计数可以证明空集合，未知计数、缺少分页结束信号或回复缺口不能冒充完整。
- `status:partial` 保留已获取正文和评论，`stop_reason` 说明未遍历完成、计数未知/不一致、验证/访问拒绝、游标异常、停滞或资源上限。`1.2万` 等近似显示不能换算成精确总数；`1,024` 等精确分组数字可以解析。根评论末页不能代替回复末页；达到上限不能标完整。后续稀疏状态不降低已知计数或覆盖已验证正文；单个评论按钮失效只标记对应区段，不阻断其他回答，真实访问拒绝/网络策略失败仍停止整个读取。

现有安全边界保持：平台候选仍有界，查询总超时仍是 120 秒；单个讨论最多观察 200 页、最多使用 60 秒且服从查询剩余期限。完整正文不作 8k 展示截断：每个讨论的可保留正文/元数据预算最多约 512 KB，并按请求结果数分摊总计约 3 MB；超过即明确 partial，而非静默裁剪完整文本。固定 DOM/接口若改版同样报告 partial，不能把 fixture 通过当作真实站点恢复。

日期/类别条件筛选**主条目**后才扩展讨论；完整上下文不按主条目日期裁掉旧回答/评论，所有上下文保留自己的真实时间，也不改变主条目的发布时间。B站仍按下一节原有笔记优先块及附件日期规则执行，不扩大为完整视频评论。

### B站视频专用块

```text
# 视频标题

## 公开笔记（主体）
### 笔记标题
笔记文字……
作者、各自发布时间和笔记链接

## 评论（补充）
各个已取得的热门根评论样本……

BV 号：BVxxxxxxxxxx
```

直接结果的 `data.video_block` 保留 `title/url/bvid/published/notes/comments` 与两类附件读取状态；每条笔记/评论都有自身作者、链接和发布时间。融合结果保留 `community_data.video_block` 和格式化 `content`，供后续报告复用。格式化块是有界展示，较长正文以结构化字段为准；BV 标识不会因文本裁剪丢失。

`platform_options.bilibili.note_limit` 为 1–5（默认 3），`comment_limit` 为 0–20（默认 5；0 不请求评论）。只读取第一页公开笔记和热门根评论，不能据此声称全部笔记或完整评论区。没有笔记、读取受限和未请求是不同状态；失败会保留已取得的块，停止后续读取，不用简介或转录填充。

日期条件的顶层视频时间仍是视频发布时间，**不拿新评论日期给旧视频换日期**；附件也按自身发布时间过滤；公开笔记列表的分钟时间标注 `published_precision:minute`，秒级窗口必须容纳整个分钟，不能伪造精确秒。检索近期笔记可选 article 类别，公开笔记包含在该类中。没有可靠时间的内容仍不会通过显式日期条件。

### 读取和安全边界

每个平台最多采样 30 个候选，最多接受 10 项；详情顺序、有界执行，查询总预算 120 秒。正常样本未达到数量时继续扫描有界候选，不因先遇到旧结果而停止。限流、验证、详情失败时停止，不自动重试、绕过登录或降级用索引摘要冒充正文。

SearchBoost 内部接管请求：只允许固定平台及静态资源域名，搜索模式禁止写接口；只有显式手动登录模式允许识别出的认证请求。Cookies 从专用浏览器 store 取得（包括 HttpOnly），不导出给模型。关闭 service worker、WebSocket 及媒体取数，单请求有时间/体积限制。代理和 NO_PROXY 按已捕获的环境逐请求选择；直连解析/校验后钉住地址，代理保留目标 DNS，不自动从代理退回直连。

**当前所有 3xx 跳转都失败即停止**，不会把重定向交还浏览器自动跟随，因为 Playwright 的路由拦截不再覆盖这条跳转。跳转至登录/验证页面或其他入口会使读取不完整，不应写成健康空结果。`aborted_by_policy/blocked_redirects` 是脱敏计数，不公开请求 URL 或凭据。

ready 只验证浏览器文件和确认过的专用会话存在，不证明平台认证、连通性或近期正文已恢复。发布前还需本人登录后的实际检索和正文/时间人工抽查。固定模板、DOM 状态和站点接口可能改版；识别不到则报告不足。测试见 `scripts/test-community-native.mjs` 与 `scripts/test-community-discussion.mjs`，排查记录见 [本次修复](community-retrieval-fix.md)。

## 证据与状态

输出包含整体 `ok/empty/partial/failed`、items、逐平台 channels、warnings 和耗时。平台未启用、不可用、域名排除、失败与成功空结果有不同状态。逐项保留原引擎 rank/provenance，并附 platform/provider/backend/retrieval_mode/content_type。纯网页片段、DOM 卡片、视频元数据不是完整正文；来源数/分数/样本不证明事实或平台舆论。

公共或分区的 `from_date/to_date` 显式过滤对未知发布时间 fail closed，报告排除数量；X 保留既有验证规则。fused recency 对非 X 结果是排序软偏好：已知旧日期和未知日期都不因此在结果层被硬删除，不伪造新日期。Reddit 的采集时间窗是另一层公开 collection bound（包括 fused 推导窗口），不因此变成无限历史采集；X 保留既有融合验证规则。域名限制在派发前粗筛、最终 URL 再校验，X/Twitter 别名仍一致。

capability resource：`search-boost://community-capabilities`，总 resource 为 `search-boost://capabilities`。能力读取不会隐式联网，ready 不代表有 session/权限或已连接。私有 cache partition 包含实例/范围/凭据变更摘要，但资源/模型不暴露 token、cookie、配置原文或 credential hash。新直接调用记一次有界脱敏审计，不双记内部 X 调用。

## 验证边界

`npm run test:community` 包含独立参数/null/ISO 精度、类型化平台 data、内存分页/私有跨进程恢复与篡改/零网络边界、registry/config、五平台 fixture、scope/checkpoint、429/取消、过滤/公平限额、真实 loopback bridge transport、DOM 卡片与 browser worker Disable/Reload 行为 fixture、1/2 页预算下跨调用公平性、真实 X 编排的 11/20/30 条 cap 与过滤/partial/cache 回归、软 recency、MCP policy 资源一致性、MCP SDK round trip、Pi 注册及融合/Adaptive 参数契约。DSH 用 pinned SDK 编译原始/投影 schema 并执行；完整隔离门禁自动收录新增测试。

这些是离线服务/协议/DOM fixture，不是五平台真实账号、真实 Chrome extension 安装会话或所有 Pi/DSH 安装版本的验收。X 原有四模式回归单独运行。49ecd7c 的历史 80 入口门禁漏测了 C1–C7；C1–C7 当轮为 82 入口；平台处理/分页最终完整隔离门禁为 84 个入口通过、284 文件语法通过，依赖审计 0 vulnerabilities。详细复现、修复、验证和剩余边界见 [交付前自审](community-search-self-review.md)。浏览器/native/归档本身会随服务变化，不把配置状态和 fixture 测试写成真实连接/可用性保证。
