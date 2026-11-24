# Community Search：设计与动态执行计划

状态：五平台代码、三宿主/融合迁移、完整回归及交付前自审已完成，待用户审查。本文记录当前共识、工作地图、证据和待决事项，不是冻结 API 的正式规范，也不是按顺序执行的任务清单。已实现行为另见 [community-search.md](community-search.md)。

## 目标与执行方式

在 SearchBoost 内建立自己的社区检索能力，以 `community_search` 为主入口，覆盖 Reddit、X、Bilibili、知乎、小红书。现有 X 实现并入公共核心；网页融合、Adaptive、MCP、DSH、Pi、提示词与注入词一起形成一致的交付。

第三方项目是策略与接入实现的参考，不是主体框架。平台语义、注册、采集控制、检索、排序、结果、缓存、诊断和宿主适配由 SearchBoost 实现。可以复用成熟 HTTP/MCP/浏览器传输设施，不以启动第三方 CLI 并原样返回 stdout 作为主要实现。

执行采用滚动规划：Agent 根据当前代码、测试、后端证据和依赖关系选择下一项工作。完成一个有意义的切片后，在关键节点重新判断下一步；不机械遵守“先完成所有核心，再做所有平台，最后做宿主”的流水线，也不为更新计划中断正在进行的有效工作。

关键节点包括：公共契约改变、宿主 schema 不兼容、后端假设被推翻、X 回归失败、采集边界问题、权限或持久化语义改变、一个端到端切片完成。此时记录：

- 已确认的事实和实际运行的检查；
- 当前可工作的范围与未解决缺口；
- 哪个假设需要保留、调整或撤回；
- 下一步最能消除风险或形成可验证功能的工作。

调整内部结构、后端选择和测试范围可以由执行 Agent 按证据决定；扩大产品范围、破坏已有兼容性、改变信任/凭据、真实账号操作和发布另行取得用户授权。“动态规划”在这里指依据进展滚动决策，不指某种优化算法，也不是省略验证。

## 当前共识与可调整事项

### 已确定的方向

- `community_search` 是 SearchBoost 的一部分，不另起一个独立搜索框架。
- 平台选择与后端选择分开；一个平台可配置多个后端实例。
- 提供工具化的后端实例注册，配套能力发现与诊断。
- Reddit 采用 Arctic Shift 档案采集与本地检索，作为正式候选后端，不依赖报告生成流程，也不以官方 API 为唯一前提。
- X 不是仅改名：原有关键词、语义、账号、线程、过滤、认证、fallback、缓存和归因能力都纳入迁移评估。
- 三个主要宿主共用业务核心，各自遵循真实协议；普通调用无需先加载 skill 或读取 resource。
- 平台只读检索与后端配置写入明确分开。

### 当前推荐，实施时可按证据收敛

- `community_search.engines` 使用平台名称数组。普通搜索指定一个或多个平台。
- `fused_search.community` 优先采用名称数组，`[]` 关闭，显式列举五个平台表示全开请求。用户最初提出的 0/1 位置数组仍是可选方案；如采用，顺序固定为 `[reddit, x, bilibili, zhihu, xiaohongshu]`，不能依资源中的可用项动态重排。
- 单平台主要引导使用 `community_search`；“网页＋单个社区平台”仍是合理 fused 用法，不强制拒绝。
- 后端管理倾向一个 `community_backend` 工具加 `action`，避免模型工具列表膨胀；也可拆为多个工具，最终按宿主 schema、权限表达和交互体验决定。
- 原决定：兼容期保留 `x_search` 薄入口。后续用户明确要求移除对外旧工具以避免混淆：现 MCP/Pi/DSH 只注册 community_search 承接 X 四模式，内部 X 核心保留；同步移除旧 schema/description/权限枚举并迁移提示词、示例与宿主测试。旧 false 偏好只读继承，子工具白名单不自动扩权。用户另明确保留 `/x-login`、`/x-logout`，Pi/DSH 注册和共享凭据管理未删除；离线登录/退出就绪切换已验证，最终全量 84 隔离入口通过。
- 社区读取/评论能力先作为 provider 可选操作；是否公开独立 `community_read` 按搜索到读取的实际缺口判断，避免为了统一而将所有模式塞进一个工具。
- 默认平台集合、平台专属 options、采集默认窗口/页数、缓存保留时间、管理 action 细节和新 schema 版本，属于待验证参数，不在本文伪装成已经实现的值。

## 逻辑模型

