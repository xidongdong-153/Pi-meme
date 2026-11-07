---
description: 'App SDK 4 的受限入口、声明式 JSON UI、包资源和迁移方式'
status: implemented
paths:
  - 'packages/plugin-sdk/**'
  - 'packages/plugin-runtime/**'
  - 'packages/plugin-devkit/**'
  - 'packages/app-ui/src/plugins/**'
  - 'plugins/**'
---

# App 插件开发

本文描述外部 App SDK 4。内置模块仍使用自己的版本 3 静态契约，不能从插件列表替换或停用。版本、授权和平台限制集中见 [权限控制与版本迁移](permissions-and-migration.md)，正式客户端接口见 [HostApi v3](host-api.md)。文中构建流程是配置说明，不代表本轮已经构建、安装或验收插件。

## 包格式与构建

外部插件只执行 SDK 4 入口：Agent 和 Server 仅支持 restricted，UI 只支持包内声明式 JSON。禁止 trusted 入口、JS/React UI 与非空 requires/provides 同进程服务依赖。包名、版本、资源路径与保留内置身份由 [manifest 解析器](../packages/plugin-sdk/src/manifest.ts) 及 [保留身份](../packages/plugin-sdk/src/reserved.ts) 校验。

```json
{
  "name": "example-plugin",
  "version": "0.1.0",
  "type": "module",
  "piMeme": {
    "sdkVersion": 4,
    "agent": {
      "restricted": "dist/agent/restricted.js"
    },
    "server": {
      "restricted": "dist/server/restricted.js"
    },
    "ui": "dist/ui/entry.json",
    "permissions": {
      "restricted": {
        "maxAccess": "read-only",
        "capabilities": []
      },
      "ui": ["navigation.pages"]
    }
  }
}
```

安装、项目启停、会话选择和能力授权是不同步骤。安装不会自动授予 workspace、网络或 UI 能力。源码默认在工作区 plugins/ 下；写入源码或生成 .pim 不会自动安装。系统 [Plugin Creator](../pi/skills/plugin-creator/SKILL.md) 读取当前 Host 随附 SDK 类型和工具链，不依赖公开 npm SDK 包。

DevKit 生成受限 TypeScript 入口与 src/ui/entry.json；构建分别输出 dist/agent/restricted.js、dist/server/restricted.js 和 dist/ui/entry.json。生成 UI 由 create.ts 内的 JSON 数据完成，不读取旧 React 模板。Agent/Server 的 CLI 选项只有 none/restricted，旧 trusted/both 不再有效。

在生成的插件目录按顺序运行：

```bash
node .pi-meme-devkit/cli.mjs check .
node .pi-meme-devkit/cli.mjs build .
node .pi-meme-devkit/cli.mjs validate .
node .pi-meme-devkit/cli.mjs pack . ../example-plugin.pim
```

check 检查源码、类型、manifest 和 JSON UI；build 生成当前产物；validate 校验可安装包；pack 再校验并输出 .pim。任何失败停止后续步骤，不用旧 dist 冒充新构建。纯资源包不要求生成 TS 或 UI。工具链缺失可用 Plugin Creator 的 prepare 恢复工具，不能对现有工程重新 create 或覆盖用户源码。来源：[create.ts](../packages/plugin-devkit/src/create.ts)、[build.ts](../packages/plugin-devkit/src/build.ts)、[check.ts](../packages/plugin-devkit/src/check.ts)。

## Agent 与 Server

受限 Agent 导出 activate(context)，受限 Server 导出 create(context)，类型见 [restricted.ts](../packages/plugin-sdk/src/restricted.ts)。工具返回 JSON 可序列化的 text/data，显式声明 effect 和 capabilities。Server 操作登记局部 name、inputSchema、outputSchema、audience、effect、capabilities、execute，不能用 TypeScript 泛型替代运行时 schema。

Agent 使用 context.server.call 调用同插件同代次受限 Server；声明式 UI 的 action 由 Host 路由到同插件受限 Server，操作须包含 ui audience。缺少对应入口时报告不可用，不回退可信函数。调用绑定实际目标、generation、policyHash、grant、任务模式和取消信号。外部插件不取得完整 HostApi、Store、SessionPool、模型凭据或任意 Node 服务对象。

代码在独立进程和 OS 沙箱执行，不进入 Host、会话 Worker 或 VM 模拟路径。manifest 的 restricted.maxAccess 只接受 read-only/workspace-write；Full 会话中的插件仍受安装授权上限约束。Plan 和普通只读任务保留只读硬顶。平台能力不足返回 sandbox-unavailable，不回退无沙箱执行。

### 受限网络与共享数据

原始网络被禁止。HTTPS 经 Host broker，精确声明 origin、method、规则 ID 并单独授权；Plan 只允许获准的 GET/HEAD。credentialRef 仅引用插件自己的凭据，不提供密钥读取接口，不继承 Host Cookie、环境代理或模型认证。远端响应仍会交给插件，授权前需确认服务不会回显敏感请求头。

