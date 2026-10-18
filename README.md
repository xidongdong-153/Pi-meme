# pi-meme

Pi Coding Agent 的 macOS Desktop 和 Web 客户端。Electron 提供窗口与本机操作，Node Host 运行会话 Worker、内置模块和 App 插件；两种界面共用 React App 和 HTTP/WebSocket 协议。Pi SDK 随应用分发，不需要安装 Pi CLI。

支持图片输入、插话与排队、消息编辑与分支、模型配置、技能、MCP、子代理、持久目标自动续跑和只读规划模式。文件、终端、Git 与插件工具在当前聊天的右侧栏打开。

## 下载使用

当前公开预览版：[v0.1.0-beta.3](https://github.com/xidongdong-153/Pi-meme/releases/tag/v0.1.0-beta.3)。从该页面下载下表附件和 `SHA256SUMS`；GitHub 自动生成的 Source code 是源码归档，不是安装包。

| 下载包                                         | 适用场景                                      |
| ---------------------------------------------- | --------------------------------------------- |
| `pi-meme-desktop-0.1.0-beta.3-macos-arm64.zip` | Apple Silicon Mac 桌面应用，已经包含本机 Host |
| `pi-meme-host-0.1.0-beta.3-macos-arm64.tar.gz` | Apple Silicon Mac 独立 Host 与 Web            |
| `pi-meme-host-0.1.0-beta.3-linux-x64.tar.gz`   | Linux x64 独立 Host 与 Web                    |
| `SHA256SUMS`                                   | 校验下载包                                    |

启动下载包不需要另外安装 Node.js、pnpm 或 Pi CLI；项目任务使用的 pnpm、Python、ego-browser 等外部工具仍需自行安装。产物验收基线是 macOS 15 arm64、Ubuntu 24.04 x64。Linux 需要 Git、bash 和 bubblewrap；其他 macOS 版本与 Linux 发行版未完成同等验收，不支持 Intel Mac、Linux arm64、Alpine/musl 和 Windows 原生运行。

macOS Desktop 安装步骤：

1. 下载 Desktop ZIP 和 `SHA256SUMS`，按[安装说明](docs/getting-started.md#安装-macos-desktop)核对 SHA256。
2. 退出旧版应用，解压 ZIP，在 Finder 中将 `pi-meme.app` 拖到“应用程序”（`/Applications`），再从该目录双击打开。
3. beta.3 使用 ad-hoc 签名，尚未做 Developer ID 签名和 Apple 公证。若 macOS 阻止启动，确认来源与校验值后，在“系统设置 → 隐私与安全性”中针对 pi-meme 选择“仍要打开”，按系统提示确认。具体提示与处理步骤见[首次打开](docs/getting-started.md#macos-首次打开)。

首次打开确认决定应用能否启动；“文件与文件夹”授权决定能否访问桌面、文稿、下载等受保护目录；App 内“完全权限”只控制 Agent 的执行范围，不会授予 macOS 的“完全磁盘访问权限”。普通项目无需预先开启完全磁盘访问，目录授权应按任务需要处理。对照说明见[首次打开与目录授权的区别](docs/getting-started.md#首次打开与目录授权的区别)。

应用打开后，在设置中配置模型服务商和模型，再选择项目开始聊天。已有 `~/.pi-meme` 配置会继续使用。beta.3 会为 Desktop 新建的本机 Host 恢复用户登录 Shell 的 PATH，已安装工具的检查方法见[检查项目命令](docs/getting-started.md#检查项目命令)。

Host 包含 Web，解压后运行 `./pi-meme-host/bin/pi-meme-host`，浏览器打开 `http://127.0.0.1:31415`。远程监听继续要求 HTTPS，见 [Remote](docs/remote.md)。

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
