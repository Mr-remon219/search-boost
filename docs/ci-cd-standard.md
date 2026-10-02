# SearchBoost 工程与 CI/CD 标准

本标准按项目风险划分验证义务，不以测试条数、进程数或绿色 job 数量代替质量。适用于单核心、多宿主适配器、安装器及 npm 包。依据文末官方资料建立项目约束；不是 DORA 成熟度、NIST SSDF 或安全认证声明。

## 1. 自动化边界与唯一执行所有者

| 义务 | 唯一所有者 | 失败含义 |
| --- | --- | --- |
| JS/MJS 语法 | `npm run check`，主 Linux cell 一次 | 无法解析；**不是 lint/typecheck** |
| 全部 workflow 结构/表达式/安全策略 | actionlint 1.7.12 + `npm run check:ci`，主 cell 一次 | YAML、动作、表达式或项目权限策略不合格 |
| 依赖锁安全 | `npm run audit:dependencies`，主 cell 一次 | moderate/high/critical 漏洞或 registry/工具不可用；不得报告安全通过 |
| 所有离线行为回归、安装、schema、包、持久化 | `npm run test:isolation`，每个 cell 一次 | 实际断言失败、污染模拟用户/源码、泄露假凭据 |
| Grok/Antigravity 生成资产 | `test-generated-assets.mjs`，包含在 isolation | 临时副本重新生成后与已提交文件字节不同；CI 不替作者修复 |
| 干净 npm tarball、global/npx、DSH schema | `test-dsh-package.mjs`，包含在 isolation | 分发包而非仅源码无法工作 |
| 本地发布前门禁 | `prepublishOnly`：语法、CI 策略、依赖审计、同一 isolation | 发布准备不合格；不能绕过门禁 |
| Linux 离线审计快照、失败日志 | 矩阵主 cell/失败 cell 的 artifact | 证据收集；不是发布、部署或额外测试 |

仓库目前只有 `.github/workflows/ci.yml`；没有自动 npm 发布或部署。`build:plugin`、`plugin:sync-grok` 是开发者显式生成命令，不是 CI 的“先修复再验收”。`jev:probe`/真实服务实验不得成为默认 CI 或发布门禁。各个 `test:*` 别名保留给本地聚焦反馈，**不再在 isolation 前后重复执行**。

基线 CI 逐套执行 52 次顶层测试派发，再完整隔离执行 63 个入口；重复来自调度，不是独立断言。删除重复 step 不删除文件、断言或历史回归。DSH schema 在源码、实际 global 安装和实际 npx 安装中分别执行是不同工件的义务，保留；Codex 场景子进程也不能因为复用了一个 fixture 文件就删除。入口数由发现器动态统计，不是完成标准。

## 2. 最小平台/版本图与反馈

一个 matrix job，四个有明确用途的 cell，而非 OS×所有 Node 的笛卡尔积：

- Linux **22.13.0**：实际验证 `engines.node >=22.13` 的下限，承担一次性静态/审计义务。
- Windows / macOS 最新 Node 22：平台路径、launcher、安装/卸载、TOML、包边界。
- Linux Node 24：另一支持版本的运行时兼容性；不再复制静态、审计、快照。

保留 `test (ubuntu-latest)`、`test (windows-latest)`、`test (macos-latest)` 名称；新增 `test (ubuntu-latest, Node 24)`。GitHub 分支保护/ruleset 不在仓库里，本次不修改或声称已验证后台配置。维护者应确认这四项 required checks，以及 PR/merge-queue 的必需策略。

`fail-fast:false` 保留平台间独立证据。安装/工具准备失败时，依赖它们的步骤正常跳过，不能 `always()` 伪运行；isolation 自身逐入口收集失败并最后非零退出，不因第一个失败掩盖其余回归。每入口耗时用于找瓶颈；45 分钟 job timeout 是基础设施保险，不是目标，更不是生产搜索的累计预算。真实 CI 时间缩短只能在更新后的云端运行中测量，不能由派发减少推算成已实现的墙钟加速。

push 保留主分支和当前命名 feature 分支的 PR 前反馈；PR 验证合并 ref，merge_group 验证队列 ref。不同 ref 并非相同输入，不能只按 head 名取消去重。并发组带 workflow、事件和 ref，同输入的新 run 取消旧 run，防止 fork 的同名分支取消保护分支任务。手工 workflow_dispatch 用于维护者复验，不触发发布。

## 3. 供应链与权限基线

- 默认 `GITHUB_TOKEN` 仅 `contents:read`，不继承 checkout 凭据，不给验证 job write 权限、不使用 secrets、不运行 `pull_request_target`/特权 workflow_run。
- 外部 actions 固定完整 40 位 commit SHA，并保留版本注释。更新时核对官方仓库 tag→commit 与发布说明，按月复查、遇安全通告立即复查；固定 SHA 不是永不升级。
- actionlint 二进制版本和 SHA-256 固定，校验成功才解压执行；不使用 `curl | bash`。验证所有 workflow，不只 ci.yml。其 shellcheck/pyflakes 集成显式关闭，因此不宣称全面 shell/Python lint。
- `npm ci --ignore-scripts` 使用提交的 lock/integrity，不执行依赖安装生命周期。可选 PDF 原生库在真实离线 PDF 回归中验证；失败不能用“optional”掩盖必需能力。
- 审计在私有临时 workspace 复制 package/lock，禁用脚本，不继承调用者 npmrc/token/配置。门槛为 moderate；无固定忽略清单、`continue-on-error` 或风险无期限豁免。registry 不可达属于检查失败，不能理解成漏洞为零。未来豁免须单独记录精确 advisory/版本、可达性证据、负责人、补偿控制与到期日，并经审查后实现。
- 本次修正锁定 PDF.js 6.2.108，并将已有范围内的 transitive ip-address 更新至 10.7.3。原 PDF advisory 的条件是启用 viewer scripting；项目 Node 文本抽取没有 viewer，不能仅由审计项推出已被利用，但也不以 `isEvalSupported:false` 等同于 `enableScripting:false` 来忽略通告。使用已修复版本，并执行真实 PDF 回归。
- artifact 不含 HOME、环境、npmrc、Git 元数据或登录信息。日志短期保留 7 天、离线 Linux 快照 3 天；快照只从已有依赖且 regression 实际运行的主 cell 收集，永不作为自动 release 工件。

