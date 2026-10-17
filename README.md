# pi-meme

Pi Coding Agent 的 macOS Desktop 和 Web 客户端。Electron 提供窗口与本机操作，Node Host 运行会话 Worker、内置模块和 App 插件；两种界面共用 React App 和 HTTP/WebSocket 协议。Pi SDK 随应用分发，不需要安装 Pi CLI。

支持图片输入、插话与排队、消息编辑与分支、模型配置、技能、MCP、子代理和只读规划模式。文件、终端、Git 与插件工具在当前聊天的右侧栏打开。

## 下载使用

下载入口：[GitHub Releases](https://github.com/xidongdong-153/Pi-meme/releases)。首版为 `v0.1.0-beta.1` 预览版；若尚未看到附件，表示还没有公开 Release，GitHub 自动提供的 Source code 不是安装包。

| 下载包                                         | 适用场景                                      |
| ---------------------------------------------- | --------------------------------------------- |
| `pi-meme-desktop-0.1.0-beta.1-macos-arm64.zip` | Apple Silicon Mac 桌面应用，已经包含本机 Host |
| `pi-meme-host-0.1.0-beta.1-macos-arm64.tar.gz` | Apple Silicon Mac 独立 Host 与 Web            |
| `pi-meme-host-0.1.0-beta.1-linux-x64.tar.gz`   | Linux x64 独立 Host 与 Web                    |
| `SHA256SUMS`                                   | 校验下载包                                    |

下载包不需要安装 Node.js、pnpm 或 Pi CLI。首发验收基线是 macOS 15 arm64、Ubuntu 24.04 x64。Linux 需要 Git、bash 和 bubblewrap；其他 macOS 版本与 Linux 发行版未作为首发验收平台，不支持 Intel Mac、Linux arm64、Alpine/musl 和 Windows 原生运行。

macOS 包使用 ad-hoc 签名，未做 Apple 公证，首次打开需要手动确认来源。安装、校验和安全放行步骤见[快速开始](docs/getting-started.md#下载使用)。Host 包含 Web，解压后运行 `./pi-meme-host/bin/pi-meme-host`，浏览器打开 `http://127.0.0.1:31415`。远程监听继续要求 HTTPS，见 [Remote](docs/remote.md)。

## 源码开发

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
| 生成独立包、验收与发布 GitHub 版本  | [版本发布](docs/releasing.md)                                            |
| 查进程与包边界、内置模块归属        | [架构](docs/architecture.md)                                             |
| 理解会话、子代理和规划模式          | [会话与协作](docs/sessions.md)                                           |
| 查配置、数据、凭据和权限            | [配置与安全](docs/configuration.md)                                      |
| 部署或连接远程 Host                 | [Remote](docs/remote.md)                                                 |
| 通过显式目标操作项目和会话          | [HostApi v2](docs/host-api.md)                                           |
| 开发插件或管理技能                  | [App 插件](docs/plugins.md)、[技能与资源](docs/skills-and-extensions.md) |

命令与版本约束来自 [根配置](package.json)，长期开发规则见 [AGENTS.md](AGENTS.md)。自有代码使用 [MIT 许可](LICENSE)，第三方代码与运行时见[第三方许可](THIRD_PARTY_NOTICES.md)。
