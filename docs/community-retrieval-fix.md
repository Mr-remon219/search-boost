# 中文社区检索修复记录（2026-10-08）

## 已确认的故障

按用户要求不重复测试 X、Reddit，仅排查小红书、知乎、B站。默认三个来源均为 `*-web/web-index`，配置 ready 不证明站内登录或覆盖。

- 无日期请求有索引候选，小红书片段包含 `Account abnormal. Switch account and retry. 300011` 和「你访问的页面不见了」。
- `Claude`、2026-10-01 至 2026-10-08 的有界检索返回 0 项，存在旧内容和日期未知候选；这不是全站统计。
- 知乎抽样回答读取只得到欢迎页；B站抽样视频页面有标题/作者/时间，但既不是视频转录，也不是近期笔记或评论。
- ddg bot challenge、brave HTTP 402 进一步降低覆盖，但不能解释平台错误页被当正文。

根因是 **网页索引没有接到站内详情链路**，以及错误页质量判断不足。日期 fail closed 是正确约束，不能为了结果数放宽。`platformUrl` 删除 query 是既有脱敏/身份契约，详情签名应在公共投影前消费。

## 架构纠正

早先实现了连接外部 xiaohongshu-mcp REST 服务的适配器。用户指出应在项目内部实现、避免额外部署和耦合，因此已撤掉该未发布方案：没有 xiaohongshu-mcp provider、外部服务 endpoint/token 配置或外部服务部署步骤。

最终复用同一个 registry、日期过滤、fusion 和快照核心，增加 `xiaohongshu-native/zhihu-native/bilibili-native`。共享的内部浏览器层只负责 SearchBoost 专用会话、请求边界、取消与资源释放；三个平台各有独立搜索/解析模块。可选 `playwright-core@1.64.0` 仅提供驱动，不自动下载浏览器，也不读个人 Chrome 会话。