```text
MCP / DSH / Pi / 其他 SearchBoost 接入宿主
                    ↓
          runtime：统一调用与入口开关
                    ↓
      community service：请求、路由、调度、结果
                    ↓
       registry + 用户后端实例 + 平台配置
                    ↓
          自己实现的平台 provider
                    ↓
      现有受控网络层 / MCP / 浏览器传输
```

`fused_search` 和 `community_search` 共用 community service。网页索引 fallback 调用注入的底层网页检索接口，不调用带社区支路的 fused facade，避免递归、重复检索和重复计分。

区分三个对象：

| 对象 | 含义 | 示例 |
| --- | --- | --- |
| Platform | 用户想查询的社区 | `reddit`、`x`、`zhihu` |
| Provider | 代码中实现并显式注册的接入方案 | Arctic Shift、现有 X 链路、知乎浏览器接入、小红书 MCP |
| Backend instance | 用户为 provider 配置的实例 | 本地小红书服务、选定浏览器 profile、档案服务配置 |

内部 ID 的最终拼写由契约决定，不根据第三方项目名称绑定公共 API。

## 注册、配置与能力发现

代码注册负责 provider 的元数据、配置校验、可用性描述及操作实现。可借鉴现有 `lib/judgment/registry.mjs` 的显式注册与重复 ID 校验；不要求照搬其模型配置结构。

provider 契约预计包括 `id`、`platform`、版本、配置 schema、操作集合、检索类型、`validateConfig`、`describeAvailability`、`search`，以及可选读取/评论/用户操作。

用户注册工具登记已经实现的 provider 实例，支持列出、注册/更新、移除和显式检查。它不是任意代码、shell、npm 包或 GitHub 仓库的执行入口。通用外部 MCP connector 如被提供，也使用允许的只读操作映射，而不是开放任意远程工具透传。

管理操作复用 SearchBoost 配置路径、私有写入、锁及原子替换。校验失败不部分写入；并发更新不丢其他实例；移除明确说明删除的是配置还是数据，不隐含删除账号凭据和 Reddit 缓存。注册默认不联网、不安装、不启动浏览器、不执行登录；检查是独立可观察动作。

凭据以本地安全配置/secret 引用接入，不要求把 Cookie 或 Token 写进模型可见参数、resource、错误或日志。注册连接和使用凭据不意味着允许修改宿主 MCP 配置、插件信任或用户默认设置。

扩展 `search-boost://capabilities` 的 community 区域；需要详细实例视图时提供 `search-boost://community-capabilities`。同一状态采集函数服务于 MCP resource、Pi 注入、DSH status、doctor 和管理查询。

状态区分 supported/enabled/configured/ready、操作集合、当前后端、检索方式、缺失原因及最近检查时间/范围。配置就绪不是实时连通或覆盖保证。资源读取默认不探测网络；最近一次失败不能永久代表后端当前状态。展示数据不含凭据或缓存分区用的私有指纹。

直接工具开关、平台/实例启用状态和宿主授权是不同层。保留现有“停用直接 X 工具不等于禁止 fused 内部 X 检索”的语义；显式平台禁止则必须对独立、fused、adaptive 及兼容入口一致生效。旧工具开关迁移不能使已禁用能力意外重新启用。

## 平台实现与参考边界

| 平台/参考 | 借鉴 | SearchBoost 自己实现 |
| --- | --- | --- |
| Reddit Research / Arctic Shift | 端点、范围采集、时间分页、增量保存、恢复、错误分类、活跃度探测 | Node 客户端、范围发现、采集器、checkpoint、本地检索、摘要、排序和诊断 |
| Agent Reach | 平台与后端分层、首选/备选、缺失项诊断 | registry、路由、能力状态；不继承其自动安装或 Agent 执行脚本流程 |
| 现有 X / twitter-cli / twscrape | 原有已验证链路；必要时参考响应、分页、账号/日期过滤 | 将现有 X 接入公共核心；新增后端按实际缺口决定，不另起重复 X 系统 |
| OpenCLI | 浏览器会话复用、各平台接入策略、搜索字段、错误模式 | 自己的平台 adapter、受控传输接口、解析和结果；桥接协议先核实再选择 |
| 小红书 MCP | 搜索筛选项、登录状态、详情与评论、读取参数 | 自己的 connector 与小红书 adapter，只映射所需只读功能 |
| B站 CLI | 搜索字段、结构化结果、认证要求 | 自己的 adapter；不把退役 SDK 当成默认核心依赖 |
| omnireach | 搜索/读取边界、统一 schema、后端标识 | 独立的 SearchBoost 调度与结果契约 |

MediaCrawler 当前非商业学习许可证不适合直接纳入通用包；Reddit Research 与其他参考的代码复用需核实许可证，许可不明确时参考方法、不复制实现。软件许可证与平台的数据访问授权分别评估。

