---
description: '下载并安装 Desktop 或 Host 独立包，以及从源码启动 Desktop、Web 和 Server'
status: implemented
paths:
  - 'package.json'
  - 'pnpm-workspace.yaml'
  - 'apps/desktop/package.json'
  - 'scripts/package-host.mts'
  - 'apps/server/README.md'
  - 'apps/server/src/main.ts'
  - 'apps/web/src/**'
  - 'apps/web/vite.config.ts'
---

# 快速开始

## 下载使用

从 [GitHub Releases](https://github.com/xidongdong-153/Pi-meme/releases) 下载 `v0.1.0-beta.1` 对应附件与 `SHA256SUMS`。预览版不依赖 `/releases/latest` 入口；没有附件时表示还未公开版本。不要把 GitHub 自动生成的 Source code 当作安装包。

首发下载包的验收基线为 macOS 15 arm64、Ubuntu 24.04 x64。Desktop 已包含本机 Host，普通 Mac 用户只需要 Desktop。独立 Host 已包含 Web、Node.js 24.14.0、Worker、技能和生产依赖，不需要 Node.js、pnpm 或 Pi CLI。

### 安装 Desktop

在下载目录执行，并将结果与 `SHA256SUMS` 中对应文件的校验值逐字比较：

```bash
shasum -a 256 pi-meme-desktop-0.1.0-beta.1-macos-arm64.zip
```

校验一致后解压，将 `pi-meme.app` 拖到 `/Applications`，再打开应用。配置模型后开始使用。

macOS 包使用 ad-hoc 签名，未经过 Developer ID 签名与公证。若系统阻止打开，在“系统设置 → 隐私与安全性”查看该应用的阻止信息，确认下载来源和校验值后选择“仍要打开”。如果提示已损坏且上述入口不能放行，仅对已校验的应用执行：

```bash
xattr -dr com.apple.quarantine /Applications/pi-meme.app
```

不使用 `sudo`，不关闭 Gatekeeper，不批量清理整个下载目录。CI 的签名检查不能代替从 GitHub 下载后的首次打开验收。

### 安装独立 Host

Linux x64 在下载目录执行：

```bash
sudo apt-get update
sudo apt-get install -y git bash bubblewrap
sha256sum pi-meme-host-0.1.0-beta.1-linux-x64.tar.gz
```

与 `SHA256SUMS` 中对应值一致后：

```bash
tar -xzf pi-meme-host-0.1.0-beta.1-linux-x64.tar.gz
./pi-meme-host/bin/pi-meme-host
```

macOS arm64 需要 Git 和 bash，改用 macOS 包：

```bash
shasum -a 256 pi-meme-host-0.1.0-beta.1-macos-arm64.tar.gz
```

校验一致后：

```bash
tar -xzf pi-meme-host-0.1.0-beta.1-macos-arm64.tar.gz
./pi-meme-host/bin/pi-meme-host
```

若 macOS 阻止包内可执行文件，只在确认来源与校验值后，对这个解压目录执行 `xattr -dr com.apple.quarantine ./pi-meme-host`，不要扩大到其他目录。

浏览器打开 `http://127.0.0.1:31415`，本机自动登录。Ctrl+C 或 SIGTERM 停止 Host。默认只监听 loopback；远程部署见 [Remote](remote.md)。Linux 的 bubblewrap 必须通过实际探测，不能通过切换完全权限来代替安装或系统策略排查。外部 MCP、Python 等仍需要各自的运行依赖。Host 包内不附 npm、pnpm，也不自动注册系统服务。

### 升级

先退出旧 Host 的管理方，备份数据目录，再替换 Desktop 的 `.app` 或解压新版 Host。数据默认在 `~/.pi-meme`，与安装目录分离；独立 Host 继续使用原来的 `PI_MEME_DATA_ROOT`。不要覆盖或上传备份中的凭据。不承诺数据格式变化后可直接降级。Desktop 与独立 Host 使用相同目录和端口时可能复用旧实例，见[共享 Host](#desktop-与-server-共享-host)。

## 源码开发

以下源码命令在仓库根目录执行。Node.js 最低版本为 22.19.0，推荐使用 24.14.0；pnpm 固定为 10.29.1。版本和脚本见 [package.json](../package.json)。Pi SDK 与内置模块随应用构建，无需安装本机 Pi CLI。

```bash
node --version
pnpm --version
pnpm install --frozen-lockfile
```

Linux/WSL2 的系统依赖和文件系统要求先看 [Linux 与 WSL](linux-wsl.md)。Desktop 的打包与验收面向 macOS。

### macOS Desktop 开发

```bash
pnpm start
```

命令启动 Electron Forge、Vite 和 Desktop。浏览器可同时打开 [开发界面](http://127.0.0.1:5173)，与 Desktop 共用默认 `127.0.0.1:31415` 的 Host，不需要再执行 `pnpm start:web` 或 `pnpm start:server`。已有兼容 Host 时直接复用，没有才启动本机子进程；两端均通过本机同源检查自动登录。默认数据目录是 `~/.pi-meme`。启动接线见 [main.ts](../apps/desktop/src/main/main.ts)、[local-host.ts](../apps/desktop/src/main/local-host.ts) 与 [host-process.ts](../apps/desktop/src/main/host-process.ts)。

打开“设置 → Agent → 模型”，连接服务商并选择默认模型和思考强度，再新建项目或会话。未配置模型时仍可查看设置、资源和历史。应用不读取本机 Pi CLI 的模型凭据，配置位置见 [配置与安全](configuration.md)。

### 本机 Web 开发

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

## 源码构建的 Server

```bash
pnpm build:web
pnpm build:server
node apps/server/dist/main.js
```

Server 构建包含 `main.js`、静态会话 Worker 和内置技能；仍依赖本机安装的 `node_modules`，不是独立单文件。构建定义见 [vite.config.mts](../apps/server/vite.config.mts)。它不同于 `pnpm package:host` 生成的独立目录包，打包与验收见[版本发布](releasing.md)。远程监听和 HTTPS 参数见 [Remote](remote.md)。

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