研究过的 GitHub 实现和具体平台边界见 [内部原生读取](community-search.md#项目内部原生读取小红书知乎b站)。借鉴状态结构、ID 匹配、公开笔记 API 和发布时间字段；没有引入 MediaCrawler 的完整签名/采集运行时，也没有复制执行第三方业务代码。

## 内容实现

- 小红书：搜索 ID/签名 → 精确 noteId 的详情 → desc/作者/time；有日期时尝试并验证「最新」排序。只输出无签名笔记链接。默认尝试遍历主评论及全部可读回复，以分页与计数判断完整性。
- 知乎：搜索问题/回答/文章 → URL 指定的实体 → 正文和创建时间；问题/回答命中扩展问题、全部可读回答和各层评论，文章扩展自身评论。不取任意第一条推荐，不用欢迎页补位。
- B站：专栏、公开笔记与 Opus 文字分别处理；公开笔记从 cvid 寻址，私有笔记接口不调用。Opus 全局发现可能仍是 index，详情 text/summary 不声称展开全文。
- 视频采用用户指定的块：**视频标题作大标题，公开笔记为主体，评论为补充，BV 号在末尾**。结构化块保留附件各自作者、链接、发布时间和读取状态，并进入直接、融合和快照结果。不抓视频转录，不能拿评论时间替代视频发布时间。
- 质量过滤同时保护索引与选中平台的普通 Web 融合支路，保留其他引擎的有效摘要，来源 wrapper 不额外增加独立票。未知日期造成不足时标为 partial。

## 安全审查与处置

独立只读审查报告已收到；子任务因无法写指定报告路径而标记失败，不作为成功审查门禁。父任务核对 Playwright 文档及固定版本源码后处理可验证问题：

- Chromium 对 fulfilled 3xx 会绕过再次路由，因此 **当前拒绝全部重定向，不向浏览器返回 3xx**。不扩展代理/地址权限或自动直连。这可能减少真实可读入口，需要登录后的验收继续判断。
- routed 请求头可能没有 Cookie，所以由专用 `context.cookies(url)` 构造对应目标 Cookie，不使用其他 origin 的头。
- 直连 DNS 校验与地址钉住，代理保留 DNS；逐请求遵守代理和 NO_PROXY，不做代理→直连降级。
- 关闭 WebSocket/service worker，拦截写接口；只有本人操作的登录初始化允许认证请求。输出脱敏失败计数。
- 平台专用 profile、所有权标记与锁；拒绝祖先/内部符号链接及非普通文件，不自动采用外国 profile；只恢复已死进程的锁。浏览器文件缺失时不报告 ready。

浏览器启动/关闭、系统级浏览器后台活动和真实站点兼容性仍需要运行验收；路由策略不是操作系统级网络沙箱。异常 Chrome singleton 残留拒绝复用，不以短超时强行解锁活跃 profile。

## 验证与剩余边界

`scripts/test-community-native.mjs` 覆盖精确实体/日期解析、公开笔记身份验证、笔记优先视频块、BV 保留、失败停止、认证 Cookie、直连 pin/代理 DNS、3xx 拒绝、会话所有权/并发/取消、原生投影、融合与零网络快照恢复；真实运行结果应以本轮最终测试日志为准。

此前在线重跑索引路径，小红书 24 个候选中剔除了 10 个错误/落地页；这只验证错误片段过滤，不验证站内正文恢复。

本轮最终验证：`npm run test:community`、真实 DSH schema 注册/校验、`npm run check`（312 个文件）、`npm run check:ci`、`git diff --check` 均通过。`npm run test:isolation` 的 94 个自动入口全部通过，模拟用户状态和源树未被测试修改。期间发现并修复了 native 日期模块让轻量迁移 CLI 间接依赖 ajv 的启动回归，以及可空枚举在 DSH schema 转换中的兼容性问题。

本机检查未找到可用的 Chromium；没有自动安装浏览器、代用户登录、修改真实后端或声称近期正文恢复。真实验收需要显式准备浏览器、本人执行 `community-login`、选择 native 来源，抽查正文与发布时间。运行宿主必须重载新代码；默认来源没有被自动改写。见 [接入步骤](community-search.md#会话和接入)。

## 后续扩展：完整评论和问题线程

按用户追加要求，仅扩展小红书与知乎；B站视频块、OCR/媒体、日期、登录和网络边界保持不变。新 `discussion` 模块记录正文、回复关系和各层分页证据，页面正常读取操作产生的响应才进入对应目标；不引入新的签名破解或外部运行时。知乎问题类别可由回答命中归到主问题，同一问题在本次检索中只遍历一次。

`data.discussion.status` 仅在全部必要段结束、回复和计数一致且正文可用时标 complete，范围限定为当前会话可读内容。日期按主条目筛选，上下文保留各自时间。风控、缺页、游标循环、正文不足、60 秒/200 页/正文容量边界都会保留已有材料并明确 partial，不把有界搜索或大量评论样本称为完整。

参考过 [MediaCrawler 知乎 client](https://github.com/NanmiCoder/MediaCrawler/blob/main/media_platform/zhihu/client.py)、[小红书 client](https://github.com/NanmiCoder/MediaCrawler/blob/main/media_platform/xhs/client.py)、[xiaohongshu-mcp 评论读取](https://github.com/xpzouying/xiaohongshu-mcp/blob/main/xiaohongshu/feed_detail.go)、[OpenCLI 知乎评论分页问题 #2551](https://github.com/jackwener/opencli/issues/2551)；其中固定 limit 校验、只读默认评论样本、未展开回复的模式没有当作完整遍历方案。

新 `scripts/test-community-discussion.mjs` 检查多层末页、回复关联、服务端改写 limit、缺页/空页/错误/计数/容量/取消、正文不静默裁剪、provider 编排、闭合 DSH schema、融合与零网络历史恢复。真实登录条件仍未满足，完整评论及问题线程的线上可读性尚未验收。

### 本轮完整性审查与最终验证（2026-10-09）

只读审查任务 `54fcb817-6e0b-4e4f-83c6-77078f6b31b0` 返回了报告，但运行状态为 failed：`Agent 'reviewer' requested unavailable child tools: x_search`。工作目录为 `/home/mrremon/orca/workspaces/search-boost/fix-bug`，分支 `Mr-remon219/fix-bug`，基点 `3849a75`；工作区有未提交改动。未修改子工具配置、重启或切换执行机制，不把此报告当成功审查门禁。

父任务用 fixture 独立核对并修复：未知/近似计数不再允许 complete；稀疏状态不覆盖已验证正文或降低已知计数；每个回答在自身详情页确认正文；局部按钮缺失/超时只阻断该区段，仍保留其他回答可取内容；滚动遍历所有候选容器并保留窗口回退。网络拒绝、策略、容量、取消等全局边界保持失败停止。native discussion 的缓存契约更新，历史快照仍保持原样，不重读或升级旧材料。

最终 `npm run test:community`（含新增完整性、控制失败与滚动反例）、真实 DSH schema 校验、`npm run check`（316 文件）、`npm run check:ci`、`git diff --check` 通过；最终完整隔离回归为 95 入口。日志见 `/tmp/sb-discussion-community-final.log`、`/tmp/sb-discussion-isolation-final.log`。上述均为离线验证；没有真实 Chromium/登录验收，也未切换真实后端或提交代码。
