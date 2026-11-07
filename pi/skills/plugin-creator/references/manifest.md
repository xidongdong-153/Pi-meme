# Manifest 与权限

外部插件使用 `piMeme.sdkVersion: 4`。包内代码入口仅 restricted；UI 仅 `.json`。旧 trusted 字段、JS UI、非空 requires/provides 会被解析器拒绝；内置模块版本 3 与此无关。

| 能力             | 源码                                    | manifest 产物                                  |
| ---------------- | --------------------------------------- | ---------------------------------------------- |
| Agent            | `src/agent/restricted.ts` 导出 activate | `agent.restricted: dist/agent/restricted.js`   |
| Server           | `src/server/restricted.ts` 导出 create  | `server.restricted: dist/server/restricted.js` |
| UI               | `src/ui/entry.json`，version 1 声明     | `ui: dist/ui/entry.json`                       |
| 技能、主题、素材 | 包内资源                                | resources.skills/themes/assets                 |

```json
{
  "name": "my-plugin",
  "version": "0.1.0",
  "type": "module",
  "piMeme": {
    "sdkVersion": 4,
    "display": { "name": "插件名称" },
    "agent": { "restricted": "dist/agent/restricted.js" },
    "permissions": {
      "restricted": { "maxAccess": "read-only", "capabilities": ["workspace.read"] }
    }
  }
}
```

至少一个入口或非空资源。路径在包内，拒绝绝对路径、`..`、通配符和路径别名逃逸。只声明真实需要的能力；maxAccess 仅 read-only/workspace-write，Full 会话也不扩大插件上限。

工具/命令明确 effect、capabilities，Server 操作明确 audience、schema、effect、capabilities。安装、项目可用、会话选择和用户 grant 分开校验；Plan/read-only 保持只读硬顶，不能以单次批准改变它。

受限 JS 在 Host 管理的独立进程和 OS 沙箱运行，runtime protocol 为 2；不携带 Node，不自建 runner，不回退 Host 导入、VM 或 Worker。缺必要能力明确 sandbox-unavailable。

网络精确声明 HTTPS origin/method，使用 http.request broker，Plan 仅获准 GET/HEAD。credentialRef 只引用插件凭据，不复制 Host/模型/MCP 密钥。命名 sharedData.read 不是共享整个数据目录；没有 SDK 3 可信 Server 的发布入口。

UI JSON 只支持 text/action 与 app/project/session scope。页面申请 navigation.pages；动作指向同插件受限 Server 的局部 operation，必须允许 ui audience。不能以主题或资源加载 JavaScript、React、HTML 或任意 CSS。

更新保留用户包名、源码与私有数据。SDK 2/3 代码按新契约重建并重新授权，不能只改 sdkVersion。SDK 3 无 agent/server/ui 的纯资源包可由解析器转换到 4，不据此执行旧代码。参考类型位于随附 SDK 的 manifest.d.ts、permissions.d.ts、restricted.d.ts、declarative-ui.d.ts。