### Reddit：档案数据搜索替代品

检索路径是范围发现 → 范围限定查询或采集 → 本地检索 → 返回结果与覆盖说明。允许上游关键词查询时优先使用；不支持或确认失败时转换为限定范围采集，不把单次超时当成永久失效。

范围优先来自显式 subreddit，其次用户配置，再其次可验证的社区发现/网页索引。未能发现时给出需要范围的诊断，不静默用模型猜测社区。每次说明实际搜索了哪些社区和时间窗，不能将有限范围称为全站完整搜索。

采集参考逐页增量保存、固定窗口、帖子 ID 去重、断点恢复、重复页/游标停滞检测及部分完成状态。重写时验证时间戳相同的多帖、页边界、乱序响应、恢复后的新帖补齐和异常空页；不能直接照搬时间减一策略声称无遗漏。上游不提供可靠完整性条件时明确 coverage_unknown。

本地检索使用允许保存且受大小限制的内容；检索文本与显示摘要分离。首版可用确定性关键词/相关性排序，不默认调用 LLM、embedding 或采用报告中的观点筛选。服务端查询语法、本地语法和多语言处理须对调用者说明，不能将 X 高级语法直接投到其他平台。

普通调用有可解释的采集范围与请求限制，不暗中启动长期全量同步。耗时采集按实际需要返回部分结果/续传信息；持久化 checkpoint 和缓存设保留/清理规则。取消停止网络和写入调度，已完成 checkpoint 保留，但不在后台继续跑。未知或失效的续传标识需要可诊断，不能误当完成结果。

评论树读取仅对真实返回的节点进行处理，保留折叠、限制和不完整信息。不存在的帖子与零评论可能返回相同空形状，先验证帖子身份，不把空响应当成确定无评论。

### X：迁移而非删除能力

盘点 `runXSearch`、x-pipeline、认证、网页检索/GraphQL/oEmbed fallback、单飞缓存、过滤及融合记录。现有 xAI hosted 路径不描述成直接 X 官方数据 API；输出保留实际来源和证据局限。

新工具必须能承接原有 keyword/semantic/user/thread 及相应参数，或者保留明确的兼容入口承接尚未统一的操作。平台专属模式只在适用平台调用时开放，不能同时指定多平台后静默忽略。

`/x-login`、`/x-logout`、CLI/TUI 认证管理保留功能并调整措辞；认证状态变化影响相应缓存和后端状态，不破坏 grok CLI 的独立登录。兼容入口不多运行一次搜索、不重复记录一次统计。

### 知乎、小红书、B站

优先验证实际搜索和结果身份，而不是仅依据第三方 README 声称已接入。浏览器后端复用用户明确选择的会话，服务/标签页按生命周期清理；Cookie 不跨不相关域转发。小红书保留读取所需 `xsec_token` 等参数，并与账号凭据区分处理。

B站原生后端需要另查现有接口、依赖与使用边界。`Nemo2011/bilibili-api` 已归档并展示停维护声明，B站 CLI 当前仍依赖 `bilibili-api-python`；不能仅根据其支持搜索的介绍把这条链路当成长久默认。网页索引模式可以独立存在，但不得伪装成平台原生搜索。

## 请求、结果、融合与 Adaptive

平台选择、后端路由、查询范围、相关性和最终条数分别建模。`max_results` 表示最终总数，不默认乘以平台数；采集量与返回条数分别诊断。某字段后端不支持时明确拒绝或披露降级，不静默忽略。

结果预计包括 platform/provider/backend、retrieval_mode、content_type、platform_id、title/snippet/url、author/community、published_at/retrieved_at、provenance。运行级记录 requested/attempted/used、每平台状态、范围、采集/候选数、部分完成、限制、警告、缓存与可续传信息。

以平台及内容 ID 做主去重，保留可用读取 URL。区分 API/浏览器检索、web-index 与 archive；本地 Reddit 相关性排名不冒充 Reddit 平台排名。同一网页引擎经不同 adapter 返回同一帖子，不重复增加独立来源贡献。按平台、作者/社区、讨论串实现合理多样性，审查现有域名上限对社区结果的影响。

保留现有 domain/recency/作者筛选边界、取消、网络/代理策略和 provenance。真实用户拒绝、策略阻断及取消不触发绕过式 fallback；一般网络故障可在既有授权内切换后端，并记录路线。

旧 `community: true` 兼容时仍映射仅 X，false 关闭；不能静默将 true 扩大成五个平台。新数组省略时 fused 维持默认关闭。数组全开是请求，不是成功保证；未启用或未配置的平台明确报告。

