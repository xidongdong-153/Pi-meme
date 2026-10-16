---
description: '安装依赖并启动 macOS Desktop、Web 开发界面和独立 Server'
status: implemented
paths:
  - 'package.json'
  - 'pnpm-workspace.yaml'
  - 'apps/desktop/package.json'
  - 'apps/server/src/main.ts'
  - 'apps/web/src/**'
  - 'apps/web/vite.config.ts'
---

# 快速开始

所有命令在仓库根目录执行。Node.js 最低版本为 22.19.0，推荐使用 24.14.0；pnpm 固定为 10.29.1。版本和脚本见 [package.json](../package.json)。Pi 1.1 与内置模块随应用构建，无需安装本机 Pi CLI。

```bash
node --version
pnpm --version
pnpm install --frozen-lockfile
```

Linux/WSL2 的系统依赖和文件系统要求先看 [Linux 与 WSL](linux-wsl.md)。Desktop 的打包与验收面向 macOS。

## macOS Desktop

```bash
pnpm start
```

命令启动 Electron Forge、Vite 和 Desktop。浏览器可同时打开 [开发界面](http://127.0.0.1:5173)，与 Desktop 共用默认 `127.0.0.1:31415` 的 Host，不需要再执行 `pnpm start:web` 或 `pnpm start:server`。已有兼容 Host 时直接复用，没有才启动本机子进程；两端均通过本机同源检查自动登录。默认数据目录是 `~/.pi-meme`。启动接线见 [main.ts](../apps/desktop/src/main/main.ts)、[local-host.ts](../apps/desktop/src/main/local-host.ts) 与 [host-process.ts](../apps/desktop/src/main/host-process.ts)。

打开“设置 → Agent → 模型”，连接服务商并选择默认模型和思考强度，再新建项目或会话。未配置模型时仍可查看设置、资源和历史。应用不读取本机 Pi CLI 的模型凭据，配置位置见 [配置与安全](configuration.md)。

## 本机 Web

先构建浏览器页面，再启动源码模式的独立 Host：

```bash
pnpm build:web
pnpm start:server
```

打开 [本机 Host](http://127.0.0.1:31415)。独立入口默认监听 `127.0.0.1:31415`，从 `apps/web/dist` 提供页面，本机来源自动登录。默认值见 [Server 入口](../apps/server/src/main.ts)。

不启动 Desktop 的 Web 开发方式，在两个终端分别运行：

```bash
# 终端一
pnpm start:server
```

```bash
# 终端二
pnpm start:web
```

打开 [Web 开发界面](http://127.0.0.1:5173)。Vite 将 `/api` 的 HTTP 和 WebSocket 请求代理给 Host；Web 代码支持热更新，Host 源码修改后需重启终端一。5173 被占用时直接报错，不自动换端口。代理目标可用 `PI_MEME_HOST_URL` 修改，见 [Vite 配置](../apps/web/vite.config.ts)。

## Desktop 与 Server 共享 Host

Desktop 和 Server 使用相同端口、相同真实数据目录时，只创建一个 Host。创建方负责停机；Desktop 仅复用 Server 的 Host 时，退出 Desktop 不会停止 Server，也不能在 Desktop 中迁移目录或清缓存。Server 入口发现已有 Host 后打印复用结果并成功退出，不接管生命周期。

Desktop 自定义目录保存在本机定位文件，Server 不读取它。先在 Desktop 查看数据目录，再以相同 `PI_MEME_DATA_ROOT` 启动 Server。目录不同、协议不兼容或端口被其他程序占用时明确报错，不会悄悄换端口。设置新的令牌、TLS 或 Web 根目录属于创建配置，不能应用到已运行的 Host。

运行另一套独立 Host，目录和端口都要区分：

```bash
PI_MEME_DATA_ROOT=/absolute/path/pi-meme-other-data PI_MEME_PORT=31416 pnpm start:server
```

独立 Web 的 `PI_MEME_HOST_URL` 优先于 `PI_MEME_PORT`；未设置地址时使用本机端口。Forge Renderer 始终跟随 Desktop 的本机端口。已由 `pnpm start` 占用 5173 时，直接打开该页面，不再启动第二个 Vite。

管理方退出后其他客户端断线，不会自动创建替代 Host；可重新启动管理方或在 Desktop 显式重试。旧版本随机端口 Host 需要先退出再使用新入口。数据锁、权限与路径规则见 [配置与安全](configuration.md)。

## 运行构建后的 Server

```bash
pnpm build:web
pnpm build:server
node apps/server/dist/main.js
```

Server 构建包含 `main.js`、静态会话 Worker 和内置技能；仍依赖本机安装的 `node_modules`，不是独立单文件。构建定义见 [vite.config.mts](../apps/server/vite.config.mts)。远程监听和 HTTPS 参数见 [Remote](remote.md)。

## 聊天操作

| 操作                               | 行为                                                               |
| ---------------------------------- | ------------------------------------------------------------------ |
| Enter / Shift+Enter                | 发送 / 换行；中文输入法组合期间不发送                              |
| 粘贴或拖入图片                     | 接受 PNG、JPEG、WebP、GIF；能否发给模型取决于模型能力              |
| 输入 `@`                           | 搜索项目文件或目录；方向键选择，Enter 插入，Tab 进入目录，Esc 关闭 |
| 输入 `$`                           | 显式选择技能；“用于当前聊天”只填入选择，不自动发送                 |
| 输入 `/plan`、`/计划`、`/计划模式` | 切换规划模式；纯命令不调用模型，带正文时发送计划任务               |
| 右侧栏“＋”                         | 打开文件、终端、变更、子代理、计划或插件面板                       |

输入与补全实现见 [composer](../packages/chat/src/ui/composer/)。插话、排队、子代理和计划的限制见 [会话与协作](sessions.md)；技能修订与调用策略见 [技能与资源](skills-and-extensions.md)。
