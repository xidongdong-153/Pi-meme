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

使用普通用户启动。浏览器访问证书对应的 HTTPS 地址，或在 Desktop 的远程设置中登记地址与令牌。不自动注册 systemd 或 launchd，也不放宽认证供反向代理使用。

## 数据与升级

数据默认位于 `~/.pi-meme`，不写入安装目录。同一目录只允许一个 Host 写入；Desktop 与 Host 的数据目录和端口相同时可能复用已有实例。

升级前先停止旧 Host 的管理方，备份数据目录，再解压新版并使用原来的 `PI_MEME_DATA_ROOT` 启动。不要将备份中的模型凭据或令牌上传到 GitHub。数据格式变化后不承诺可直接降级。

用户配置的 MCP、Python 等外部工具仍需自行安装依赖。包内 Node 会进入 Host 子进程的 PATH，但不提供 npm、pnpm 或其他开发工具。

项目下载与文档：[GitHub Releases](https://github.com/xidongdong-153/Pi-meme/releases)、[快速开始](https://github.com/xidongdong-153/Pi-meme/blob/main/docs/getting-started.md)、[Remote](https://github.com/xidongdong-153/Pi-meme/blob/main/docs/remote.md)。

许可证见 `LICENSE`、`THIRD_PARTY_NOTICES.md`、`THIRD_PARTY_LICENSES.txt` 和 `runtime/LICENSE`。
