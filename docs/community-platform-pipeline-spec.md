# Community 平台处理与结果分页：滚动实施设计

状态：本文所述平台处理/分页实现与离线验证已完成；真实部署能力保持单独验收。起点为 community 分支及尚未提交的 C1–C7 修复；不整合新版 v0.2.5，不发布、不创建 PR。本文是目标与决策记录，不是固定施工顺序。执行到接口、能力、数据保存或测试关键点时，agent 根据新证据选择下一项工作并更新本文。

## 要解决的问题

五个平台的数据获取不同，不能把 X 的字段、身份规则或结果结构套给全部平台。借鉴 X 的输入规范化、候选召回、先合并后过滤、未知元数据诊断和来源保留原则，让每个平台拥有自己的预处理与后处理。对外分页读取一次检索的已存结果，避免长返回挤占上下文；融合只使用最小公共投影，不抹掉平台差异。

## 逻辑模型

请求 → 解析新检索/只读分页模式 → 公共输入与平台参数校验 → 平台预处理 → 选中后端能力检查 → 获取候选 → 平台后处理 → 公共去重/最终限额 → 结果快照 → 第一页。

后续 cursor 只读同一快照，不重新采集、排序、登录或判断。上游采集翻页/checkpoint 与对外结果分页是两个概念。fused/Adaptive 直接消费共享核心的候选投影，不调用对外分页 facade，不新增重复检索、来源票或审计。

## 输入方向

- 保留现有 engines、query、type、max_results 与 X/Reddit 旧字段，避免破坏已有调用。
- 新增 platform_options，按 x/reddit/bilibili/zhihu/xiaohongshu 分区；整个分区可为 null，单个可选条件也可为 null。未提供或 null 表示继承公共值/使用平台默认值，不代表扩大权限。
- 每个平台可独立 query/type/date；独立字段优先于公共字段，显式 null 使用默认/继承，不把 false、0、空字符串变成默认值。只允许所选平台的参数，错别字与误投字段提前报错。
- X 继续使用其四模式、handle/post_id、模型和作者过滤；Reddit 使用 subreddit、采集窗口、页预算和可验证作者条件；B站/知乎/小红书使用各自内容分类和日期条件。具体字段以已实现处理能力为依据，不为不存在的接口造参数。
- 日期兼容 X 的 YYYY-MM-DD 和带时区 ISO 时间戳；日期终点包含整天，时间戳终点包含该时刻。Reddit 把精确日期约束投影为采集日窗口，再对结果执行精确过滤。
- 非 X 的 semantic/user/thread 若选中后端尚未实现，明确报告 unsupported，不冒充 keyword。平台身份/作者/互动条件分别解释，缺失所需元数据时不放行硬条件。
- 新检索支持 page_size（返回条数，与总 max_results 分离）、save_results（显式私有持久保存）；cursor/saved_result_id 只接受 page_size，不可混入新检索参数。

## 后处理方向

平台模块负责身份、URL、内容分类、作者/时间和特有字段；不能从其他平台 ID 套用 X Snowflake 规则。保留共同的 URL、标题/文字、平台/provider/backend/route、排名/出处，同时增加有版本的平台 data：X 帖子/账号、Reddit 帖子、B站视频/文章/动态、知乎问题/回答/文章、小红书笔记。字段缺失为 null 或省略，不把未知作者、日期或计数写成已验证事实。

合并只按平台身份/规范 URL；标题相同不构成去重依据。X 继续由现有 pipeline 完成合并与验证；非 X 使用自己的过滤器，保留 removed/unknown 诊断。普通文字的 relevance 不是事实验证，不强行把所有 query 操作符本地执行。fused recency 是非 X 结果的排序偏好，不变成硬日期删除；Reddit acquisition window 仍是独立 collection bound。

## 存储与返回方向

社区结果使用独立格式/游标，不混用 Adaptive 的 s6/h1 和 research 文件。默认在进程内保存短期、有容量及字节界限的快照；仅 save_results=true 写入 SearchBoost home 的私有社区结果目录，保存公共证据与类型化诊断，不保存凭据、后端 config、浏览器任务/会话或模型原始日志。

统一外壳继续使用 status/items/channels/warnings；分页版本增加 total_results、page_results、next_cursor、expires_at、可选 saved_result_id，以及只读恢复/复用说明。items 的 data 按平台区分，不强求所有条目同一字段集。大条目优先完整保留，在单页字节范围内减少条数；超过允许单条/整批存储界限时明确报错，不能静默剪掉证据。页大小不改排序、总量或检索调用次数。

快照不可变，绑定当前 SearchBoost home 与版本；无效/过期/越界 cursor 不触发网络。持久读取检查路径、普通文件、文件大小、格式与 schema；历史读取保留采集时间，不宣称新检索。工具入口权限仍由宿主控制，分页不授予新的检索/管理能力。

## 接入面

