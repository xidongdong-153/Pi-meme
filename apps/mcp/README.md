# Pi meme MCP App

独立 MCP 服务，供 Rakazo 和其他 Bot 操作已有 Pi meme Host。它不启动 Host、不读取工作台的当前选择，也不直接写 Host 数据目录。

- **Streamable HTTP**：无状态 `POST /mcp`，独立 Bearer 认证，适合服务器和远程 Bot。
- **stdio**：供本机 MCP 客户端启动；stdout 只承载 MCP 协议，日志写 stderr。
- **多 Host**：连接服务所有者预先配置的本地或远程 Host，不接受工具调用提供临时 URL。

## 启动

需要 Node.js ≥22.19.0、pnpm 10.29.1，以及已经运行的 Pi meme Host。以下命令在仓库根目录执行：

```bash
pnpm install --frozen-lockfile

export PI_MEME_HOST_URL='http://127.0.0.1:3185'
export PI_MEME_HOST_TOKEN='替换为 Host 登录令牌'
export PI_MEME_MCP_TOKEN="$(node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))")"

pnpm start:mcp
```

默认监听 `http://127.0.0.1:4311/mcp`。源码开发 Host 的默认端口是 **3180**，正式 Host 是 **3185**，请按实际地址调整。MCP 和 Host 使用两个不同的令牌；MCP 令牌至少 32 字符，不放在 URL 或 Git 中。

上游按工具调用连接：即使 Host 暂时离线，MCP 仍可初始化和列出工具，业务调用返回连接错误。`GET /health` 是无鉴权的 MCP 进程探活，不检查上游 Host，也不证明工具可用。

## 配置与权限

不指定配置文件时，使用这些环境变量：

| 变量                                           | 默认值 / 用途                                         |
| ---------------------------------------------- | ----------------------------------------------------- |
| `PI_MEME_HOST_URL`                             | `http://127.0.0.1:3185`，上游 Host 根地址             |
| `PI_MEME_HOST_TOKEN`                           | 上游登录令牌，必填                                    |
| `PI_MEME_HOST_ID`                              | 可选的预期 Host 身份，阻止连到不同数据目录            |
| `PI_MEME_MCP_TOKEN`                            | HTTP MCP 独立访问令牌；stdio 不需要                   |
| `PI_MEME_MCP_TRANSPORT`                        | `http` 或 `stdio`，默认 `http`                        |
| `PI_MEME_MCP_HOST` / `PI_MEME_MCP_PORT`        | `127.0.0.1` / `4311`；显式 `0` 分配临时端口，空串拒绝 |
| `PI_MEME_MCP_PUBLIC_URL`                       | 部署后的公开 HTTPS MCP 地址，用于 Host/Origin 白名单  |
| `PI_MEME_MCP_ALLOW_WRITE`                      | 仅 `true` 开启写操作；未设置或 `false` 为只读         |
| `PI_MEME_MCP_ALLOW_PROJECT_REGISTRATION`       | 额外允许登记 Host 上的目录；仅 `true` 开启            |
| `PI_MEME_MCP_TLS_CERT` / `PI_MEME_MCP_TLS_KEY` | 直接 HTTPS 监听的证书和私钥路径，必须同时设置         |
| `PI_MEME_MCP_CONFIG`                           | JSON 配置文件路径，与 `--config` 等价                 |

`0`、`1`、`YES` 等值不会被当成布尔开关，启动时明确报错。指定 JSON 配置后，配置里的行为与 Host 列表取代上述快捷设置；令牌仍从 `tokenEnv` 指定的环境变量读取。

复制 [config.example.json](config.example.json)，或使用多 Host 配置：

```json
{
  "transport": "http",
  "hostname": "127.0.0.1",
  "port": 4311,
  "tokenEnv": "PI_MEME_MCP_TOKEN",
  "clientId": "pi-meme-mcp",
  "requestTimeoutMs": 30000,
  "hosts": [
    {
      "name": "local",
      "url": "http://127.0.0.1:3185",
      "tokenEnv": "LOCAL_HOST_TOKEN",
      "allowWrites": true,
      "projectIds": ["替换为已有项目的 projectId"],
      "allowStandaloneSessions": false
    },
    {
      "name": "server",
      "url": "https://host.your-domain.com",
      "tokenEnv": "SERVER_HOST_TOKEN",
      "allowWrites": false
    }
  ]
}
```

```bash
pnpm start:mcp --config /absolute/path/config.json
```

先用只读连接调用 `pi_meme_projects_list` 取得真实项目 ID，再填写 `projectIds`。多 Host 时每次工具调用必须传 `host: "local"` 或 `host: "server"`；`Ref.hostId` 必须匹配该 Host 的真实身份。

权限边界：

