---
description: '独立 Bots 应用的启动部署、对话配置、Pi meme 连接、QQ 与认证 API'
status: implemented
paths:
  - 'apps/bot/**'
  - 'package.json'
  - 'packages/ui/src/components/ui/**'
---

# 独立 Bots

Bots 是独立部署的个人助理服务与 Web，内核为 Pi Durable。主界面参考 `~/Code/DS-Bot`，采用左侧 Bot/群组列表与右侧聊天，每个 Bot 对应固定 Web 私聊。首次连通模型后，用户通过对话管理 Bot、模型、Pi meme、QQ 和应用设置。左下头像菜单提供手动设置入口。[应用入口](../apps/bot/README.md) · [改造验收](#对话配置改造验收)

本页描述当前源码与配置。真实模型聊天、图片生成与账单、QQ 收发与主动消息权限、多台 Pi meme 委派及远程部署，按对应账号和环境中的实际行为验收。当前改造与早期版本的验收记录分别列在文末。

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

默认根目录由 Node 的 `os.homedir()` 解析，为运行服务用户的 `~/.pi-meme-bot/`。手工验收可通过 `createBotService({dataDirectory})` 注入隔离目录，每个目录仍由一个服务实例持有写入锁。工作台 `~/.pi-meme`、开发 Host 和 Pi CLI 各自维护其配置与会话。

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

首次路径为访问密码 → 模型配置 → 默认助理私聊。密码至少 12 个字符。模型配置展示服务、模型和密钥，预置服务自动填写协议与地址，自定义兼容服务补充 URL，名称与参数可在折叠区域调整。“连接并开机”依次保存候选、实际检查工具调用往返、激活默认模型。检查会调用供应商并可能计费。首次激活在一个事务中创建默认助理及固定私聊，已有团队则选用现有角色。失败后可在原位调整候选配置。

对话模型适配 OpenAI Responses、OpenAI 兼容 Chat Completions、Anthropic 和 Google，开机检查要求完成文字与工具调用往返。图片输入能力依据模型目录或已有验证信息。`kind:"text"` 是 API 的序列化名称。输入/输出 token 可记录，缺少权威计价时费用为 `null`。图片生成使用独立的 OpenAI 或兼容图片模型，Pi meme、QQ 和生图可在开机后交给 Bot 配置。

全部 Bot 统一拥有应用配置管理能力。Pi meme 连接覆盖全部项目及以后新增的项目，Bot 可读取项目、会话、消息和文件，也可委派实际项目工作。默认工具调用预算为 32，角色配置可调整到 1–128。普通配置按用户要求直接执行，删除、停用、撤销等重要操作提供确认。

创建 Bot 只需名称和职责，`modelId:null` 或省略字段表示跟随默认模型，明确 ID 表示覆盖。有效模型在接纳新任务时解析并冻结，修改默认会影响后续任务，凭据撤销会阻断旧任务的后续调用。Web 默认助理由 `defaultAssistantId` 指定，QQ 接待角色由 QQ 配置管理。

每个 Bot 由 `webConversationId` 指向固定 Web 私聊，创建或复制 Bot 时同事务建立记录。群聊有 2–16 个 Bot 和一名协调者，`collaborationEnabled` 控制群内自动协作。Bot 可邀请其他已启用角色协作。显式 `recipientIds` 使用稳定成员 ID，省略接收人时由协调者处理。

每项根任务使用独立 Durable runtime。上下文按来源消息 ID、发言身份、成员加入边界及附件引用构造，QQ 进一步限定为当前角色参与的消息。历史按有效模型 token 预算选择，超过预算时由同一模型生成滚动摘要，保留目标、决定、待办及来源引用，摘要失败时保留原始历史并显示错误。近期图片直接进入模型输入，较早的获准附件可通过 `read_attachment` 读取。协作子任务只取得显式传入的材料和附件，成员加入前的历史继续受范围校验。

根任务并发上限为 4，包含子协作的总并发硬上限为 12。协作深度最多 3，每个父任务最多 8 个直接子协作，整棵任务树最多 32 项。空闲直接发送，忙时默认排队，补充通过菜单选择明确的运行轮。停止根任务作用于该轮及其协作，其他排队轮可逐条取消。尚未消费的补充通过 Durable Submission 单独撤回，已消费补充返回 `409 supplement-consumed` 并指向父任务。

服务启动为旧 Bot 补齐固定私聊关联：已有有效固定 ID 保持不变，否则优先复用未归档且最近更新的旧 direct，没有才创建；归档的选定记录会恢复可用。其他旧 direct 及其消息、附件、任务、计划引用完整保留，不自动合并到固定私聊，不迁移旧计划目标；仍可通过现有 API 读取，但新主列表不继续提供多会话管理。QQ 保留单独渠道会话，不与固定 Web 私聊合并。固定私聊不可独立归档、删除或更换 Bot；删除 Bot 时保留并归档其 direct 历史，活动任务、群协调者、QQ 默认角色和启用计划的依赖仍须先处理。

“资料”提供附件预览、授权下载与复用到草稿。输入框支持选择、粘贴、拖拽、发送前缩略预览及移除。每条消息最多 10 个附件，单件上限 **20 MiB**，总 HTTP 请求体上限 **22 MiB**。上传格式为 PNG、JPEG、WebP、GIF、UTF-8 文本和 JSON，服务端校验 MIME、图片头、文件大小和内容摘要，浏览器解码失败时阻止发送。跨会话复用通过复制建立目标会话的独立附件引用。

逐消息“记住这条”在私聊默认选择当前 Bot，在群聊默认选择当前群，保留 `sourceMessageId`，可继续编辑或撤销。设置页与消息旁共用记忆编辑器，支持 owner、Bot 和会话范围。Bot 根据用户要求直接保存或修改记忆。

### 模型配置与升级

`GET/PATCH /settings/models` 是唯一配置资源，返回聚合 `revision`、`services`、`models`、默认模型、默认助理和初始化状态。服务保存供应商、协议、地址和凭据，模型引用 `serviceId`，同一服务内多个模型共用连接。PATCH 的列表按 ID 部分更新，移除服务使用 `removedServiceIds` 且要求无模型引用，删除模型使用既有 `DELETE /models/:id`。服务密钥省略时保留，空字符串表示撤销，响应仅提供 `hasCredential`。

`POST /settings/models/check` 接受 `{modelId,revision}`。验证结果为 `unverified`、`verified`、`unsupported`、`failed` 或 `unknown`，绑定有效模型、协议、地址、参数及凭据版本。模型检查在存储事务外执行，写回时再次核对配置，慢请求的旧结果遇到并发修改会被拒绝。显示名称调整可复用原有效验证，连接或模型参数改变后须重新检查。

Doc 与业务 schema 升至 v3。v1 模型先转为独立 service，再清理 Bot 与任务快照中的能力、协作对象、连接和项目授权字段。应用设置加入服务端主题和时区。旧待处理的授权或配置草稿任务标记为 blocked，提示用户重新发起。升级前后的数据由同一 Durable 存储维护。

模型写入统一使用带聚合 revision 的 `services` 和 `models`，密钥、地址和协议属于服务字段。字段白名单拒绝旧式混合连接参数。活动任务持有模型配置快照，模型修改在后续任务生效，显式撤销服务密钥会阻断后续调用。删除模型前须结束引用它的活动任务。

### 对话配置工具

`read_configuration` 返回可管理配置与稳定 ID，凭据以是否配置的状态展示。配置工具通过进程内请求复用 Web API 的字段校验、领域修改和幂等回执，发起任务身份在服务端上下文中传递。修改调用按真实 Durable tool call ID 保存参数摘要和结果，恢复时沿用原版本及动态默认值。

| 工具                                               | 管理内容                                           |
| -------------------------------------------------- | -------------------------------------------------- |
| `configure_bot`                                    | 创建、修改、复制、停用和删除角色，包括自己         |
| `configure_model`                                  | 模型服务、密钥、模型参数、连通检查和默认模型       |
| `configure_pi_meme`、`read_pi_meme`                | 连接管理及全部项目、会话、历史消息、文件和模型目录 |
| `create_pi_meme_project`、`delegate_pi_meme`       | 登记项目和以完全权限执行项目工作                   |
| `configure_qq`                                     | 保存并连接 QQ、生成绑定码、解绑                    |
| `configure_preferences`                            | 主题、减少动态效果、时区和公开网页访问             |
| `manage_group`、`manage_memory`、`manage_schedule` | 群组、记忆和定时任务                               |
| `set_default_assistant`                            | Web 默认助理                                       |
| `change_access_password`、`manage_api_token`       | 登录密码和 API 令牌                                |

问题与重要操作确认通过 `POST /tasks/:id/responses` 回应，绑定真实 `interactionId` 和交互 `revision`。同键恢复返回原消费结果，新键重复消费返回 409，停止任务取消 pending 交互。QQ 会投递问题，用户可直接回复答案、选项序号或“确认”“取消”，多个待答问题使用 `/回复 <交互ID> <答案>`。QQ 绑定身份、入站去重及后续回复窗口在同一事务内核对并保存。

删除当前 Bot 或归档当前会话会登记回复后的操作，最终回答与操作结果一起持久化。其他活动任务、配置并发修改及现有依赖会阻止删除或归档并返回具体错误。任务停止或失败时取消待执行操作。

### 定时任务

聊天的“新建定时任务”自动带入来源会话、执行 Bot、应用时区和 Web 通知，在设置同层打开表单。名称最多 80 字符，内容最多 32000 字符，时区最多 100 字符。支持 `once`、`daily`、`weekly`，工作日可使用每周 `[1,2,3,4,5]`，保存前可预览后续执行时刻。单次 `at` 必须包含明确时区，周期按 IANA 时区的本地日历计算。

Bot 使用 `manage_schedule` 直接保存规则，通知渠道继承来源任务，规则总数上限为 500。服务端生成 `executionGrant` 代次，规则更新、暂停、恢复时推进，实际消息接纳事务核对当前代次和运行快照。执行 Bot 必须启用且属于来源会话。

夏令时缺失时刻跳过，重复时刻取第一次。服务停机期间错过的安排记录为 `skipped`，不补跑；运行期间超过允许延迟同样跳过。服务必须运行，不会唤醒关机或休眠设备。同计划最多一个活跃运行，会话忙碌时不积队。手动立即运行使用独立运行记录，不改变周期。

暂停撤销未来触发及尚未接纳运行的规则许可，已接纳任务通过“停止本次运行”控制。删除规则前须先处理当前运行，历史任务与运行结果继续保留。QQ 通知要求当前已绑定的 QQ 来源会话，执行与投递分别记录状态。

### 图片与公开网页

图片请求先保存生成意图，再调用供应商；返回的 PNG、JPEG 或 WebP 内容经大小和 MIME 检查后进入附件库。费用缺少权威账单时保持 `null`。请求已发出但结果、下载或保存未确认时标 `unknown`，不自动重试、不自动换模型；同一任务有未确认的生图时，工具层禁止继续生成。

生图从 service 解析有效凭据，在每次后续请求前核对配置指纹与当前授权。Durable 工具调用 ID 绑定已保存的生成回执，恢复时可读取同一次已完成结果，未确认结果继续要求人工核对。

用户核对原供应商结果和账单后，可以明确创建新尝试。API 需 `previousGenerationId` 与 `confirmUnknown:true`，并使用新幂等键；原生成记录保留，重复费用风险不会被改写为零。

公开网页访问默认启用，Bot 可通过 `configure_preferences` 调整开关和域名列表。读取公开 HTTP(S) 内容时返回实际最终来源。域名列表为空表示允许公开站点，填写后只接受列表中完全匹配的域名，跳转目标也受限制。读取阻止私网、回环、保留地址及 URL 账号信息，固定已检查的 DNS 地址连接，限制跳转、响应大小与时间。站点需要登录、拒绝访问、限流或返回不支持的内容时，提供具体错误。部署环境的 DNS 若将公开域名映射到 `198.18.0.0/15` 等保留地址，需要配置真实的公开 DNS 与网络出口。

### Pi meme 与 QQ

Pi meme 连接只需 URL 和密钥，名称默认采用 URL 中的主机地址，保存后自动检查。失败配置保存为 offline，可在原连接重试。全部 Bot 可访问全部项目及后续新增项目。远程使用 HTTPS，回环地址可用 HTTP，URL 由运行 Bots 的机器访问。连接检查保存服务身份，后续请求核对身份和凭据。项目创建接口登记 **Pi meme 所在机器上的已有目录**。

项目选择与委派复用 HostApi 的 `AppProject` 契约，以 `projectId` 保存项目身份。连接的 `revision` 保护配置修改，连接观测更新 `checkedAt`、`updatedAt` 和状态。`read_pi_meme` 提供项目、会话、消息分页、文件列表、文件读取、文件搜索和模型目录。委派新会话使用 `full-access/default`。

委派保留 Host、项目、会话、operation 和 submission 等稳定引用。断线后先核对原回执，不把重连等同再次提交；远端停止须以实际回执为准。Host 产物仅通过其允许的文件接口取得，不能读取任意路径或任意大小文件。

QQ 使用官方机器人 C2C 私聊、一个入口路由多个 Bot。填写 AppID 与 AppSecret 后自动连接并选择接待 Bot，连接正常后自动生成本人绑定码。在 QQ 向机器人发送 `/绑定 <绑定码>`，有效期 5 分钟。绑定完成后可用 `/角色` 列出角色、`/切换 <准确名称或ID>` 切换、`/状态` 查看当前角色任务、`/停止` 请求停止。问题与配置确认可直接在 QQ 中回复。入站去重和出站投递分别保存，Web 可查看 QQ 来源会话。

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

所有 `/api/v1` 写请求携带 `Idempotency-Key`，长度不超过 200，只含字母、数字、下划线、冒号、点和短横线。作用域为 principal、HTTP 方法与路径，同键异参返回 409，原调用仍在处理时等待同次回执。连接中断时保留原键和原请求内容，消息与任务响应可通过领域回执恢复已接纳操作，其余未确认副作用返回 `outcome-unknown`。一次性 token 或绑定码需单独重新创建。

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

| 路由                                                             | 主要输入或返回                                                                                                                                          |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /snapshot`、`GET /capabilities`                             | 资源快照与游标；能力状态只表示配置/已知状态，不能证明外部调用成功                                                                                       |
| `GET/POST /bots`、`GET/PATCH/DELETE /bots/:id`                   | 名称、头像、简介、指令、模型、启停和工具预算，更新与删除带 revision                                                                                     |
| `POST /bots/:id/copy`                                            | 复制角色配置，副本默认停用，并拥有独立固定 Web 私聊                                                                                                     |
| `POST /bots/:id/conversation`                                    | 无需业务 body，返回 200 `Conversation`；同事务获取或创建固定 Web 私聊，并发重复调用复用同一 ID                                                          |
| `GET/POST /conversations`、`GET/PATCH/DELETE /conversations/:id` | `{name?,kind,memberIds,coordinatorId?,collaborationEnabled?,pinned?,archived?}`，群名与协调者可由成员生成默认值                                         |
| `GET /conversations/:id/messages`                                | `?limit=1..200&cursor=...`，默认 50；返回 `{items,nextCursor?}`                                                                                         |
| `POST /conversations/:id/messages`                               | `{content,attachmentIds?,recipientIds?,mode?:"queue"\|"steer",targetTaskId?}`，steer 必须绑定明确目标，202 返回 `{messageId,taskIds,status:"accepted"}` |
| `GET /tasks`、`GET /tasks/:id`                                   | 可按 `?conversationId=` 筛选，查看来源、子任务、结果和执行状态                                                                                          |
| `POST /tasks/:id/stop`                                           | 返回实际影响的任务 ID；远端停止可能仍待确认                                                                                                             |
| `POST /tasks/:id/attempts`                                       | 已失败、停止或阻塞任务的新尝试；活动或 unknown 任务拒绝盲重做                                                                                           |
| `POST /tasks/:id/responses`                                      | `{interactionId,revision,answer?}` 或 `{interactionId,revision,decision}`，处理问题和重要操作确认                                                       |
| `POST /tasks/:id/completion-action`                              | `{kind,revision}`，kind 为 `delete-bot` 或 `archive-conversation`，当前任务回复后执行                                                                   |
| `GET/PATCH /settings/models`                                     | 聚合 `{revision,services?,models?,defaultModelId?,defaultAssistantId?,removedServiceIds?}`，按 ID 部分更新                                              |
| `POST /settings/models/check`                                    | `{modelId,revision}`，实际检查工具调用往返后返回配置及验证摘要                                                                                          |
| `DELETE /models/:id`                                             | `{revision}`；先处理仍在引用该文本模型的 Bot                                                                                                            |
| `GET/PATCH /settings`                                            | `{theme?,timezone?,webEnabled?,allowedWebDomains?,reducedMotion?}`，主题与减少动态效果通过 SSE 同步页面                                                 |
| `POST /settings/password`                                        | `{currentPassword,password}`，修改密码并注销已有网页登录                                                                                                |
| `GET/POST /memories`、`PATCH/DELETE /memories/:id`               | `{scope:"owner"\|"bot"\|"conversation",targetId?,title,content,sourceMessageId?,revision?}`                                                             |
| `GET/POST /attachments`                                          | POST 为 multipart `file` 与可选 `conversationId`，返回附件元信息                                                                                        |
| `GET /attachments/:id`、`GET /attachments/:id/content`           | 元信息与鉴权下载；图片可内联，其他类型下载                                                                                                              |
| `POST /attachments/:id/copy`                                     | `{conversationId}`；复制到另一会话以供显式复用                                                                                                          |
| `GET/POST /tokens`、`DELETE /tokens/:id`                         | 创建 `{name,scopes:["read","write"]}`，由网页登录用户或 Bot 对话管理                                                                                    |

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

### 定时任务、图片与探索

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
| `/images/generations`                                    | `/generations` 的薄兼容别名，移除目标为 Bots API v2                                                                |
| `POST /explore`                                          | `{url,botId}`，返回 `{content}`；只读取实际公开内容                                                                |

每日定时任务可使用以下创建内容。

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

### Pi meme、QQ 与投递

| 路由                                             | 主要输入或返回                                                                                                                 |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| `GET/POST /hosts`、`GET/PATCH/DELETE /hosts/:id` | 新建只需 `{url,token}`，更新与删除带 revision，保存后自动检查                                                                  |
| `POST /hosts/:id/check`                          | 显式检查身份和连接能力                                                                                                         |
| `GET/POST /hosts/:id/projects`                   | GET 返回全部 `AppProject[]`，POST `{cwd,name?}` 登记远端已有目录                                                               |
| `GET /hosts/:id/content`                         | `kind` 选择 projects、sessions、session、messages、files、read_file、search_files、models，messages 支持 offset、limit、cursor |
| `POST /delegations`                              | `{botId,conversationId,hostId,projectId,prompt,sessionId?}`；202 `{taskId,status:"accepted"}`                                  |
| `GET /delegations/:id`                           | 查看任务与原远端 receipt、snapshot                                                                                             |
| `POST /delegations/:id/reconcile`                | 有稳定 operation 后核对原委派，不重新创建不明远端工作                                                                          |
| `POST /delegations/:id/interaction`              | `{requestId,response,agentId?}`；response 使用正式 Host interaction 契约                                                       |
| `POST /delegations/:id/attachments`              | `{path}`；从允许的 Host 产物接口取得副本                                                                                       |
| `GET/PATCH /channels/qq`                         | `{revision,enabled?,appId?,appSecret?,defaultBotId?}`                                                                          |
| `POST /channels/qq/connect`                      | 显式连接官方网关                                                                                                               |
| `POST/DELETE /channels/qq/binding`               | 生成一次性绑定码或显式解绑；删除带 revision                                                                                    |
| `GET /deliveries`                                | 投递状态、目标、错误与官方回执                                                                                                 |
| `POST /deliveries/:id/attempts`                  | 复用原消息创建投递尝试；unknown 时须 `{confirmUnknown:true}`                                                                   |

### 事件与重新同步

`GET /events?after=<cursor>&conversationId=<optional>` 返回唯一 SSE 通道。先读 `/snapshot` 取得 `cursor`、正式消息任务和 `live` 草稿，再从该游标订阅。`change` 包含 `{cursor,event}`，SSE id 使用持久游标，`heartbeat` 提供已知游标，`unauthenticated` 表示凭据已失效。持久事件保留最近 1000 条变更。

`live` 事件来自 Durable 公开 watch/LiveDoc，载荷为 `TaskLive[]`，每项带 `taskId`、`conversationId`、`botId`、`runId`、`generation`、`version`、真实 `text` 和状态。`conversationId` 可筛选草稿。`generation` 跨运行恢复递增，`version` 在该代内递增，临时草稿使用这两个字段替换合并。正式回答按任务与 assistant entry 身份替换草稿，停止或失败的真实部分正文保存为 `partialResult` 并标明未完成状态。

游标过期、epoch 不匹配或越界返回 409 `resync-required`，重读快照后重新订阅。消息分页 cursor 绑定会话与数据 epoch，失效返回 `stale-cursor`。事件用于触发重新读取正式资源，重复事件按 ID 去重；断线和重连不会自动再次发送原消息。token 或 Cookie 撤销后，后续请求与已打开 SSE 都重新校验授权。

## Web UI

Bots 保留 `apps/bot/src/ui` 内的 DS-Bot 布局、主题 token、业务状态与动效，基础控件复用项目组件库：Select、Button、Input、Textarea、Tooltip、DropdownMenu 按 `@pi-meme/ui/components/ui/<组件文件>` 的具体路径导入，例如 `@pi-meme/ui/components/ui/select`，不使用聚合入口，也不导入 `@pi-meme/app-ui` 或工作台业务状态。Tailwind 显式扫描本地 UI 与 `packages/ui/src`，保证共享组件的工具类进入 Bots 构建。

Bots 的 Modal 保留自身焦点、遮罩与退场/Portal 生命周期，不直接套用强制遮罩及 Portal 关闭行为的项目 Dialog。项目库没有 Checkbox，多选 Check 保留原生复选框语义，不替换为 Switch；复用基础控件不改变 DS 参考与设置弹窗结构。

主界面以 Bot/群组列表和聊天两栏组织。左下头像菜单打开设置弹窗，分类为外观、模型、联网能力、记忆、定时任务、资料、连接、访问凭据。标题先打开只读详情，编辑替换同层内容，Bot 编辑可跳到所选模型的设置并原位返回。模型、记忆、定时任务编辑在设置同层展开，未保存时关闭会确认，保存期间保护相关关闭操作。分类切换与返回聊天保留草稿和阅读位置，系统或应用的减少动态效果设置控制局部动效。

右上角任务记录按根任务组织协作，显示邀请关系、等待、结果及逐条取消入口。问题与重要操作确认卡出现在来源消息附近，任务详情展示回复后配置操作的失败或取消结果。空私聊提供常用配置的对话入口。主题和减少动态效果取自服务端设置，Bot 修改后页面自动同步。

聊天草稿、待核对发送及阅读位置按会话保存。待核对卡保留原幂等键、原正文、目标与附件，新编辑使用独立草稿代次，恢复原请求只清理原代次草稿。401 或连接结果未知时继续保留原请求。新增消息在底部时跟随，在查看上文时保留阅读位置并提供“跳到最新”，分页补读保持阅读锚点。真实流式草稿直接更新正文，最终消息完成替换。

## 实现位置与验收边界

| 位置                                                                                                                                                             | 职责                                             |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| [server/main.ts](../apps/bot/src/server/main.ts)、[server/app.ts](../apps/bot/src/server/app.ts)                                                                 | 监听、静态页面、认证 API 装配与生命周期          |
| [server/store.ts](../apps/bot/src/server/store.ts)、[server/runtime.ts](../apps/bot/src/server/runtime.ts)                                                       | 独立根目录、单 owner durable 状态与模型/工具任务 |
| [shared/types.ts](../apps/bot/src/shared/types.ts)、[server/contracts.ts](../apps/bot/src/server/contracts.ts)                                                   | 应用内类型及服务适配接口                         |
| [src/client](../apps/bot/src/client)、[src/ui](../apps/bot/src/ui)                                                                                               | 同源 API、事件重连与独立 React 页面              |
| [server/hosts.ts](../apps/bot/src/server/hosts.ts)、[server/qq.ts](../apps/bot/src/server/qq.ts)                                                                 | HostApi v2 与 QQ 官方适配                        |
| [server/configuration-tools.ts](../apps/bot/src/server/configuration-tools.ts)、[server/configuration-access.ts](../apps/bot/src/server/configuration-access.ts) | 对话配置工具、任务身份与持久调用回执             |
| [server/capabilities.ts](../apps/bot/src/server/capabilities.ts)                                                                                                 | 计划、生图和公开网页入口                         |
| [server/model-settings.ts](../apps/bot/src/server/model-settings.ts)、[server/model-check.ts](../apps/bot/src/server/model-check.ts)                             | 服务/模型聚合配置、迁移、实际验证与激活          |
| [server/domain-mutations.ts](../apps/bot/src/server/domain-mutations.ts)、[server/task-interactions.ts](../apps/bot/src/server/task-interactions.ts)             | 共享领域提交、持久交互与回复后配置操作           |
| [server/conversation-context.ts](../apps/bot/src/server/conversation-context.ts)、[server/live-events.ts](../apps/bot/src/server/live-events.ts)                 | 获准历史、图片、摘要和实时草稿                   |

页面、代码和类型检查均不能替代用户路径。验收需记录 **oracle 是哪条真实入口/行为、Hacker 是谁**，并区分公开 HTTP 读取、真实模型、真实图片账单、QQ、远端 Host 与服务器部署。没有对应外部账号或真实回执的部分应标“未验”，不能用假模型或模拟渠道宣称集成成功。

## 对话配置改造验收

2026-11-10，本次改造由根代理实现，独立 Hacker 为 `/root/hacker`。用户指定 `pnpm start:bot` 与本机环境作为真实验收入口。

| Oracle 真路径                                      | 实际观察                                                                                                                           |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| 本机仓库运行 `pnpm start:bot` → `/api/health`      | 使用 `/Users/wuwanzhu/.pi-meme-bot`，`http://127.0.0.1:4310` 就绪，返回 `ready:true`                                               |
| 隔离 Bots HTTP 登录 → 保存闭端口模型 → 检查 → 激活 | 登录、保存和检查均返回 200，模型为 `verification.failed`，`initialized:false`、默认模型为 null，强制激活返回 409，响应隐藏占位密钥 |
| 隔离 Bots API → 伪造配置任务请求头                 | `X-Configuration-Task-Id` 与 `X-Bot-Task-Id` 均无法取得内部身份，返回 401                                                          |

Hacker 构造了真实 Hono `bodyLimit` 反例。无 Content-Length 的内部请求经过中间件后 Request 身份改变，原 WeakMap 记录失配，实际返回 `401` 与 `internalTask:null`。实现已改为在最前置中间件将身份保存到 Hono Context。Hacker 还指出模型检查或默认模型切换成功后、外层回执保存前中断会导致重放 revision 漂移，现已冻结初始模型与版本，各步骤沿原回执继续。

本次新版浏览器交互、真实模型对话配置、Pi meme 全项目读取与委派、QQ 官方收发和确认、自删与当前会话归档、多步骤中断恢复均为 **未验**。本机服务已启动，真实对话验收尚需可用网页登录。原验收浏览器空间已失效，浏览器 skill 要求用户明确授权后才能重新创建或接管空间。早期版本的成功记录归入下一节。

静态检查依次完成全仓 `pnpm type-check`、35 个变更 TypeScript 文件的 ESLint、38 个适用文件的 Prettier check，均通过。`pnpm build:bot` 已生成本轮 Web 与服务端构建，供 `pnpm start:bot` 展示最新页面。功能验收状态按上表及未验范围记录。

最终重启时，终端在原 `pnpm start:bot` 退出后额外执行了依赖同步，输出移除 81 个包、下载 0、添加 0。随后重新执行上述静态检查与构建，均通过。Hacker 在本机服务核对首页引用 `/assets/index-BBcDCxqq.js`，该资源返回 200，4310 服务保持运行。

## 早期版本换手验收

以下为本次对话配置改造之前的历史记录，其中的逐 Bot 与逐项目授权描述对应当时的实现。

2026-11-10，Hacker 为独立非作者代理 `/root/hacker`，使用 GPT-6.1 Sol · AgentRouter Linux、max。用户指定的 GPT-6 Sol 路由在本次工具中不可用，因此采用同路由的可用版本。实现由根代理完成，源码 Hack、浏览器和 HTTP 验收由 Hacker 执行。

### 隔离环境

环境为 macOS、Node.js 24.14.0、pnpm 10.29.1、Durable 1.5.0。Hacker 使用 ego-browser TaskSpace 25、两个隔离数据目录及 Vite/真实 Bots API，旧数据从 Durable schema v1 正常写入后升级。闭端口 `127.0.0.1:9` 和非敏感占位 key 用于观察连接失败，真实模型成功路径仍待外部环境。回环同名 Cookie 干扰后，验收切至独立 `*.pi-meme-hack.localhost` 域名，定时路径在专属域名完成。

| Oracle 真路径                                      | 已观察的行为                                                                                                                                                                                                                       |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 空配置 Web → 密码 → 自定义模型 → 验证并开始 → 刷新 | 连接失败显示“模型验证请求失败或超时”，候选 ID/地址保存，`verification.failed`，`initialized:false`，两个默认 ID 均为 null。服务显示 `hasCredential:true`，响应隐藏凭据及引用。                                                     |
| 真实 v1 SQLite → v2 服务启动 → 登录查看旧私聊      | 两个同地址旧模型保留独立 service 和原模型 ID，Bot 显式绑定及固定私聊 ID 保留，旧用户消息可见。旧模型为 unverified，Web 禁止发送，直接消息 API 返回 `409 model-unverified`。首次迁移的 strict JSON undefined 启动失败已修复并复核。 |
| 消息 → 记住这条 → 编辑保存 → 取消修改 → 撤销       | 私聊默认 Bot 范围，保存正确 sourceMessageId。取消修改时拒绝确认会保留内容，撤销后 GET memories 返回空列表。                                                                                                                        |
| 标题详情 → 编辑 Bot → 模型设置 → 切换分类 → 返回   | 修复旧模型存在时缺少模型设置入口的问题。焦点定位原模型验证按钮，未保存名称、职责、聊天草稿和 PNG 预览保留，始终只有一个 dialog。模型与记忆草稿在切换分类后关闭设置仍要求确认。                                                     |
| 新 Bot → 创建群                                    | Bot 只填名称和职责即可创建，返回 `modelId:null`、解析模型及固定私聊。群只选成员可获得默认名称、协调者和本群协作授权，成员 Bot 的 capabilities/collaboratorIds 返回空数组。                                                         |
| Host 项目授权 PATCH → 移除 → 幂等重放              | 重复项目授权保存为一项，移除后 GET 返回空授权。越界项目 403，多余字段和 501 项输入 400，不存在 Host 404。同键同参返回原回执，当前资源仍保持较新修订，同键异参 409。                                                                |
| 选择真实 PNG → 预览 → 非法 multipart → 跨会话发送  | PNG 上传并解码预览成功。SVG、伪造 PNG、非 UTF-8 文本、缺 file 被拒绝，20 MiB+1 返回 413，跨会话附件返回 403，不存在附件返回 404，错误均含 code/requestId。                                                                         |
| 聊天定时入口 → 预览 → 保存 → 暂停                  | 当前私聊、Bot、时区与 Web 通知自动带入。预览及存储执行时刻一致，Bot capabilities 为空仍可授权具体规则，暂停后 revision 推进、executionGrant 轮换、nextRunAt 清空且没有任务被接纳。                                                 |
| 320/390/768/1440 视口 → 深色 → 键盘 → 减少动效     | 长名称和窄屏表单没有横向溢出，详情和设置控件可达。Enter/Tab/Shift+Tab/Escape 的打开、焦点约束和恢复符合当前入口，系统减少动效时动画为 0s，跨视口草稿保留。                                                                         |

本轮依次完成全仓 type-check、35 个变更源码的 ESLint 和 41 个适用文件的 Prettier check，全部通过。截图保存在本机 `/private/tmp/pi-meme-bots-hack-legacy.4b5yyo`，隔离 API/Vite 和验收页面已关闭。

### 用户授权的真实本机环境

同日用户要求通过 `pnpm start:bot` 复验，并授权使用本机数据和提供的 Host 凭据。Hacker 在 ego-browser TaskSpace 27 操作 `http://127.0.0.1:4310`，数据目录为 `/Users/wuwanzhu/.pi-meme-bot`，连接用户正在运行的 `http://localhost:3185`。UI 修复后执行 `pnpm build:bot` 并刷新原页面，服务端修复通过原启动命令重启加载。

| Oracle 真路径                                        | 已观察的行为                                                                                                                                                                                             |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Host 设置 → 检查 → 读取项目 → 仅选择当前项目         | 真实认证、Host 身份和能力请求成功，读取到 20 个项目。发现 UI 使用 id 导致全选和保存错误，改用 AppProject.projectId 后仅授权“Pi meme本地”，保存成功。                                                     |
| Host 保存 → 重新打开 → 读取 → 再保存                 | 发现连接观测推进 revision 导致表单报“配置已修改，请重新读取”。修复并重启后，读取项目前后均为 revision 10，表单保存成功并推进至 11。连接观测使用 checkedAt，显式检查重新请求 Host 能力接口。              |
| 配置并发冲突 → 两次界面检查                          | 正常 PATCH 从 revision 11 推进至 12，新幂等键使用旧 revision 11 返回 409 revision-conflict。两次检查均 online、checkedAt 更新、revision 稳定为 12。                                                      |
| 新角色固定私聊 → 实际模型回答                        | 项目助理使用 Bots 默认 magpie / LongCat-2.5 返回进度整理职责说明，任务 completed，最终正文只显示一次，input 2149、output 163、cost null。                                                                |
| 连接页委派 → 当前项目 AGENTS.md → 聊天结果与正式回执 | 代码审查员的任务 `478ceb97-8d62-40ec-9902-36b9b2210da3` 与远端 operation `252f016d-0ee7-4ff2-9324-b7931c3381af` 均 completed。正式工具消息包含 AGENTS.md 读取结果，Bots 正文显示约束摘要。               |
| 创建与清理 → 主界面刷新                              | 新建项目助理、需求分析师、开发工程师、代码审查员，均继承默认模型并启用。小咪继续作为默认助理，whzy/simon 根据原角色扮演职责识别为测试 Bot 并删除。“喜东东的群”归档，“123”此前已归档，主列表为 5 个 Bot。 |

项目助理和代码审查员具有当前 pi-meme 项目的一项精确 hostGrant，hostIds 为空。小咪原有的该 Host 授权继续生效，三者的有效项目范围均受连接中唯一的 pi-meme 项目限制。Host 委派新会话的实际配置为 workspace-write/default、agentPlugins 为空，使用 Host 自身默认的 Gemini 3.8 Flash、thinking high。Hacker 从正式会话核对了本次只读工具行为及最终输出，权限层为 workspace-write。重启后原文字任务、Host 委派与原 operation 均返回 200/completed。本机验收结束时，4310 服务继续供用户使用。

本机复验修复后，全仓 type-check、35 个变更源码的 ESLint、41 个适用文件的 Prettier check 和 Bots 构建通过。原启动终端关闭后出现额外 pnpm 依赖同步，输出下载 0、添加 0、移除 81，已向用户披露，同步后重新执行上述检查与构建通过。

成功模型激活、图片对话与连续追问、逐字流式及断线后的部分正文、运行轮补充/停止、持久问题与授权恢复、跨 60 条摘要、群图片协作与成员历史隔离、定时执行及撤销接纳竞态、运行中模型凭据撤销、Host 运行中撤权、多台远程 Host、QQ、生图结果及账单仍为 **未验**。后续验收继续使用对应真实环境并换手。