共享 schema/Core 是源头，MCP/Pi/DSH 使用同一输入与输出。DSH 的 nullable object/array 使用不重叠 oneOf 投影并由原始 Ajv 再验；MCP/Zod 不 strip 平台字段。注册表/能力资源描述平台参数和后端实际操作；提示词、policy、skills、文档说明 null 默认、参数优先级、平台 data 与零网络分页。Adaptive 历史契约不改。按后续用户要求移除对外 x_search；保留内部 X 核心，由 community_search 的 engines:["x"] 承接四模式。

## 验证与动态决策

关键证据包括：省略/null/具体值与冲突参数；错误参数零派发；各平台分类/身份/日期/作者/未知值；X 过滤与 single-flight 不退化；多平台一处不支持不阻断其他已有效请求；快照分页完整性/不可变/容量/取消/home 隔离/篡改与跨进程恢复；真实 MCP 与 pinned DSH schema；fused/Adaptive 不重复获取、不误用分页 limit。继续运行 C1–C7、完整隔离门禁、生成资产与依赖审计。离线验证与真实平台/Chrome/安装宿主验收分别记录。

执行时不固定平台顺序。若关键点发现共享契约先于 provider、持久化先于接口、或测试揭示语义冲突，就调整下一步；文档记录决策和剩余工作，不把未实现能力写成已完成。

## 决策/证据日志

- 初始核对：community schema 当前全局平铺参数、严格日日期、非 X 四模式整体拒绝；provider 输出已有不同字段，但没有类型化平台 data。runCommunitySearch 未分页。Adaptive pages 可借鉴，但绑定 v5/v6 元数据；research storage 的私有原子写/严格只读检查可复用思路，不混格式。
- 平台契约关键点：已增加 platform_options 分区，null 继承/默认；独立 query/type/date、X 原有条件、Reddit scope/page/作者条件、中文平台内容分类。精确时间与 Reddit acquisition 日窗口分开。非 X 未实现四模式明确 unsupported；不将缺少采集能力伪装成参数支持。
- 处理关键点：共享核心接入纯 pipeline，各平台独立身份/分类/data；按内容身份合并别名和补齐元数据后过滤。web-index display author 不作为 native 账号身份。B站 public/browser 视频能力单独校验。fused 保留原候选投影/票，不读公共第一页。
- 分页关键点：公共 facade 返回 schema_version:2，独立 c1 内存快照；显式 save_results 写 private community-v1。跨进程只读恢复、原始 captured_at、home 绑定、TTL/容量/UTF-8、严格文件/类型检查已实现。真实 MCP/Pi 读页与 DSH schema/execute fixture 已接通。
- 验证新证据：两套新测试已通过。非空 typed data 揭示 communityZod 原先只适用字符串 enum，数字版本 enum 需 literal 投影，已修复；页测试也修正了 isolate 环境可不设 SEARCH_BOOST_HOME 的假设。旧多平台 thread 整体拒绝断言按新的 per-channel 能力契约改成非法字段零派发验证，没有把真实失败改成成功。
- 最终验证关键点：可见 schema/资源/policy/注入/readme 与生成副本已同步。`test:community` 七个入口通过；真实 pinned DSH 编译/执行、MCP/Pi 读页、旧 X snapshot 14 分组和 prompt-contract 通过；全局隔离门禁 84 个入口全部通过，模拟用户状态/source tree 未改变。284 文件语法、CI policy、生成资产/包交付回归通过，audit 0 vulnerabilities（原脚本 DEP0190 警告保留）。最后文档修改仅记录结果。
- 后续入口决策：用户要求移除 x_search 防止 agent 混淆，并明确保留 /x-login、/x-logout。已移除 MCP/Pi/DSH 旧注册、独立 schema/description、catalog、skill token 和权限枚举；prompt/policy/资源示例及生成资产统一指向 community_search。内部 X 四模式与 xAI/Grok hosted/fallback 核心未删除；Pi/DSH 凭据命令及 CLI config x 保留。旧 false 偏好只读继承，旧工具不允许新保存或注册；子白名单只诊断 retired_tool，不自动替换/扩权。
- 本次验证证据：真实 MCP 无旧工具且旧调用被拒绝；真实 DSH 七工具编译/输出门禁通过；Pi/DSH /x-login -k 与 /x-logout 的离线凭据就绪切换通过。首次完整门禁发现安装测试仍断言七条 Grok auto-allow，改为移除旧入口后的六条并新增旧权限缺席断言；最终重跑 84 个隔离入口全部通过，模拟用户状态/source tree 未改变。284 文件语法、CI policy、生成资产与依赖审计通过，0 vulnerabilities；Windows 已有 skip/DEP0190 保留，未验真实账号或宿主会话。
- 剩余范围：不新增非 X 账号/线程/语义获取或上游深翻页，不声称真实平台/Chrome/安装宿主会话已验证；若后续提供新的实际平台证据或能力需求，在本文新增决策而非机械沿预定顺序施工。本轮未提交/推送、未创建 PR，仍未整合新 v0.2.5 基线。
