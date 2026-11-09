---
description: '独立 Bots 应用的启动部署、独立存储、角色对话、QQ、多 Host 与认证 API'
status: implemented
paths:
  - 'apps/bot/**'
  - 'package.json'
  - 'packages/ui/src/components/ui/**'
---

# 独立 Bots

Bots 位于 [apps/bot](../apps/bot/README.md)，是独立部署的个人助理服务与 Web，内核为 Pi Durable。配置和日常对话不依赖 Pi meme 工作台。主界面参考 `~/Code/DS-Bot`，仅保留左侧 Bot/群组列表与右侧聊天；每个 Bot 对应一条固定 Web 私聊，可创建 Bot 和群组，不提供独立会话管理。左下头像打开气泡菜单，选择设置进入弹窗。任务协作、计划、资料、记忆和连接仍由同一服务提供，认证 API 与 QQ 官方机器人 C2C 私聊保持独立入口。该决定覆盖旧活动轨与多会话方案，参考依据见[现行设计](temp/bots/design.md)。

本页描述当前源码与配置，**不代表所有外部链路已验收**。真实模型聊天、图片生成与账单、QQ 收发与主动消息权限、两台 Host 的委派及远程服务器部署，需要在对应账号和环境中核实。没有供应商凭据时不会得到实际聊天或图片；公开网页读取也不具备登录浏览器能力。最初确认的需求与设计保留在 [Bots 方案入口](temp/bots/README.md)，原方案不是当前功能的验收记录。

## 启动与部署

要求 Node.js **24.14.0 或更高版本**、pnpm **10.29.1**。从仓库根目录运行：

```bash
pnpm install --frozen-lockfile
pnpm build:bot
pnpm serve:bot
```

默认打开 `http://127.0.0.1:4310`。构建生成 `apps/bot/dist/web` 和 `apps/bot/dist/server`，Node 服务提供同源静态页面和 API。当前部署方式保留仓库工作区、依赖和两个构建目录；没有新增 Bots 独立下载包或官方容器镜像。

开发时，在一个终端运行 `pnpm start:bot` 启动源码服务，在另一个终端运行 `pnpm dev:bot`，打开 `http://127.0.0.1:4311`。Vite 将 `/api` 代理至源码服务。`start:bot` 不监视服务端源码变化，修改服务端后需要重启；dev 模式仍在 4310 提供上一次构建的 Web，修改 UI 后应使用 4311 热更新或重新构建再刷新 4310。开发和构建后的服务使用同一用户的 Bots 数据目录，不能同时启动两个写入进程。

| 命令             | 配置中的用途              |
| ---------------- | ------------------------- |
| `pnpm start:bot` | 通过 tsx 运行独立服务源码 |
| `pnpm dev:bot`   | 启动 Vite Web 开发入口    |
| `pnpm build:bot` | 构建 Web 与 Node 服务     |
| `pnpm serve:bot` | 运行构建后的 Node 服务    |

| 环境变量                          | 默认值                  | 含义与约束                                                                       |
| --------------------------------- | ----------------------- | -------------------------------------------------------------------------------- |
| `PI_BOT_HOST`                     | `127.0.0.1`             | 服务监听地址；非回环监听必须配置 HTTPS 的公开 Origin                             |
| `PI_BOT_PORT`                     | `4310`                  | 服务端口，整数 `1–65535`                                                         |
| `PI_BOT_ORIGIN`                   | 未设置                  | 公开页面 Origin，例如 `https://bots.example.com`；不带路径、查询、片段或账号信息 |
| `PI_BOT_SCHEDULE_MAX_LATENESS_MS` | `60000`                 | 运行期间触发允许延迟，整数 `0–300000`；超过后记录跳过并推进                      |
| `BOTS_API_URL`                    | `http://127.0.0.1:4310` | 仅供 Vite 开发代理选择 API 地址；修改服务端口时同步设置                          |

服务器部署由反向代理提供 HTTPS。Node 仍可监听本机回环，例如在类 Unix shell 中执行：

```bash
PI_BOT_ORIGIN=https://bots.example.com pnpm serve:bot
```

