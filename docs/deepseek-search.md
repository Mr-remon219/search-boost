# DeepSeek Search

引擎 ID 仍是 `deepseek-search`。0.3.1-beta.1 起它只调用官方独立 Search API，不再调用 0.3.0 的 Anthropic messages + `web_search_20250305`。同一把 Key 不会打两条路径。失败时也不回退到旧协议、Fetch 或其他引擎。

本文件记录 2026-11-24 对官网的阅读。没有用真实 Key 发过请求，因此不是 live 验证。

亲核页面：

- https://api-docs.deepseek.com/guides/search/
- https://api-docs.deepseek.com/api/search.md
- https://api-docs.deepseek.com/updates/ （2026-10-17 写明开放自研搜索 API）
- https://api-docs.deepseek.com/quick_start/pricing/
- https://api-docs.deepseek.com/zh-cn/guides/search/
- https://api-docs.deepseek.com/zh-cn/quick_start/pricing/

## 配置

```bash
search-boost config keys --set deepseek-search=KEY
search-boost config keys --enable deepseek-search
```

也可以使用 `DEEPSEEK_API_KEY`。保存 Key 不联网。已有 `enabledEngines` 白名单不会因为保存而扩大。没有白名单时，0.3.0 的规则仍是「已配置的 Key 都启用」，所以第一把或额外的 Key 会进入默认搜索。要把它留在默认搜索之外，使用 `--disable` 或显式白名单。

启用后，省略 `engine_pool` 的搜索会包含它，并可能产生费用。当次免 Key：`engine_pool: "free"`，且不要在 `engines` 里列出它。

Base URL 的默认值是 `https://api.deepseek.com`，路径固定追加 `/v1/tools/search`。文件里如果还存着 0.3.0 的默认值 `https://api.deepseek.com/anthropic/v1`，只把它当成旧默认值，仍然只请求 Search API。自定义基址若指向 `/anthropic` 或 `/messages`，不会发请求。

三个排序权重仍是未经校准的 1.0。

## 请求

`POST https://api.deepseek.com/v1/tools/search`

- `Authorization: Bearer <key>`。不发送 `x-api-key`，不发送 `anthropic-version`。
- `query`：原样发送。按 Unicode 码点计必须是 1–128 且不能全空白。官方写的是 “Unicode characters”，没有定义码点、UTF-16 或字素簇。本实现用码点，超长直接拒绝，不截断。
- `count`：1–50。调用方没给时用官方默认 10。越界不发出，也不悄悄改成别的数再声称那就是用户的值。
- `ori_question`：只有调用方另外给了合法的 1–128 码点字符串才发送。
- `need_content`：默认 false。只有显式打开才为 true。默认不调用 Fetch。
- `localization`：是 IP。默认不发送，本版也没有开关去发送。

查询里的 `site:`、`OR`、引号由 DeepSeek 搜索语法原样处理。融合层不会为了这个引擎把 query 拆开或改写。

## 响应

只读 `results`。模型风格的 `content` / `web_search_tool_result` 不是搜索结果，会报无效响应，不从正文里抽 URL。

- `snippet` 给 UI，`summary` 给 agent。二者都不互相填空。
- `title`、`site_name`、`date`、`authority`、`rerank_score` 缺失或类型不对时保持空或 null。
- 只要 `http`/`https` 且不带账号密码的 URL。不编造链接。
- HTTP 200 且 `results` 为 `[]` 是成功零条。

## 错误与重试

缺 Key、非法 query/count、已退役的 messages 基址：零次出站。

只对 408、429 和 5xx 额外重试，最多 2 次。400、401、402、403、404、413 不重试。`Retry-After` 的纯数字按秒解释，包括 `1.5` 这种小数；只有不超过 1 秒才等待，更长就停止，不会把 `1.5` 交给日期解析。HTTP-date 按当前时钟计算，未来且超过 1 秒也停止。取消之后不再发下一次。错误类放在 `engineStats` 的 `note`，整条最长 120 个字符，超长时保留开头和结尾，不回显响应正文。

## 价格

2026-11-24 的英文价格页写 Search API 每 1,000 次成功请求 $0.75，中文页写 5 元。指南写明失败、空结果和超时不计费，且价格可能变化。界面不把这个单价写成承诺。没有 live 账单核对。

## 测试

`scripts/test-deepseek-search.mjs` 和 `scripts/test-v031-beta.mjs` 使用隔离配置和 fixture。它们不访问真实 DeepSeek，也不能证明账号权限或来源真实性。