Adaptive 的 schema、策略问题、候选分配、诊断、缓存/私有存储版本一起调整。当前一次判断控制 X 支路的逻辑不能通过修改文案直接宣称多平台已接入。待决定全开/全关策略与细粒度选择的范围：策略最多选择现有允许的平台，不启用新配置、不增加隐藏查询扩展，不改变一次原问题快照与完整审阅边界。旧游标/历史快照保留原版本含义，不能因为新版本安装而变成新鲜检索。

## 三个宿主的协议与呈现

业务请求与结果使用公共契约，但不把 MCP 对象直接交给 Pi 或 DSH。每个 adapter 负责 schema 投影、生命周期、错误映射与可读呈现。

| 宿主 | 需要覆盖的真实接入面 |
| --- | --- |
| MCP | 工具注册、input/output schema、CallToolResult 的 content/structuredContent/isError、工具 annotations、取消/进度、server instructions、resources 与可选 policy/routing prompt |
| DSH | 真实工具 registry、受限 schema、Ajv 执行前后校验、native output、card/preview、错误、exec 生命周期、search:policy 与 search:status sections |
| Pi 原生 | registerTool、TypeBox 参数/输出契约、content/details/适用时 structuredContent、execute signal/onUpdate、工具开关/active set、promptSnippet/promptGuidelines、before_agent_start、TUI 与无 UI 模式、session_shutdown |
| Pi 通过 MCP | 使用实际连接后的命名/曝光及资源工具，不把原生裸工具名当作 MCP 名；不自动改变 direct/deferred/codemode 配置 |

MCP 注册/更新/删除实例是配置变更，不标成 readOnly。搜索的只读提示指平台无写操作，缓存等本地副作用应在文档/策略中解释。部分平台失败而仍有有效结果，用类型化状态和警告呈现；全失败与合法空结果区分。annotations 是提示，不替代真正权限校验。

DSH 现有 `adapters/dsh/schema.js` 不支持所有 JSON Schema 形状，特别是任意 anyOf 转换、边界、字典值 schema 和 type 数组。新模式/数组/配置结构用真实 pinned registry 验证；原契约继续由 Ajv 检查，不为了注册成功删除语义。管理工具的不同 action 结构是重点，不预设所有宿主支持同一种 union。

Pi 当前文档支持 data tool 的 outputSchema/structuredContent；与项目实际兼容版本核对后采用，不盲目假设旧版本也支持。模型读取的是 content，不把必要证据只留在 details、卡片或 codemode 数据里。原生 factory 不启动浏览器/连接守护进程；资源按调用或 session 生命周期建立与清理。非交互模式不能卡在 TUI 确认。配置写入使用项目锁/原子写入，并按 Pi 对文件变更工具的要求核对 mutation queue。

Pi 注入刷新保留用户系统提示词，去除旧 capability 段避免累积；评估当前 `before_agent_start` 完整文本替换与新 Pi structured prompt sections 的兼容，必要时适配而不在本次社区功能中无关重构。原生与 MCP 同时加载时避免重复广告/误选工具；使用宿主实际注册列表。

各宿主 UI 预览可以简短，但不能替代完整模型可见结果。长结果明确截断/续读，状态、引用、范围和失败信息不因折叠丢失。

## 提示词、注入词与文档责任

沿用 [prompt-contract.md](prompt-contract.md) 的渐进披露，不给每个宿主复制一套长工具手册。此次交付不仅是代码，以下文本都在工作范围内。

| 文本/资产 | 负责的内容与主要落点 |
| --- | --- |
| Canonical tool descriptions | community 搜索/后端管理用途、选择依据、结果限制；更新 fused、X 兼容及 Adaptive。`lib/search/tool-descriptions.js`、`routing.js`、`screening/describe.js` 或新增共享描述文件 |
| 参数字段描述 | 平台数组、默认、专属模式、管理 action、配置写入、范围/续传及不支持组合。公共 schema 和各宿主投影 |
| MCP handshake / host inject | 公共与社区证据的简短路由、真实调用通道、配置变更需授权。`agents/shared/server-instructions.md`、`agents/<host>/inject.md`、Antigravity rule/GEMINI |
| Standing policy / hooks | 档案/索引/原生证据边界，注册不是普通检索步骤；不复写字段表。shared startup、Pi inject、DSH policy；hook 只负责已有投递机制 |
| Dynamic status | 平台/后端配置状态和工具开关，无凭据、无长工作流。公共 capability formatter、Pi 注入、DSH status |
| Optional resource | 查询、配置示例，后端诊断，档案覆盖与读取局限。MCP policy 与 community capability resource |
| Skills / workflow / child prompts | 普通 community 调用不要求加载 skill。核对工具名模板、能力发现和 child allowlist；子代理只在实际授权的 runner 中获得所需只读工具，不获得配置管理工具 |
| CLI/TUI / auth / docs | x 搜索并入后的认证措辞、tool switches、doctor/stats/audit、安装/迁移说明、README 中英文及当前契约文档 |
| Generated assets | 从源模板生成 Grok/Antigravity 插件和其他 owned 安装资产，不直接改生成副本作为唯一真相 |

