# Repository Guidelines

## 项目结构与模块职责

仓库使用 pnpm workspace：`apps/` 放运行入口，`packages/` 放基础包与内置业务模块；可选 `plugins/` 只放独立分发的 App 插件源码。

- `apps/desktop`：Electron 窗口、本地 Host 子进程、平台 IPC 与 Desktop 入口；不实现业务服务。
- `apps/server`：独立 Node Host 启动、环境变量与退出清理。
- `apps/web`：Web 入口、登录与浏览器构建。
- `packages/contracts`：Pi、Host、会话、设置、模型、资源和平台契约。
- `packages/ui`：通用 UI 原语、图标、ErrorBoundary、`cn`、CSS tokens 与工具卡片扩展入口。
- `packages/app-ui`：Desktop/Web 共用布局、功能协调、技能/插件独立页面、右侧工具标签与七类 UI 贡献槽。
- `packages/client`：HTTP/WebSocket、快照、功能 Bridge 和平台适配。
- `packages/host`：认证、唯一数据写入、客户端选择、内置静态装配与外部插件生命周期。
- `packages/pi-adapter`：Worker、Pi SDK 装配和凭据同步。
- `packages/pi-runtime`：会话池、事件转换、原生 JSONL 与安全执行底层。
- `packages/plugin-sdk`、`plugin-runtime`、`plugin-devkit`：插件契约、Chord 作用域及创建/构建/验证/打包。
- `packages/{chat,workspace,history,models,settings,resources,interaction,subagents,mcp,codemode,permissions,sandbox-macos,sandbox-linux,usage,git}`：Server、Agent、UI 实现与测试。
- `tests/fixtures`：共享假模型端点、App 插件和技能 fixture，用文件 URL 定位。

业务包与插件只创建有代码的目录：`src/server`、`src/agent`、`src/ui`、`src/shared`。`packages/interaction` 的包身份为 `@pi-meme/interaction`。`dist/`、`.vite/` 和 `out/` 是构建目录，不提交。

## 安装、开发与构建

使用 pnpm `10.29.1`，Node.js 最低 `22.19.0`，推荐 Node.js `24.14.0`。Pi 1.1 与内置模块随应用分发，不要求本机 Pi CLI。Node.js 26 下已复现 Electron Forge 退出码为 0 但不生成 `.app`；打包使用 Node.js 24.14.0，并检查 `apps/desktop/out/` 中的实际产物。

- `pnpm install`：安装工作区依赖。
- `pnpm start`：直接构建并启动 Desktop。
- `pnpm start:server`：启动独立 Host。
- `pnpm start:web`：启动 Web 开发界面。
- `pnpm build:web`、`pnpm build:server`：构建对应产物。
- `pnpm package`：生成本机 macOS 应用。
- `pnpm make`：生成分发包。

## 代码风格与命名

使用严格 TypeScript。Prettier 使用两空格、单引号、无分号、LF、120 列和尾随逗号；ESLint 使用 `eslint.config.mjs`。

文件用 kebab-case，组件和类型用 PascalCase，函数与变量用 camelCase，Hook 用 `use` 前缀。组件 Props 留在组件文件，共享聊天类型放在 `packages/chat/src/ui/model/types.ts`。跨包导入用 `@pi-meme/<包名>/<子路径>`，包内用相对导入。直接导入具体文件，不新增批量导出的 `index.ts`。

业务包与插件不互导私有实现；使用契约、显式 Props 或声明的服务。Host 与 app-ui 是组合根，基础包不得反向依赖业务包。UI 不导入 Server、Agent、Node 或 Electron；Electron 不承载聊天、配置、会话或插件业务。

## 前端与用户体验规范

统一组件与交互体验，防止布局偏移与界面闪烁：

- **统一 UI 库与原语**：基础交互组件必须使用 `@pi-meme/ui/components/ui/*`（`Button`、`Switch`、`Input`、`Popover`、`Dialog`、`Tooltip` 等），图标统一使用 `lucide-react`，类名组合统一使用 `@pi-meme/ui/lib/utils` 的 `cn`；不私自手写非标替代组件。
- **避免布局偏移（CLS）**：已有数据刷新时保持现有卡片或列表结构静止，禁止临时在列表中间插入破坏排版的加载提示；仅在初次无数据时展示空状态或骨架文案。
- **精细化状态控制**：加载与禁用状态收敛到触发源局部（如刷新按钮自身），禁止使用全局 `busy` 级联禁用无关的子组件（如刷新时不得导致列表内 `Switch` 或相邻操作置灰闪烁）。
- **平滑加载反馈**：刷新操作使用按钮内联旋转指示（`RefreshCw` 加 `animate-spin`），对快速异步任务设置保底展示时间（如 400ms），避免动画被打断产生抽搐跳变；可变状态的组件（如 `Switch`）必须包含 `opacity` 过渡。
- **浮层与弹窗锚点稳定**：使用 `PopoverAnchor` 虚拟定位时，关闭退场动画完成前必须保持 Anchor 引用，禁止在 `open=false` 时提前卸载导致浮层回退瞬移；明确指定展开方向（`side`），避免关闭动画期间发生碰撞翻转。