- `allowWrites` 默认 `false`。所有 Host 都只读时不注册写工具；混合权限时，调用仍会逐 Host 校验，不能借另一个可写 Host 绕过。
- **`allowWrites=true` 包含 Agent 执行授权，不只是修改会话名称**：客户端可以配置会话并提交模型任务，可能运行命令、调用网络服务或产生费用。仅向可信应用发放令牌。
- `allowProjectRegistration` 默认 `false`，不随 `allowWrites` 自动开启。需要同时开启两者才有 `pi_meme_projects_create`；它可将 Host 上任意已有目录登记为项目，进而暴露整个目录树。更安全的方式是所有者先在 Pi meme 登记项目。此开关不能与 `projectIds` 限定同时开启。
- `projectIds` 限制 MCP 直接操作的项目、所属会话、文件、定时任务和回执；省略时可访问该 Host 全部正式项目。设置时默认禁止独立聊天，可用 `allowStandaloneSessions` 显式改变。
- `projectIds` **不是多租户隔离或 Agent 文件系统沙箱**。启动 Agent 后，其真实工具权限由 Host 的 `accessMode`、任务模式和平台隔离决定；不要用它向不可信 Bot 承诺文件机密隔离。
- 模型配置凭据、任意内部 RPC、直接终端执行、插件管理和图片模型配置不在此 MCP 工具面中。文件正文和任务输出仍可能包含用户自己的敏感内容。

## 工具与任务流程

工具名使用 `pi_meme_` 前缀；具体参数、输入限制和是否写入由 `tools/list` 返回的 schema 与 annotations 声明。

| 工具组                                   | 能力                                                        |
| ---------------------------------------- | ----------------------------------------------------------- |
| `hosts` / `capabilities` / `models_list` | Host 名称、真实身份、授权范围和模型目录                     |
| `projects_*`                             | 列表、详情、登记、命名、置顶、删除预览及删除                |
| `sessions_*`                             | 聊天创建、配置、命名、置顶、删除、状态、消息、提交及回执    |
| `files_*` / `git_*`                      | 工作目录内文本与 Git 只读；可写时保存带 revision 的现有文本 |
| `schedules_*`                            | 定时任务配置、暂停/恢复、运行、停止及记录                   |
| `goals_*`                                | 持续目标的读取、启动、编辑和控制                            |
| `agents_*` / `activities_*`              | 子 Agent 与受管服务读取、日志和停止                         |
| `plans_list` / `interaction_respond`     | 保存的计划和真实待回答交互                                  |

让其他 Bot 创建开发任务的路径：

1. 调用 `pi_meme_hosts`、`pi_meme_capabilities` 和 `pi_meme_projects_list`。
2. 取项目返回的 `{ hostId, projectId }`，调用 `pi_meme_sessions_create`，保存返回的 `{ hostId, sessionId }`。新建聊天不调用模型，也不切换工作台界面。
3. 必要时调用 `pi_meme_sessions_configure`。运行中拒绝配置变更；真实权限/任务模式变化要与模型、思考强度及插件选择变更分开提交。
4. 调用 `pi_meme_sessions_submit`，显式提供 `delivery`、正文和稳定 `idempotencyKey`。
5. 保存 `operationId`，用 `pi_meme_sessions_receipt` 查询执行状态，再用 `pi_meme_sessions_messages` 读取真实输出。`accepted`、`queued`、`running` 都不代表成功。

`delivery=start` 仅在空闲时启动；`queue` 入队；`steer` 给运行中的任务插话。持续目标另用 `goals_get` 判断目标是否完成，单次提交回执完成不等于持续目标完成。

每个写操作都要求调用方提供 1–128 字符的稳定幂等键。网络结果不确定时保留原键，不自动重放，不为同一个外部事件生成新键；同键不同内容由 Host 拒绝。Host 的幂等记录不等于任意工具副作用恰好执行一次。

配置是启动快照，调整后需重启 MCP。上游去重命名空间由 `clientId`、Host 名称、规范化的 `projectIds` 和独立聊天权限共同确定：相同范围重启可重放已经删除对象的操作结果，范围收紧或更换客户端/Host 名称后不能读取旧范围的删除记录。范围变化后不要把结果不确定的旧请求当成新操作自动发送。

项目删除必须先读取预览并携带 `revision` 与 `confirm=true`；会话删除同样要求显式确认。清理结果里的 `errors` / `warnings` 不能忽略。文件保存要求 `files_read` 返回的 revision，Host 拒绝外部修改、越界路径和越界符号链接；文本上限 1 MiB，MCP HTTP 请求体和单个工具结果上限 2 MiB。消息使用原生 `entryId` 与分支绑定 cursor；`stale-cursor` 时重读，不拼接不同分支。

## Rakazo