拟采用的核心英文工具描述方向（草案，不是已注册能力声明）：

> Search selected community platforms through configured SearchBoost backends. Use for platform-specific posts and discussions, or multi-platform community research. Results identify the platform, backend and retrieval mode, with scope, freshness and partial-failure diagnostics. Archive and web-index results are not equivalent to live native platform search; a returned sample does not establish complete coverage or platform-wide sentiment. Select supported platforms and operations using the current schema. Ordinary searches do not register, enable or install backends.

后端管理描述方向：

> Inspect or manage configured community backend instances. Register, update and remove actions change local SearchBoost configuration and require the user's request or authorization; they do not install software, execute arbitrary code or perform platform login. Check explicitly probes a configured backend. Keep credentials out of model-visible arguments and outputs; use supported local secret references.

短注入提醒方向：

> Use community_search for selected-platform community evidence and fused_search for web retrieval with optional community sources. Follow the tools actually registered in this host. Capabilities describe configuration readiness, not connectivity or permission. Distinguish native, archive and web-index evidence. Backend registration is a configuration action, not a prerequisite for ordinary search; do not change configuration because a search is empty or fails.

这些草案必须在实现具备对应能力后才进入广告文本。Pi 原生、MCP 前缀、DSH 工具名与子代理工具集通过各自绑定渲染，不能把一个宿主的调用方式硬编码到所有宿主。schema 细节留在字段描述和可选示例中。

## 工作地图：按当前证据选择，不按编号排队

以下是可交叉推进的工作域。Agent 每次选能形成完整切片、验证假设或解除依赖的工作，不需要一次完成整域才进入别域。

| 工作域 | 可验证产物 | 触发重评估的证据 |
| --- | --- | --- |
| 公共契约与注册 | registry、实例配置、管理工具及状态采集；临时 provider 贯通三个宿主 | action/schema 在宿主不能注册；写入与权限语义不一致 |
| X 迁入 | 新入口与兼容入口对固定输入产生等价行为，保留过滤和来源 | 固定 replay 排名变动、缓存/单飞/认证/开关回归 |
| Reddit 检索 | 范围发现、查询/采集、本地相关性、部分结果与恢复 | 上游关键词能力不符、采集漏页、范围或耗时不能解释 |
| 浏览器/MCP 平台 | 自己的 provider 完成可解释搜索，并能取消/清理 | 协议不公开/不稳定、账号或浏览器选择不明确 |
| 融合与 Adaptive | 多平台候选、来源相关性、筛选状态与保存版本 | 重复计分、候选饥饿、历史读取失真 |
| 宿主和语言交付 | 注册、调用、返回、提示、注入、资源、generated parity | 仅 mock 通过；卡片有数据但模型没有；老提示仍指向旧接口 |
| 安装/管理/验证 | 隔离测试、owned 文件迁移、状态和真实宿主证据 | 全局配置被修改、已禁用功能重启、生成资产漂移 |

## 验证证据与完成判断

不规定固定测试顺序。根据当前改动选择相关检查，并在接近交付时检查跨域遗漏。使用隔离 HOME/配置和受控 fixture，不为普通测试写用户真实 Cookie、账号、浏览器或安装配置。

重点证据：

- 公共契约与管理：重复注册、配置校验、并发/原子更新、移除语义、secret 脱敏、入口开关与平台禁止。
- Reddit：同时间戳边界、重复/乱序/空页、429/5xx/400/422 分类、取消、checkpoint 恢复、增量更新、检索与摘要分离、评论折叠、范围和历史新鲜度。
- X：原四种模式、作者/日期过滤、认证变更、网页/fallback 路线、单飞取消、旧入口与新入口无双重调用/审计、固定归因/排序 replay。
- 融合/Adaptive：数组与旧 boolean、domain/recency、同源不双投票、候选分配、部分失败、缓存分区、旧/新保存记录和零网络历史读取。
- MCP：真实 SDK 注册与调用结果校验、资源 JSON、read/write annotations、模型文本与结构化结果一致。
- DSH：真实 pinned SDK 的 registry/schema 编译、原始 Ajv 输入输出、card/preview 与模型正文，管理工具 union 的实际可表达性。
- Pi：原生注册、TypeBox 与结构化输出兼容、进度/取消、TUI 与 print/JSON 等无 UI 路径、active tools、重复注入、恢复会话、生命周期清理。
- 提示/安装资产：所有示例匹配实际 schema，无未展开 token；MCP 名称、DSH/Pi 原生名称和兼容描述正确；children 不得到管理写权限；owned 文件和生成资产一致。

