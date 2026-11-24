# 网络与抓取策略 / Network and fetching policy

## 抓取顺序与速度

1. 命中 24 小时正文缓存时直接返回，`focus` 筛选仍按本次请求执行。
2. 优先抓原站并清理 HTML；普通成功请求不再先等待 Jina，也不启动 curl 子进程。Undici 复用连接。
3. 遇到主传输兼容问题，使用**同线路** curl 兜底（如已安装）。支持依赖加载失败、HTTP 解析差异、部分连接/正文流中断；curl 缺失时保留主传输诊断。curl 正常验证证书，可使用与 Node 不同的 CA 信任库，不使用 `--insecure`。
4. 原站失败或清理后内容很少时，使用 Jina Reader 备用读取。两个来源都失败时保留原因；不会把空内容假装成成功，也不会因 Jina 失败丢弃已有的简短正文。

curl 只是备用传输，不是额外权限：不会通过 shell 执行、不会加载 curlrc、不会自动跟随未经检查的跳转。URL 和代理配置通过 stdin 传入，避免凭据出现在命令行参数中。正文清理、focus、缓存仍由 SearchBoost 负责。Jina 备用路径会把目标 URL 发给第三方 `r.jina.ai`。

这能减少普通请求的额外网络跳数和重复进程开销，但不是“任何环境都比裸 curl 快”的保证。需要登录、验证码、浏览器 JS、网站封禁、网络断开等仍可能失败。curl 不可用时，Undici 和 Jina 路径仍可工作。

## 五次代理失败后的换线

- 适用于网页请求及 `fused_search` 所使用的服务传输：代理最多尝试 **5 次总计**，不是首次请求加 5 次重试。第 5 次成功则不直连；连续连接失败后尝试直接连接。
- 重试间隔为 100 / 200 / 400 / 800 ms；代理 TCP/TLS 建连预算为 2 秒，curl 直连建连预算为 10 秒。取消和调用方总截止时间优先，不保证超时前一定能做满 5 次。
- 触发条件限于连接/解析失败和代理 CONNECT 的 502/503/504。GET/HEAD 可重试断连等模糊传输失败；POST 仅在未建立连接等可安全重放的失败下重试，流式请求体不自动重放。
- 网站的 HTTP 状态码（例如 403、429、503）、代理认证/策略拒绝（407/403）、无效代理配置、不支持的 SOCKS 和证书验证失败**不触发换线**。同线路 curl 的独立证书验证不等于换线或关闭验证。
- 直连不再读取代理环境变量。网页一旦换到直连，该抓取后续跳转保持直连；每跳仍检查 HTTP(S)、URL 凭据及本地/私有目标；直连前重复校验并固定 DNS。
- 每次切换发出 `SEARCH_BOOST_DIRECT_FALLBACK` 警告，不包含目标 URL 或代理凭据。直连可能向目标暴露本机出口 IP，**配置代理不再代表绝不直连**。

计数针对传输请求，不是跨工具调用的全局失败计数；curl 兼容探测、Jina 备用请求各自可能产生额外网络请求。请求不会无限重试。页面总预算 40 秒，原站阶段 20 秒，下载上限 8,000,000 字节，最多 5 个跳转请求。

## 网络安全由谁负责

- **页面 URL 静态检查**：拒绝非 HTTP(S)、内嵌凭据、本地主机名和私有/回环/链路本地字面 IP；缓存和每个跳转也遵守这些限制。
- **直连线路**：有界解析全部 DNS 答案，拒绝私有答案及公私混合答案，并把连接固定到已校验快照；Undici、curl 和代理失败后的直连都受约束。不能用第二次不受控解析绕过初次检查。
- **显式代理线路**：静态检查仍执行，但代理接收逻辑主机名并自行解析。远端 DNS 和最终地址访问控制是受信任代理的责任；本地预查不能证明代理最终连向哪里。代理必须独立禁止不应访问的目标，这不是应用端对代理目的地址的保证。
- **TUN fake-IP**：直连解析到合成地址默认拒绝。显式 `SEARCH_BOOST_TRUSTED_TUN=1`（及既有兼容别名）委托本地受信任 TUN 映射；字面合成 IP 不等于已验证的公开目标。
- **用户配置的服务端点**：API/判断服务是用户授权配置，不等同模型提供的页面 URL。自定义端点及显式 `SEARCH_BOOST_KEYS_FILE` 必须由用户信任。
- **仍然保留**：正常 TLS 验证、取消、总截止时间、跳转次数和下载大小限制；敏感 API 请求禁止自动重定向，避免凭据转发。

上述检查不是 OS 沙箱，也没有替用户批准代理/TUN 的剩余风险。完整私密安全报告仍须单独受理；不得仅凭 fixture 通过宣称所有 SSRF 风险已经解决。

## 环境变量选路

- HTTP：`http_proxy` / `HTTP_PROXY`，其次 `all_proxy` / `ALL_PROXY`。
- HTTPS：`https_proxy` / `HTTPS_PROXY`，其次 HTTP 代理，再其次 ALL 代理。
- 仅配置 HTTPS 代理不会让 HTTP 请求也走代理。代理值取非空的小写形式优先；`no_proxy` 小写形式优先（即使为空），否则使用 `NO_PROXY`。
- `NO_PROXY` 使用 Undici 语义：逗号/空白分隔，支持 `host:port`；普通名称精确匹配，前导 `.` / `*` 为后缀匹配，`*` 绕过全部；不支持 CIDR。`.example.com`、`*.example.com` 不包括裸域 `example.com`，可将裸域单独列出。
- 校验所有有效代理配置：即使某次 HTTPS 请求有独立 HTTPS 代理，无效/不受支持的 HTTP 代理配置仍会报错。

## English summary

Fetch the origin first, clean locally, and cache usable content. Optional same-route curl handles transport compatibility; Jina is the backup, not a mandatory first hop. After five proxy connection failures, page and engine/service requests may switch to direct networking, emitting a credential-free warning. Cancellation and the existing deadline override retries; HTTP errors, proxy policy/auth denial and TLS verdicts do not switch routes. POST replays are restricted to safe pre-connect failures and reusable bodies.

Page requests reject local/private literal targets and local hostnames. Direct requests validate all DNS answers and pin the connection, including curl and proxy-to-direct fallback. Explicit proxies resolve remote names and must enforce destination policy themselves; trusted-TUN mode explicitly delegates synthetic routing. Neither delegation proves a remote destination public nor accepts the residual risk for the user. HTTP(S), URL credential restrictions, normal TLS verification, cancellation and bounded downloads/redirects remain. Curl does not load curlrc, run via a shell, follow redirects automatically or disable certificate validation. Direct fallback may expose the local egress IP. Neither universal connectivity nor universal superiority over raw curl is promised.
