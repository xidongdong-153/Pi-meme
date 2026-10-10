# 插件开发与安装

本文描述用户安装的外部插件。内置 14 个模块位于 `packages/*`，由 Host 静态装配，不参加启停、卸载或重新加载。

插件身份来自 `package.json` 的 `name` 和 `version`。`piMeme` 声明 SDK 版本、构建入口和服务依赖。Host 不执行插件的安装脚本，也不要求用户安装 Pi CLI。

```json
{
  "name": "@local/clock",
  "version": "0.1.0",
  "type": "module",
  "piMeme": {
    "sdkVersion": 1,
    "server": "dist/server/chord-facets.json",
    "agent": "dist/agent/entry.js",
    "ui": "dist/ui/entry.js"
  }
}
```

三个入口按实际能力选用，至少声明一个。`server` 是 Chord Node facet bundle；`agent` 是 Node ESM；`ui` 是浏览器 ESM。UI 使用宿主的 React，不能导入 Node 模块或使用全局 `require`。

## 创建、构建和打包

在仓库根目录运行：

```bash
pnpm exec tsx packages/plugin-devkit/src/cli.ts create /tmp/clock @local/clock
pnpm --dir /tmp/clock install --ignore-scripts
pnpm exec tsx packages/plugin-devkit/src/cli.ts build /tmp/clock
pnpm exec tsx packages/plugin-devkit/src/cli.ts validate /tmp/clock
pnpm exec tsx packages/plugin-devkit/src/cli.ts pack /tmp/clock /tmp/clock.pim
```

构建前先准备开发目录的依赖。模板使用 `typebox`；类型来自 `@pi-meme/plugin-sdk`、Pi 1.1 和 React。模板的 SDK 开发依赖使用本地 `link:`，指向生成模板时使用的 `packages/plugin-sdk`，不会尝试下载未发布的 SDK。移动开发目录后重新设置这个 link。其余依赖通过显式的 `pnpm install --ignore-scripts` 准备；DevKit 不自动安装依赖。仓库外构建测试把现有依赖链接到临时目录，验证构建、打包和安装，不验证联网安装。

模板包含一个读取 UTC 时间的 Pi 工具、一个 Host 操作，以及调用该操作的 React 页面。修改 `src/server/entry.ts`、`src/agent/entry.ts` 和 `src/ui/entry.tsx`。`build` 将第三方依赖打入产物，Pi SDK 和 React 分别由 Node Host 和浏览器宿主提供。`validate` 检查身份、SDK 版本、入口、Chord 哈希和浏览器模块，不代替类型检查或业务测试。

`.pim` 是带文件清单的 gzip 包，只收集 `package.json`、`dist/`、README 和许可证。不包含 `src/`、`node_modules/`、`.env` 或根目录开发文件。上传和解压大小均有 32 MiB 限制，路径越界和软链接会被拒绝。

在“设置 → 扩展”上传本机 `.pim`；Host 构建目录加载与重新加载位于“设置 → 更多 → 开发者”。Remote 用户上传包即可，不需要在远程机器安装 npm 依赖。当前没有在线 npm/git 安装、插件市场或 GitHub 集成。

## Server 入口

```ts
import type { ServerPluginContext } from '@pi-meme/plugin-sdk/server'

export function create(context: ServerPluginContext) {
  context.registerHandlers({
    [`${context.pluginId}:time`]: () => new Date().toISOString(),
  })
}
```

`create` 可以返回带 `dispose` 的对象，也可以用 `context.onDispose` 登记释放函数。释放按登记的逆序执行；一个释放函数失败时仍会继续释放其他资源。

`piMeme.requires` 列出需要的服务，`piMeme.provides` 列出提供的服务。入口通过 `context.services.require<T>(name)` 获取服务，通过 `context.provide(name, object)` 提供实现。未声明的服务访问、重复提供者和循环依赖会被拒绝。依赖使用 Chord local service handles；插件不直接导入其他插件实现。

插件操作使用 `${pluginId}:` 前缀。内置业务操作由 Host 静态注册；外部插件只能登记自己命名空间的操作，不能覆盖内置操作。`context.dataDirectory` 是该插件在 `plugin-data/` 下的独立数据目录。

## Agent 与 UI 入口

普通 Agent 入口导出 Pi 原生 `ExtensionFactory`：