现有回归入口可按改动选用：`test:x`、`test:xauth`、`test:fusion`、`test:search`、`test:adaptive`、`test:screening`、`test:persistence`、`test:adapters`、`test:mcp`、`test:skills`、`test:hooks`、`test:parallel`、`test:doctor`、`test:network`、`test:isolation`，以及 `scripts/test-prompt-contract.mjs`。新增 community/provider/管理/宿主测试归入合适入口。生成副本通过 `plugin:sync-grok` / `build:plugin` 更新并核对差异；不要将构建误当成已经刷新用户全局集成。

判断交付看功能与证据，而不是 checklist 是否写满：主要宿主接受新工具并能调用；X 迁移不丢能力；Reddit 替代检索给出可用结果及诚实范围；其他平台已实现、未配置、实验或未实现状态准确；提示/注入/资源与代码一致；失败、取消和权限边界可解释。后端 fixture 成功、真实服务成功、真实宿主调用成功分别记录，不相互替代。没有真实账号测试的平台保留验证缺口，不声称五平台全面实测。

## 当前执行记录与开放问题

### 2026-10-07：公共核心与 X 三宿主切片

已完成：`lib/community/` 显式 registry、私有原子实例配置、共享 schema/Zod 投影与验证、服务入口、existing-x provider；runtime 暴露 community_search/community_backend；MCP、DSH、Pi 注册与模型文本/结构化结果；能力 resource/注入；工具开关和旧 X opt-out 兼容；提示词、README、当前使用说明、生成资产和回归测试。

真实 MCP SDK 内存协议 round trip 与真实 pinned DSH registry/schema 编译已通过；Pi 当前验证是原生注册/执行 fixture 和现有 adapter 测试，不是实际启动已安装 Pi 的模型会话。X 四模式通过注入 fixture 委托，原有 X pipeline 的 25 项回归通过。无第三方工具安装、平台登录或真实网络搜索，没有修改用户全局配置。

实际已通过：check、check:ci、test:community、test:x、test:xauth、test:fusion、test:adapters（含 DSH 与 tool switches）、test:mcp、test-prompt-contract、test:skills、test:hooks、test:adaptive、test:search、test:cli。生成副本由 plugin:sync-grok/build:plugin 更新。未声称完整 CI matrix 或全部 test:isolation 通过。

新判断：管理工具用单入口 action，初始配置只接受 existing-x 的空配置；没有引入任意代码/MCP endpoint 执行能力。MCP/Pi 管理入口声明非只读，DSH 不并发运行管理调用；Grok 枚举 auto-allow 只加入 community_search。旧 x_search 显式关闭时新直接入口不会自动开启。

当前缺口：Reddit 和其他平台未实现；fused/Adaptive 仍是旧 X boolean 支路；关闭社区实例暂时不控制 legacy x_search/fused X，需要在统一路由迁移时补齐并验证。孩子工具白名单未扩大。社区统一审计/统计、可验证的后端细粒度结果 schema，以及真实 Pi 目标版本会话验证仍待推进。

下一项选择：优先实现 Reddit 的独立有界检索切片，先以显式 subreddit 验证采集、检索和取消/覆盖契约；是否同时推进 fused 路由，取决于新 provider 输出与范围字段的稳定性。社区发现、持久化断点和融合不能以当前 X 切片通过测试为证据宣称完成。执行前按当前 git 状态和关键证据重新判断。

下一次执行应从当前 git 状态和本文件继续，选择最有价值的切片，补充下面的简短记录；不需要用户逐项给出固定下一步：

```text
关键节点：
已完成/检查：
新证据与变更判断：
当前缺口：
下一项选择及原因：
需要用户确认的事项（如有）：
```

### 2026-10-07：五平台与统一路由实现节点

已收敛选择：平台采用唯一名称数组并兼容 bool（true 仍仅 X），不采用位置 0/1 数组；X 四模式保留，新工具的其他平台先提供 keyword 检索；管理单入口 action；Reddit 默认有界 URL scope 发现或显式/实例 scope，6 页/最多 20 页、每页 100 条、1 小时私有有限语料 checkpoint 与本地 relevance；浏览器采用 SearchBoost 自有 bearer loopback HTTP 协议和用户手动启用的固定 DOM 读取扩展；B站保留可选公共 API，不设为默认可靠路线；Adaptive 显式数组走共享 fused，自动策略仍只判断旧 X 支路。旧 X entry/融合现在遵守同一实例 readiness；child 维持 fused/fetch 白名单，不发管理权限。

