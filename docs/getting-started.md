---
description: '下载并安装 Desktop 或 Host 独立包，以及从源码启动 Desktop、Web 和 Server'
status: implemented
paths:
  - 'package.json'
  - 'pnpm-workspace.yaml'
  - 'apps/desktop/package.json'
  - 'apps/desktop/forge.config.ts'
  - 'apps/desktop/src/main/local-host.ts'
  - 'apps/desktop/src/main/user-login-path.ts'
  - 'packages/permissions/src/ui/agent-access-selector.tsx'
  - 'scripts/package-host.mts'
  - 'apps/server/README.md'
  - 'apps/server/package.json'
  - 'apps/server/src/dev.ts'
  - 'apps/server/src/main.ts'
  - 'packages/host/src/transport-auth.ts'
  - 'apps/web/src/**'
  - 'apps/web/vite.config.ts'
---

# 快速开始

## 下载使用

从 [v0.1.0-beta.4 发布页](https://github.com/xidongdong-153/Pi-meme/releases/tag/v0.1.0-beta.4) 下载对应附件与 `SHA256SUMS`。GitHub 自动生成的 Source code 是源码归档，不是安装包。

下载包的产物验收基线为 macOS 15 arm64、Ubuntu 24.04 x64。Desktop 支持 Apple Silicon Mac，不提供 Intel Mac 或 Windows 原生安装包。Desktop 已包含本机 Host，使用桌面应用只需下载 `pi-meme-desktop-0.1.0-beta.4-macos-arm64.zip`。独立 Host 已包含 Web、Node.js 24.14.0、Worker、技能和生产依赖；启动下载版无需另外安装 Node.js、pnpm 或 Pi CLI。

### 安装 macOS Desktop

1. 从同一个 beta.4 发布页下载 Desktop ZIP 和 `SHA256SUMS`。
2. 在下载目录打开终端，执行下方命令，将输出的 SHA256 与 `SHA256SUMS` 中同名文件的值逐字比较。

   ```bash
   shasum -a 256 pi-meme-desktop-0.1.0-beta.4-macos-arm64.zip
   ```

3. 校验一致后解压 ZIP。升级时先退出旧 Desktop；若独立 Host 正在使用同一数据目录，也先停止它，避免新版复用旧 Host。数据备份见[升级](#升级)。
4. 在 Finder 中将 `pi-meme.app` 拖到“应用程序”（`/Applications`），再从该目录双击打开。
5. 如遇系统启动提示，先完成下节的首次打开确认。看到主界面后，在设置中配置模型服务商和模型，选择项目开始聊天。已有 `~/.pi-meme` 配置会继续使用。

### macOS 首次打开

beta.4 使用 ad-hoc 签名，尚未做 Developer ID 签名和 Apple 公证，macOS 的 Gatekeeper 可能阻止首次启动。这个阶段应用还未进入聊天界面，调整模型或 Agent 的“完全权限”不能解决启动拦截。

| 看到的提示或现象                               | 处理方式                                                                                                                                                             |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| “从互联网下载，是否打开”                       | 确认应用来自上述发布页且 SHA256 一致后，选择“打开”。这是首次运行下载应用的系统确认。                                                                                 |
| 无法验证开发者、Apple 无法检查是否包含恶意软件 | 先尝试从 `/Applications` 打开一次，再进入“系统设置 → 隐私与安全性”，在“安全性”区域找到 pi-meme 的阻止信息，选择“仍要打开”，按系统提示确认；可能需要密码或 Touch ID。 |
| Dock 图标跳动，但没有主窗口                    | 可能有首次打开确认等待处理。先查看系统弹窗及“隐私与安全性”中的 pi-meme 提示，完成确认后等待主界面；不要反复启动多个实例。                                            |
| 没有“仍要打开”入口                             | 核对刚尝试打开的是否为 `/Applications/pi-meme.app`。受管理的 Mac 可能限制该入口，需要联系设备管理员。仍无法打开时按下方格式反馈。                                    |
| SHA256 不一致，或提示应用已损坏                | 停止打开，重新从同一发布页下载并校验；再次校验一致后仍异常时，保留原始提示并反馈。                                                                                   |
| 提示检测到恶意软件或应用会损坏电脑             | 停止打开，保留系统提示并反馈。不要按普通首次打开确认处理。                                                                                                           |

Gatekeeper 确认只处理应用启动，不授予项目目录访问权限。正式签名和公证尚未接入，正常的互联网下载确认与“未验证开发者”拦截也要分别判断。系统提示说明见 [Apple：安全地打开 Mac 上的 App](https://support.apple.com/zh-cn/102445)。

### 首次打开与目录授权的区别

| 名称与位置                                                 | 控制什么                           | 使用时怎么处理                                                                                          |
| ---------------------------------------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Gatekeeper 首次打开确认；系统弹窗或“隐私与安全性 → 安全性” | 应用能否启动                       | 只在已确认下载来源和校验值后，处理对应 pi-meme 的启动提示。                                             |
| “隐私与安全性 → 文件与文件夹”                              | 桌面、文稿、下载等受保护目录的访问 | 当前任务确实需要该位置时再允许。误点“不允许”后，可在这里查看并调整 pi-meme 对应目录的开关，再重试任务。 |
| “隐私与安全性 → 完全磁盘访问权限”                          | 更广泛的受保护文件访问             | 普通项目操作无需预先开启；仅在具体访问需求和错误说明明确需要时，由用户决定是否授予。                    |
| App 内“完全权限”                                           | Agent 在当前 Host 上的执行范围     | 允许 Agent 执行更广范围的任务，文件访问仍受 Host 所在操作系统授权限制，不会自动打开上面的系统权限。     |

首次验证可选择 `~/Code/项目名` 等普通项目目录。项目位于桌面、文稿或下载目录时，首次访问可能出现必要授权；拒绝后该位置可能读取失败，可按需调整授权或另选项目目录。

任务不涉及照片、媒体库等内容时，遇到这些无关授权可以先选择“不允许”，让 Agent 说明访问的具体路径和原因。不要为定位一个命令而同意遍历整个用户目录。开发版可能沿用终端的系统授权，不能据此判断 Finder 启动的安装版已有相同权限。

目录权限由实际执行任务的 Host 所在系统控制；远程 Host 的文件访问不会因为本机 App 选择“完全权限”而自动获得授权。详见[配置与安全](configuration.md#权限与沙箱)和 [Apple 文件访问说明](https://support.apple.com/zh-cn/guide/security/secddd1d86a6/web)。

### 检查项目命令

beta.4 会在 Desktop 新建本机 Host 前恢复用户登录 Shell 的 PATH；会话命令、MCP 和项目终端继承该环境。它帮助定位已安装的工具，不会自动安装 pnpm、ego-browser、Python 等项目依赖。需要使用这些工具时，可以让 Agent 在项目目录执行：

```bash
command -v pnpm
pnpm --version
command -v ego-browser
ego-browser skill
```

只检查当前任务需要的工具，不用先手动 `export PATH`。命令不存在时，先核对安装情况、`command -v` 和明确的安装位置，不要通过 `find /` 或遍历整个用户目录寻找工具。

如果工具在系统终端可用、App 内却找不到，先完全退出 Desktop 并停止同数据目录的旧独立 Host，再从 Finder 启动 beta.4。连接已运行 Host 时不会改写它的环境，独立 Server 和远程 Host 也使用各自的启动环境。详细规则见[macOS Desktop 命令环境](configuration.md#macos-desktop-命令环境)。

仍无法安装或执行时，在 [GitHub Issues](https://github.com/xidongdong-153/Pi-meme/issues) 提供：应用版本、macOS 版本与芯片、下载附件名、SHA256 校验结果、失败步骤、完整提示，以及任务涉及的目录类型。路径中的个人信息可隐藏，不上传 `~/.pi-meme` 整个目录、`auth.json`、令牌或模型凭据。

### 安装独立 Host

Linux x64 在下载目录执行：

```bash
sudo apt-get update
sudo apt-get install -y git bash bubblewrap
sha256sum pi-meme-host-0.1.0-beta.4-linux-x64.tar.gz
```

与 `SHA256SUMS` 中对应值一致后：

```bash
tar -xzf pi-meme-host-0.1.0-beta.4-linux-x64.tar.gz
./pi-meme-host/bin/pi-meme-host
```

macOS arm64 需要 Git 和 bash，改用 macOS 包：

```bash
shasum -a 256 pi-meme-host-0.1.0-beta.4-macos-arm64.tar.gz
```

校验一致后：

```bash
tar -xzf pi-meme-host-0.1.0-beta.4-macos-arm64.tar.gz
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

命令启动 Electron Forge、Vite 和 Desktop。浏览器可同时打开 [开发界面](http://127.0.0.1:5173)，与 Desktop 共用默认 `127.0.0.1:31416` 的 Host，不需要再执行 `pnpm start:web` 或 `pnpm start:server`。已有兼容 Host 时直接复用，没有才启动本机子进程；两端均通过本机同源检查自动登录。开发版默认数据目录是 `~/.pi-meme-dev`，Electron 缓存和单实例锁使用 `appData/pi-meme-dev`（macOS 为 `~/Library/Application Support/pi-meme-dev`）。构建 App 继续使用 `31415` 和 `~/.pi-meme`，两者可同时运行。开发版需单独配置模型，不自动复制正式数据。显式设置 `PI_MEME_PORT` 或 `PI_MEME_DATA_ROOT` 时仍以环境变量为准；需要并行运行时，不要将两者覆盖成同一端口或目录。启动接线见 [main.ts](../apps/desktop/src/main/main.ts)、[local-host.ts](../apps/desktop/src/main/local-host.ts) 与 [host-process.ts](../apps/desktop/src/main/host-process.ts)。

打开“设置 → Agent → 模型”，连接服务商并选择默认模型和思考强度，再新建项目或会话。未配置模型时仍可查看设置、资源和历史。应用不读取本机 Pi CLI 的模型凭据，配置位置见 [配置与安全](configuration.md)。

### 本机 Web 开发

不启动 Desktop 时，在两个终端分别运行，无需额外设置环境变量：

```bash
# 终端一
pnpm start:server
```

```bash
# 终端二
pnpm start:web
```

打开 [Web 开发界面](http://127.0.0.1:5173)。Vite 默认将 `/api` 的 HTTP 和 WebSocket 请求代理给 `127.0.0.1:31416`；Web 代码支持热更新，Host 源码修改后需重启终端一。5173 被占用时直接报错，不自动换端口。代理目标可用 `PI_MEME_HOST_URL` 修改，见 [Vite 配置](../apps/web/vite.config.ts)。

`pnpm start:server` 从 [dev.ts](../apps/server/src/dev.ts) 启动，默认监听 `127.0.0.1:31416`，数据目录为 `~/.pi-meme-dev`，与正式环境的 `31415` 和 `~/.pi-meme` 分开。该入口和 Vite 开发服务器都会使用 `NODE_ENV=development`，即使终端继承了 `NODE_ENV=production`。开发环境需单独配置模型凭据，不自动复制正式数据。

显式设置 `PI_MEME_PORT`、`PI_MEME_DATA_ROOT` 或 `PI_MEME_HOST_URL` 时仍以环境变量为准；不要把开发端口、目录或代理地址覆盖成正式环境。登录 Cookie 按 Host 身份区分，避免同一 `127.0.0.1` 下不同端口的登录互相覆盖。这里隔离的是应用数据和登录状态，不隔离项目源码和用户共享技能目录；两套环境修改同一个文件时仍会相互影响。

需要查看构建后的页面时执行：

```bash
pnpm build:web
pnpm start:server
```

打开 [开发 Host](http://127.0.0.1:31416)，从 `apps/web/dist` 提供页面，本机来源自动登录。这里仍启动开发 Host；正式源码部署使用下文的[源码构建的 Server](#源码构建的-server)。

## Desktop 与 Server 共享 Host

Desktop 和 Server 使用相同端口、相同真实数据目录时，只创建一个 Host。创建方负责停机；Desktop 仅复用 Server 的 Host 时，退出 Desktop 不会停止 Server，也不能在 Desktop 中迁移目录或清缓存。Server 入口发现已有 Host 后打印复用结果并成功退出，不接管生命周期。

Desktop 自定义目录保存在本机定位文件，Server 不读取它。先在 Desktop 查看数据目录，再以相同 `PI_MEME_DATA_ROOT` 启动 Server。目录不同、协议不兼容或端口被其他程序占用时明确报错，不会悄悄换端口。设置新的令牌、TLS 或 Web 根目录属于创建配置，不能应用到已运行的 Host。

`pnpm start:server` 默认与 Desktop 开发版共用 `31416` 和 `~/.pi-meme-dev`，独立 Web 的代理也默认连接 `31416`，无需额外设置。构建后的 `node apps/server/dist/main.js` 和 Host 独立包默认使用 `31415` 和 `~/.pi-meme`，与构建 App 一致。

运行另一套独立 Host，目录和端口都要区分：

```bash
PI_MEME_DATA_ROOT=/absolute/path/pi-meme-other-data PI_MEME_PORT=31417 pnpm start:server
```

独立 Web 的 `PI_MEME_HOST_URL` 优先于 `PI_MEME_PORT`；未设置地址时使用本机端口。Forge Renderer 始终跟随 Desktop 的本机端口。已由 `pnpm start` 占用 5173 时，直接打开该页面，不再启动第二个 Vite。

管理方退出后其他客户端断线，不会自动创建替代 Host；可重新启动管理方或在 Desktop 显式重试。旧版本随机端口 Host 需要先退出再使用新入口。数据锁、权限与路径规则见 [配置与安全](configuration.md)。

## 源码构建的 Server

```bash
pnpm build:web
pnpm build:server
node apps/server/dist/main.js
```

打开 [本机 Host](http://127.0.0.1:31415)。构建入口默认使用 `31415` 和 `~/.pi-meme`，不使用开发入口的默认值；显式设置 `PI_MEME_PORT` 或 `PI_MEME_DATA_ROOT` 时仍以环境变量为准。

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
