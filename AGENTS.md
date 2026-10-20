# AGENTS.md

本文件适用于在此仓库工作的开发 Agent。

## 项目

pi-meme 是本地 Pi Coding Agent 的桌面客户端，外加可独立部署的 Host 和浏览器入口。Electron 只做平台壳；应用数据和执行调度在 Node Host。Desktop 与 Web 共用 React `app-ui`，走同一套 HTTP/WebSocket 协议。Pi 负责原生会话与扩展执行，Chord 负责外部插件的服务作用域。

项目文档从 [docs/index.md](docs/index.md) 按主题进入。

包管理器是 pnpm `10.29.1`（`packageManager` 字段）。macOS 打包用 Node.js 24.14.0：Node.js 26 下 Forge 可能退出码为 0 但没有生成 `.app`，要检查产物，不能只看退出码。

## 命令

都在仓库根目录执行。

```bash
pnpm start                 # Electron Forge 启动 Desktop（本地拉起 Host 子进程）
pnpm start:server          # 独立 Host：apps/server
pnpm start:web             # 浏览器入口：apps/web（Vite）
pnpm type-check            # 全 workspace tsc --noEmit
pnpm lint                  # 全仓 Lint，供 CI 或明确的全仓检查使用
pnpm format                # 全仓格式检查，供 CI 或明确的全仓检查使用
pnpm check-boundaries      # 包导入、依赖声明、UI/进程边界
pnpm test --list           # 列出可选业务功能，不执行测试
pnpm test --file <路径>    # 日常优先选择直接相关的测试文件
pnpm test --feature chat   # 确需跨包验证时扩大到聊天功能的源码测试
pnpm test:all              # 手动完整验收，包含必要构建和产物验收
pnpm build:web             # 浏览器入口
pnpm build:server          # 独立 Host 与静态 Worker
pnpm package               # 生成本机 .app
pnpm make                  # 分发包
```

## 验证与测试

代码任务收尾按顺序执行一轮 `pnpm type-check`、`pnpm exec eslint <变更文件>`、`pnpm exec prettier --check <变更文件>`，前一项通过后再执行下一项；失败修复后重跑受影响的检查。类型检查保留全仓，Lint 和 Format 只传本任务修改且仍存在的适用文件，包含新增和暂存文件，不包含已有无关改动或已删除路径。只修本次引入的问题。仅修改文档时检查格式、链接和来源路径，不运行类型检查或应用构建。

日常优先 `pnpm test --file <路径>`，需要时用 `--name` 缩到用例。确需跨包验证时才使用 `--feature`，不因所属功能自动扩大范围。修改测试清单或选测入口时运行 `pnpm test --feature testing` 和受影响文件，可用 `pnpm test --all --list` 检查完整清单。无参数 `pnpm test` 返回选测帮助并失败，不执行测试。

普通新功能不强制新增测试，不要求覆盖多个层次或达到覆盖率。文案、CSS、普通布局不新增仅验证展示细节的自动测试。修 bug 先用最窄范围复现，必要时补最小回归。会话持久化、存储迁移、凭据、认证和权限改动必须做针对性验证，必要时补用例，但不因此扩大到全仓。没有可复用用例的普通功能可做针对性手工检查，并说明未自动验证的部分。

未经用户明确要求相应验收，不自动运行全量测试、E2E、打包或产物验收；修改窗口、preload、IPC、打包接线或测试基础设施也不例外。单项验收只选择对应文件或平台，不扩大到整套完整测试。发布前由明确的验收任务或手动完整 workflow 验证目标平台。

日常 CI 保留全仓静态检查、包边界检查和源码测试，Web E2E 留在手动完整验收。普通 Agent 任务不运行或等待完整验收；报告已通过的检查、未运行的检查和剩余风险，不把本地任务完成写成发布验收通过。

测试使用 Vitest；组件交互使用 React Testing Library，Web 与开发态 Electron 使用 Playwright；真实产物保留 Node 原生测试。文件后缀明确标记 `unit`、`component`、`integration`、`e2e`、`artifact`，所有测试必须登记到 `tests/catalog.ts`。用临时数据目录、本地假模型和可释放的 fixture，不读写真实凭据或会话。具体选测和新增测试条件见 [测试](docs/testing.md)。

