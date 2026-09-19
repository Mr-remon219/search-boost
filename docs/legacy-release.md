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

构建脚本从同一份代码生成旧包发布目录，不改仓库根目录的包名/版本，也不会覆盖已有输出目录。过渡版保留 CLI、MCP、Pi 和 DSH 适配层；旧包内的 DSH module specifier、插件 npx 包名和安装命令仍指向 `search-boost-mcp`。显式执行 `search-boost-mcp upgrade` 才会安装新 `search-boost` 并调用新代码迁移。

新旧包的版本号分开比较：旧包 `0.1.8` 迁到新包 `0.1.7` 不属于新包降级。

## 发布顺序与用户步骤

1. 先准备并验证两个发布物，确认 npm 包名的发布权限。
2. 发布新 `search-boost`；再发布命令改名后的旧包过渡版。**脚本不会执行发布。**
3. 两个版本都可用后，再向旧用户提供迁移命令：

```sh
npm install -g search-boost-mcp@latest
npm install -g search-boost@latest
search-boost
```

第一步由 npm 更新原包，并移除原包已不再声明的 `search-boost` 命令；第二步将该命令交给新包。`search-boost-mcp` 仍可独立运行。不要在新包安装后再安装会声明共享 bin 的**老版本** `search-boost-mcp`。

版本必须真正发布后 `@latest` 才能获得这些变化；不能原地修改已发布的版本。

## 验证范围

`npm run test:upgrade` 包含真实、离线 npm 测试，使用临时 HOME/cache/global prefix：安装双命令旧包 → 更新为单命令过渡版 → 安装新包 → 检查两个命令分别运行不同版本、旧包未被卸载、凭据和宿主配置字节未变。包管理测试不访问开发者实际安装，不执行 npm publish。

Pi/DSH 迁移另有隔离 fixtures；真实宿主中的认证、工具加载和 Windows 全流程仍需对应环境验证。
