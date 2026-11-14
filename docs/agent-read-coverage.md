---
description: 'Agent 内置读取覆盖、设置入口映射、纯读取边界与真路径验收标准'
status: implemented
paths:
  - 'packages/host/src/system-operations.ts'
  - 'packages/host/src/system-read-schemas.ts'
  - 'packages/host/src/session-read-operations.ts'
  - 'packages/host/src/system-settings-reads.ts'
  - 'packages/host/src/system-resource-reads.ts'
  - 'packages/host/src/system-read-results.ts'
  - 'packages/contracts/src/system-read.ts'
  - 'packages/contracts/src/system-client-reads.ts'
  - 'packages/app-ui/src/session/system-ui-snapshot.ts'
---

# Agent 读取覆盖

本页将现有内置业务与 `system_read` 操作对应，记录来源、作用域和读取边界。它描述源码实现，不能代替独立真路径验收。当前可发现操作以分页 `capabilities` 为准，参数、结果及限制以 `capabilities.describe` 为准；目录项存在不表示目标已加载、客户端已连接或配置已启用。

## 查询与完整性

```ts
system_read({ operation: 'capabilities', args: [{ write: false, limit: 50 }] })
system_read({ operation: 'capabilities.describe', args: ['sessions.history'] })
```

目录支持 `domain/scope/write/query` 筛选，返回 `operations/total/revision/nextCursor/observedAt`。保持筛选条件，用 `nextCursor` 继续查询。`available` 表示当前 Host 或发起客户端支持该操作，`allowed` 表示当前任务的读写权限；目标权限与启用状态在实际读取时再次检查。两者不能用来推断网络连通、凭据有效或历史完整。

共有三种续读方式，不能混用偏移单位：

| 返回           | 下一步                             | 边界                                                                      |
| -------------- | ---------------------------------- | ------------------------------------------------------------------------- |
| `nextCursor`   | 保持目标与查询条件，携带游标       | 游标绑定查询、可见范围与数据修订；变化后重新查询                          |
| `nextOffset`   | 保持目标、`revision`，使用返回偏移 | 通用正文为 JavaScript 字符串偏移；`files.readPiece` 为 UTF-8 **字节**偏移 |
| `continuation` | 调用返回的 `results.read` 参数     | 拼接 `content` 后解析完整 JSON；每次重新校验原目标权限                    |

通用列表最多每页 100 条，业务可使用更小限制；通用正文最多 20000 字符，工具最终按序列化 UTF-8 文本限制为 48 KiB。图片单独使用原生图片内容，支持 PNG、JPEG、GIF、WebP，最多 8 MiB。文本不从 JSON 中间截断。

`results.read` 仅保留当前执行身份的内存快照，访问期限 5 分钟；整个 Host 最多 32 个结果、64 MiB。执行变化、权限变化、结果淘汰或原来源修订变化时返回过期错误。它不是持久文件地址，也不允许任意对象路径读取。没有业务修订的来源按捕获快照续读，不冒充实时列表。

规范错误码为 `invalid-input`、`not-found`、`not-supported`、`not-loaded`、`disabled`、`disconnected`、`permission-denied`、`stale-cursor`、`cancelled`、`timeout`、`internal-error`。`system_read` 错误以 `{error:{code,message}}` 返回；未知底层异常转换为固定安全提示。

## 业务覆盖

