# DeepSeek Search 接入

## 配置与权重

逻辑引擎名为 `deepseek-search`，属于默认 api/hybrid 池，不属于默认 free 池。显式 `engines` 可沿用现有跨池选择契约，但不能绕过缺 Key 或禁用状态。

```bash
search-boost config keys --set deepseek-search=KEY
search-boost config keys --enable deepseek-search
# 可选：可信 Anthropic 兼容网关的 API base，不是完整 Messages endpoint
search-boost config keys --base-url deepseek-search=https://gateway.example/anthropic/v1
```

也可设置 `DEEPSEEK_API_KEY`，或通过 TUI 的搜索引擎配置设置 Key、启停、Base URL、恢复默认地址及删除文件 Key。已有显式白名单不自动扩张；文件与环境变量凭据均受启停配置约束。保存 Key 不触发联网，也不修改用户聊天模型的凭据或 endpoint。

`balanced / research / fresh` 三个预设权重均为 **1.0**：未经实测校准的中性冷启动值，非质量保证。不重算其他引擎权重，不按当次可用集合归一化。没有足够证据确认其索引上游，不强行归入 Bing/Google/Exa 来源组；这也不证明来源独立。

单次 MCP/Pi/DSH `fused_search` 输入示例：

```json
{
  "query": "DeepSeek API documentation",
  "engine_pool": "api",
  "engines": ["deepseek-search", "exa"],
  "engine_weights": { "deepseek-search": 0.8 },
  "complexity": "simple"
}
```

权重必须为有限非负数；零权重仍调用引擎，但不参与评分。需要停止请求应禁用或不选择该引擎，而不是设为零权重。

## 协议与执行边界

实现依据：[DeepSeek 官方 Harness provider 源码](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/web/web-search-deepseek/src/provider.ts)。这是直接 HTTP 接入，不依赖同名 Python CLI，也不复用 Harness 的账户登录 token。

- 默认 `POST https://api.deepseek.com/anthropic/v1/messages`。
- API base 自动追加 `/messages`；不读取聊天的 `DEEPSEEK_BASE_URL`。
- 使用 `x-api-key` 和 Bearer Key；`anthropic-version: 2023-06-01`。
- 固定辅助模型 `deepseek-v4-flash`、`max_tokens: 4096`、关闭 thinking。
- 使用原生 `web_search_20250305`，每个查询变体最多一次工具调用（`max_uses: 1`）。每个变体可能产生模型和搜索费用；服务限额及定价以提供方为准。
- 只接受 `web_search_tool_result` 内的结构化 `web_search_result`。摘要按 URL 关联文本块的 `citations[].cited_text`；生成的回答正文不作为证据。没有引用摘录时摘要保持空，不编造内容。
- 原始结果位置用于 `providerRank`；URL 去重并限制返回数量。`page_age` 经公共日期规范化，缺失/不可解析时未知。
- 域名约束沿用 query 中的 `site:` 提示及最终本地硬过滤；不发送未验证的原生域名/日期参数。`recency` 沿用融合软偏好，不保证服务端日期过滤。
- 单请求超时 60 秒，响应体上限 8 MB，传递调用取消信号；使用既有受控网络传输。禁止重定向，HTTP/原生工具失败不伪装为空成功，不回显错误正文或自动重试 HTTP 失败。
- 无结构化结果块即报错；合法空结果块允许空列表。当前不提供自动余额查询，控制台显示 unsupported，不以搜索请求探测余额。

## 验证

`scripts/test-deepseek-search.mjs` 已加入 `npm run test:engines`，覆盖池/权重/schema、实际请求和 citation 映射、重复/畸形条目、单 Key 权威配置、环境变量/启停、CLI/Base URL、融合缓存及零权重、HTTP/JSON/工具错误、响应大小及取消。

所有测试使用隔离配置和模拟传输，未调用真实 DeepSeek 服务、未修改用户已有凭据。真实账户可用性、费用、中文检索质量和延迟仍需独立验证。
