# Agent 与 Server

在本技能 `dist/toolchain/node_modules/@pi-meme/plugin-sdk/src/` 中，可信 Agent 读取 `agent.d.ts`，可信 Server 读取 `server.d.ts`，受限入口读取 `restricted.d.ts`。同插件调用类型见 `rpc.d.ts`，授权声明见 `permissions.d.ts`。

Agent 导出 `activate(context)`，Server 导出 `create(context)`。仅使用一侧入口时不要调用不存在的另一侧。Agent 工具返回 `{ text, data? }`，`data` 是 JSON；不要返回任意类实例或文件句柄。

## Server 操作

通过 `registerOperations` 声明局部操作名、inputSchema、outputSchema、audience、effect、capabilities 和 execute。输入输出使用 JSON Schema；TypeScript 泛型不能代替运行时校验。

Agent 与 UI 通过 `context.server.call('operation', input, { signal, target? })` 调用同插件、同代次操作。operation 不加插件前缀。可信 Agent 调可信 Server，受限 Agent 调受限 Server；UI 只调获准的可信 Server。缺少对应入口时不回退另一种执行路径。

可信 Server 可使用 `context.host` 的显式 ProjectRef/SessionRef 接口、自己的 dataDirectory、声明过的外部插件服务，以及 `onDispose`。不要访问应用私有 Store、当前界面选择或内置装配服务。类型与运行时辅助函数 `defineServerOperation`、`defineOperation` 都在随附 SDK 中。

## 受限入口

工具和命令必须明确 effect 与 capabilities；manifest 的 restricted 权限是上限，安装不会自动授权。Plan 仅允许获准的只读入口。完全权限任务中的受限插件仍受原上限约束。

受限代码由应用在独立进程和 OS 沙箱中运行。不要生成另一套 runner、携带 Node 二进制，或退回 Host 导入、VM、Worker 线程。沙箱不可用时报告 sandbox-unavailable 并停止。

网络请求使用 `context.http.request`，manifest 精确声明 HTTPS origin、method 和规则 ID。Plan 只允许获准的 GET/HEAD。凭据使用插件专属 credentialRef，不读取或复制 Host、模型、MCP 密钥。

受限入口读取可信 Server 显式发布的 sharedData 需要授权；不共享整个数据目录。共享数据是 Host 内存中的有修订 JSON，重启后需要重新发布，不是持久数据库。

## 释放与验证

通过返回的释放函数或 `onDispose` 关闭订阅、计时器、连接和文件句柄。写操作不自动重试；取消与断线后结果可能不确定。

用临时数据验证实际输入输出、错误和取消。测试受限能力时保留应用授权与沙箱边界，不能因直接在 Node 中导入成功就声称通过受限运行验证。
