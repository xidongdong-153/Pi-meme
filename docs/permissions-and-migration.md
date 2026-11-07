---
description: '统一权限控制的身份、执行授权、平台能力、开发快照与破坏性迁移说明'
status: implemented
paths:
  - 'packages/contracts/src/authorization.ts'
  - 'packages/contracts/src/app-host.ts'
  - 'packages/contracts/src/host-runtime.ts'
  - 'packages/contracts/src/transport-identity.ts'
  - 'packages/contracts/src/execution-capabilities.ts'
  - 'packages/permissions/**'
  - 'packages/host/src/authorization.ts'
  - 'packages/host/src/model-broker.ts'
  - 'packages/host/src/runtime-snapshot.ts'
  - 'packages/pi-runtime/src/sdk/**'
  - 'apps/desktop/src/main/browser/**'
  - 'apps/desktop/src/main/remote-auth.ts'
  - 'apps/desktop/src/main/main.ts'
  - 'packages/windows-native/src/controlled-read.ts'
  - 'packages/windows-native/native/src/controlled_read.rs'
  - 'packages/git/src/server/**'
  - 'packages/host/src/terminal-service.ts'
  - 'packages/mcp/src/server/**'
  - 'scripts/development-runtime.mts'
  - 'scripts/build-development-runtime.mts'
  - 'packages/plugin-sdk/src/manifest.ts'
---

# 权限控制与版本迁移

本文记录源码中的权限路径、兼容边界和已完成的有限换手验收。源码接线不等于平台保证；文末证据只覆盖列明的 Darwin / Node.js 24.14 路径，不代表 Windows、Linux 或发布验收通过。

## 版本边界

| 契约                      | 当前版本 | 迁移要求                                                             |
| ------------------------- | -------- | -------------------------------------------------------------------- |
| 正式 HostApi              | v3       | 客户端按 v3 请求，写操作核对当前目标和比较前置条件                   |
| Host runtime protocol     | 2        | Desktop、Server、已有 Host 的复用检查须匹配，不把旧实例当兼容实例    |
| 外部 App SDK              | 4        | Agent/Server 仅 restricted，UI 仅声明式 JSON；旧 JS 需重建并重新授权 |
| 外部受限 runtime protocol | 2        | 使用同版 Host runner，不复用旧协议进程                               |
| 内置 Builtin modules      | 3        | 属于静态内置装配契约，不是外部 App SDK 版本                          |

版本来源：[HostApi](../packages/contracts/src/app-host.ts)、[Host runtime](../packages/contracts/src/host-runtime.ts)、[manifest](../packages/plugin-sdk/src/manifest.ts)、[受限 runner](../packages/plugin-runtime/src/restricted-runner.ts)。迁移外部插件不能把内置模块版本也改成 4。

## 认证身份与代理

回环地址、Host、Origin 和请求体 `clientId` 都不能替代身份凭据。`POST /api/auth` 只接受有效显式 token、有效单次启动票据，或延续已经认证的 Cookie。伪造 localhost 来源不会得到 owner 身份。

- 独立 Server：使用明确 token；浏览器首次登录输入令牌，不能再依靠旧的 loopback 自动登录。
- Desktop owned：仅创建该 Host 的可信父进程取得短时单次票据，用于建立当前连接。票据不能通过公共 HTTP 接口签发，也不能作为长期 token 保存或写日志。
- Desktop attached：复用已有 Host 不取得其启动票据；通过显式令牌配对，保存的配对材料位于 Electron 私有目录。认证过期或失效后重新配对。
- 同源前端代理：HTTP/WS 只转发当前调用者携带的目标 Host 命名空间 Cookie，移除其他 Host 命名空间和旧保留名，保留普通 Cookie；不注入上游 owner 凭据。未认证访问者不能借代理获得 Desktop 的身份。

Desktop main 用 Node `fetch` 和 `credentials: 'omit'` 认证，只在精确配对 origin 复用该 Host 的 Cookie。Owner Main Session 的子资源请求也按精确 API/本机前端 origin 和当前 Host Cookie 名过滤，未知 origin 不能携带或覆盖保留 Cookie；业务 Session 不取得这个允许列表。失联或身份不符先使旧连接和认证代次失效，再清理资源，旧认证不能写回新的配对状态。Cookie 写入串行处理；调用期限 10 秒，未结束的原生 Cookie 写入仍阻挡后续认证，不能因调用超时假定写入已经停止。