| 用户入口或对象        | 主要读取操作                                                                                              | 来源与边界                                                                               |
| --------------------- | --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| 项目列表与详情        | `projects.list/get/deletePreview`                                                                         | Host 项目登记、置顶、删除范围；不登记新项目或切换界面                                    |
| 会话列表与查询        | `sessions.list/get/query/search`                                                                          | 已登记会话；查询先过滤归属再分页，搜索逐页扫描可见正文                                   |
| 当前会话与历史        | `sessions.snapshot/history/messages/message`                                                              | 已有运行态或保存历史；不恢复 Worker、不修改查看状态                                      |
| 会话树与条目          | `sessions.tree/entry`                                                                                     | 原生 entry ID、分支结构和公共正文投影；未知内部条目标记 `protected`                      |
| 会话输入与附件        | `sessions.queue/interactions/sources/image`                                                               | 已保存或排队输入、待答交互、附件元信息；图片显式读，不取出队列或确认交互                 |
| 会话统计与查看        | `sessions.stats/attention`                                                                                | 已有统计、估算和提醒；未观察到的统计明确不可用，不标记已读                               |
| 提交与事件            | `sessions.receipt/submissions`、`events.read`、`sessions.events`                                          | 回执与原生队列分别读取；保留事件游标，不新建订阅                                         |
| 子代理与协作          | `agents.list/get/messages/events/mailbox`                                                                 | 限所属根会话；只查看已有快照，不恢复任务或消费邮件                                       |
| 保存计划与目标        | `plans.list/history/get`、`goals.get`                                                                     | 当前分支计划版本与持久目标；正文可按版本分片                                             |
| 文件与目录            | `files.list/listPage/read/readPiece/preview/search`                                                       | 会话或项目 WorkspaceRef；工作区授权、路径校验、修订和有界读取                            |
| Git                   | `git.availability/snapshot/environment/diff/review/reviewFile/reviewOptions/turnChangeSummaries/turnFile` | 本地仓库与保存轮次，不 fetch；读取关闭可选索引锁及 fsmonitor，差异关闭外部 diff/textconv |
| 终端与后台服务        | `terminal.list/read`、`activities.list/logs`                                                              | 有权访问的现存终端与服务；屏幕和保留输出，不创建进程或发送输入                           |
| 定时任务              | `schedules.list/get/runs/schema`                                                                          | 配置和保存运行记录；不运行、重置或确认任务                                               |
| 图像素材与可视化      | `images.list/get/read`、`visualizations.list/read`                                                        | Host 已保存产物与版本；图片保留真实 MIME，不生成或导入；当前预览状态另走客户端读取       |
| 上下文窗口            | `contextWindow.list/get/item/reply/piece/image`                                                           | 已捕获请求与归档；摘要、正文、图片分别显式查询，保留原有范围和保留策略                   |
| 资源与技能包          | `resources.list/catalog/detail/readSkill/files/file`、`commands.list`                                     | 配置资源与本轮已有命令；读取不生成执行资源快照，不加载插件                               |
| 指令与记忆            | `instructions.get/configured/captured/effective`、`memory.status/list/search/get/sources`                 | 区分保存与本轮捕获；记忆限当前项目和通用范围，关闭时不读正文                             |
| 模型、插件、Host 配置 | 见下表                                                                                                    | 配置读取与已有运行状态分别报告；不认证、不连接、不探测                                   |

`sessions.entry`、会话和子代理事件只返回公共白名单投影；隐藏思考、sealed、原始 Pi/provider 对象和原始错误正文不返回。内部 custom/context_edit 等条目保留稳定身份与允许的元信息，受保护的内部正文不伪装成空正文。

旧预览接口保留原有小文件语义。大目录使用 `files.listPage`；大 UTF-8 文件使用 `files.readPiece([{relativePath,offset?,limit?,revision?},WorkspaceRef?])`，不受旧 1 MiB 文本预览限制。保持返回的文件修订与字节偏移；文件变化、非 UTF-8、字符中间偏移及非法路径会被拒绝。

## 设置的 16 个入口

ID 与标题以 [settings-page.tsx](../packages/app-ui/src/settings/settings-page.tsx) 为准。`account` 是“个人资料”，`profile` 是“用量”，不能按英文 ID 猜业务。

