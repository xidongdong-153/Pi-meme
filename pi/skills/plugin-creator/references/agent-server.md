# Agent 与 Server

读取随附 SDK 的 restricted.d.ts、rpc.d.ts、permissions.d.ts。外部 SDK 4 不支持 trusted 入口，也不因为旧 agent/server/ui 类型文件仍存在而允许完整 HostApi 或同进程服务。

Agent 导出 activate(context)，Server 导出 create(context)。Agent 工具返回 `{ text, data? }`，data 为 JSON。工具和命令必须明确 effect 与 capabilities；manifest 申请和用户 grant 都是上限，不能通过 Full 或一次批准提升。

## Server 操作

registerOperations 声明局部 name、inputSchema、outputSchema、audience、effect、capabilities、execute；schema 是运行时验证，泛型不替代它。

Agent 用 context.server.call 调用同插件同代次受限 Server；声明式 UI action 由 Host 路由到该 Server，操作包含 ui audience。operation 不加插件前缀，不接受跨插件名。缺少受限 Server 时明确不可用，不回退可信函数。

受限 Server 只有窄 broker、pluginId、generation、registerOperations、onDispose；不访问 Host 私有 Store、完整 HostApi、dataDirectory、共享服务对象或可信 sharedData.publish。共享数据只读已发布且获准的命名 JSON，不能以此实现插件数据库。

## 执行与网络

Host 在独立进程与真实 OS 沙箱运行构建产物，runtime protocol 为 2。禁止自建 runner、携带 Node、Host 导入或 VM/Worker 模拟。沙箱缺项返回 sandbox-unavailable 并停止；Windows Full typed/PSEC 组合未兑现，不能声称 Windows 全链路可用。

Plan 和普通 read-only 保持只读，workspace-write 不超过真实工作区与 grant。网络使用 context.http.request，明确精确 HTTPS origin/method 与规则；Plan 仅获准 GET/HEAD。使用插件 credentialRef，不读取 Host、模型或 MCP 的密钥、环境和 Cookie。

## 释放与结果

使用 onDispose 或返回的 disposer 释放订阅、计时器和句柄。撤权阻止新调用并取消旧执行；写操作不自动重试，断线或取消可能留下 outcome-unknown，不能把取消当外部副作用回滚。

直接在 Node 导入成功只说明普通 JS 能运行，不能证明应用授权或受限路径可用。交付时记录实际检查；真实用户路径由换手者观察，缺少 oracle/Hacker 时标未验，不用类型检查或构建代替业务证据。