arm64 应用在 `apps/desktop/out/Pi meme-darwin-arm64/Pi meme.app`。`dist/`、`.vite/`、`out/`、`.vitest/` 不提交。

## 架构

```
Desktop (Electron) ──┐
                     ├─ app-ui (React) ─ client ─ Node Host ─┬─ 内置服务（静态装配）
Web (Vite) ──────────┘                                      ├─ 外部插件（Chord 作用域）
                                                            └─ pi-adapter ─ 会话 Worker ─ Pi SDK
```

入口：`apps/desktop/src/main/main.ts`、`apps/server/src/main.ts`、`apps/web/src/main.tsx`、`packages/host/src/server.ts`、`packages/host/src/session-worker.ts`。Host 用 Hono，路由在 `packages/host/src/transport-app.ts`，认证在 `transport-auth.ts`。

依赖方向：

- `packages/contracts` 是 HostApi、事件、资源与平台契约。基础包和契约不得反向依赖业务实现。
- `packages/host` 与 `packages/app-ui` 是组合根。业务包之间不互导私有实现，走契约、显式 Props 或声明的服务。
- UI 不导入 Server、Agent、Node 或 Electron。Electron main 不实现聊天、配置、会话或插件生命周期。
- 跨包导入写 `@pi-meme/<包名>/<具体文件>`，不要新增批量导出的 `index.ts`。包内用相对路径。
- 边界由 `scripts/check-package-boundaries.mjs` 检查静态导入、动态 `import()`、re-export 和 UI 边界。

内置模块由 `packages/host/src/builtin-modules.ts` 静态装配（聊天、工作区、历史、模型、设置、资源、交互、子代理、MCP、codemode、权限、当前平台沙箱、用量、git）。内置初始化失败会中止 Host。外部 App 插件由用户安装，走独立启停；恢复失败只隔离相关依赖组。插件源码在 `plugins/`，SDK 在 `packages/plugin-sdk`、`plugin-runtime`、`plugin-devkit`。插件不能替换左侧导航或中央聊天；工具面板只允许 `right`。

同一个 Host 是其数据目录的唯一写入者。会话 Worker 按执行会话独立创建，持有固定资源快照和插件代次；JSONL 由 Pi SDK 保存。正式 HostApi v2 用稳定 `ProjectRef` / `SessionRef` 操作显式目标，不读写界面选择。App 内部 `/api/rpc` 继续服务内置界面。`PlatformAdapter`（`packages/contracts`）承载本机文件选择、Finder/编辑器等平台操作；Electron preload 只连接平台 channel。远程路径不要交给本机文件选择器。

## 改代码时容易踩的约定

- 文件名 kebab-case；组件和类型 PascalCase；函数与变量 camelCase；Hook 用 `use` 前缀。
- 组件 Props 留在组件文件。共享聊天类型在 `packages/chat/src/ui/model/types.ts`。
- 基础交互用 `packages/ui` 的原语，图标用 `lucide-react`，类名用 `cn`。
- 页面顶栏复用 `packages/app-ui/src/layout/page-header.tsx` 的 `PageHeader` 和 `PageHeaderNavigation`；顶栏高度、交通灯留白和导航按钮样式只在该文件维护。页面自己的操作通过子组件组合，并使用 `no-drag` 标记交互区域。
- 新功能先判断是内置能力还是可独立安装的 App 插件。业务包按需建 `src/server`、`src/agent`、`src/ui`、`src/shared`，不建空层。
- 刷新保留已有列表结构；加载和禁用只作用在触发操作上。Popover 关闭动画结束前保留虚拟 Anchor，并显式指定展开方向。
- Prettier：两空格、单引号、无分号、LF、120 列、尾随逗号。
- 没有配置公证或自动更新。无证书时 Forge 用 ad-hoc 签名，可用 `PI_DESKTOP_SIGNING_IDENTITY` 指定证书。