反向代理将该域名转发到 `127.0.0.1:4310`，保留原始 Host，允许长连接并关闭 SSE 响应缓冲。服务本身不生成 TLS 证书。若部署容器，持久卷挂载到容器内运行用户主目录的 `.pi-meme-bot`，而非项目目录；不要让两个副本共享写入同一目录。首次公开访问前完成 owner 密码设置。

健康入口 `GET /api/health` 返回 `{ready, application:"pi-meme-bot"}`。`ready:false` 返回 503；端口开放、进程存在或健康检查成功均不表示供应商、QQ 或 Host 工作已完成。

## 数据与恢复

根目录由 Node 的 `os.homedir()` 解析，固定为运行服务用户的 `~/.pi-meme-bot/`。更换启动目录、浏览器或工作台项目不会改变它。Bots 不读取工作台 `~/.pi-meme`、开发 Host 或 Pi CLI 的模型配置和会话。

| 位置                                   | 内容                                                         |
| -------------------------------------- | ------------------------------------------------------------ |
| `state/bots.sqlite` 及 SQLite 伴随文件 | durable 业务状态、角色配置、消息、任务、计划、投递与操作回执 |
| `credentials/`                         | 模型、Host、QQ 等写入后不回显的凭据                          |
| `attachments/`                         | 上传文件、生图与取得的 Host 产物对象                         |
| `config/`、`resources/`                | Bots 独立配置与资源的目录边界                                |
| `logs/`、`cache/`、`runtime/`          | 运行资料和可重建内容的目录边界                               |

目录使用 `0700`、凭据和数据库等文件使用 `0600` 权限；这属于文件权限保护，不是加密存储。单 owner 进程锁保存在根目录内的 `runtime/owner.lock`，符号链接目录和数据库会被拒绝。浏览器草稿和布局偏好属于客户端状态，不代替服务端消息及任务记录。

备份与恢复按以下顺序进行：

1. 停止 Bots 服务并等待退出，保证没有第二个写入者。
2. 复制**整个 `~/.pi-meme-bot/`**，包含配置、凭据、数据库、SQLite 伴随文件与附件，并保护备份的读取权限。
3. 恢复时同样保持服务停止，将完整快照恢复到目标服务用户的同一路径，恢复该用户的所有权及文件权限。
4. 不携带旧进程的运行锁。确认旧进程确已结束后再由新服务取得所有权；不要通过删锁让两个进程并行运行。
5. 使用兼容版本启动，检查角色、历史、任务、附件与外部回执。schema 版本不兼容时服务拒绝启动，不静默清空数据。

Bot 业务状态与模型上下文由同一个 durable SQLite 保存，二进制附件与凭据在同一根目录分区管理。`@earendil-works/pi-durable`、`pi-ai`、`pi-schema`、`chord` 固定为 `1.5.0`；durable 上游声明实验性，升级前核对任务、文档版本与恢复行为。它不会恢复另一台 Host 的 Pi 工具循环，也不能消除 QQ 或图片接口的外部结果不确定性。

## 配置与日常入口

首次进入设置至少 12 个字符的访问密码。添加独立文本模型，再创建 Bot；角色包含名称、头像、指令、文本模型、工具预算、可协作角色、可用 Host 及明确能力授权。文本模型适配 OpenAI Responses、OpenAI 兼容 Chat Completions、Anthropic 和 Google；这些接口是否能使用指定模型，需实际供应商确认。文本用量可以记录输入/输出 token；缺少权威计价时费用为 `null`，底层模型目录的占位零价格不表示免费。图片模型只使用 OpenAI 或兼容图片 API，不承诺图片编辑。保存配置、角色或会话不会调用模型。

每个 Bot 只有一条固定 Web 私聊，由 `Bot.webConversationId` 指向；创建 Bot 或复制角色配置时同事务建立私聊，点击 Bot 直接打开该记录。群聊有 2–16 个 Bot 和一名协调者。未点名由协调者处理，明确选择接收角色时按所选成员派发。角色上下文按会话隔离；当前每项任务使用独立 durable runtime，并从获准的最近 60 条公开消息及显式记忆构造上下文，QQ 进一步只取该角色参与的消息。历史仍持久保存，但更早内容不会自动全部注入，也尚未实现应用级长期摘要。公开消息保留发言身份、稳定来源消息与任务引用。当前最多并行执行 4 个外部根任务，包含子协作的总并发硬上限为 12；协作深度上限 3、每个父任务最多 8 个直接子协作、整棵任务树最多 32 项，超过预算会返回明确错误。新增群成员不自动获得加入前的全部历史。停止关联任务会记录实际状态；已经发生的外部费用、文件改动和渠道发送不会被撤销。