| 设置 ID / 标题              | 读取操作                                                                                                  | 数据与可用性                                                                                 |
| --------------------------- | --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `general` 常规              | `settings.general`、`permissions.status`、`storage.info/status`                                           | 输入与展示开关、默认权限、执行权限、存储来源；客户端维护状态未观察时为 unknown               |
| `shortcuts` 快捷键          | `shortcuts.list`                                                                                          | 发起客户端的默认、自定义与最终绑定                                                           |
| `account` 个人资料          | `profile.get/avatar`                                                                                      | 执行 Host 的公开资料、修订；头像单独读，getter 不创建目录                                    |
| `appearance` 外观           | `appearance.get/effective`、`themes.list/get`                                                             | 外观 Host 的保存配置，以及发起客户端实际主题、系统偏好、预览与 pending                       |
| `profile` 用量              | `usage.get/summary/details`                                                                               | Host 本地统计、每日 Token、已知费用与不完整状态；不读取提供商远程账单                        |
| `models` 模型               | `models.list/providers/defaults/authStatus`                                                               | 可用目录、保存提供商、默认选择和凭据存在性；不返回地址、头、Key 或刷新认证                   |
| `image-generation` 图片生成 | `imageGeneration.config`                                                                                  | 图片模型与默认选择、配置存在性；不生图或调用测试连接                                         |
| `subagents` 子代理          | `settings.agent`、`subagents.settings/catalog`                                                            | 默认配置、定义目录和安全诊断；不启动子任务                                                   |
| `instructions` 指令         | `instructions.get/configured/captured/effective`                                                          | 保存来源、本轮捕获与生效范围；正文显式分片，捕获缺失为 unknown                               |
| `memory` 记忆               | `memory.status/list/search/get/sources`                                                                   | 开关、预算、当前项目任务及可见条目/来源；不向 Agent 提供其他项目正文                         |
| `skills` 技能               | `resources.catalog/detail/readSkill/files/file`                                                           | 技能策略、SKILL.md 和包内文件；大字段/目录分片，不创建资源快照                               |
| `plugins` 插件              | `plugins.list/get/status/dependencies/permissions/session/diagnostics/defaults`、`client.plugins.ui.list` | 安装、授权、依赖、项目状态、本轮代次、已加载 UI 元数据分别读取；不执行私有渲染或任意插件业务 |
| `mcp` MCP                   | `mcp.get/status/tools`                                                                                    | 保存配置与本轮加载信息；没有工具捕获时为 unknown，不为了查询建立 MCP 连接                    |
| `browser` 浏览器            | `browser.settings.get/history.list/downloads.list/downloads.get/permissions.list/data.status`             | 发起 Desktop 的本地浏览器档案；Web/无客户端不支持，Cookie/网站存储正文为 not-inspected       |
| `host` 远程                 | `client.connections.list/status`、`client.ssh.capabilities/list`                                          | 入口缓存连接与 SSH 管理能力；不重连、不探测、不返回 token/身份文件                           |
| `about` 关于                | `host.runtime/modules/diagnostics`、`host.capabilities`                                                   | 执行 Host、已有 Pi 运行时、装配模块与安全诊断；不以客户端所选其他服务替代                    |

补充读取包括 `tools.execution` 和 `sandbox.status`：保存的工具开关、Worker 捕获值、任务有效权限与启动时缓存的沙箱能力分别返回。配置存在性不表示正在生效；凭据存在不表示有效；未捕获工具或未观察客户端状态不以成功空列表替代。

## 发起客户端的覆盖与隔离

| 对象           | 操作                                                                                              | 读取边界                                                                                   |
| -------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| 页面与导航     | `client.state/navigation`                                                                         | 读取当前真实页面与导航状态，不跳页                                                         |
| 会话面板       | `client.panels`                                                                                   | 已保留布局、tab 和打开元信息，不挂载或恢复面板                                             |
| 输入框         | `composer.status/read/attachments/processing`                                                     | 先取得明确 ref 和草稿数字修订；只读文档 JSON、附件进度、处理状态，不发送或运行处理器       |
| 网页与批注     | `browser.list/read/screenshot/workspace/annotations.list/annotations.get/annotations.image`       | 所属会话；工作区摘要不恢复标签、不保存，批注正文和截图分开读                               |
| 外观与快捷键   | `appearance.get/effective`、`themes.list/get`、`shortcuts.list`                                   | 使用实际外观 Host 和发起客户端偏好，不按执行 Host 猜外观                                   |
| 入口与原生能力 | `client.connections.*`、`client.ssh.*`、`client.platform.capabilities`、`client.projectApps.list` | 支持状态和缓存摘要；不连接远端、打开应用或执行原生操作                                     |
| 插件 UI        | `client.plugins.ui.list`                                                                          | 已注册且已授权页面、面板、导航和动作的元数据；不返回任意 props、render 或回调              |
| 可视化预览     | `visualizations.previewState`                                                                     | client scope，绑定执行会话和真实版本引用；返回状态与 `live/saved/initial` 来源，不挂载面板 |