实现包含 Arctic collector 的 scope/window checkpoint 与有界缓存、中文平台 public web-index adapters、自有浏览器三个平台 adapter/bridge/Chrome 扩展、B站 public adapter、共享融合/源票/去重/日期与域名过滤、逐平台状态、私有实例/credential cache partition、脱敏审计与模型可见路线，以及 shared/schema/宿主/readme 文案和独立测试。不是第三方 CLI 包装，没有安装/登录浏览器或改变用户信任。

关键新证据：Arctic API README 完整读取，确认 scope 查询与 limit/sort/fields、keyword 局限、无 uptime 保证，36 小时说明仅 score/num_comments 元数据。B站搜索资料检索有历史接口样例，但已知上游源码/文档路径返回 404；因此 public API 标注可选、fixture-only、可能风控，不虚构 live 验证或自动签名绕过。OpenCLI 当前目录说明三个中文平台 Browser 路线可作策略参考；自有扩展不依赖其内部未验证 transport。

当前自审重点：归档时间戳边界/并发 checkpoint、不完整来源与失败区分、缓存不能绕过 disable、域名/日期验证、browser 授权/取消/迟到结果、所有宿主平台数组与文本/结构化结果一致、package 交付资产，以及完整隔离门禁/冻结 X 回归。`test:community` 的三个入口已通过：五平台 fixture、真实 loopback bearer 协议、DOM 卡片与 MCP round trip。没有真实账号/Chrome/Pi 安装会话，也没有全 CI OS/Node matrix 的本地代替证据。

部署者验收保留项：真实平台变化/账号会话、Chrome 扩展安装和目标 Pi/DSH 版本；这些需要用户已有环境，不能在自动代码测试中擅自登录/安装。结果能力始终只报告配置 readiness 和实际路线，不报告这些未进行的连接实测。实现/自审结论以最后交付记录为准。

### 2026-10-07：自审与交付节点

实现、自审修复与最后完整门禁结束：80 个自动隔离入口全部通过，模拟用户状态/source tree 未变化；277 文件 syntax、CI policy 和新社区三套入口通过。依赖审计发现 SDK/proxy-addr 已有漏洞，核对官方 advisory 后仅更新这两个依赖：SDK floor ^1.31.0、lock 1.32.1；proxy-addr override ^2.0.8、lock 2.0.8。依赖审计为 0 vulnerabilities，更新后重新完整跑过门禁。生成资产核对通过。详细发现、修复、skip 和真实部署验收边界见 [community-search-self-review.md](community-search-self-review.md)。

下一项不再是实现切片，而是用户代码审查与其已授权环境中的部署验收；未自动安装第三方平台工具/浏览器扩展、登录或改写用户全局权限。代码保持工作树未提交，版本未自动发布。

### 2026-10-07：外部 C1–C7 反馈与修复节点

用户授权在当前分支复现/修复 C1–C7，暂不整合更新的 v0.2.5 基线，不创建 PR。再次读取完整外部审查；隔离环境的固定 49ecd7c 源码替身复现了 Disable/隐藏卡片/scope 饥饿/X 10 cap/softDates 硬删和 policy 矛盾，C7 保持生命周期证据而非真实 Chrome 实测。

本轮实现：浏览器可取消授权代次与恢复、可见 gate/卡片检查、跨调用持久 scope 轮转、community X cap/execution 与 candidateMode 解耦、非 X 软日期中性、现行 MCP policy 与资源一致性。新增 worker 与 review 两个隔离入口，扩充 bridge/MCP 测试，使用真实 X 编排而非替换整个 X runtime。目标回归和旧 X snapshot/prompt-contract 已通过；最终完整门禁 82 个隔离入口全部通过（模拟用户状态/source tree 未变）、279 文件语法和 CI policy 通过、依赖审计 0 vulnerabilities、生成资产/包交付回归通过；审查历史结论已在 [自审记录](community-search-self-review.md) 中明确撤回并区分历史证据。

浏览器恢复账本使用 local 的唯一 URL fragment 标记，只清理可证明由扩展创建的 tab；标记消失/用户导航不猜测所有权。已提交给 Chrome 的 native 调用不能撤回，Disable 后丢弃其证据并清理；账号/实机/宿主和新基线仍是独立验收项。没有安装、登录、导出 cookie 或更改用户权限。本轮修复未提交/推送，仍为工作树变更；未创建 PR。