sharedData.read 只读取 Host 已发布且明确授权的命名 JSON，不共享整个数据根、数据库连接或文件句柄。SDK 4 没有可信 Server 发布入口，不能照搬 SDK 3 sharedData.publish 的方案。现有命名共享数据不是插件持久数据库。来源：[plugin-http-broker.ts](../packages/host/src/plugin-http-broker.ts)、[plugin-call-bridge.ts](../packages/host/src/plugin-call-bridge.ts)。

## UI 面板与贡献

SDK 4 外部 UI 是 [DeclarativePluginUi](../packages/plugin-sdk/src/declarative-ui.ts)，由 [Host 控件](../packages/app-ui/src/plugins/declarative-plugin-ui.tsx) 渲染，不导入插件 JavaScript、React、HTML 或 CSS。

```json
{
  "version": 1,
  "pages": [
    {
      "id": "main",
      "title": "状态",
      "scope": "app",
      "blocks": [
        {
          "kind": "text",
          "text": "当前状态"
        },
        {
          "kind": "action",
          "title": "刷新",
          "operation": "status",
          "input": {}
        }
      ]
    }
  ]
}
```

pages 和 panels 每类最多 32 个，id 全包唯一；每个 surface 最多 128 blocks，全包最多 512 blocks，序列化 JSON 长度最多 128 × 1024 字符。scope 为 app/project/session。当前控件只有 text 和 action；action 的 operation 为同插件局部操作名，input 为 JSON。

页面声明需申请 navigation.pages。动作仍检查真实目标、Server audience、effect 与授权。旧 composer hook、message renderer、messageActions、React navigation 注册及发送前 JS 处理器不因修改 sdkVersion 自动迁移，也不能通过主题或资源加载脚本。当前声明式能力不足时明确报告缺口，不能回退宿主同源代码。

## 受限 Node 运行时

Node、runner 和平台沙箱由 Host 提供，插件不携带自己的可执行文件，也不自行实现另一套 runner。受限 runtime protocol 为 2；必须使用匹配 Host 的当前工具链。能力探测不等于目标插件可用性验收，Windows PSEC 与 Unix 的具体拒绝项见 [平台能力](permissions-and-migration.md#平台能力与未验范围)。

## 结构化主题

主题字段定义见 [settings.ts](../packages/contracts/src/settings.ts)，可安装的完整示例见 [landscape.json](../plugins/theme-landscape/themes/landscape.json)。下例省略 `colors/fonts`，只展示标识、布局与背景字段：

```json
{
  "id": "landscape",
  "name": "山色",
  "appearance": "dark",
  "tokens": { "spacing": 1, "radius": 10, "surfaceOpacity": 0.82 },
  "background": {
    "image": "assets/landscape.png",
    "area": "workspace",
    "fit": "cover",
    "position": "center",
    "opacity": 0.35,
    "overlay": "#16202b",
    "blur": 0
  }
}
```

`spacing` 范围 0.5–2，`radius` 范围 0–24，`surfaceOpacity` 范围 0.4–1。背景位置支持 `app/workspace/sidebar`，填充支持 `cover/contain`，锚点支持 `center/top/bottom`，透明度 0–1，模糊 0–32。

图片必须在 `resources.assets` 中声明，支持 PNG、JPEG、WebP、AVIF，最大 8 MiB；主题 JSON 最大 256 KiB。拒绝远程 URL、SVG、CSS 和脚本字段。Host 生成绑定插件代次的认证资源地址。安装前校验失败保留旧版；停用或卸载后使用内置主题；重启恢复仍有效的主题选择。

外观页可调背景透明度、模糊、间距、圆角与表面透明度。单文件 JSON 导出包含颜色、字体和布局；背景资源通过 `.pim` 分发，不放进单文件主题导入。

## 释放与更新

调用与任务持有固定插件代次和代码快照。更新不把旧调用交给新 Server；撤权、停用和卸载立即阻止旧授权继续准入，并取消受影响调用、等待进程释放。断线和取消可能留下 outcome-unknown，写操作不自动重试，也不承诺副作用回滚。

安装记录和代次高水位保存在 state/plugins.json；损坏或未知 schema 时保留文件并报告，不扩大授权。卸载默认保留插件私有数据与 Pi 会话。旧 SDK 2/3 代码不导入；SDK 3 纯资源包没有 agent/server/ui 时可按解析器升级为 SDK 4，资源路径校验仍保留。旧 React/Node 插件须逐项重建为受限能力和 JSON UI，重新构建、安装并授权，不能只改版本字段。

Pi、Host、Node 与 runner 随应用升级，不通过外部插件热更新。实现见 [PluginManager](../packages/plugin-runtime/src/manager.ts)。