认证通道生成 `principalId / installationId / connectionEpoch / role / hostId`。客户端传入的 `clientId` 只用于路由与客户端状态，不决定 principal。Cookie 为 HttpOnly、SameSite=Strict，HTTPS 使用 Secure；来源检查继续防跨站，但不是原生 HTTP 调用者的身份证明。

来源：[transport-auth.ts](../packages/host/src/transport-auth.ts)、[transport-identity.ts](../packages/contracts/src/transport-identity.ts)、[Desktop local-host.ts](../apps/desktop/src/main/local-host.ts)、[remote-auth.ts](../apps/desktop/src/main/remote-auth.ts)、[Desktop main.ts](../apps/desktop/src/main/main.ts)、[frontend-server.ts](../packages/host/src/frontend-server.ts)。远程连接继续按 [Remote](remote.md) 的目标与令牌规则执行。

## 业务浏览器与控制面隔离

Main Renderer 与业务网页使用不同 Session；业务 guest 的实际网络边界剥离出站 `Cookie` 和入站 `Set-Cookie` 中 `pi_meme_session_` 前缀及旧名 `pi_meme_session` 的 reserved Host Cookie，保留普通网站 Cookie，不靠 Cookie 的端口隔离，也不清空所有网站登录。

Host UI/API 响应带 `X-Pi-Meme-Control-Plane: 1`。业务网络每个请求刷新已知控制面 origin 清单，拒绝已知 Host、前端代理及远程连接 origin；`ws/wss` 对应到 `http/https` 的同一边界。未知 origin 的 marker 在响应头阶段触发阻断、记录 origin，并使相关 guest frame 所属网页不能由 Agent 操作。已学到的 origin 保留至 Desktop 退出；Agent 还检查目标、当前 URL 和嵌套 frame。

未知旧 Host 或去掉 marker 的自定义代理不能凭页面语义识别。清单读取等待最多 5 秒并 fail closed，该超时不取消底层 `NodeHostClient` 调用。原 native 对抗验收被平台检查中断，仅有部分证据；后续 WS 修复未重新走真路径，不能据源码宣布浏览器或 native permit 已完整通过。

来源：[browser-policy.ts](../apps/desktop/src/main/browser/browser-policy.ts)、[browser-runtime.ts](../apps/desktop/src/main/browser/browser-runtime.ts)、[transport-identity.ts](../packages/contracts/src/transport-identity.ts)、[transport-app.ts](../packages/host/src/transport-app.ts)。

## 执行硬顶与人类决定

Host 从真实执行目标构造 `AuthorizationContext`，绑定 principal、scope、策略修订、访问权限、任务模式与委派链。调用者不能在参数中自报更高权限、修改 cwd，或以界面当前选择代替目标。有效能力取平台可兑现能力、安装和项目策略、会话权限、父级委派与本次操作的交集。

`read-only` 和 Plan 禁止业务写入；Full 也保留 Host 凭据、运行时代码、模型配置、桌面配对目录等保护。Plan 允许的计划产物写入仅来自 Host 命名的专用 adapter，不能给任意文件写操作添加标签获得例外。子代理、codemode 嵌套调用、插件、MCP、定时任务和受管服务都不能扩大根任务硬顶。

一次确认只能允许硬顶内的明确操作。确认记录绑定输入摘要、资源身份、principal、scope、策略修订、委派和 nonce；批准不改变会话权限。并发与重放必须消费同一持久执行记录，不能因重试生成新身份。

来源：[authorization-policy.ts](../packages/permissions/src/shared/authorization-policy.ts)、[AuthorizationService](../packages/permissions/src/server/authorization-service.ts)、[Host 授权入口](../packages/host/src/authorization.ts)。

## 单次授权、幂等与撤销

授权流程区分 approval、一次性 grant 和执行 lease。响应必须携带对应 nonce；过期、输入变化、策略变化、委派失效或已经消费时拒绝。

固定 SDK 从真实已持久化的 Native session、assistant entry 和 entry 内唯一工具槽位构造 `toolop:v1:<SHA-256>`；嵌套调用绑定私有父 operation 与 Native ordinal。provider 原始 `callId` 保留为调用路由，单独的 `call0` 等编号不能用作全局去重。同一编号出现在不同持久 entry 时是不同逻辑操作；重开同一 JSONL 或更换 Worker principal/registration，不能把同一逻辑操作变成新执行。