## 4. 行为与工件验收

每个修改先证明对应失败，后证明修复；检查失败/空结果/部分成功、配置重定位、所有权冲突、dry-run、重复操作、历史读取与取消等真实边界，不只匹配实现文字。严格 schema 不能为迁就 fixture 而放松。模拟 transport 的成功零命中不是引擎失败；全引擎失败必须暴露 `all_engines_failed` 和不完整状态。

生产配置用 `CODEX_HOME` / `CLAUDE_CONFIG_DIR` 时，安装、status、print、规则/skill/hook 和卸载须与宿主的实际发现规则一致。Codex 的配置、规则和 hooks 跟随 `CODEX_HOME`，个人 skills 按官方发现规则仍在 `$HOME/.agents/skills`，不应随 state root 搬迁；Claude 个人 MCP 文件在显式覆盖时为 `$CLAUDE_CONFIG_DIR/.claude.json`，默认则为 `~/.claude.json`。卸载只删除可证明属于 SearchBoost 的本地链接，不跟随目标、不删除模糊用户目录或外来包。实际安装目录和 tarball 测试继续承担独立 obligation。

所有自动入口先 import `isolate-tests.mjs`；有毒调用者测试应包含未来未知覆盖项及 Codex/Claude 重定位路径。详细边界见 [test-isolation.md](test-isolation.md)。这是环境隔离，**不是 OS 安全沙箱**。

GUI 重启加载、真实 Grok/DSH/native host、付费 Jev/X、对抗性安全测试没有默认自动化覆盖。fixture 成功不代表这些场景通过。报告必须列明执行的 OS/Node/包版本、命令、失败/skip、日志和未执行边界；本地 Linux 结果不代替 Windows/macOS 云端结果，也不追认旧审计中越过 HOME 隔离的 Grok 状态完全恢复。

## 5. 维护与交付

- 小批次修正、聚焦红绿回归，随后一次最终全门禁；仅在输入变化或具体疑点时重跑相关义务。
- 不按“更多 job/更多断言”扩张门禁。新增检查须说明风险、唯一执行所有者、失败策略和维护成本；覆盖证明优先于计数。
- 手动 `npm run plugin:sync-grok && npm run build:plugin` 后审查生成 diff；CI/发布验收不能静默重写源码。
- `npm run check:ci` 检查 YAML 和项目策略；actionlint 检查 GitHub 语义；两者不能互相代替。安全政策参见 [SECURITY.md](../SECURITY.md)。
- 发布需维护者明确授权，遵循 `prepublishOnly`、审查实际 tarball、版本/变更说明和 rollback 方案。本标准不新增 release job、机器人 PR 或改变远端保护设置。

## 官方依据（2026-10-02 核对）

1. [DORA Continuous integration](https://dora.dev/capabilities/continuous-integration/)：小批次、频繁集成、及时可行动反馈；据此删除重复调度而非压低有用覆盖。
2. [GitHub Secure use](https://docs.github.com/en/actions/reference/security/secure-use)：最小 token 权限、完整 SHA 固定、不让不可信 PR 接触特权与 secrets。
3. [GitHub Concurrency](https://docs.github.com/en/actions/writing-workflows/choosing-what-your-workflow-does/control-the-concurrency-of-workflows-and-jobs)：取消过时 run；本项目按事件/ref 隔离不同验证输入。
4. [NIST SP 800-218 SSDF 1.1](https://csrc.nist.gov/pubs/sp/800/218/final)：保护软件与构建环境、验证可交付软件、响应漏洞；这里是工程映射，不是认证。
5. [actionlint 1.7.12](https://github.com/rhysd/actionlint/releases/tag/v1.7.12)、官方 API asset digest：固定验证器及校验和。
6. [PDF.js GHSA-hq66-cqwq-w95j](https://github.com/advisories/GHSA-hq66-cqwq-w95j)、[6.2.108 npm metadata](https://registry.npmjs.org/pdfjs-dist/6.2.108)：修复版本及 Node 下限。
7. [ip-address cross-family advisory](https://github.com/advisories/GHSA-j6r3-76f7-8jcv)、[DoS advisory](https://github.com/advisories/GHSA-h3mg-xc3c-68pw)：<=10.7.0 受影响，10.7.1 已修复；当前锁更新至 10.7.3。
8. [Codex skills](https://learn.chatgpt.com/codex/skills)：USER skill scope 是 `$HOME/.agents/skills`，解决本地旧 CLI 二进制对 skill-root 描述不一致的疑点；本次保留原 skill 根目录并显式验证安装/卸载。
9. [yaml API](https://eemeli.org/yaml/#parsing-documents)：真正解析 YAML 并拒绝 errors/重复键；不用文本搜索代替结构验证。