Rakazo 的[插件文档](https://rakazo.com/docs/build-a-plugin/)要求：**公开 HTTPS MCP 服务 + 公开 GitHub 仓库内的 `plugin.json` 与 `mcp.json`**。它不会执行仓库内的服务代码，不支持本地 stdio、localhost 或私网 MCP 插件入口。

### 部署服务

```bash
pnpm build:mcp
```

`apps/mcp/dist/` 包含服务、插件配置生成 CLI、独立运行清单与配置示例。部署时复制**整个 dist 目录**到服务器，无需复制 Host 或整个仓库；在部署目录执行：

```bash
pnpm install --prod

export PI_MEME_HOST_URL='http://127.0.0.1:3185'
export PI_MEME_HOST_TOKEN='替换为 Host 登录令牌'
export PI_MEME_MCP_TOKEN='替换为独立随机 MCP 令牌'
export PI_MEME_MCP_PUBLIC_URL='https://mcp.your-domain.com/mcp'

node main.js
```

Host 可与 MCP 同机，也可远程连接：远程 Host 根地址要求 HTTPS，无账号信息、查询参数或路径前缀。本机回环 Host 可以 HTTP。Host 的运行和认证见仓库 [Remote 文档](../../docs/remote.md)。

推荐保持 MCP 仅监听 `127.0.0.1:4311`，由 Caddy/Nginx 提供公网 HTTPS。Caddy 示例（替换成自己的域名，并配置 DNS）：

```caddyfile
mcp.your-domain.com {
  reverse_proxy 127.0.0.1:4311
}
```

设置 `publicUrl` 或 `PI_MEME_MCP_PUBLIC_URL`，否则转发公网 Host 请求头会被拒绝。MCP 不信任 `X-Forwarded-*` 来放宽认证；不要向公网开放未加密的后端 HTTP 端口。非回环直接监听必须同时配置 `tlsCertEnv` / `tlsKeyEnv`，或使用对应 TLS 环境变量。

### 生成与安装连接器

完成 HTTPS 部署后，在仓库根目录执行（网址必须替换为实际公网端点）：

```bash
pnpm mcp:plugin --url 'https://mcp.your-domain.com/mcp' --out out/mcp-plugin
```

部署目录也可执行 `node plugin-manifest.js --url ... --out ...`。输出目录必须不存在，命令不会覆盖已有文件。生成内容：

```text
out/mcp-plugin/
├── plugin.json
├── mcp.json
└── README.md
```

两个 JSON 使用 Agent Plugins **1.1.0** schema；服务器类型是 `streamable-http`。生成器拒绝账号信息、查询参数、回环/私网 IP 和本地/示例域名，但不执行 DNS 可达性或服务登录检查。**生成不等于部署或安装成功。**

1. 将生成目录发布到公开 GitHub 仓库。仓库内不放 Host/MCP 令牌、Authorization 头或 `${VAR}` 占位符。
2. Rakazo → **Integrations → + → From GitHub → Preview → Connect**，填写仓库或该目录的 GitHub URL。
3. **Manage MCP servers → 编辑 Pi meme → Advanced → Access token**，填入 **MCP 令牌**，不是 Host 登录令牌。
4. 选中 Bot，点击 **Use in this bot**，让它实际调用 `pi_meme_hosts`、`pi_meme_capabilities` 和 `pi_meme_projects_list`，再尝试已授权的任务路径。

此服务使用 Bearer token，不实现 OAuth。插件文件不声明密钥表单、不展开 `${VAR}`。后续文件更新不自动更新 Rakazo 安装，现有安装固定在提交，需要重新预览/安装。

## 其他 MCP 客户端

HTTP 客户端连接 `/mcp`，设置 `Authorization: Bearer <MCP令牌>`。服务使用官方无状态 Streamable HTTP，不设置 MCP session ID、不提供独立 GET SSE 通道；`GET` / `DELETE /mcp` 返回 405。重启 MCP 不重启 Host，不自动重放任务。

如客户端直接从浏览器访问，需在 `allowedOrigins` 中显式列出其 HTTP(S) origin。未提供 Origin 的服务器端客户端仍需 Bearer 认证；`Origin: null` 和未授权来源被拒绝。

本机 stdio 示例：

```json
{
  "mcpServers": {
    "pi-meme": {
      "command": "node",
      "args": ["/absolute/path/pi-meme/apps/mcp/dist/main.js", "--transport", "stdio"],
      "env": {
        "PI_MEME_HOST_URL": "http://127.0.0.1:3185",
        "PI_MEME_HOST_TOKEN": "仅填在客户端私有配置里，不提交到 Git"
      }
    }
  }
}
```

使用源码时，可将 args 换成 `['--import', 'tsx', '/absolute/path/pi-meme/apps/mcp/src/main.ts', '--transport', 'stdio']`，并将 cwd 设为仓库根目录。不要通过会向 stdout 输出脚本标题的 `pnpm start:mcp` 启动 stdio 客户端。

## 源码入口

- [config.ts](src/config.ts)：JSON/环境变量、上游 URL、令牌引用、权限和 TLS。
- [hosts.ts](src/hosts.ts)：Node Host 客户端、稳定身份、项目/会话范围与错误投影。
- [tools.ts](src/tools.ts)：显式类型化 MCP 工具，不提供任意 RPC 转发。
- [http-server.ts](src/http-server.ts)：Bearer、Host/Origin 校验、无状态传输与清理。
- [main.ts](src/main.ts)：HTTP/stdio CLI 与退出。
- [plugin-manifest.ts](src/plugin-manifest.ts)：无凭据 Rakazo 连接器生成。

HostApi 契约见仓库 [HostApi v2](../../docs/host-api.md)。本目录不是 Pi meme 自身的 `.pim` App 插件，不依赖工作台安装或 UI 集成。