Host 同步恢复 journal 后才接纳工具，以跨 principal 的 starting reservation 阻挡并发启动，并查询同一 journal 内已持久化的工具 operation。boot/registration 不进入逻辑操作键；registration 仍约束当前在途调用及终结结果归属。来源：[SDK 工具绑定](../packages/pi-runtime/src/sdk/session.ts)、[Host 工具准入](../packages/host/src/authorization.ts)。

持久 lease 记录 `prepared / running / succeeded / failed / cancelled / outcome-unknown`。重启不重放旧执行：待执行项取消，已运行但无法确定结果的项记为 `outcome-unknown`；旧 grant 不恢复为可用权限。日志损坏或不可读时拒绝恢复授权，不默认为空白全许可。

授权 journal 本轮升级为 format 2。旧未发布开发版 format 1 缺少可信工具身份映射，明确不兼容、拒绝恢复并保留原日志；不猜测迁移，不自动删除日志或重放工具。日志恢复读取的安全上限为 64 MiB，超过时下次启动 fail closed；当前追加没有同阈值的即时截止保证，不能裁掉幂等记录换取启动。此版本独立于数据目录布局版本。

撤销先阻止新准入，再取消受影响调用、进程、服务或计划授权；结果不确定仍保留记录。取消不能证明外部副作用已回滚，`outcome-unknown` 需要用户核实真实结果，不能换新幂等键自动重跑。查看与管理入口使用 Host 的 authorization snapshot/respond/revoke/resume 业务路径。

本地事件订阅断开不产生需要用户核实的业务效果。只有策略精确列出的 Host 本地状态读取/订阅可带可信 `localReadOnly` 标记，且效果必须全为 `process.read` 与 `host`；这些调用取消或失败记为 `failed`，仍取消信号并等待真实清理。模型、MCP、远程事件、网络和文件操作不由此降级，未标记的历史未知记录也不追改。设置页保留全部 `outcome-unknown` 并显示操作、时间与原因；普通刷新不应增加本地订阅的未知结果。

用户设置操作使用真实用户的管理上下文，独立于当前选中会话的任务硬顶；个人资料读取仍按读取处理，侧栏偏好保存仍是策略写入。继承的 Agent/插件上下文不因 `settings:*` 被转换成用户。