```ts
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

export default function extension(pi: ExtensionAPI) {
  pi.on('session_start', async (_event, context) => {
    context.ui.setStatus('clock:ready', '时间工具已就绪')
  })
}
```

工具、命令和 hook 使用 Pi 1.1 的公开扩展接口，hook 用 `pi.on`。静态 Worker 内置工厂使用内部上下文注入路径、配置与权限策略；外部 Agent 只有普通 ExtensionFactory，不能注册或覆盖沙箱与访问策略。函数对象不跨 Worker 传递。

UI 入口导出 `activate(context)`，使用 `context.contribute` 登记贡献，返回释放函数：

```tsx
import type { UiPluginContext } from '@pi-meme/plugin-sdk/ui'

export function activate(context: UiPluginContext) {
  return context.contribute({
    id: `${context.pluginId}:page`,
    slot: 'page',
    title: '时间工具',
    render: () => <p>时间工具页面</p>,
  })
}
```

固定槽位是 `page`、`sidebar`、`composer`、`tool-card`、`status`、`settings`。贡献 ID 使用 `${pluginId}:` 前缀。`context.call<T>(method, args)` 调用本插件的 Host 操作。渲染参数包括所属 Host、会话和快照；内置业务组件接收 App 注入的具体 Props。

`interaction` 将 Pi 的选择、确认、输入、编辑、通知、状态和文本挂件映射到图形界面。Pi TUI 的 `custom()` 组件不会自动成为 React 组件；需要在 App 插件 UI 入口补图形界面。

## 更新、停用和卸载

```mermaid
%%{init: {"theme": "dark"}}%%
flowchart LR
  Source["构建目录或上传包"] --> Validate["校验与不可变快照"]
  Validate --> Group["计算受影响服务依赖组"]
  Group --> Agent["纯 Agent：新会话取新代次"]
  Agent --> Retain["旧任务保留旧代次租约"]
  Retain --> Release["租约结束后释放旧代码"]
  Group --> Server["共享 Server：阻止本组新调用"]
  Server --> Drain["等待相关任务、工具、子任务与交互结束"]
  Drain --> Switch["释放旧作用域，创建新版"]
  Switch --> Restore["启动失败时恢复旧版"]
```

纯 Agent 插件允许新旧代次并存。服务插件按 `requires`/`provides` 组成依赖组；切换共享服务时先等待这个组的使用者释放，避免文件、端口等资源同时被两个版本使用。只更新 Git 或历史查询时，不等待无关 Agent 任务。UI 使用所属代次的资源地址。

图形交互桥是内置能力。外部插件切换仍等待相关工具、子任务与交互租约；父子 Worker 各自持有外部 Agent 代次，不因根会话停止读取界面就提前释放。

目录安装保存原目录位置。“重新加载”会读取那里重新构建的产物；Host 当前使用的目录是不可变快照，修改源文件不会改变正在运行的旧任务。上传包没有开发目录，重新加载只重启当前版本；更新代码需要上传新包。内置 ID 的启用、停用、卸载和重新加载一律拒绝。

停用后撤销操作、Agent 入口和 UI 贡献。若其他启用插件依赖它提供的必需服务，Host 拒绝停用或卸载；先停用使用者。外部插件不能提供或替换内置安全服务。卸载释放资源并删除不再使用的代码快照，默认保留插件数据和 Pi 会话。

插件属于可信宿主代码，拥有 Node Host 权限。Agent 的三档文件权限和沙箱另行约束；插件可信不表示 Agent 自动获得完全权限。内置权限/沙箱不可用或初始化失败时，受限任务拒绝启动。Pi SDK 和 Host 二进制升级随应用发布，不通过插件热更新替换。

## 内置身份与启动恢复

`packages/plugin-sdk/src/reserved.ts` 保存内置身份和保留服务。目录安装、`.pim` 安装、替换与启动恢复在执行外部入口前检查身份冲突，来源字段或相同包名不能把外部代码变成内置代码。

`plugins/installed.json` 只保存外部记录。旧内置记录经过校验后移出安装清单；同名外部覆盖、损坏包、缺失依赖和初始化失败按依赖组隔离，保留源目录与用户数据。安装清单无法解析时保留原文件、本次不加载外部项；基础 Host 仍运行，开发者页面展示诊断。内置初始化失败则明确中止启动。

外部插件拥有可信 Host 权限。Agent 的三档权限和计划模式执行检查独立生效；安装插件不会让任务越过父权限，规划模式也不加载外部工具或 MCP。