服务启动为旧 Bot 补齐固定私聊关联：已有有效固定 ID 保持不变，否则优先复用未归档且最近更新的旧 direct，没有才创建；归档的选定记录会恢复可用。其他旧 direct 及其消息、附件、任务、计划引用完整保留，不自动合并到固定私聊，不迁移旧计划目标；仍可通过现有 API 读取，但新主列表不继续提供多会话管理。QQ 保留单独渠道会话，不与固定 Web 私聊合并。固定私聊不可独立归档、删除或更换 Bot；删除 Bot 时保留并归档其 direct 历史，活动任务、群协调者、QQ 默认角色和启用计划的依赖仍须先处理。

“资料”提供附件预览、授权下载与复用到草稿。附件上限 **20 MiB**，总 HTTP 请求体上限 **22 MiB**。上传只接收文件内容，不接收服务端路径。跨会话复用会复制为目标会话的独立附件引用；选择或预览附件不会自动发送消息。

记忆由用户显式维护，分为 owner、Bot 和会话范围，可记录来源消息。Host 自身记忆仍归 Host，不通过 Bots 直接修改远端存储。

### 定时安排

计划选择已有来源会话、该会话的执行 Bot、内容、时区与通知渠道。执行 Bot 必须启用并获得 `schedules` 授权。支持 `once`、`daily`、`weekly`，工作日可使用每周 `[1,2,3,4,5]`。保存前可预览后续 UTC 执行时刻；单次 `at` 必须包含明确时区，周期按 IANA 时区的本地日历计算。模型的 `create_schedule` 工具同样校验当前任务与会话授权、有效日期和未来时刻，继承来源任务的通知渠道，并对同一任务的相同安排去重；计划总数上限为 500。

夏令时缺失时刻跳过，重复时刻取第一次。服务停机期间错过的安排记录为 `skipped`，不补跑；运行期间超过允许延迟同样跳过。服务必须运行，不会唤醒关机或休眠设备。同计划最多一个活跃运行，会话忙碌时不积队。手动立即运行使用独立运行记录，不改变周期。

暂停只影响未来触发；停止本次运行操作实际关联任务。运行中的计划不能直接删除，需要先处理本次运行。已有任务与运行结果不会随删除规则一起消失。QQ 通知要求当前已绑定的 QQ 来源会话；Web 中仍能查看结果，投递失败不等于执行失败。

### 图片与公开网页

图片请求先保存生成意图，再调用供应商；返回的 PNG、JPEG 或 WebP 内容经大小和 MIME 检查后进入附件库。费用缺少权威账单时保持 `null`。请求已发出但结果、下载或保存未确认时标 `unknown`，不自动重试、不自动换模型；同一任务有未确认的生图时，工具层禁止继续生成。

用户核对原供应商结果和账单后，可以明确创建新尝试。API 需 `previousGenerationId` 与 `confirmUnknown:true`，并使用新幂等键；原生成记录保留，重复费用风险不会被改写为零。

公开网页探索需要全局启用联网和 Bot 的 `web` 授权。它只读取公开 HTTP(S) 内容，返回实际最终来源；没有搜索引擎、JavaScript 浏览器或登录账号。域名允许列表为空表示允许公开站点，填写后只接受列表中完全匹配的域名，跳转目标也受限制。读取阻止私网、回环、保留地址及 URL 账号信息，固定已检查的 DNS 地址连接，限制跳转、响应大小与时间。站点需登录、拒绝、限流、编码或内容类型不支持时，返回具体状态，不伪装成已取得社交账号内容。若部署环境的 DNS 将公开域名映射到 `198.18.0.0/15` 等保留地址（例如部分代理的 fake-IP 模式），同样会被阻止；需由部署者配置真实的公开 DNS/网络出口，不通过放开私网限制来绕过。