`visualizations.previewState([{id,revision}])` 读取发起客户端的状态；Host 先校验执行会话、临时会话归属与当前分支引用，不取前台选中会话。来源为 `initial` 的值只是保存初值，不冒充用户已操作的状态；读取不重置、不保存、不发起聊天。`visualizations.list/read` 仍是 Host 保存产物的会话范围读取，两类来源不能混用。

相关写操作 `visualizations.export([ref,{format:'png'|'html'}])` 同为 client scope 并绑定执行会话，沿用完全权限要求。它发起客户端下载当前状态；PNG 需要已挂载且就绪的可见预览，否则返回 `not-loaded`，不为了导出自动挂载。HTML 含离线运行时和当前状态，成功结果只表示下载已发起；导出不属于纯读取。标题、PNG 复制/下载、放大和反馈属于宿主 UI，片段不提供业务 API。旧 Host 走既有预览回退，不伪装支持新增能力，详见 [可视化](visualize.md)。

执行 Host、外观 Host、本地浏览器 Host 和发起客户端是不同来源。浏览器档案中的历史、下载、权限为该客户端共享档案；会话网页、批注和输入框仍校验明确会话身份。下载不返回本机路径，元数据 URL 移除 userInfo、query、fragment。

Host 在提交时固定客户端连接、注册与文档代次。sessionStorage 中的 `clientId` 保持重载归属；新的 WebSocket 有独立 `connectionId`，登记具有 `registrationId/documentGeneration`。请求、回执、卸载与断线都校验完整身份；同 ID 的另一连接不能抢注册、代答或提交原窗口任务。缺少客户端、断线、能力未登记或目标过期时明确失败，不转发到另一窗口或机器。

客户端读取最长等待 30 秒。草稿 ref、修订、页面注册或连接变化后旧读取失效；没有合适输入框时不回退到其他会话的草稿。真实 Desktop IPC、原生截图和平台专用行为仍需对应平台真路径验收。

## 纯读取与验收

读取链路使用已有运行时的 peek、纯内存投影、磁盘读取和本地只读 Git。目录刷新、模型目录捕获、执行资源快照和 Worker 初始化属于 Host 启动、配置更改或执行生命周期；读取入口不触发这些动作。冷历史索引仅在内存建立，不等待或写入后台索引文件。读取不确认交互、不消费邮件、不标记已读、不保存浏览器工作区、不初始化插件或 MCP、不调用模型或探测网络。

实现入口：

- [操作注册与路由](../packages/host/src/system-operations.ts)、[原有操作输入 schema](../packages/host/src/system-read-schemas.ts)、[共有分页和正文约束](../packages/contracts/src/system-read.ts)。
- [会话公共投影](../packages/host/src/session-read-operations.ts)、[配置读取投影](../packages/host/src/system-settings-reads.ts)、[资源读取](../packages/host/src/system-resource-reads.ts)、[长结果续读](../packages/host/src/system-read-results.ts)。
- [客户端读取契约](../packages/contracts/src/system-client-reads.ts)、[界面快照](../packages/app-ui/src/session/system-ui-snapshot.ts)、[连接与注册隔离](../packages/host/src/system-client-bridge.ts)。

验收必须换手。作者提供实现和静态检查，独立 Hacker 使用真实界面、Agent 对话、Host 输出与临时业务数据寻找反例，并记录 oracle、人员、具体输入/输出和未验范围。重点包括保存 JSONL 的冷读取前后文件与资源快照不变、分页还原、超长与非法参数、权限变化、其他窗口临时会话、断线与旧回执、关闭恢复时首次浏览器工作区读取、历史查询不清空、双 Host 草稿身份和图片 MIME。

单个 helper 的实调只能证明该函数行为，不能写成 Agent 或 Desktop 链路已通过。目录数量、静态检查或注册完成不能作为全覆盖验收结论。一次性证据存放 `out/tests/` 等不提交目录，未运行的平台与路径标为“未验”，不在项目文档堆积临时会话 ID、令牌或验收流水。
