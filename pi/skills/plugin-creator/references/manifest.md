# Manifest 与权限

`package.json` 使用 `"type": "module"`，并声明 `piMeme.sdkVersion: 3`。不生成 SDK 2 代码，也不保留旧 `context.call`、`registerHandlers` 或 `message-actions` render 槽。只声明实际使用的入口：

| 能力                 | 源码                                               | manifest 入口                                              |
| -------------------- | -------------------------------------------------- | ---------------------------------------------------------- |
| 受限 Agent           | `src/agent/restricted.ts` 导出 `activate(context)` | `agent.restricted: dist/agent/restricted.js`               |
| 可信 Agent           | `src/agent/entry.ts` 导出 `activate(context)`      | `agent.trusted: dist/agent/entry.js`                       |
| 受限 Server          | `src/server/restricted.ts` 导出 `create(context)`  | `server.restricted: dist/server/restricted.js`             |
| 可信 Server          | `src/server/entry.ts` 导出 `create(context)`       | `server.trusted: dist/server/chord-facets.json`            |
| UI 页面、面板和贡献  | `src/ui/entry.tsx` 导出 `activate(context)`        | `ui: dist/ui/entry.js`                                     |
| 主题、包内技能、图片 | 包内相对路径                                       | `resources.skills`、`resources.themes`、`resources.assets` |

至少要有一个代码入口，或一项非空 `resources`。路径必须在包内，不能是 `..`、绝对路径或通配符。

```json
{
  "name": "my-plugin",
  "version": "0.1.0",
  "type": "module",
  "description": "插件做什么。",
  "piMeme": {
    "sdkVersion": 3,
    "display": { "name": "插件显示名" },
    "agent": { "restricted": "dist/agent/restricted.js" },
    "permissions": {
      "restricted": {
        "maxAccess": "read-only",
        "capabilities": ["workspace.read"]
      }
    }
  }
}
```

- Agent 工具返回 `{ text, data? }`，`data` 必须可序列化为 JSON。安装、项目启停、会话选择和能力授权分别校验，不因安装提升权限。
- 优先生成真正需要的受限入口。Plan 仅加载获准的受限只读入口；可信 Agent 只在完全权限普通任务中、明确授权后加载。restricted-only 插件在完全权限任务中仍受原上限约束。
- 受限 JS/TS 产物在独立进程和 OS 沙箱执行，不能改成 Host 导入、VM 或 Worker 线程。平台不可用时报告 `sandbox-unavailable` 并停止，不退回无沙箱运行。不要把可执行文件或 Node 运行时打进插件。
- 受限工具和命令显式声明 effect 与 capabilities，不靠工具名前缀或 safe 标记放行。`permissions.restricted` 明确列出 maxAccess、capabilities、network 与 sharedData；缺省不授予能力。联网只走 `http.request` 和精确授权的 HTTPS origin/method，Plan 限 GET/HEAD。凭据只传插件专属 credentialRef，不复制 Host、模型或 MCP 的密钥。
- Server 用 `registerOperations` 登记局部 name、inputSchema、outputSchema、audience、effect、capabilities 和 execute；UI/Agent 统一通过 `context.server.call` 调用同插件同代次操作。受限入口不能回退可信 Server。
- UI 使用宿主 React，不把 Node 产物打进浏览器；可信 UI 在加载前单独授权，不把同源 React 宣传为恶意代码沙箱。面板 `location` 为 `right`。CSS 只作用自己的根并在释放时移除。
- 包内技能目录包含 `SKILL.md`，并列入 `resources.skills`。安装后它们出现在技能页，标记为来自插件，属于个人技能，不是系统技能。
- 纯主题插件可以只有 `package.json`、主题 JSON 和图片。主题不执行 JavaScript 或任意 CSS。

更新已有插件时先读取现有 manifest 和入口，只改当前任务需要的部分，保留包名。SDK 2 必须按新契约重建，不能只改 sdkVersion 后继续使用旧 API。不要为了统一样式重写整个插件。
