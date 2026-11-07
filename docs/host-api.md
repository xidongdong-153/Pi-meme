---
description: 'HostApi v3 的稳定目标、HTTP 控制、幂等提交、回执、事件补读和 Node 客户端'
status: implemented
paths:
  - 'packages/contracts/src/app-host.ts'
  - 'packages/contracts/src/model-config.ts'
  - 'packages/models/src/server/model-service.ts'
  - 'packages/contracts/src/image-generation.ts'
  - 'packages/contracts/src/image-library.ts'
  - 'packages/contracts/src/goal.ts'
  - 'packages/contracts/src/plugin-ui-data.ts'
  - 'packages/contracts/src/plugin-ui-message.ts'
  - 'packages/host/src/app-control.ts'
  - 'packages/host/src/control-store.ts'
  - 'packages/goals/src/server/service.ts'
  - 'packages/host/src/workspace-files.ts'
  - 'packages/host/src/terminal-service.ts'
  - 'packages/contracts/src/service-activity.ts'
  - 'packages/activities/src/server/service.ts'
  - 'packages/client/src/app-host-client.ts'
  - 'packages/client/src/node-host-client.ts'
---

# HostApi v3

本文描述当前正式接口契约，不代表本轮运行验收。认证、执行硬顶和破坏性升级见 [权限控制与版本迁移](permissions-and-migration.md)。公共类型在 [app-host.ts](../packages/contracts/src/app-host.ts)，实现位于 [app-control.ts](../packages/host/src/app-control.ts)。外部应用通过认证客户端调用显式目标接口；SDK 4 插件只使用受限 broker 和声明式 UI，不取得完整 context.host、内部 Store、SessionPool 或 Worker。

## 稳定目标与接口组

`apiVersion` 固定为 3。`ProjectRef = { hostId, projectId }`，`SessionRef = { hostId, sessionId }`，`WorkspaceRef` 接受二者之一。Host 身份在 `host-id`，项目、会话与操作记录持久化于 `state/control/`（快照与追加日志；旧版本为单个 `control.json`，详见 [数据目录与存储](storage.md)）。

操作指定目标，不读取或改变客户端的界面选择。会话创建立即持久化身份，首次生成 Pi JSONL 后补充文件绑定；内部 `sessionKey` 不作为公开持久 ID。

| 接口组            | 已实现操作                                                                                                                                                                                     |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `capabilities()`  | Host 身份、API 版本、功能及可选文件操作能力                                                                                                                                                    |
| `models`          | `list`，查询当前 Host 可用模型，仅读取                                                                                                                                                         |
| `imageGeneration` | `getConfig`、`saveModel`、`deleteModel`、`setDefault`、`test`，图片模型配置与显式生图测试                                                                                                      |
| `plugins`         | `getDefaultAgentPlugins`、`setDefaultAgentPlugins`                                                                                                                                             |
| `projects`        | `list`、`register`、`get`                                                                                                                                                                      |
| `sessions`        | `create`、`list`、`get`、`attention`、`markRead`、`snapshot`、`history`、`messages`、`message`、`configure`、`submit`、`stop`、`pause`、`resume`、`receipt`、`submissions`、`cancelSubmission` |
| `files`           | `list`、`read`、`preview`、`search`、`write`                                                                                                                                                   |
| `terminal`        | `open`、`attach`、`input`、`resize`、`close`                                                                                                                                                   |
| `git`             | 契约包含 `environment`、`snapshot`、`diff`；当前工作树 executor 不支持，见下文能力边界                                                                                                         |
| `interaction`     | `respond`，按根会话或子任务来源回答                                                                                                                                                            |
| `agents`          | `list`、`get`、`stop`                                                                                                                                                                          |
| `goals`           | `get`、`start`、`edit`、`pause`、`resume`、`clear`                                                                                                                                             |
| `schedules`       | `list`、`get`、`create`、`update`、`pause`、`resume`、`delete`、`runNow`、`stopRun`、`runs`、`markRead`、`resetSession`                                                                        |
| `activities`      | `list`、`logs`、`stop`，查看和停止 Agent 启动的项目服务                                                                                                                                        |
| `plans`           | `list`，读取已保存计划                                                                                                                                                                         |
| `events`          | `read`、`subscribe`                                                                                                                                                                            |