## 检查与测试

代码修改后依次运行 `pnpm type-check`、`pnpm lint`、`pnpm format`，前一项通过后再执行下一项。只修本次引入的问题，既有错误单独报告。

`pnpm test` 递归运行 `node:test`、`node:assert/strict` 与 tsx 测试。测试放在所属包或插件的 `tests/`，文件名 `<功能>.test.ts`，修 bug 先复现再添加回归断言。公共 fixture 在 `tests/fixtures`。测试使用临时目录和假模型端点，不调用真实模型或读写真实配置。

`pnpm check-boundaries` 检查静态导入、动态 `import()` 和 re-export，拒绝业务包或插件互导实现、基础包反向依赖、未声明包依赖及 UI 引入 Node/Electron。

独立 Server 产物验收运行 `pnpm test:server`；它先构建，再从 `dist/main.js` 启动临时 Host，验证静态 Worker、假模型、外部工具、MCP、持续子代理与计划文件，不使用真实凭据。

涉及窗口、preload、平台 IPC 或打包的修改，运行 `pnpm package`、`pnpm test:package`、`pnpm test:desktop`。验收截图位于 `apps/desktop/out/desktop-smoke/`。

## 插件与会话安全

修改前阅读 `docs/architecture.md`，插件契约见 `docs/plugins.md`，独立 Host 运行见 `docs/remote.md`。

内置模块静态装配不读取用户插件启用记录；外部插件 `package.json` 的 `name/version` 是身份，`piMeme` 声明 SDK、入口与服务依赖。Node 与浏览器分别构建；UI 共享宿主 React。外部插件使用 App SDK 2：Server/UI 调用正式 `HostApi`，Agent 导出 `activate(context)` 并通过 App 接口注册工具、命令和生命周期。外部插件不取得 Pi `ExtensionAPI`、SessionManager、Worker 或内部 Store；不登记 `host.*`、`agent.*` 内部服务依赖。内置 Agent 工厂可继续使用 Pi 原生 `pi.on`。外部 AppAgent 仅在已选择、完全权限且普通任务时加载；未选择、受限权限或规划模式不得导入其入口。

Chord 1.1 `reload` 不能新增/删除 facet 或改变服务 shape。安装、卸载与拓扑变化通过独立 `create/dispose` 作用域完成。保持受影响组的调用 gate、任务/工具/SubAgent/交互租约和 UI 代次；纯 Agent 可新旧共存，共享 Server 等使用者释放。初始化或持久化失败保留/恢复旧版，必需服务的唯一提供者不能被拔掉。

Pi 会话使用公开 SDK 的 JSONL、恢复、分支与压缩。内置历史模块只索引/查询/导出/UI，不宣称任意存储替换。Pi 和 Host 二进制不通过插件热更新升级。

插件拥有可信 Host 权限，Agent 权限另行约束。保持三档权限，内置权限/沙箱不可用或沙箱失效时拒绝受限任务，不授予完全权限。

规划模式只允许读取工具、协作、提问与 `save_plan`；子代理继承父任务权限和模式。不得用完全权限绕过计划模式，也不得在保存计划后自动执行。

## 数据与凭据

Host 默认数据目录 `~/.pi-meme`，`PI_MEME_DATA_ROOT` 可修改；同一目录只允许一个 Host 写入。配置、主题、技能、会话、插件快照与插件数据都在此目录。项目 `.pi` 与 `AGENTS.md` 只读，不导入本机 Pi CLI 全局配置。

凭据由 Node Host 保存到数据目录的 `auth.json`，权限为 `0600`。启动不读取钥匙串；仅用户主动导入旧凭据时读取。不要提交凭据、个人配置或真实会话。协作身份与计划元数据写入 `collaboration.json`，子会话继续用 Pi JSONL；计划正文在 `plans/<sessionId>/<id>.md`。用户资源仅管理 AI 模型配置、技能、App 插件和 MCP；集成区只提供技能、插件、MCP 独立入口，不新增共享资源页或类型筛选；不装配 Host/项目裸 Pi 扩展或原生 Pi 包。App 资源只声明 `skills`、`themes` 和 `assets`。主题保持 JSON，背景图来自声明的包内素材，不执行 JavaScript 或任意 CSS。

正式控制接口使用 `apiVersion: 2`、稳定 `ProjectRef`/`SessionRef` 和调用方幂等键。操作指定目标，不借用界面选择；重启中断的提交不重放。新会话外部 Agent 默认列表为空，会话选择持久化，运行中拒绝改配置。左侧固定为置顶、项目、最近，中间固定聊天；插件面板只允许 `right`，通过当前聊天的右侧标签页打开；贡献槽为 `composer/composer-actions/tool-card/message/message-actions/status/settings`。卸载插件默认保留数据和 Pi 会话。

## Git 提交与 Pull Request

执行 `git commit`、`git push`、`git merge` 前，展示改动摘要并获得用户明确确认。未确认时停留在工作区或暂存区，不提交、不推送、不合并，不回滚用户或其他工具的改动。

PR 描述写明问题、修改后的行为和验证命令；有关联 issue 时附链接，界面修改附截图。
