---
description: '独立 Host 的 HTTPS 与 SSH 连接、认证、运行参数、会话来源和排错'
status: implemented
paths:
  - 'apps/server/src/dev.ts'
  - 'apps/server/src/main.ts'
  - 'scripts/package-host.mts'
  - 'apps/server/README.md'
  - 'apps/web/vite.config.ts'
  - 'apps/desktop/src/main/host-process.ts'
  - 'apps/desktop/src/main/remote-auth.ts'
  - 'packages/host/src/server.ts'
  - 'packages/host/src/local-host.ts'
  - 'packages/host/src/frontend-server.ts'
  - 'packages/contracts/src/host-runtime.ts'
  - 'packages/host/src/transport-auth.ts'
  - 'packages/host/src/transport-app.ts'
  - 'packages/host/src/remote-services.ts'
  - 'packages/host/src/connection-credentials.ts'
  - 'packages/host/src/ssh-config.ts'
  - 'packages/host/src/ssh-connections.ts'
  - 'packages/host/src/ssh-tunnels.ts'
  - 'packages/contracts/src/ssh-connections.ts'
  - 'packages/client/src/host-client.ts'
  - 'packages/app-ui/src/shell/remote-settings.tsx'
  - 'packages/app-ui/src/shell/ssh-connection-dialog.tsx'
  - 'packages/app-ui/src/shell/remote-project-details.tsx'
---

# 独立 Host 与 Remote