### Host 与 QQ

Host 连接分别登记名称、地址、token 和允许项目，Bot 还需获得对应 Host 及 `hosts` 授权。远程使用 HTTPS，回环地址可用 HTTP；地址属于运行 Bots 的机器。检查连接保存 Host 身份，身份变化时阻断。项目创建接口只登记 **Host 上已有目录**，不会在远端自动创建磁盘目录。

委派保留 Host、项目、会话、operation 和 submission 等稳定引用。断线后先核对原回执，不把重连等同再次提交；远端停止须以实际回执为准。Host 产物仅通过其允许的文件接口取得，不能读取任意路径或任意大小文件。

QQ 使用官方机器人 C2C 私聊、一个入口路由多个 Bot。配置 AppID、AppSecret、默认 Bot 后，单独连接并生成一次性绑定码，在 QQ 向机器人发送 `/绑定 <绑定码>`。绑定码有效期 5 分钟。绑定完成后可用 `/角色` 列出角色、`/切换 <准确名称或ID>` 切换、`/状态` 查看当前角色任务、`/停止` 请求停止。入站去重和出站投递分别保存；Web 可查看 QQ 来源会话。

QQ WebSocket 由 Bots 主动连出，不提供家庭内网 Host 的穿透能力。主动消息、回复窗口、配额与富媒体上传仍受当前官方账号权限约束，需真实账号验证。生成成功与投递成功分别记录；投递 `unknown` 时不自动重发，显式再次发送只复用原结果，不重跑模型、生图或 Host 工作。

## API 约定

服务入口为 `/api/v1`。资源字段见 [shared/types.ts](../apps/bot/src/shared/types.ts)，实际路由见 [routes.ts](../apps/bot/src/server/routes.ts)、[capabilities.ts](../apps/bot/src/server/capabilities.ts)、[hosts.ts](../apps/bot/src/server/hosts.ts) 和 [qq.ts](../apps/bot/src/server/qq.ts)。

| 认证入口                  | 请求与行为                                              |
| ------------------------- | ------------------------------------------------------- |
| `GET /api/auth/status`    | `{initialized, authenticated}`                          |
| `POST /api/auth/setup`    | `{password}`；只允许首次设置                            |
| `POST /api/auth/login`    | `{password}`；成功设置 HttpOnly、SameSite Strict Cookie |
| `POST /api/auth/logout`   | 注销当前 Cookie 会话                                    |
| `POST /api/auth/password` | `{currentPassword,password}`；改密撤销旧 Cookie 会话    |

Web 写入校验同源 `Origin` 与跨站请求标记。API token 在 Web 的访问凭据页面创建，明文只返回一次；后续用 `Authorization: Bearer <token>`。token 需含 `read`，可额外授予 `write`，由 Web 撤销；token 不用于创建或撤销其他 token。Cookie 会话约 7 天有效，HTTPS 部署使用 Secure Cookie。API token 没有 Cookie 时可以不带 Origin；若提供 Origin，仍须与公开 Origin 一致。

所有 `/api/v1` 写请求携带 `Idempotency-Key`，长度不超过 200，只含字母、数字、下划线、冒号、点和短横线。作用域为 principal、HTTP 方法与路径；同键异参返回 409，原调用仍在处理时等待同次回执。连接中断时保留原键并查询任务，不自行换键重发。进程中断留下未确认操作时返回 `outcome-unknown`，不会自动重做。一次性 token 或绑定码的原响应不供持久重放，需要重新创建。

具有 `revision` 字段的资源更新携带已读取的版本，冲突返回 `revision-conflict` 与当前版本；保留本地输入后重新读取。多数 DELETE 在 JSON body 中接受 `{revision}`，计划删除也接受 `?revision=N`；token 撤销不需要 revision。

统一错误结构为：

```json
{
  "error": {
    "code": "revision-conflict",
    "message": "配置已改变，请重新读取后保存",
    "retryable": false,
    "requestId": "服务分配的请求标识",
    "details": { "revision": 2 }
  }
}
```

