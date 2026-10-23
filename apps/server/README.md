# pi-meme Host

本目录包含 Host、Web、会话 Worker、内置技能、生产依赖和 Node.js 24.14.0。不需要安装 Node.js、pnpm 或 Pi CLI。版本与构建 commit 见 `release.json`。

## 启动

需要 Git、bash；Linux 还需要 `/usr/bin/bwrap`。Ubuntu 24.04 可执行：

```bash
sudo apt-get update
sudo apt-get install -y git bash bubblewrap
```

在解压后的 `pi-meme-host` 目录执行：

```bash
./bin/pi-meme-host
```

浏览器访问 `http://127.0.0.1:31415`，本机自动登录。在设置中配置模型后开始使用。Ctrl+C 或 SIGTERM 正常停止 Host。

下载包的验收基线是 macOS 15 arm64、Ubuntu 24.04 x64。其他版本或发行版未作为首发验收平台；不支持 Intel Mac、Linux arm64、Alpine/musl 或 Windows 原生运行。Linux 受限权限依赖实际可用的 bubblewrap；系统策略禁止 user namespace 时会报告不可用，不会静默切换完全权限。

macOS 下载包未做 Apple 公证。仅在确认来自项目 Release 且 SHA256 校验一致后，才允许打开具体下载内容；不要关闭系统 Gatekeeper。完整安装步骤见项目的快速开始文档。

## 远程部署

### HTTPS 直连

默认仅监听 loopback。远程监听必须同时提供 HTTPS 证书、私钥及登录令牌，以下路径和令牌需替换：

```bash
PI_MEME_HOST=0.0.0.0 \
PI_MEME_PORT=31415 \
PI_MEME_DATA_ROOT=/absolute/path/pi-meme-data \
PI_MEME_TLS_CERT=/absolute/path/fullchain.pem \
PI_MEME_TLS_KEY=/absolute/path/private-key.pem \
PI_MEME_TOKEN=replace-with-your-access-token \
./bin/pi-meme-host
```

使用普通用户启动。浏览器访问证书对应的 HTTPS 地址，或在“设置 → 系统 → 远程 → HTTPS”登记地址与令牌。不自动注册 systemd 或 launchd，也不放宽认证供反向代理使用。

### SSH 隧道连接

SSH 目标必须预装并运行支持 SSH 通道认证的 Host，同时允许 SSH 登录。应用只管理入口 Host 的系统 OpenSSH 隧道，不自动安装、启动、升级或停止远端 Host，不同步项目文件。以下命令在远端解压后的 `pi-meme-host` 目录执行：

```bash
PI_MEME_HOST=127.0.0.1 \
PI_MEME_PORT=31415 \
PI_MEME_DATA_ROOT=/absolute/path/pi-meme-data \
PI_MEME_AUTH_MODE=token-required \
PI_MEME_TOKEN=replace-with-your-access-token \
./bin/pi-meme-host
```

远端只开放 SSH，业务 HTTP 端口留在 loopback，不需要为此配置 TLS。`PI_MEME_AUTH_MODE` 仅接受 `token-required`；未设置时保留默认本机免登录。单独设置 `PI_MEME_TOKEN` 不会关闭免登录，SSH 连接会检查实际认证模式并拒绝不兼容实例。已有 Host 需先由其管理方停止，不能向运行中实例补加新模式。

在入口 Host 的终端先确认 `ssh <别名或user@host>` 可用，核实 `known_hosts` 并解锁所需 agent 密钥。再从入口 Host 的已认证本机界面进入“设置 → 系统 → 远程 → SSH”：

1. 点击“添加”，从 `~/.ssh/config` 勾选具体别名，或点“手动添加”填写名称、主机、可选 SSH 端口。
2. 使用 SSH 配置/agent，或指定入口 Host 上的身份文件绝对路径或 `~/` 路径；不上传私钥。
3. 在“远端 Host”填写业务端口和上面的 Host 令牌。保存不会连接，打开开关后才建立通道。

配置发现只读取 `Host`/`Include` 候选，不求值 `Match`；启用时系统 OpenSSH 才预检目标配置，额外端口转发会被拒绝。SSH 配置中的 `Match exec`、`ProxyCommand` 等属于用户信任的命令，不能使用不可信配置。首期非交互，不在应用内收集 SSH 密码、密钥口令或 MFA，不自动接受未知指纹。

管理 SSH 要求入口 Host 的已认证本机来源；普通远程网络页面不能管理。外部 SSH 转发到入口 loopback 后仍可能被视为本机，这不是物理在场或多用户隔离。完整限制与排错见项目 Remote 文档。

关闭开关只暂停入口隧道和自动重连，不停止远端任务；移除只删除入口登记、令牌和摘要，不删除远端项目或会话。以上 SSH 说明对应当前源码，不表示已完成真实主机或发布包联通验收。

## 数据与升级

数据默认位于 `~/.pi-meme`，不写入安装目录。入口 SSH 连接资料保存在 `config/ssh-connections.json`，Host 令牌在 `credentials/auth.json` 的 `ssh-host:<连接ID>` 键中；凭据文件权限为 `0600`，不代表加密。`cache/remote-services.json` 只是可重建摘要，清缓存不移除连接。SSH 私钥不复制到数据目录。同一目录只允许一个 Host 写入；Desktop 与 Host 的数据目录和端口相同时可能复用已有实例。

升级前先停止旧 Host 的管理方，备份数据目录，再解压新版并使用原来的 `PI_MEME_DATA_ROOT` 启动。不要将备份中的模型凭据或令牌上传到 GitHub。数据格式变化后不承诺可直接降级。

用户配置的 MCP、Python 等外部工具仍需自行安装依赖。包内 Node 会进入 Host 子进程的 PATH，但不提供 npm、pnpm 或其他开发工具。

项目下载与文档：[GitHub Releases](https://github.com/xidongdong-153/Pi-meme/releases)、[快速开始](https://github.com/xidongdong-153/Pi-meme/blob/main/docs/getting-started.md)、[Remote](https://github.com/xidongdong-153/Pi-meme/blob/main/docs/remote.md)。

许可证见 `LICENSE`、`THIRD_PARTY_NOTICES.md`、`THIRD_PARTY_LICENSES.txt` 和 `runtime/LICENSE`。