正式 API 的控制幂等记录与授权 lease 是不同层：前者保存方法和参数结果，后者约束实际效果。重放阻挡限定于保留记录的同一 Host/journal，不承诺不同 Host/dataRoot 或任意外部副作用全局 exactly-once。来源：[授权契约](../packages/contracts/src/authorization.ts)、[授权日志](../packages/permissions/src/server/authorization-journal.ts)、[控制接口](host-api.md#幂等操作)。

## 暂停、恢复与旧执行失效

pause 结束原 submit attempt，旧 `sessions.receipt` 永久保持 `interrupted`。显式 resume 发送新的 custom continuation，沿用逻辑任务的 rootTask、epoch、run、原权限 ceiling 与预算计数 key；恢复后的完成不能回写旧 receipt 为 `completed`。当前逻辑进度看 agents/root/run，见 [提交与回执](host-api.md#提交与回执)。

Host 私有 authorization generation 纳入 `ctx.policyRevision`，旧 context 在 await 后再次校验。SDK 使用 run ticket、按运行绑定的模型 facade 和已取消的旧 signal，旧模型 I/O 尚未 drain 时快速拒绝新准入。Worker 边界取消实际模型/MCP I/O 并等待停止或报告 unknown；暂停恢复不清除用户撤权。取消连接不证明远端计费、计算或副作用回滚已经停止。

来源：[service.ts](../packages/host/src/service.ts)、[Worker 边界](../packages/pi-adapter/src/worker-session.ts)、[SDK session](../packages/pi-runtime/src/sdk/session.ts)、[coordinator.ts](../packages/subagents/src/server/coordinator.ts)、[model-broker.ts](../packages/host/src/model-broker.ts)。

## 模型请求留在 Host

模型 broker 将 Host 模型凭据留在 Host，Worker 通过窄接口请求模型。Host 校验实际会话、模型白名单、当前策略和取消信号，使用自己的模型配置完成请求；模型响应不携带凭据或 Host 私有配置。有限真实路径见文末，不能由预算与接口接线推导所有模型协议、图片或超时边界均可用。

当前接线按根任务与执行 epoch 计数，默认最多 256 次模型请求；每次请求的输出 maxTokens 上限默认 16,384，并与模型上限和请求上限取更小值。预算耗尽返回 `model-budget-exhausted`，不无限续跑或通过子代理绕过根任务预算。预算是请求和输出限制，不是金额保证。

来源：[model-broker.ts](../packages/host/src/model-broker.ts)、[service.ts](../packages/host/src/service.ts)、[Worker broker runtime](../packages/pi-runtime/src/sdk/model-broker-runtime.ts)。

图片配置的 `imageGeneration.test(id)` 是用户直接发起的一次独立管理操作，可能产生费用；所有非用户主体均不能调用它，Agent 生图走受当前任务预算约束的 `image_gen` 桥接。配置测试使用当前授权租约信号，撤权会取消实际请求和响应读取，已送出的请求仍可能有未知结果或费用。来源：[API 效果定义](../packages/host/src/authorization-adapters.ts)、[图片服务](../packages/image-generation/src/server/service.ts)。

## MCP 与外部插件

MCP 授权绑定当前配置哈希；配置中的命令、参数、工作目录、env、headers 或服务授权变化后重新核对（启停/展示字段及 OAuth clientSecret 按哈希实现排除），模型或 SDK 的启停更新不能代替用户创建新授权。Plan 和普通只读任务要求用户显式列入 `planReadOnlyTools`，同时满足只读注解且不声明破坏性；注解本身不会授予权限。默认模式 read-only 的旧 factory 过滤已修复，原生 `tool_search` 可发现 deferred 工具，再走实际只读调用。

`session_start` 只加载本地配置，idle 不联网；`before_agent_start` 才连接。每个物理 metadata/read/tool HTTP 请求分别取得 Host lease，HTTP 只读效果使用 `network.read`；包括 initialize、list、ping、SSE 与实际 cleanup，不能借 metadata 身份发送 tools/call。没有真实 Actor 时禁止 HTTP 初始化。agent_end、pause、abort 等边界关闭并 drain 实际 transport；显式 resume 后未来的新调用可重连，旧 transport ticket/ALS 回调不能借新 generation 重放。每次 tools/call 只允许一次实际 POST，SDK 401/404 不得隐式重放效果。

HTTP transport 核对实际签名 endpoint、请求方法和重定向。OAuth refresh/login 与模型 provider alias 认证明确 unsupported，不调用裸 OAuth fetch；专用缓存 credential 或已签名 header 可用。本地 stdio 仍须满足真实沙箱能力，缺能力即拒绝。

来源：[配置哈希](../packages/mcp/src/shared/authorization.ts)、[runtime-config.ts](../packages/mcp/src/server/runtime-config.ts)、[execution-boundary.ts](../packages/mcp/src/server/execution-boundary.ts)、[extension-lifecycle.ts](../packages/mcp/src/server/extension-lifecycle.ts)、[HTTP 准入](../packages/mcp/src/server/http-request-authorization.ts)、[Host MCP 授权](../packages/host/src/mcp-authorization.ts)、[mcp-transport-guard.ts](../packages/mcp/src/server/mcp-transport-guard.ts)、[plan-transport.ts](../packages/mcp/src/server/plan-transport.ts)。以上是源码机制；文末有限验收未覆盖每种 metadata 方法。远端“只读”仍依赖被授权服务语义，GET/HEAD 不能证明没有外部副作用。

外部插件 SDK 4 不允许 trusted Node 入口、同进程服务对象或包内 React/JS UI。Agent/Server 在独立受限进程运行；UI 是 Host 渲染的 JSON 页面/面板，仅支持声明的 text/action。动作调用同插件同代次的受限 Server，仍检查 audience、schema、effect、capabilities 和真实目标。详情与重建流程见 [App 插件开发](plugins.md)。

## 开发运行时快照

官方 bootstrap 先 `assertStorageLayout`，再创建 cache/snapshot；`pnpm start` 有限构建后，把 Host、Worker、静态 UI、Node/Electron、preload、必要依赖与技能发布到 `dataRoot/runtime-snapshots/<内容哈希>`。完整 manifest 校验内容，拒绝越界 symlink、共享硬链接和特殊文件；快照发布后不就地覆盖。

Electron 下用 `createRequire(process.execPath)` 取得 `original-fs`，对原始 callback API 做 promisify，按物理 ASAR archive 检查；不能借被 Electron 改写的虚拟目录语义检查归档。该接法兼容 CJS/ESM，仍须以真实启动证据判定目标平台是否可用。

本次 owner 进程从快照加载编译 JS，不使用仓库 TS loader，也不接 Vite HMR 或 live `frontendUrl`。Agent 可以继续编辑项目；这些改动只在用户下一次显式启动构建时进入新代次，不通过下一次 Worker import 自动进入正在运行的控制面。

开发启动的构建子进程限时 5 分钟；较重的快照校验使开发 Host/Web 等待上限为 120 秒，不能把进程已启动等同应用已就绪。开发数据根在本次运行固定；切换或迁移需退出后以新目标重新启动，未实现开发态 active UI/snapshot 跨目录热迁移。正式打包应用不走此开发 bootstrap，原发布和存储流程分别见 [发布](releasing.md) 与 [存储](storage.md)。

Desktop 不再通过登录 Shell `-lic` 读取 PATH，不执行 `.zprofile/.zshrc`。只保留父环境绝对 PATH、固定系统/Homebrew目录与固定 Node 目录。Finder 不自动导入 nvm 或自定义 profile 的路径，需要启动父环境显式提供。Windows 继续使用原 NoProfile 路径，没有新增 profile 探测。

来源：[development-runtime.mts](../scripts/development-runtime.mts)、[build-development-runtime.mts](../scripts/build-development-runtime.mts)、[runtime-snapshot.ts](../packages/host/src/runtime-snapshot.ts)、[user-login-path.ts](../apps/desktop/src/main/user-login-path.ts)。

## 平台能力与未验范围

认证或 Full 权限不代表执行后端已经实现能力。能力报告使用 `enforced / unsupported / unknown`；操作需要的任一能力未兑现时明确拒绝，不降级到无沙箱、workspace-write 或其他平台路径。

| 平台与路径              | 当前边界                                                                                                            |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Windows core            | 历史、设置、连接等核心启动不等待 PSEC 可用；探测失败只禁用依赖该能力的执行                                          |
| Windows Full typed/PSEC | 当前无法同时兑现 Full 广泛写与私有根拒绝，明确 `sandbox-unavailable`；不使用 ACL、管理员服务或缩小到工作区假装 Full |
| Unix 任意命令           | `host-secrets` 仍为 unknown；要求该能力的 bash、rg、脚本、stdio 等任意执行拒绝，即使 Full 或已经批准                |
| macOS 进程树            | 完整 `process-tree` 仍有 unknown，不能声称所有脱离进程都会回收                                                      |
| Unix 硬链接写边界       | `hardlink-write-boundary` 仍有 unsupported；typed 写限定同一验证 FD 的单链接目标，不能推导为任意代码隔离能力        |
| 平台真实路径            | Windows 本轮未做真实运行或 ZIP/安装验收；macOS/Linux 代码说明也不等于目标产物通过                                   |

controlled reader 提供固定文件/目录读取的窄能力，实际 I/O 受平台后端约束；macOS 目录读取不支持 `expected` 目录身份，要求时明确拒绝。它们不能推导成任意 Shell 可执行。

Windows 的 `expected` 只接受完整 native 卷序列号和 FileID 能与 Node 24/libuv 的 dev/ino 无损对应的情况；宽卷序列号或 classic/native 身份不一致时明确 unsupported，不截断匹配。操作、保护根及读取例外的相关目录必须能查询 `FileCaseSensitiveInfo` 且标志为零；大小写敏感、未知非零标志或查询失败均拒绝，并在输出前复核。

读取例外以持有对象的完整 `{VolumeSerialNumber, FileId128}` 为依据。盘符之后的组件用 `NtCreateFile` 相对持有的父目录打开并记录祖先身份；只有读取例外的实际最终对象在目标的持有祖先链中，且该例外自身的真实祖先链严格位于对应保护根之下，才可放行。缺失 selector 的最终身份为 `None`，不能授予例外；大小写折叠字符串只用于保守拒绝和范围筛查。绝对路径第二次打开的实际 read handle 必须等于目标 pin 的最终完整 ID。目录枚举只使用原持有目录句柄及其已证明的祖先链过滤条目，不为未 pin 的条目名称新增绝对 lookup 或据其 64 位记录 ID 推造读取例外。

标志查询不等于元数据锁；例外不依赖标志保持不变，也不承诺完整祖先/卷映射 ABA 安全。真实 Windows 尚未运行，不能据源码猜测 NTFS 宽序列号会使多少普通卷不可用。

typed writer 已改为同一个经验证的 `O_RDWR` FD 原地 `write / truncate / fsync / hash`，不再使用临时文件加 rename。`expected` 必填；新文件为 `null`，已有目标绑定 dev/ino，携带内容修订时再做 CAS，并要求普通单链接文件。取消或失败可能已留下部分或完整内容，结果记 unknown；不能承诺原子替换、回滚或祖先目录 ABA 的完整证明。

来源：[execution-capabilities.ts](../packages/contracts/src/execution-capabilities.ts)、[controlled-file-read.ts](../packages/pi-runtime/src/sdk/controlled-file-read.ts)、[authorized-file-read.ts](../packages/pi-runtime/src/sdk/authorized-file-read.ts)、[authorized-file-mutation.ts](../packages/pi-runtime/src/sdk/authorized-file-mutation.ts)、[access-sandbox.ts](../packages/pi-runtime/src/sdk/access-sandbox.ts)、[windows-sandbox.ts](../packages/pi-runtime/src/sdk/windows-sandbox.ts)。

Owner PTY 的 open/input/resize/close 仅接受真实用户来源，Agent 不能借相同会话或父能力操作它。Git status/diff/checkout/switch/worktree executor 尚不支持；availability 本身包含 status，所以对应 Git UI 可能不可用，不能把版本探测成功当成工作树操作可用。changed-turn undo 缺少受控 restore 后端，明确 unsupported，不按记录路径直接回滚。来源：[terminal-service.ts](../packages/host/src/terminal-service.ts)、[Git executor](../packages/git/src/server/safe-git-command.ts)、[Git availability](../packages/git/src/server/git-service.ts)、[turn-change-store.ts](../packages/pi-runtime/src/turn-change-store.ts)。

## 有限换手验收证据

以下为本轮已完成的独立真路径记录，环境为 Darwin / Node.js 24.14。测试和静态检查只能作为源码探针，不能替代用户路径；Hacker 均与对应实现作者分离。证据来自各自的独立验收，文档更新不增加验收范围。

| 范围                | Oracle（真实用户路径）                                                                                                                                              | Hacker                          |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| 文件 I/O 与工具身份 | 真实 Host files、SDK write/edit/read、Full 下外部普通文件写；同为 call0 的不同持久 Native entry 可分别执行                                                          | 独立 I/O 审查 Agent             |
| 生命周期            | 模型 HOLD → pause 约 48 ms → 新 continuation read A/B；rootTask/epoch/run 均保持，撤权关闭两个 Worker                                                               | 独立生命周期审查 Agent          |
| MCP                 | 真实 Host/Worker 与本地只读服务：直连、deferred 搜索调用、401 一次 POST、签名 endpoint 变更拒绝；工具与首模型前 initialize HOLD 的 pause/resume、撤权保持及实际断连 | 独立 MCP 审查 Agent（未写 MCP） |
| 官方启动            | fresh bootstrap 首屏、Host ready、静态响应字节与快照匹配、无 HMR                                                                                                    | 独立 Desktop 启动审查 Agent     |
| 独立 Server 启动    | 真实 `pnpm start:server`、Node 24.14.0、临时 dataRoot；status 200/协议 2，监听进程执行快照 Node 与编译 JS；停机后进程/端口/锁释放                                   | 独立入口审查 Agent              |
| 授权日志恢复        | 同一 dataRoot 正常重启不重放；新 Native entry 复用 call0 可执行；合法 hash chain 的 format 1 样本启动明确拒绝且保留原字节                                           | 独立持久化审查 Agent            |
| 普通用户设置        | 真实 Owner 首屏、个人资料、设置与一次 reload 后续用；无错误审批、过期探针 stack，本地订阅未知计数保持 0                                                             | 独立 Desktop UI 审查 Agent      |
| 用户图片配置测试    | 真实 HTTP API 到本地固定 PNG 服务；图片返回/落盘一致；HOLD 后撤权约 22 ms 实际断连，付费路径仍记 unknown，无额外请求                                                | 独立图片请求审查 Agent          |

Windows/Linux、完整 browser/native permit、任务内 `image_gen`、更多 transport 路径、忽略 abort 超过 5 秒的实际停止边界等未验。浏览器 native 对抗仅有中断前部分证据，WS 修复未再复核；上表不能转写为全部平台、所有竞态或发布通过。

升级时保留旧插件记录、私有数据和原生会话；含旧代码的 SDK 2/3 插件暂停执行，迁移到 SDK 4 后重新构建并授权。只有 SDK 3 的纯资源包可按 manifest 解析器无代码升级。停止旧 Host 后再启动新协议版本，不绕过身份、协议或数据锁诊断。
