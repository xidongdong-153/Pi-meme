<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="packages/assets/files/brand/pi-dev-dark-128x128.png" />
  <img src="packages/assets/files/brand/pi-dev-light-128x128.png" width="96" height="96" alt="pi-meme 图标" />
</picture>

# pi-meme

**基于 Pi 的 macOS 桌面与 Web 编码工作台。**

[下载安装](https://github.com/xidongdong-153/Pi-meme/releases) · [使用文档](docs/index.md) · [开发插件](docs/plugins.md) · [反馈问题](https://github.com/xidongdong-153/Pi-meme/issues)

</div>

连接模型、选择项目，让 Agent 读取代码、修改文件、运行命令。你可以在对话旁查看变更、文件和终端，也可以先讨论计划，再开始执行。

pi-meme 基于 [Pi](https://github.com/earendil-works/pi) 的原生会话与 TypeScript SDK，提供项目管理、可恢复的会话、子代理协作和 App 插件。Pi SDK 随应用分发，无需单独安装 Pi CLI。

## 在一个项目里持续工作

- **会话与上下文**：按项目管理对话，搜索历史，引用文件和图片；任务运行时可以插话或排队，也可以编辑消息、从回复创建新分支。
- **计划与目标**：用 `/plan` 先分析项目并保存计划，确认后再执行；用 `/goal` 持续推进目标，随时查看进展、暂停或恢复。
- **子代理协作**：将独立子任务交给子代理，查看各自的消息、执行状态和结果；可为子代理设置模型与思考强度。
- **项目工具**：在同一界面查看文件、Git 变更和终端输出，管理 Agent 启动的项目服务。切换会话或关闭工具面板不会停止已启动的服务。
- **模型配置**：连接服务商账号、API Key 或兼容接口，为会话选择模型和思考强度；配置保存在执行任务的 Host 上。
- **技能与插件**：导入 `SKILL.md`、连接 MCP，或通过 App SDK 扩展工具、输入框、消息操作、业务页面与主题。安装、启用和授权分别管理。

具体交互与限制见[会话与协作](docs/sessions.md)，技能与插件分别见[资源管理](docs/skills-and-extensions.md)和[插件开发](docs/plugins.md)。

## 开始使用

Desktop 与 Web 使用同一套界面。Host 是执行任务、保存配置和会话的后台服务；Desktop 自带本机 Host，也可连接远程 Host。

| 使用方式                   | 下载包                                   | 适用平台                        |
| -------------------------- | ---------------------------------------- | ------------------------------- |
| 桌面应用                   | `pi-meme-desktop-<版本>-macos-arm64.zip` | Apple Silicon Mac               |
| Mac 上的独立 Host 与 Web   | `pi-meme-host-<版本>-macos-arm64.tar.gz` | macOS arm64                     |
| Linux 上的独立 Host 与 Web | `pi-meme-host-<版本>-linux-x64.tar.gz`   | Linux x64；WSL2 使用 Linux 环境 |

1. 从 [Releases](https://github.com/xidongdong-153/Pi-meme/releases) 选择版本，下载对应安装包与同一版本的 `SHA256SUMS`，按[安装说明](docs/getting-started.md#下载使用)校验并启动。
2. 打开“设置 → Agent → 模型”，连接服务商并选择模型。
3. 选择项目，发送任务。需要先讨论方案时，在输入框选择 `/plan`。

下载包包含运行时，不需要另外安装 Node.js、pnpm 或 Pi CLI；项目任务和外部工具仍需各自的依赖。独立 Host 启动后，浏览器访问 `http://127.0.0.1:3185`。

产物验收基线为 macOS 15 arm64、Ubuntu 24.04 x64。Linux 需要 Git、bash 和 bubblewrap；当前没有 Intel Mac、Linux arm64 或 Windows 原生安装包。macOS 默认使用 ad-hoc 签名，尚未公证，首次打开请按[系统提示说明](docs/getting-started.md#macos-首次打开)处理。

需要在另一台机器执行任务时，可使用 [HTTPS 或 SSH 连接](docs/remote.md)。项目文件、模型配置和会话属于所连接的 Host，浏览器所在的机器不承担远端执行。

## 数据与权限

会话、配置和凭据保存在 Host 数据目录中，默认是 `~/.pi-meme`。使用远程 Host 时，这些数据保存在远端；模型请求发送给你配置的服务商。凭据文件通过 `0600` 权限保护，不是加密存储，备份时需一并保护。目录迁移、缓存清理与恢复见[数据目录与存储](docs/storage.md)。

新会话默认使用工作区写入权限，也可选择只读或完全权限。内置工具的受限模式限制业务文件写入，仍允许读取与联网；插件的可信入口与受限能力另行授权。执行范围和操作系统限制见[配置与安全](docs/configuration.md#权限与沙箱)。

## 从源码运行

Node.js 最低 22.19.0，推荐 24.14.0；pnpm 固定为 10.29.1。在仓库根目录执行：

```bash
pnpm install --frozen-lockfile
pnpm start
```

`pnpm start` 按系统启动开发环境：macOS 启动 Desktop、Host 和 Web；Linux/WSL 启动 Host 和 Web。浏览器访问 [Web 开发界面](http://127.0.0.1:3181)，macOS 的 Desktop 与 Web 共用一个 Host。Ctrl+C 停止本次启动的进程，复用的已有 Host 仍由原启动方管理。

需要分开启动，或在 macOS 只运行 Host + Web 时，在两个终端分别执行：

```bash
# 终端一：启动 Host
pnpm start:server
```

```bash
# 终端二：启动 Web
pnpm start:web
```

浏览器打开 `http://127.0.0.1:3181`。开发 Host 默认使用端口 `3180` 和数据目录 `~/.pi-meme-dev`，与正式环境分开，需单独配置模型。

Linux/WSL2 环境、自定义端口和源码构建见[快速开始](docs/getting-started.md#源码开发)。

## 开发与扩展

| 想做什么                 | 从这里开始                                                                |
| ------------------------ | ------------------------------------------------------------------------- |
| 修改界面或内置功能       | [开发指南](docs/development.md)、[架构](docs/architecture.md)             |
| 运行检查与相关测试       | [测试](docs/testing.md)                                                   |
| 编写技能或 App 插件      | [技能与资源](docs/skills-and-extensions.md)、[App SDK 3](docs/plugins.md) |
| 从其他应用控制项目与会话 | [HostApi v2](docs/host-api.md)                                            |
| 构建安装包与发布版本     | [版本发布](docs/releasing.md)                                             |

完整主题入口见[文档索引](docs/index.md)，长期开发约定见 [AGENTS.md](AGENTS.md)。反馈问题时请附应用版本、系统与架构、复现步骤和错误信息；不要附带令牌、模型凭据或完整数据目录。

## 许可

自有代码采用 [MIT 许可](LICENSE)。Pi 提供 Agent 与会话能力，[Chord](https://github.com/earendil-works/pi/tree/main/packages/chord) 提供插件服务作用域；运行时、字体、图标和其他依赖保留各自许可，见[第三方许可](THIRD_PARTY_NOTICES.md)。
