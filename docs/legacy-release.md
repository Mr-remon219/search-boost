# npm 包名与命令过渡

| 发布物 | npm 包名 | 唯一 CLI 命令 |
| --- | --- | --- |
| 仓库根目录 | `search-boost` | `search-boost` |
| 单独生成的旧包过渡版 | `search-boost-mcp` | `search-boost-mcp` |

不保留旧包的 `search-boost` bin alias；不增加自动转发插件、postinstall 迁移、强制覆盖、暂存接管或全局旧包卸载。MCP server ID 仍为 `search-boost`，无需改名。

## 生成过渡版

先运行完整检查，再选择一个**尚未发布的旧包版本号**（以下 `0.1.8` 只是示例）：

```sh
npm run prepublishOnly
npm run build:legacy -- --version 0.1.8
npm pack ./dist/search-boost-mcp-0.1.8 --dry-run
```

构建脚本从同一份代码生成旧包发布目录，不改仓库根目录的包名/版本，也不会覆盖已有输出目录。过渡版保留 CLI、MCP、Pi 和 DSH 适配层；旧包内的 DSH module specifier、插件 npx 包名和安装命令仍指向 `search-boost-mcp`。显式执行 `search-boost-mcp migrate`（旧的 `upgrade` 入口也保留）才会安装新 `search-boost` 并调用新代码迁移。

新旧包的版本号分开比较：旧包 `0.1.8` 迁到新包 `0.1.7` 不属于新包降级。

## 发布顺序与用户步骤

1. 先准备并验证两个发布物，确认 npm 包名的发布权限。
2. 发布新 `search-boost`；再发布命令改名后的旧包过渡版。**脚本不会执行发布。**
3. 两个版本都可用后，再向旧用户提供迁移命令：

```sh
npm install -g search-boost-mcp@latest
search-boost-mcp migrate -y
search-boost
```

第一步由 npm 更新原包，并移除原包已不再声明的 `search-boost` 命令；第二步一键安装并验证新包，然后迁移现有宿主集成，将该命令交给新包。`search-boost-mcp` 仍可独立运行。不要在新包安装后再安装会声明共享 bin 的**老版本** `search-boost-mcp`。

版本必须真正发布后 `@latest` 才能获得这些变化；不能原地修改已发布的版本。

## 一键迁移入口

安装过渡版后：

```sh
search-boost-mcp migrate -y                  # 一键执行
search-boost-mcp migrate --dry-run           # 只预览
search-boost-mcp migrate --workspace /path/to/project -y
# 不依赖 PATH；脚本也随过渡版 npm tarball 发布：
node /path/to/search-boost-mcp/migrate.mjs -y
```

不带 `-y` 会先确认。`migrate` 不接受 `--sync-only`，必须先确认新包可用；安装后由**新包自己的代码**刷新已识别的 Pi/DSH/MCP 集成，而不是复用内存里的旧版本代码。

- 新包尚未发布或 registry 不可访问：在安装及配置迁移前停止，保留旧包。
- npm 安装或替代包校验失败：不进入宿主配置迁移，不强制覆盖 bin。
- 部分宿主迁移失败：非零退出、明确报告；保留新旧全局包，按输出修复后重试。
- 保留 API keys、token、认证文件、搜索层、权限和禁用状态；仅迁移确认归属的注册/资产，先备份后处理。
- 扫描范围仍为已知用户配置、DSH profiles、当前/已记录项目及指定 workspace，不保证找到任意位置的手工安装。

成功后使用 `search-boost`，并重启相关 Agent。不会自动卸载旧全局包，也不会在 npm install 的生命周期中自动运行迁移。

## 验证范围

`npm run test:upgrade` 包含真实、离线 npm 测试，使用临时 HOME/cache/global prefix：安装双命令旧包 → 更新为单命令过渡版 → 安装新包 → 检查两个命令分别运行不同版本、旧包未被卸载、凭据和宿主配置字节未变。另外验证随包迁移入口、新包尚未发布时安全退出、部分失败、修复后重试，以及真实 npm 安装→新进程接管→配置迁移的完整链路（仅用本地 tarball 替换 registry 响应）。包管理测试不访问开发者实际安装，不执行 npm publish。

Pi/DSH 迁移另有隔离 fixtures；真实宿主中的认证、工具加载和 Windows 全流程仍需对应环境验证。