HTTP 400 表示输入错误，401 未认证，403 授权或来源被拒绝，404 资源不存在，409 表示版本、幂等、资源状态冲突或结果未知，413 请求过大，429 限流。`retryable` 不表示可以换幂等键重做计费或远端副作用。

### 资源与对话

| 路由                                                             | 主要输入或返回                                                                                                           |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `GET /snapshot`、`GET /capabilities`                             | 资源快照与游标；能力状态只表示配置/已知状态，不能证明外部调用成功                                                        |
| `GET/POST /bots`、`GET/PATCH/DELETE /bots/:id`                   | 名称、头像、简介、指令、模型、能力、协作与 Host 授权、工具预算；更新/删除带 revision                                     |
| `POST /bots/:id/copy`                                            | 复制角色配置，副本默认停用，并拥有独立固定 Web 私聊                                                                      |
| `POST /bots/:id/conversation`                                    | 无需业务 body，返回 200 `Conversation`；同事务获取或创建固定 Web 私聊，并发重复调用复用同一 ID                           |
| `GET/POST /conversations`、`GET/PATCH/DELETE /conversations/:id` | `{name,kind,memberIds,coordinatorId,pinned?,archived?}`；group 创建群组，direct 复用 Bot 的固定私聊                      |
| `GET /conversations/:id/messages`                                | `?limit=1..200&cursor=...`，默认 50；返回 `{items,nextCursor?}`                                                          |
| `POST /conversations/:id/messages`                               | `{content,attachmentIds?,recipientIds?,mode?:"queue"\|"steer"}`，202 返回 `{messageId,taskIds,status:"accepted"}`        |
| `GET /tasks`、`GET /tasks/:id`                                   | 可按 `?conversationId=` 筛选，查看来源、子任务、结果和执行状态                                                           |
| `POST /tasks/:id/stop`                                           | 返回实际影响的任务 ID；远端停止可能仍待确认                                                                              |
| `POST /tasks/:id/attempts`                                       | 已失败、停止或阻塞任务的新尝试；活动或 unknown 任务拒绝盲重做                                                            |
| `GET/PATCH /settings/models`                                     | PATCH `{models:[{id?,revision?,name,kind,provider,model,baseUrl?,apiKey?}]}`；省略已有模型 apiKey 保留凭据，空字符串清除 |
| `DELETE /models/:id`                                             | `{revision}`；先处理仍在引用该文本模型的 Bot                                                                             |
| `GET/PATCH /settings`                                            | `{webEnabled?,allowedWebDomains?,reducedMotion?}`                                                                        |
| `GET/POST /memories`、`PATCH/DELETE /memories/:id`               | `{scope:"owner"\|"bot"\|"conversation",targetId?,title,content,sourceMessageId?,revision?}`                              |
| `GET/POST /attachments`                                          | POST 为 multipart `file` 与可选 `conversationId`，返回附件元信息                                                         |
| `GET /attachments/:id`、`GET /attachments/:id/content`           | 元信息与鉴权下载；图片可内联，其他类型下载                                                                               |
| `POST /attachments/:id/copy`                                     | `{conversationId}`；复制到另一会话以供显式复用                                                                           |
| `GET/POST /tokens`、`DELETE /tokens/:id`                         | 创建 `{name,scopes:["read","write"]}`；仅 Cookie owner 可管理                                                            |

固定私聊更新继续带 revision，但 `PATCH archived:true` 或 DELETE 返回 `409 fixed-conversation`；成员与类型校验禁止将其换成其他 Bot 或群组。`POST /bots/:id/conversation` 同样要求写权限与 `Idempotency-Key`，客户端使用 `openBotConversation(botId)`。兼容创建 direct 返回固定记录，不能据此创建额外会话；群组仍有独立 ID。

发送消息示例只表示调用方式；替换为实际 token、会话和 Bot ID。首次调用与该次传输重试使用相同键：

```bash
curl 'http://127.0.0.1:4310/api/v1/conversations/<conversationId>/messages' \
  -H 'Authorization: Bearer <token>' \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: my-client-message-0001' \
  --data '{"content":"整理这个需求","recipientIds":["<botId>"],"mode":"queue"}'
```