### 平台独立处理与分页：滚动执行入口

用户进一步澄清：不照搬 X 参数/返回，各平台分别做预处理和后处理，可有 null 默认和不同平台 payload，通过快照分页返回。轻量逻辑设计与动态决策落在 [community-platform-pipeline-spec.md](community-platform-pipeline-spec.md)，不是固定施工顺序。本轮按接口/测试关键点滚动执行，保留 C1–C7 修复，不合并新基线、不发 PR。

现已接通 platform_options、日期/身份/内容分类与作者过滤、有版本 data、独立 c1 快照和显式私有跨进程恢复；候选核心不经过对外分页，旧 X 和 Adaptive 历史格式不改。新增 pipeline/pages 测试，真实 MCP/Pi/DSH 契约与源票验证通过。最终文案/生成资产同步后完整新执行：84 个隔离入口全部通过（模拟用户状态/source tree 未变）、284 文件语法/CI policy/生成资产/包交付通过、audit 0 vulnerabilities。保持已有 Windows skip 与真实部署边界；仍未提交/推送、不创建 PR。

### Adaptive 经 fused 底座的滚动接入

原调用链已复用 runFused，本轮不新建获取链。按 [adaptive-community-integration-spec.md](adaptive-community-integration-spec.md) 补齐 shared platform_options/纯预检、实际 X 模式、跨 Web 硬过滤、独立来源无 Web 时执行、类型化渠道/选中出处与保存读页，并同步真实 MCP/Pi/DSH。该文记录复现、修正及两次失败/中断门禁；最终重新执行全部 85 隔离入口通过，模拟用户状态/source tree 未改，288 文件语法、CI/generated/包交付与 diff 检查通过，audit 0。旧普通 fused 的 7+5 冻结回放保持原 hash，未重写 golden。未改变旧 X 移除/登录、授权或部署边界；本段不沿用前轮 84/284 为本轮验收，仍未提交/推送。后续独立自审 AR1–AR6/DOC1 见同一 SPEC：12 专项组复现/修复，最新代码重新全量 86 入口/289 文件通过，保留原 frozen hash、模拟状态/source tree 不变和真实连接边界。

## 参考与核对入口

研究参考（2026-10-07 已查看文档/部分源文件；脚本网页提取有缺段，不能当成完整可运行源码或测试证据）：

- [LINUX DO 原帖](https://linux.do/t/topic/2981466)
- [Reddit Research](https://github.com/liangdabiao/reddit-research)：`fetch_subreddit.py`、`probe_subreddit.py`、`comment_tree.py`，参考采集策略，不采用报告流程。
- [Arctic Shift API](https://github.com/ArthurHeitmann/arctic_shift/blob/master/api/README.md)
- [Agent Reach](https://github.com/Panniantong/Agent-Reach)
- [OpenCLI](https://github.com/jackwener/opencli)
- [小红书 MCP](https://github.com/xpzouying/xiaohongshu-mcp)
- [twitter-cli](https://github.com/public-clis/twitter-cli)、[twscrape](https://github.com/vladkens/twscrape)
- [B站 CLI 依赖](https://github.com/public-clis/bilibili-cli/blob/main/pyproject.toml)、[停维护的 bilibili-api](https://github.com/Nemo2011/bilibili-api)
- [omnireach](https://github.com/Daily-AC/omnireach)、[MediaCrawler LICENSE](https://github.com/NanmiCoder/MediaCrawler/blob/main/LICENSE)

本项目入口：`lib/runtime.mjs`、`lib/search/x/`、`lib/search/capability.js`、`lib/search/scoring.js`、`lib/search/screening/`、`lib/tool-config.mjs`、`lib/judgment/registry.mjs`、`adapters/{mcp,dsh,pi}/`、`agents/`、`lib/agent-skills.mjs`、`lib/mcp-entry.mjs`、`lib/installer/`、`scripts/test-prompt-contract.mjs`。

配套契约：[prompt-contract.md](prompt-contract.md)、[dsh-compatibility.md](dsh-compatibility.md)、[network-policy.md](network-policy.md)、[test-isolation.md](test-isolation.md)、[共享研究角色说明](../agents/shared/research/README.md)。实际实施前按涉及范围阅读全文，并以当前实现和宿主 API 为准。

Pi 协议本轮核对本机 1.0.4 文档：`docs/extensions.md`、`docs/mcp.md`、`docs/packages.md` 与 `examples/extensions/hello.ts`。这些是版本相关证据，不代表包已将最低 Pi 版本固定为 1.0.4；新增 API 需进一步核对所支持版本的声明和示例。
