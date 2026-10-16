# pi-meme

Pi Coding Agent 的 macOS Desktop 和 Web 客户端。Electron 提供窗口与本机操作，Node Host 运行会话 Worker、内置模块和 App 插件；两种界面共用 React App 和 HTTP/WebSocket 协议。Pi 1.1 随应用分发，不需要安装 Pi CLI。

支持图片输入、插话与排队、消息编辑与分支、模型配置、技能、MCP、子代理和只读规划模式。文件、终端、Git 与插件工具在当前聊天的右侧栏打开。

## 启动

在仓库根目录执行。Node.js 最低 22.19.0，推荐 24.14.0；pnpm 使用 10.29.1。

macOS Desktop：

```bash
pnpm install --frozen-lockfile
pnpm start
```

启动 Desktop 后，也可在浏览器打开 [Web 开发界面](http://127.0.0.1:5173)，两端使用同一个 Host，不需要再启动 Server 或第二个 Vite。

不启动 Desktop、只运行 Web：

```bash
pnpm install --frozen-lockfile
pnpm build:web
pnpm start:server
```

浏览器打开 [本机 Host](http://127.0.0.1:31415)，本机访问自动登录。在“设置 → 个人 → 模型”中配置模型后发送任务。Linux/WSL2 还需安装 bubblewrap，见 [Linux 与 WSL](docs/linux-wsl.md)。

数据默认保存在 `~/.pi-meme`，可用 `PI_MEME_DATA_ROOT` 修改。Desktop 和 Server 默认使用 `127.0.0.1:31415`；目录和端口一致时复用同一个 Host，创建它的入口退出时 Host 停止。运行多套独立 Host 必须同时使用不同目录和 `PI_MEME_PORT`。凭据由 Host 保存到 `auth.json`，不读取本机 Pi CLI 配置。

## 文档

从 [文档索引](docs/index.md) 查找主题和源码入口。

| 需要做什么                          | 文档                                                                     |
| ----------------------------------- | ------------------------------------------------------------------------ |
| 安装、启动 Desktop 或 Web           | [快速开始](docs/getting-started.md)                                      |
| 修改功能、运行检查、打包 macOS 应用 | [开发与验证](docs/development.md)                                        |
| 查进程与包边界、内置模块归属        | [架构](docs/architecture.md)                                             |
| 理解会话、子代理和规划模式          | [会话与协作](docs/sessions.md)                                           |
| 查配置、数据、凭据和权限            | [配置与安全](docs/configuration.md)                                      |
| 部署或连接远程 Host                 | [Remote](docs/remote.md)                                                 |
| 通过显式目标操作项目和会话          | [HostApi v2](docs/host-api.md)                                           |
| 开发插件或管理技能                  | [App 插件](docs/plugins.md)、[技能与资源](docs/skills-and-extensions.md) |

命令与版本约束来自 [根配置](package.json)，长期开发规则见 [AGENTS.md](AGENTS.md)。