202 仅说明持久接纳。通过任务或后续消息读取最终结果，不把响应或实时流当作完成证据。

### 计划、图片与探索

| 路由                                                     | 主要输入或返回                                                                                                     |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `GET/POST /schedules`、`GET/PATCH/DELETE /schedules/:id` | 规则字段见下例；列表返回 `{items,policy}`                                                                          |
| `POST /schedules/preview`                                | `{kind,timezone,at?,time?,weekdays?}`，返回 `{nextRunAt,occurrences,timezone}`                                     |
| `GET /schedules/policy`                                  | `{maxLatenessMs,downtime:"skip"}`                                                                                  |
| `POST /schedules/:id/pause`、`resume`                    | `{revision}`；只控制后续触发                                                                                       |
| `POST /schedules/:id/run`                                | 立即运行；202 返回关联实际 taskIds 的运行记录                                                                      |
| `GET /schedules/:id/runs`                                | `{items}`，包含 `running/completed/failed/skipped` 状态与 taskIds                                                  |
| `POST /schedules/:id/runs/:runId/stop`                   | 停止关联任务；仍在接纳时返回 409，重读后操作                                                                       |
| `GET/POST /generations`、`GET /generations/:id`          | POST `{conversationId,prompt,modelId?,previousGenerationId?,confirmUnknown?}`；返回 `{generationId,attachmentIds}` |
| `/images/generations`                                    | 上述生图路由的兼容路径                                                                                             |
| `POST /explore`                                          | `{url,botId}`，返回 `{content}`；只读取实际公开内容                                                                |

每日计划的创建内容：

```json
{
  "name": "晚间整理",
  "conversationId": "<conversationId>",
  "botId": "<botId>",
  "prompt": "整理今天提供的材料，列出待办",
  "enabled": true,
  "kind": "daily",
  "timezone": "Asia/Shanghai",
  "time": "21:00",
  "weekdays": [],
  "notification": "web"
}
```

单次用 `kind:"once"` 与带时区的 `at`；每周用 `kind:"weekly"`、`time` 和 `weekdays`，其中 `0` 为周日、`6` 为周六。保存不调用模型。生图提示词上限 16000 字符，不接受参考图编辑参数。

### Host、QQ 与投递

| 路由                                             | 主要输入或返回                                                                                |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| `GET/POST /hosts`、`GET/PATCH/DELETE /hosts/:id` | `{name,url,token?,projectIds?,revision?}`；凭据只写不回显                                     |
| `POST /hosts/:id/check`                          | 显式检查身份和连接能力                                                                        |
| `GET/POST /hosts/:id/projects`                   | GET 读取项目；POST `{cwd,name?}` 登记远端已有目录                                             |
| `POST /delegations`                              | `{botId,conversationId,hostId,projectId,prompt,sessionId?}`；202 `{taskId,status:"accepted"}` |
| `GET /delegations/:id`                           | 查看任务与原远端 receipt、snapshot                                                            |
| `POST /delegations/:id/reconcile`                | 有稳定 operation 后核对原委派，不重新创建不明远端工作                                         |
| `POST /delegations/:id/interaction`              | `{requestId,response,agentId?}`；response 使用正式 Host interaction 契约                      |
| `POST /delegations/:id/attachments`              | `{path}`；从允许的 Host 产物接口取得副本                                                      |
| `GET/PATCH /channels/qq`                         | `{revision,enabled?,appId?,appSecret?,defaultBotId?}`                                         |
| `POST /channels/qq/connect`                      | 显式连接官方网关                                                                              |
| `POST/DELETE /channels/qq/binding`               | 生成一次性绑定码或显式解绑；删除带 revision                                                   |
| `GET /deliveries`                                | 投递状态、目标、错误与官方回执                                                                |
| `POST /deliveries/:id/attempts`                  | 复用原消息创建投递尝试；unknown 时须 `{confirmUnknown:true}`                                  |

### 事件与重新同步

`GET /events?after=<cursor>` 返回 SSE。先读 `/snapshot` 取得 `cursor`，再从该游标订阅。`change` 事件包含 `{cursor,event}`，SSE id 也是游标；`heartbeat` 提供已知游标，`unauthenticated` 表示凭据已失效。持久事件有界保留，当前为最近 1000 条变更；不提供逐 token 的持久补读。

