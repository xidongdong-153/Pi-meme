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

命令启动 Electron Forge，构建并运行应用。Desktop 启动本地 Host，通过一次性票据自动登录；默认数据目录是 `~/.pi-meme`。启动接线见 [main.ts](../apps/desktop/src/main/main.ts) 与 [host-process.ts](../apps/desktop/src/main/host-process.ts)。

打开“设置 → 个人 → 模型”，连接服务商并选择默认模型，再新建项目或会话。未配置模型时仍可查看设置、资源和历史。应用不读取本机 Pi CLI 的模型凭据，配置位置见 [配置与安全](configuration.md)。

## 本机 Web

先构建浏览器页面，再启动源码模式的独立 Host：

```bash
pnpm build:web
pnpm start:server
```

打开 [本机 Host](http://127.0.0.1:31415)。独立入口默认监听 `127.0.0.1:31415`，从 `apps/web/dist` 提供页面，本机来源自动登录。默认值见 [Server 入口](../apps/server/src/main.ts)。

开发时分别在两个终端运行：

```bash
# 终端一
pnpm start:server
```

```bash
# 终端二
pnpm start:web
```

打开 [Web 开发界面](http://127.0.0.1:5173)。Vite 将 `/api` 的 HTTP 和 WebSocket 请求代理给 Host；Web 代码支持热更新，Host 源码修改后需重启终端一。5173 被占用时直接报错，不自动换端口。代理目标可用 `PI_MEME_HOST_URL` 修改，见 [Vite 配置](../apps/web/vite.config.ts)。

Desktop 和独立 Server 各自启动 Host；同时运行时，为其中一个选择不同数据目录，例如：

```bash
PI_MEME_DATA_ROOT=/absolute/path/pi-meme-web-data pnpm start:server
```

数据锁、权限与路径规则见 [配置与安全](configuration.md)。

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