工作区文件、模型、MCP、插件与 Pi 会话存放在执行它们的 Host 机器。Desktop 和 Web 共用界面与协议，浏览器不执行 Host 上的文件工具。架构见 [进程与调用](architecture.md#进程与调用)，正式控制接口见 [HostApi v2](host-api.md)。

远程设置支持 HTTPS 直连和 SSH 隧道；SSH 仍传输已有 HTTP/WebSocket 协议，不提供远程桌面或终端。下文 SSH 说明对应当前源码实现，不代表已完成真实 SSH、WSL/Tailscale 或发布包联通验收。

## 本机启动

优先下载与机器匹配的 Host 独立包，按[快速开始](getting-started.md#安装独立-host)完成校验与解压。在解压目录的父目录运行：

```bash
./pi-meme-host/bin/pi-meme-host
```

独立包已包含 Web 和 Node.js，不需要 pnpm。首发目标为 macOS 15 arm64、Ubuntu 24.04 x64，不自动安装系统服务；包内说明见 [Host README](../apps/server/README.md)。正式源码部署在仓库根目录执行：

```bash
pnpm build:web
pnpm build:server
node apps/server/dist/main.js
```

打开 [本机 Host](http://127.0.0.1:31415)，本机来源自动登录。源码开发则在两个终端分别执行 `pnpm start:server` 和 `pnpm start:web`，无需额外环境变量，访问 [开发界面](http://127.0.0.1:5173)，默认代理到 `31416`。完整安装、双终端与构建产物用法见 [快速开始](getting-started.md)。

构建 App、构建后的 Server 和 Host 独立包默认使用 `~/.pi-meme` 和端口 `31415`；`pnpm start` 的 Desktop 开发版和 `pnpm start:server` 默认使用 `~/.pi-meme-dev` 和端口 `31416`。同一目录只允许一个 Host 写入。Desktop 和 Server 的目录、端口一致时复用同一个运行实例；创建方负责停机。先运行 `pnpm start` 时可直接打开 5173，不再运行第二个 Vite 或 Server。不同目录不能复用同一端口；多套独立 Host 必须同时区分目录和端口，显式覆盖时不要将开发环境指向正式环境。

本机共享入口通过 `GET /api/status` 校验产品、运行协议、Host 身份和真实目录。状态仅允许本机来源读取，不返回令牌、Cookie 或远程密钥。Server 入口发现兼容 Host 后打印复用结果并成功退出；显式设置令牌、TLS、Web 根目录或认证模式时不能静默应用到已有 Host，需先停止管理方。实现见 [local-host.ts](../packages/host/src/local-host.ts) 与 [运行契约](../packages/contracts/src/host-runtime.ts)。

## 部署 HTTPS 远程 Host

非 loopback 监听必须同时配置 HTTPS 证书与私钥。使用普通用户，在解压目录 `pi-meme-host` 的父目录运行；示例路径和令牌需替换为部署环境值：

```bash
PI_MEME_HOST=0.0.0.0 \
PI_MEME_PORT=31415 \
PI_MEME_DATA_ROOT=/absolute/path/pi-meme-data \
PI_MEME_TLS_CERT=/absolute/path/fullchain.pem \
PI_MEME_TLS_KEY=/absolute/path/private-key.pem \
PI_MEME_TOKEN=replace-with-your-access-token \
./pi-meme-host/bin/pi-meme-host
```

浏览器访问证书对应的 HTTPS 地址并登录；独立包已经包含页面。Desktop 也可在远程设置中登记这个地址和令牌。不额外放宽 Origin、认证或 HTTPS 规则供反向代理使用。

源码部署时先在仓库根目录执行 `pnpm build:web` 和 `pnpm build:server`，再将最后一行换成 `node apps/server/dist/main.js`；`pnpm start:server` 是默认隔离的开发入口，不用于正式部署。源码构建产物仍依赖仓库的 `node_modules`，不能只压缩 `dist` 当作独立包。升级时停止旧管理方并备份数据目录，见[升级](getting-started.md#升级)。

监听检查见 [server.ts](../packages/host/src/server.ts)，证书读取与环境变量见 [Server main](../apps/server/src/main.ts)。macOS 受限执行使用 `sandbox-exec`，Linux/WSL2 使用 bubblewrap；平台隔离由 Host 决定，见 [权限与沙箱](configuration.md#权限与沙箱)。

## 通过 SSH 连接预装 Host

SSH 连接由入口 Node Host 发起，读取该 Host 运行用户的 SSH 配置、agent 和 `known_hosts`，不是浏览器所在电脑的文件。远端必须先安装并运行兼容的 pi-meme Host，同时允许 SSH 访问；应用不安装、升级、启动或停止远端 Host，不注册 systemd/launchd，不同步项目目录。

### 远端启动

使用包含 SSH 通道认证能力的 Host 版本。远端普通用户在 `pi-meme-host` 的父目录执行，替换数据路径和令牌：

```bash
PI_MEME_HOST=127.0.0.1 \
PI_MEME_PORT=31415 \
PI_MEME_DATA_ROOT=/absolute/path/pi-meme-data \
PI_MEME_AUTH_MODE=token-required \
PI_MEME_TOKEN=replace-with-your-access-token \
./pi-meme-host/bin/pi-meme-host
```

远端业务端口只监听 loopback，由 SSH 隧道访问，不需要为这个 loopback HTTP 入口配置 TLS。不要为此改成 `0.0.0.0`；非 loopback 仍要求 HTTPS。源码正式部署先执行上文的两个构建命令，再把最后一行替换为 `node apps/server/dist/main.js`。`pnpm start:server` 是开发入口，不替代正式启动。

`PI_MEME_AUTH_MODE=token-required` 关闭本机自动登录。只设置 `PI_MEME_TOKEN` 不会关闭默认的 loopback 免登录；SSH 转发到 loopback 后也会满足其本机条件。连接时同时验证访问令牌、当前认证模式、SSH 通道能力和持久 `hostId`；旧 Host 或未启用该模式的实例会被拒绝，不降级为免登录。已有 Host 必须先由其管理方停止，不能向运行中的实例补加环境变量。

### 设置步骤

1. 在入口 Host 的终端确认系统 OpenSSH 可以连接目标，例如 `ssh wsl`。核实主机指纹并写入系统 `known_hosts`，需要密钥解锁时先处理 SSH agent。
2. 打开已认证的入口 Host 本机页面，进入“设置 → 系统 → 远程 → SSH”。Desktop 的本地入口也可管理；普通远程网络页面只显示已登记服务，不能管理 SSH 配置。
3. 点击“添加”。列表来自入口 Host 用户的 `~/.ssh/config`；勾选具体别名后点击“添加（数量）”。刷新只重读配置，已添加别名不可重复选择。批量添加仅保存资料，不连接。
4. 没有候选时点“手动添加”。填写显示名称、主机或 `user@host`，SSH 端口可留空使用系统配置；不要填写完整 `ssh` 命令。认证方式选“使用 SSH 配置”或“指定身份文件”。后者填写入口 Host 上的绝对路径或 `~/` 路径，不上传、复制私钥。
5. 展开“远端 Host”，填写业务端口（默认 `31415`）和上面配置的 Host 访问令牌。它不同于 SSH 端口。可以先不填令牌保存，但连接前必须补全；已有令牌不回显，留空保留原值。
6. 保存后打开“保持连接”开关。SSH 建通、Host 认证及身份校验都成功后才显示“已连接”；首次成功前不会出现在可执行的工作位置列表。
7. 在输入框的工作位置选择器中选择远程连接和项目。远程目录选择查询目标 Host，不调用当前电脑的目录选择器。

连接启用期间只能改显示名称；更改目标、端口、身份文件或令牌前先关闭连接开关。修改资料不会自动清除已确认的 Host 身份；确实换成另一 Host 时需重新登记，不能把旧会话摘要绑定到新机器。

### SSH 配置和非交互限制

- 配置发现只提取具体 `Host` 名称，过滤通配符和否定模式，递归读取 `Include` 并限制深度、文件数和累计大小。`Host`/`Match` 条件内的内容也只是候选，不求值条件，不代表该别名此刻一定生效。
- 发现列表不运行 `ssh -G`，也不逐一探测主机。用户启用某条连接后，才由系统 OpenSSH 做该目标的有效配置预检；有效配置包含额外 `LocalForward`、`RemoteForward` 或 `DynamicForward` 时拒绝连接，需使用不含额外转发的别名。
- SSH 配置属于入口 Host 用户信任的配置。连接预检和建通可能执行其中的 `Match exec`、`ProxyCommand` 等命令；不要导入不可信 SSH 配置。应用禁止本次连接的 `LocalCommand`、`RemoteCommand`、agent/X11 转发和共享 ControlMaster，不因此把其余 SSH 配置当作安全沙箱。
- 首期采用非交互模式和严格主机指纹校验，不在应用内询问 SSH 密码、密钥口令或交互式 MFA，不自动接受未知主机指纹。密钥/agent 不可用、指纹变化时先在入口 Host 终端处理，再重试。Desktop 的 PATH 探测不会补导入 agent 环境；已运行 Host 使用其启动时可见的 agent。
- 隧道只把入口 Host 的临时 `127.0.0.1` 端口转发至远端 `127.0.0.1:<Host端口>`。临时端口不作为连接或会话身份，不提供任意端口转发。
- 若目标是 WSL，先确认 SSH 登录进入的是 WSL Linux 还是 Windows；Windows SSH 的 loopback 不保证指向 WSL Host。Tailscale 只改变可达网络，不代替 SSH、Host 认证或平台依赖。

实现见 [配置发现](../packages/host/src/ssh-config.ts)、[隧道进程](../packages/host/src/ssh-tunnels.ts)、[连接状态](../packages/host/src/ssh-connections.ts) 与 [SSH 契约](../packages/contracts/src/ssh-connections.ts)。

```mermaid
%%{init: {"theme": "dark"}}%%
flowchart TD
  UI[入口界面] --> Entry[入口 Node Host]
  Entry --> Config[SSH 配置与系统 agent]
  Entry --> Tunnel[受管 OpenSSH 隧道]
  Tunnel --> Remote[远端 loopback Host]
  Remote --> Auth[令牌 模式与 Host 身份校验]
  Auth --> Session[远端项目与会话 Worker]
```

### 本机管理资格

SSH 配置读取、保存、启停、重试和移除要求已认证且通过入口 Host 的本机来源检查；服务端强制检查，不以是否 Electron 判断。应用自身的远程代理不转发 SSH 管理请求，也不能用通用重试/移除方法绕过。

这里的“本机”是 loopback TCP 对端与 Host 地址边界，不是物理在场证明。用户主动用外部 SSH 将入口 Host 的 loopback 转发给自己，再携带有效认证访问，仍会被视为本机来源。`token-required` 只改变登录条件，不改变这个来源分类。这是可信单用户 Host 的管理入口限制，不提供多租户或同账号恶意进程隔离。

## 运行参数

| 环境变量                               | 作用范围                      | 用途与默认值                                                                                                                          |
| -------------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `PI_MEME_DATA_ROOT`                    | Host                          | 数据根目录，构建 App、构建后的 Server 和独立包默认 `~/.pi-meme`；Desktop 与 Server 开发入口默认 `~/.pi-meme-dev`                      |
| `PI_MEME_HOST`                         | 独立 Server                   | 监听地址，默认 `127.0.0.1`                                                                                                            |
| `PI_MEME_PORT`                         | Desktop、Server、Web 开发代理 | 构建 App、构建后的 Server 和独立包默认 `31415`；Desktop、Server 开发入口及 Web 开发代理默认 `31416`；`0` 用于隔离测试，不参与自动复用 |
| `PI_MEME_TOKEN`                        | 独立 Server                   | 登录令牌；未设置时读取 `credentials/auth.json`，首次生成（数据布局详见 [数据目录与存储](storage.md)）                                 |
| `PI_MEME_AUTH_MODE`                    | 独立 Server                   | 仅接受 `token-required`，关闭本机自动登录；未设置时沿用默认方式，SSH 目标必须显式启用此模式                                           |
| `PI_MEME_WEB_ROOT`                     | 独立 Server                   | 页面目录，默认应用相邻的 `apps/web/dist`                                                                                              |
| `PI_MEME_TLS_CERT` / `PI_MEME_TLS_KEY` | 独立 Server                   | HTTPS 证书与私钥文件路径，必须同时提供                                                                                                |
| `PI_MEME_HOST_URL`                     | 独立 Web 开发服务器           | `/api` 代理目标，优先于 `PI_MEME_PORT`；Forge Renderer 不使用此覆盖                                                                   |
| `PI_MEME_REMOTE_HOST`                  | Desktop                       | 启动时登记指定远程服务；登录令牌来自 `PI_MEME_TOKEN` 或已保存记录                                                                     |

Server 参数来自 [main.ts](../apps/server/src/main.ts)，开发默认值来自 [dev.ts](../apps/server/src/dev.ts)，开发代理来自 [Vite 配置](../apps/web/vite.config.ts)，Desktop 登记来自 [main.ts](../apps/desktop/src/main/main.ts)。测试凭据与 Worker 路径覆盖属于开发接线，不是日常部署所需参数。

## 在界面登记远程服务

进入“设置 → 系统 → 远程 → HTTPS”，点击“配置远程服务”，填写 HTTPS 地址与访问令牌。登记后在工作位置中选择远程项目；每个项目和会话使用所属 Host 的目录、配置与运行状态。入口见 [设置导航](../packages/app-ui/src/settings/settings-page.tsx) 与 [RemoteSettings](../packages/app-ui/src/shell/remote-settings.tsx)。

入口 Node Host 保存远程地址、Host 身份与令牌，分别维护各上游的内存 Cookie。Renderer 不保存远程令牌或 Cookie；HTTP、事件 WebSocket、控制接口和插件资源经已登记服务代理，页面保留本机 origin。代理不接受任意临时上游 URL、不跟随重定向、不修改远程 CORS。

```mermaid
%%{init: {"theme": "dark"}}%%
sequenceDiagram
  participant UI as 本机界面
  participant Local as 本机 Host
  participant Remote as 已登记远程 Host
  participant Worker as 远程 Worker
  UI->>Local: 登记地址与令牌
  Local->>Remote: 认证并核对 Host 身份
  Remote-->>Local: 认证 Cookie
  Local-->>UI: 服务身份与项目摘要
  UI->>Local: 指定服务和会话发起操作
  Local->>Remote: 转发已认证请求
  Remote->>Worker: 执行目标任务
  Worker-->>Remote: 带会话与代次的事件
  Remote-->>Local: 事件 WebSocket
  Local-->>UI: 更新所属服务快照
```

服务断线后保留 `cache/remote-services.json` 中的项目与会话摘要，可在远程页重试。移除服务只删除本机登记、凭据和摘要，不删除远程数据。Remote 目录选择查询远程 Host；上传读取当前电脑文件，插件目录安装则填写远程 Host 路径。实现见 [remote-services.ts](../packages/host/src/remote-services.ts)。

## 会话来源、暂停与移除

本地和远程继续共用“置顶 / 项目 / 最近”列表，不按 SSH 单独分组。HTTPS 和 SSH 远程项目使用文件夹地球角标，远程会话行使用地球标记；工作位置和搜索结果显示所属连接，避免同名项目混淆。远程项目详情显示连接名称、HTTPS/SSH、聊天数、状态和路径；可复制路径，不能直接在本机 Finder 打开远程目录。

连接断开后仍可显示项目/会话摘要以及当前页面已加载的内存内容，但没有任意会话 JSONL 正文的离线副本。断线后的计数和运行状态只是上次同步快照，不能据此确认任务当前是否仍在运行。

- 关闭 SSH 开关会暂停入口隧道和自动重连，保留登记、凭据、摘要及当前页面草稿；不切回本地、不停止远端 Host 或任务。暂停时发送、远程写入和打开其他远端会话需要先恢复连接。
- 网络中断可退避重连；SSH 指纹、认证、Host 身份和兼容问题进入“需要处理”，处理后再手动重试。恢复只补读状态，不重发消息。
- 移除删除入口保存的连接、令牌和摘要，不删除远端项目、会话，不停止任务。移除 SSH 前，界面检查未保存文件/指令/插件页、草稿附件、消息编辑及正在提交的操作，未处理时阻止移除。当前服务被移除后才切回本地。
- 新会话属于当前工作位置，断线不会自动改成本地。跨服务选择沿用确认流程，已保存在另一 Host 的文件附件不能直接随草稿跨服务发送。

SSH 配置位于 `config/ssh-connections.json`；令牌在凭据存储中使用 `ssh-host:<连接ID>`，摘要在 `cache/remote-services.json`。配置和凭据不是缓存，清缓存不会移除连接。详见 [存储](storage.md#ssh-连接资料与摘要)。

## 认证与连接恢复

认证入口是 `/api/auth`。Cookie 名按 Host 身份区分，避免同一 `127.0.0.1` 下不同端口的登录互相覆盖；Cookie 为 HttpOnly、SameSite=Strict，HTTPS 下带 Secure。HTTP 操作、WebSocket 和插件资源共用认证与来源检查，令牌不放在资源或事件 URL 中。

Desktop 创建的 Host 和未设置认证模式的独立 Server，只监听 loopback 时默认启用本机自动登录，即使设置了 `PI_MEME_TOKEN`，本机来源仍可免填令牌；来源地址、Host 与 Origin 必须满足本机检查。独立 Server 显式设置 `PI_MEME_AUTH_MODE=token-required` 后不再免登录。非 loopback 监听要求令牌。Vite 和正式 Desktop 的同源代理保留原始 Host、Origin 和 Cookie，不放宽 CORS，不跟随上游重定向。

Desktop 使用内存浏览器会话；正式界面由随包资源提供，不依赖已运行 Server 的 Web 构建。开发入口首次认证最多等待本机 Host 就绪 30 秒，超时返回 503 并提示启动 Host，不作为令牌错误处理。状态探测可以重试，业务写请求不会因网络失败自动重放。长期凭据的落盘、钥匙串导入与认证隔离见 [配置与安全](configuration.md#凭据)。

| WebSocket 升级失败                    | HTTP 状态 |
| ------------------------------------- | --------- |
| 来源无效                              | 403       |
| 未认证                                | 401       |
| 事件路径不存在                        | 404       |
| 已认证但 clientId 缺失或超过 128 字符 | 400       |

连接建立后，控制订阅参数无效以 1008 关闭，订阅或代理失败以 1011 关闭。具体顺序与断言见 [transport-app.ts](../packages/host/src/transport-app.ts) 和 [transport.integration.test.ts](../packages/host/tests/transport.integration.test.ts)。

短暂断线自动重连并补读快照，客户端缓冲快照读取期间的事件，过滤旧序号与代次；不重放 prompt。Host 重启使内存 Cookie 失效，本机客户端重新认证，代理用已保存令牌恢复上游认证。代理只对明确 401 的未执行请求续期并重试一次，保留原 requestId；网络失败不重发消息。

直接访问远程地址的浏览器使用该地址自己的登录页。已登记令牌失效时在远程页重新配置服务。正式 API 的幂等回执与事件补读有独立规则，见 [HostApi v2](host-api.md)。

## 排错与验证

| 现象                                      | 检查位置                                                                                           |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------- |
| 解压后提示原生模块或运行时不可用          | 核对下载平台、CPU 架构与 `release.json`；不要从源码目录单独复制 `dist` 或跨平台复用 `node_modules` |
| 启动提示已有 Host、目录不一致或协议不兼容 | 核对两个入口的目录和端口；停止旧版本 Host，或为独立实例指定另一目录和端口                          |
| `/api/auth` 返回 503 或代理连接被拒绝     | 确认管理方仍在运行、`PI_MEME_PORT` 与代理目标一致；首次启动等待最多 30 秒                          |
| 非本机监听被拒绝                          | 同时设置 TLS 证书与私钥，核对文件路径和读取权限                                                    |
| 5173 被占用                               | 停止占用进程后重启；Vite 的 `strictPort` 不会换端口                                                |
| WSL 内可访问、Windows 浏览器失败          | 先确认 WSL 服务，再检查 localhost 转发、端口和防火墙，不放宽认证                                   |
| 页面能打开，WebSocket 失败                | 查看升级 HTTP 状态、Origin、Cookie、clientId 及代理是否支持 WebSocket                              |
| 远程身份变化                              | 核对所连 Host 数据目录与持久 host-id，重新确认连接目标                                             |
| 受限任务无法启动                          | 查看 `restrictedAccessReason`；安装平台依赖后重启 Host，不切换权限绕过                             |
| SSH 提示旧 Host 或认证模式错误            | 升级远端 Host，由其管理方停止后以 `PI_MEME_AUTH_MODE=token-required` 重启                          |
| SSH 指纹或身份验证失败                    | 在入口 Host 的终端核实 `known_hosts`、密钥与 agent；应用不会弹出口令输入或自动接受指纹             |
| SSH 预检报告额外转发                      | 为该连接使用不含 `LocalForward`、`RemoteForward`、`DynamicForward` 的 SSH 别名                     |
| SSH 已建通但 Host 不可用                  | 核对 SSH 登录环境、远端 loopback 业务端口与 Host 进程；不是把 SSH 端口填进 Host 端口               |
| SSH 管理按钮不可用                        | 确认访问的是已认证的入口 Host 本机来源，并确认该 Host 的 PATH 能找到系统 OpenSSH                   |

`pnpm test --all --layer artifact --target server` 从实际构建产物启动临时 Host，使用内存凭据和假模型验证静态 Worker、JSONL、外部 Agent、MCP、codemode、持续子代理、计划与默认受限权限。平台运行与测试入口见 [开发与验证](development.md) 和 [Linux 与 WSL](linux-wsl.md)。这些是验证命令说明，不表示本次文档整理运行过应用验收。