游标过期、epoch 不匹配或越界返回 409 `resync-required`，重读快照后重新订阅。消息分页 cursor 绑定会话与数据 epoch，失效返回 `stale-cursor`。事件用于触发重新读取正式资源，重复事件按 ID 去重；断线和重连不会自动再次发送原消息。token 或 Cookie 撤销后，后续请求与已打开 SSE 都重新校验授权。

## Web UI

Bots 保留 `apps/bot/src/ui` 内的 DS-Bot 布局、主题 token、业务状态与动效，基础控件复用项目组件库：Select、Button、Input、Textarea、Tooltip、DropdownMenu 按 `@pi-meme/ui/components/ui/<组件文件>` 的具体路径导入，例如 `@pi-meme/ui/components/ui/select`，不使用聚合入口，也不导入 `@pi-meme/app-ui` 或工作台业务状态。Tailwind 显式扫描本地 UI 与 `packages/ui/src`，保证共享组件的工具类进入 Bots 构建。

Bots 的 Modal 保留自身焦点、遮罩与退场/Portal 生命周期，不直接套用强制遮罩及 Portal 关闭行为的项目 Dialog。项目库没有 Checkbox，多选 Check 保留原生复选框语义，不替换为 Switch；复用基础控件不改变 DS 参考与设置弹窗结构。

主界面以 Bot/群组列表和聊天两栏组织，不再用活动轨切换全屏业务页。左下头像气泡菜单中的“设置”打开模态窗口，分类为外观、模型、联网、记忆、计划、资料、连接、访问凭据。创建 Bot、创建群组及角色编辑按需打开弹窗；详情不占常驻第三栏。设置分类切换保持窗口尺寸和聊天状态，返回聊天保留草稿与阅读位置。局部动效兼容不支持 React View Transitions 的浏览器；系统或应用的“减少动态效果”会取消空间运动，后台事件重读保持安静。

聊天顶部名称打开 Bot 或群组设置；右上角直接打开任务记录，不重复提供设置菜单。输入框上方不再常驻显示任务状态行，运行状态在任务记录中查看，输入框保留停止操作。任务详情绑定来源会话，切换聊天时不显示其他会话的详情。

聊天草稿、待核对发送及阅读位置按会话保存；新增消息在底部时跟随，在查看上文时保留阅读位置并提供“跳到最新”。首次加载、读取失败与空消息分别展示，分页补读保持阅读锚点。当前服务不推送逐 token 正文，任务状态表示真实执行过程，不用打字机效果模拟模型流式输出。

## 实现位置与验收边界

| 位置                                                                                                           | 职责                                             |
| -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| [server/main.ts](../apps/bot/src/server/main.ts)、[server/app.ts](../apps/bot/src/server/app.ts)               | 监听、静态页面、认证 API 装配与生命周期          |
| [server/store.ts](../apps/bot/src/server/store.ts)、[server/runtime.ts](../apps/bot/src/server/runtime.ts)     | 独立根目录、单 owner durable 状态与模型/工具任务 |
| [shared/types.ts](../apps/bot/src/shared/types.ts)、[server/contracts.ts](../apps/bot/src/server/contracts.ts) | 应用内类型及服务适配接口                         |
| [src/client](../apps/bot/src/client)、[src/ui](../apps/bot/src/ui)                                             | 同源 API、事件重连与独立 React 页面              |
| [server/hosts.ts](../apps/bot/src/server/hosts.ts)、[server/qq.ts](../apps/bot/src/server/qq.ts)               | HostApi v2 与 QQ 官方适配                        |
| [server/capabilities.ts](../apps/bot/src/server/capabilities.ts)                                               | 计划、生图和公开网页入口                         |

页面、代码和类型检查均不能替代用户路径。验收需记录 **oracle 是哪条真实入口/行为、Hacker 是谁**，并区分公开 HTTP 读取、真实模型、真实图片账单、QQ、远端 Host 与服务器部署。没有对应外部账号或真实回执的部分应标“未验”，不能用假模型或模拟渠道宣称集成成功。