完整参数与返回类型以 [HostApi](../packages/contracts/src/app-host.ts) 为准。`sessions.history` 使用 `offset/limit`，默认 100 条、最大 500 条，返回 `totalMessages/nextOffset`。`sessions.configure` 可设置模型、思考等级、访问权限、任务模式和 `agentPlugins`；运行中拒绝变更配置。

`capabilities().features` 包含 `goals` 时，可以按 `SessionRef` 调用目标接口。`goals.start(ref, { objective, images?, skills?, sourceMessageTimestamp? }, options)` 返回 `{ goal, receipt }`；指定来源时间戳时由 Host 核对当前分支并引用原消息，正文与图片以原生记录为准。已有目标的编辑、暂停、恢复、清除需要 `goalId` 和 `revision`，旧修订会被拒绝。`edit` 只接受新正文且要求执行已停止，保留累计用量和耗时；创建和恢复均以普通模式执行，进入 Plan 会先暂停活跃目标。

目标类型见 [goal.ts](../packages/contracts/src/goal.ts)。`sessions.snapshot` 返回 `goal` 和 `goalsSupported`；`goal_updated`、`goal_cleared` 沿现有事件补读通道发送。提交回执只表示对应提交是否结束，目标是否结束以 `goal.status` 为准。目标持久化、重启恢复和 UI 操作见 [会话与协作](sessions.md#持久目标-goal)。

## 会话查看状态

`capabilities().features` 包含 `session-attention` 时，`sessions.attention(ref)` 返回该正式会话的 Host 共享查看状态，包括 `revision`、`completionToken`、`completionSource`、`inputRequestIds`、`unread` 和 `inputUnread`。读取不会标记已读。`sessions.markRead(ref, { completionToken?, inputRequestIds? }, options)` 只确认明确提交的内容，写操作携带幂等键；参数中的 token 必须匹配当前回复版本，过期时要求重新读取。交互仅确认仍属于该会话的请求 ID，不回答或取消交互。

查看记录独立于客户端和会话 JSONL，Host 持久化成功后通过内置 `sessions-changed` 广播刷新列表。`revision` 是持久查看记录的修订，不是正文修订；调用方不能将旧响应的标志拼接到新回复 token 上。正文快照的 `sessionAttention` 仅在返回消息包含对应完成版本时携带完成 token。迁移与前台查看条件见[会话与协作](sessions.md#会话与-worker-生命周期)。

## 模型目录

`capabilities().features` 包含 `models` 时，`models.list()` 返回当前 Host 可用模型的白名单投影，不依赖当前界面选择或执行会话。每项包含 `provider/id/name`，以及可选的 API 协议、思考能力和档位、上下文、输出上限、输入类型；不返回 Base URL、请求头、API Key、凭据或文件路径。类型见 [model-config.ts](../packages/contracts/src/model-config.ts)。

第三方注入的模型归入普通自定义提供商，沿用提交的提供商 ID 和上游模型 ID。配置读写复用已有的认证 RPC，具体参数见[第三方注入自定义提供商](configuration.md#第三方注入自定义提供商)。`HostApi.models` 只提供查询，接入已有 Host 时先查询 capabilities，缺少 `models` 能力时不要调用该组。

```ts
const capabilities = await client.capabilities()
if (capabilities.features.includes('models') && client.models) {
  const models = await client.models.list()
  // 用返回的 provider 与原始 id 配置显式目标会话。
  console.log(models.map(({ provider, id }) => ({ provider, id })))
}
```

## 图片模型配置

`capabilities().features` 包含 `image-generation` 时，`imageGeneration` 提供当前 Host 的图片模型配置。类型见 [image-generation.ts](../packages/contracts/src/image-generation.ts)。`getConfig` 返回修订、默认配置 ID、模型列表与凭据是否存在，不返回 API Key。`saveModel`、`deleteModel`、`setDefault` 携带读取时的 `revision`，不使用 `MutationOptions`，过期修订被拒绝。

`test(id)` 只允许已认证用户直接发起，独立于当前选中会话的只读/Plan 设置；它明确指定配置并实际生成一张测试图，可能产生费用，不自动重试。所有非用户主体均拒绝，Agent 生图和编辑使用绑定当前任务预算与模式的 Worker 桥接。

测试使用当前授权租约的取消信号，撤权会取消实际请求和响应读取；已送出的请求仍可能产生费用，未知结果不能自动重试。返回原生图片与 Host 附件路径；它不修改默认模型，也不验证编辑能力。设置调用不进入 ControlStore 的操作回执或日志，授权日志仍记录对应 lease，凭据单独保存。

## 消息查找与分页

SDK 4 的公共消息数据沿用原生条目身份与分页投影；正式接口已升级为 HostApi v3，权限迁移见 [权限控制与版本迁移](permissions-and-migration.md)。公共类型见 [plugin-ui-data.ts](../packages/contracts/src/plugin-ui-data.ts)，可见内容转换见 [plugin-ui-message.ts](../packages/contracts/src/plugin-ui-message.ts)。

- `sessions.messages(ref, { offset?, limit?, cursor? })`：读取当前原生分支的公共消息投影，默认 100、最大 500 条。返回 `messages/totalMessages/nextOffset/nextCursor/branchRevision/leafId`。
- `sessions.message(ref, { entryId })`：按原生条目 ID 查单条消息。内置共享界面的引用使用 `MessageRef = { session: ref, entryId }`，不表示 SDK 4 声明式插件获得任意消息读取能力。
- `messages` 每项包含角色、状态、内容 revision、来源插件与 generation、工具或自定义类型，以及可见 `text`、JSON `data` 和图片元数据。不返回隐藏 thinking、技能展开全文、原始 Pi 对象或图片 base64。
- 持久 ref 只对应原生 `message/custom_message`；流式内容和压缩、分支摘要等合成内容不伪造可操作 ref。assistant 聚合回复保留多个真实 refs，不分配虚构聚合 ID。
- cursor 绑定 session、由 leaf 与消息 sourceEntry 计算的 branch revision，以及下一页 offset；分支或 context edit 改变后返回 `stale-cursor`，调用方应重新读取，不能拼接不同分支。

旧 `sessions.history` 的 offset 接口继续用于既有历史功能。这里改善公共数据契约与 UI 的按需读取，不承诺 JSONL 随机 IO；Host 仍可能读取原生文件并构建分支投影。插件消息动作不提供通用历史修改、删除或工具重跑接口。

## HTTP 与认证

认证、HTTPS 和来源检查见 [Remote](remote.md#认证与连接恢复)。正式控制入口是 `POST /api/control`，内置界面的 `/api/rpc` 继续保留；事件订阅使用 WebSocket `/api/control/events`。

以下请求使用示例身份，实际调用前先从 Host 取得目标 Ref：

```json
{
  "apiVersion": 3,
  "hostId": "example-host",
  "clientId": "example-app",
  "method": "sessions.submit",
  "args": [
    { "hostId": "example-host", "sessionId": "example-session" },
    { "delivery": "start", "text": "检查项目状态" }
  ],
  "idempotencyKey": "external-message-42"
}
```

`clientId` 为非空字符串，最多 128 字符；传入 `hostId` 时必须匹配连接目标。业务响应为 `{ hostId, result? , error?: { code, message } }`，控制接口的业务失败也可返回 HTTP 200，调用方必须检查 `error`。`events.subscribe` 不通过该 HTTP method 调用。

## 幂等操作

除上述图片配置与测试接口外，写操作携带 `MutationOptions = { idempotencyKey, expected? }`；HTTP 请求将键和比较前置条件放在顶层。`expected` 可包含 operationId、runId、policy 或 schedule 的任务/运行/授权修订，仅用于比较当前状态；它不能配置会话或授予权限。认证 principal 来自通道身份，请求体 clientId 不能覆盖它。键长度为 1–128 字符，在认证身份隔离后的客户端 namespace 内按 idempotencyKey 去重；namespace 由 principalId、installationId 与调用者 clientId 绑定。重新登录或配对可能改变 installationId，不能假定跨身份沿用旧 namespace：

- 相同键和相同方法、参数返回已保存结果；并发调用等待同一次操作。
- 同键不同内容返回 `idempotency-conflict`，缺失或无效键返回 `invalid-key`。
- 已失败或中断的操作不重新执行；中断提交可读取已有回执。

[ControlStore](../packages/host/src/control-store.ts) 保存请求摘要、操作结果、回执与关键事件，不把终端输入正文存入控制日志。客户端遇到网络不确定时用相同键查询或重试，不为同一外部事件生成新键。

这层控制请求 namespace 与工具执行身份不同。固定 SDK 把真实持久 Native session、assistant entry、唯一工具槽位绑定为 `toolop:v1:<SHA-256>`；嵌套调用绑定私有父 operation 与 Native ordinal，原 provider callId 保留用于 Native 路由与 entry 内槽位核对，不能独立用作全局去重。Host 同一授权 journal 跨 registration/principal 阻挡已记录工具的重放；boot/registration 不进入逻辑键，但在途调用仍核对原注册归属。

授权 journal 现为 format 2，旧未发布开发 format 1 缺可信工具映射，明确拒恢复并保留原日志，不猜迁移或自动删除；64 MiB 安全读取上限不通过裁剪幂等记录绕过。控制请求和工具准入均不承诺不同 Host/dataRoot 或任意外部效果全局 exactly-once。详情见 [单次授权、幂等与撤销](permissions-and-migration.md#单次授权幂等与撤销)。

```mermaid
sequenceDiagram
  participant C as App 客户端
  participant H as Host
  participant L as state/control/
  participant P as Pi Worker
  C->>H: submit：SessionRef、输入、幂等键
  H->>L: 保存操作与提交回执
  H-->>C: operationId 与 submissionId
  H->>P: 调度目标会话
  P-->>H: 执行事件
  H->>L: 保存关键状态
  H-->>C: 状态事件与实时输出
  C->>H: 断线后按游标补读
  H-->>C: 关键事件或 resync
```

## 提交与回执

`SubmissionInput` 包含 `delivery`、非空 `text`，以及可选 `images`、`skills`、`mode`。模式为 `default` 或 `plan`，每次提交独立保存。

| delivery | 调度规则                                         |
| -------- | ------------------------------------------------ |
| `start`  | 会话空闲时启动；运行中拒绝                       |
| `queue`  | 运行时入队，空闲后调度；空闲且未暂停时可直接启动 |
| `steer`  | 向正在运行的任务投递；空闲时拒绝                 |

回执状态包含 `accepted`、`queued`、`running`、`completed`、`failed`、`cancelled`、`interrupted`。`operationId` 用于 `sessions.receipt`，`submissionId` 标识一次提交；运行关联建立后提供 `runId`，steer 与当前运行关联。

`cancelSubmission` 只撤销排队提交，已投递任务需停止会话；`sessions.stop` 中断当前运行并撤销未投递队列。`pause/resume` 控制会话暂停与后续调度。

pause 会结束原 submit attempt；原 `sessions.receipt(operationId)` 永久保持 `interrupted`。显式 resume 发送新的 custom continuation，继续同一逻辑任务的 rootTask/epoch/run，保留原权限 ceiling 与预算计数 key。恢复完成不能将旧 receipt 改为 `completed`，当前逻辑任务状态应看 agents/root/run，而不是等待旧提交回执复活。

Host 用私有 authorization generation 与 await 后 context 校验隔离旧执行，SDK 用 run ticket、按运行绑定的 facade 与旧 signal 取消阻断旧回调。旧模型 I/O 尚未 drain 时新请求快速拒绝；暂停恢复不会清除用户撤权。停止或 interrupted 也不证明远端计算、计费或外部副作用已经停止/回滚。来源：[app-control.ts](../packages/host/src/app-control.ts)、[coordinator.ts](../packages/subagents/src/server/coordinator.ts)、[SDK session](../packages/pi-runtime/src/sdk/session.ts)。

`sessions.stopTask` 中断当前任务并保留未投递队列。之后的 `start` 输入独立执行，`continueTask` 只继续当前任务；两者都不释放旧队列。调用 `sessions.resume` 后才继续投递这些排队提交。

Host 退出或重启将未完成提交记为 `interrupted`，不重放任务。`outcomeUncertain` 表示关闭前已经开始投递；未投递队列为 false。收到受理回执不能视为任务成功，需读取回执或订阅状态事件。

## 快照与事件恢复

`sessions.snapshot(ref)` 返回 `controlCursor`。订阅参数为 `EventSubscription`，支持 `projectId/sessionId/terminalId/after`，通过 WebSocket 查询参数 `subscription` 传入 JSON；`clientId` 单独传入。

游标是 `{ journalEpoch, seq }`，关键事件还有 `eventId`、Host/项目/会话、时间与运行关联。[ControlStore](../packages/host/src/control-store.ts) 保留最近 4096 条关键事件；过期、跨 epoch 或超前游标要求重读快照：`events.read` 返回 `resyncRequired`，WebSocket 发出 `resync`。

客户端从快照游标订阅，缓冲读取期间的事件并处理重复投影。token 和终端输出使用 `stream: live`，不写入控制日志、不推进补读游标；聊天正文以 Pi JSONL 为准，终端用 `terminal.attach` 读取当前输出快照。事件日志不能恢复全部 token 或超出终端缓冲的输出。

## 文件与终端

文件操作使用显式目标的工作目录内相对路径；`preview` 额外接受该工作目录内的绝对路径，以及当前 Host 附件目录内的图片绝对路径，用于显示 Agent 截图和上传图片。工作目录的配置路径与解析后的真实路径均可使用，符号链接目标仍须留在对应允许目录内。[workspace-files.ts](../packages/host/src/workspace-files.ts) 校验目标、路径与真实符号链接目标，拒绝越界：

- `preview` 分类返回文本、图片或不支持原因；附件预览只读取数据目录 `data/attachments/` 内的图片，拒绝符号链接根目录与越界链接，不允许读取附件文本或修改附件。`search` 按文件名搜索并返回分页游标。
- `write` 只保存现有 UTF-8 文本文件，携带读取时的 `revision` 和幂等键，按身份与内容 CAS 拒绝已变化的目标。实际 typed writer 在同一经验证的 `O_RDWR` FD 上原地写入、截断、fsync 和哈希校验，不做临时文件 rename；取消可能留下部分或完整内容，不能承诺原子替换或回滚。
- 文本读取/保存上限为 1 MiB，图片上限 8 MiB；保存保留 BOM、LF/CRLF 与文件权限。
- `capabilities().fileOperations` 用于协商 `preview/search/write`，旧 Host 未提供该字段时文件面板保持只读。

文件/目录读取使用 [controlled reader](../packages/pi-runtime/src/sdk/controlled-file-read.ts) 的窄能力；macOS 目录 `expected` 身份验证不支持，不能由预检查声称祖先 ABA 已被完整证明。底层 writer 的 `expected` 必填，新增文件用 `null`；公共 `files.write` 仍只写已有文件，由 Host 绑定该批准对象。完整边界见 [权限控制与版本迁移](permissions-and-migration.md#平台能力与未验范围)。

终端由 [terminal-service.ts](../packages/host/src/terminal-service.ts) 使用 `node-pty`，界面使用 xterm.js。Owner PTY 的 open/input/resize/close 仅允许真实用户来源；Agent 不能凭同一 SessionRef、父能力或声明 user 身份调用。每个 Host 最多 16 个活动终端，单终端保留 256 KiB 输出，单次输入最多 64 KiB。能力不可用时 `capabilities().features` 不包含 `terminal`。

隐藏面板、关闭右侧标签和切换会话保留 PTY；显式关闭终端实例或 Host 退出才关闭进程。重新附着读取输出序号与缓冲，重启不恢复 PTY 进程。

Git 契约存在不表示 executor 可用：status/diff/checkout/switch/worktree 当前明确 unsupported，availability 也会执行 status，因此相关 UI 可显示不可用。changed-turn undo 尚缺受控 restore 后端，不通过旧记录路径直接恢复。来源：[safe-git-command.ts](../packages/git/src/server/safe-git-command.ts)、[git-service.ts](../packages/git/src/server/git-service.ts)、[turn-change-store.ts](../packages/pi-runtime/src/turn-change-store.ts)。

## Agent 项目服务

`capabilities().features` 包含 `activities` 时，可按正式 `SessionRef` 管理所属根会话的受管服务，包括子 Agent 启动的服务：

- `activities.list(ref)` 返回 `activities`、列表 `revision` 和 `cursor`。服务包含名称、命令、目录、来源、状态和启动/结束信息；进程存活不代表应用健康。
- `activities.logs(ref, serviceId)` 返回有界日志尾部 `output`、`sequence` 和 `truncated`，不创建终端。
- `activities.stop(ref, serviceId, options)` 使用幂等键停止指定服务，返回服务状态。目标不匹配会被拒绝；已经结束的服务返回当前结果，不执行其他命令。

启动仅由可信 Agent 请求桥处理，用户停止不走 `sessions.submit` 或模型续跑。服务不随 UI、Worker 或 Agent 单轮结束而终止，Host 正常退出统一清理。

状态变化使用 `type: activity` 的最小失效通知，包含服务标识和修订，可沿事件游标补读；收到后重新读取列表。日志通知走 `stream: live`，只携带服务标识和日志序号，不写入控制日志；查看日志的客户端再读取日志尾部。重连或 `resync` 后重新读取列表，不能仅凭旧服务标识认定 Host 重启后的进程仍存在。

活动运行态和日志不跨 Host 重启恢复，不支持按任意 PID 或端口接管进程。契约见 [service-activity.ts](../packages/contracts/src/service-activity.ts)，生命周期见 [会话与协作](sessions.md#当前活动项目服务)。

## Node 客户端

[createNodeHostClient](../packages/client/src/node-host-client.ts) 不依赖 Electron 或浏览器全局状态。调用应用自行提供 WebSocket 实现；以下示例假定调用应用已安装 `ws`，`PI_HOST_URL/PI_HOST_TOKEN` 是示例客户端参数，不是 Server 配置变量。

```ts
import WebSocket from 'ws'
import { createNodeHostClient } from '@pi-meme/client/node-host-client'

const url = process.env.PI_HOST_URL
const token = process.env.PI_HOST_TOKEN
if (!url || !token) throw new Error('请设置 PI_HOST_URL 和 PI_HOST_TOKEN')

const host = await createNodeHostClient({
  url,
  token,
  clientId: 'example-app',
  webSocket: (address, headers) => new WebSocket(address, { headers }),
})
try {
  const project = (await host.projects.list())[0]
  if (!project) throw new Error('请先登记项目')
  const session = await host.sessions.create({ project }, { idempotencyKey: 'create-task-42' })
  const receipt = await host.sessions.submit(
    session,
    { delivery: 'start', text: '检查项目状态' },
    { idempotencyKey: 'external-message-42' },
  )
  const current = await host.sessions.receipt(receipt.operationId)
  console.log(current.status)
} finally {
  host.dispose()
}
```

客户端处理 Cookie 登录、401 续期、事件重连和序号去重，拒绝 Host 身份变化。远程地址要求无账号信息的 HTTPS，本机回环允许 HTTP。示例只查询当前回执，不等待执行完成；同一业务操作重试时保留幂等键。

定时任务通过 `capabilities().features` 中的 `schedules` 协商能力，使用 `{ hostId, taskId }` 定位。写操作沿用幂等键，变化通过 `schedule` 控制事件推送；运行执行复用显式会话接口。规则、恢复和接口参数见 [定时任务](schedules.md)。

## 会话上下文窗口

`capabilities().features` 包含 `context-window` 时提供可选的 `contextWindow`。`list/get` 读取真实请求摘要，`item/reply` 返回正文索引元数据，`piece/image` 显式读取分页文本或受限内联位图。首个参数始终是明确的 `SessionRef`，复用临时会话授权及删除校验。`context-window` 控制事件只携带请求 ID 和修订，客户端重新读取摘要，不在事件中传输正文。读取、缓存未知值、容量来源和归档限制见[会话上下文窗口](context-window.md)，契约见[context-window.ts](../packages/contracts/src/context-window.ts)。

## 图像库

`capabilities().features` 包含 `image-library` 时提供 `imageLibrary`，类型见 [image-library.ts](../packages/contracts/src/image-library.ts)。

- `list({ projectId?, query?, cursor?, limit? })` 返回作品元数据、项目筛选项和历史补录状态。默认每页 40 项，最多 100 项；`projectId: 'standalone'` 筛选独立聊天，省略则查询全部项目。`query` 匹配名称和提示词，游标只用于相同筛选条件。
- `read(id)` 按作品 ID 返回 PNG 的 `dataUrl` 和字节数，不依赖来源会话。Host 校验原图位于附件目录且不经过符号链接，最大 8 MiB。
- `rename(id, name, options)` 修改展示名，名称为 1～120 个字符。
- `remove(id, options)` 持久保存移除标记，不删除附件。修改操作使用现有 `MutationOptions` 幂等键。

作品收录、重命名、移除和历史补录结束发送 `image-library` 实时事件。客户端收到事件后重新读取列表，连接恢复时同样重读；事件不包含图片数据。旧版本 Host 不具备此 capability，客户端不应调用该接口组。
