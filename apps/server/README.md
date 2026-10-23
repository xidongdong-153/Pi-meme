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

### SSH 自动连接

先在入口 Host 的终端确认 `ssh <别名或user@host>` 已能非交互登录，核实 `known_hosts` 并解锁 agent 密钥。进入入口 Host 的已认证本机界面“设置 → 系统 → 远程”，默认显示 SSH：

1. 点击“添加”，从 `~/.ssh/config` 勾选具体别名；也可手动填写主机、可选名称和 SSH 端口。
2. 默认沿用 SSH 配置和 agent；需要时指定入口 Host 上的身份文件路径，不上传私钥。
3. 添加后先通过 Python 3 只读探测已有 Host，找到后直接建立隧道并认证。只有明确未发现时，才下载匹配发行版本的完整 Host 包，校验后经 SSH 传输并后台启动；不填写业务端口或 Host 令牌。
4. 已连接后选择远程项目。新环境的模型设置在远端完成，不自动复制本机凭据。

远端需可运行 Python 3，探测脚本从 SSH 标准输入执行，不写远端文件。先检查 `~/.local/state/pi-meme/ssh-host` 的运行描述端口，再检查默认 `127.0.0.1:31415`；不扫描其他端口、进程、NVM 或 systemd。自定义端口没有运行描述时不能自动发现。

已有 Host 的运行协议、身份和真实数据目录必须匹配远端 `~/.pi-meme`。入口从该目录 `credentials/auth.json` 的 `host:token` 读取令牌，建立隧道后校验 `token-required`、`sshTunnelAuthV1` 与 Host 身份。复用不要求发行版本同号，不区分 systemd、源码或独立包启动；不检查 Node、Git、bash、tar 或 bubblewrap，不下载包，不调用 `ssh-bootstrap`，也不停止或重启服务。

Python 3 缺失、运行描述损坏、权限或身份错误、认证失败均明确报错，不转安装。未找到端点但 `~/.pi-meme/host.lock` 目录 mtime 距当前不超过 30 秒时，也会报错保护正在启动的 Host，不删除锁。

只有明确未发现已有 Host 才走自动安装：远端需要 Git、bash、tar，Linux 还需要实际可用的 bubblewrap，不需要预装 Node。应用不使用 sudo 安装系统依赖。安装位于 `~/.local/share/pi-meme/host/<版本>/<平台>`，数据固定在 `~/.pi-meme`；运行信息位于 `~/.local/state/pi-meme/ssh-host`。

新建 Host 的业务端口自动分配、只监听 loopback，强制令牌认证，不需要 TLS 证书。令牌不返回界面。安装只使用当前版本发行包，没有匹配资源时明确失败，不回退其他版本；没有发行版本的源码入口仍可连接符合条件的已有 Host。

发现列表只读取 SSH 候选；添加后才预检并连接。配置中的额外端口转发会被拒绝。`Match exec`、`ProxyCommand` 等属于用户信任的 SSH 命令，不能使用不可信配置。不在应用内收集 SSH 密码、密钥口令或 MFA，不自动接受未知指纹。普通远程网络页面不能管理 SSH。

暂停、断线、入口退出或移除连接不停止远端 Host 和任务。已有 systemd 服务继续由原 systemd 管理。应用新建的 Host 在机器重启后的下次连接时自动启动，不注册系统服务或保证开机在线；复用的服务遵循原管理方的启动规则。不自动同步项目目录。上述说明对应源码，不表示已完成真实 SSH、WSL 或发行包联通验收。

## 数据与升级

数据默认位于 `~/.pi-meme`，不写入安装目录。入口 SSH 连接资料保存在 `config/ssh-connections.json`，Host 令牌在 `credentials/auth.json` 的 `ssh-host:<连接ID>` 键中；凭据文件权限为 `0600`，不代表加密。`cache/remote-services.json` 只是可重建摘要，清缓存不移除连接。SSH 私钥不复制到数据目录。同一目录只允许一个 Host 写入；Desktop 与 Host 的数据目录和端口相同时可能复用已有实例。

升级前先停止旧 Host 的管理方，备份数据目录，再解压新版并使用原来的 `PI_MEME_DATA_ROOT` 启动。不要将备份中的模型凭据或令牌上传到 GitHub。数据格式变化后不承诺可直接降级。

用户配置的 MCP、Python 等外部工具仍需自行安装依赖。包内 Node 会进入 Host 子进程的 PATH，但不提供 npm、pnpm 或其他开发工具。

项目下载与文档：[GitHub Releases](https://github.com/xidongdong-153/Pi-meme/releases)、[快速开始](https://github.com/xidongdong-153/Pi-meme/blob/main/docs/getting-started.md)、[Remote](https://github.com/xidongdong-153/Pi-meme/blob/main/docs/remote.md)。

许可证见 `LICENSE`、`THIRD_PARTY_NOTICES.md`、`THIRD_PARTY_LICENSES.txt` 和 `runtime/LICENSE`。
