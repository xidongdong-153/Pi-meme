# AGENTS.md

本文件适用于在此仓库工作的开发 Agent。

## 项目

pi-meme 是本地 Pi Coding Agent 的桌面客户端，外加可独立部署的 Host 和浏览器入口。Electron 只做平台壳；应用数据和执行调度在 Node Host。Desktop 与 Web 共用 React `app-ui`，走同一套 HTTP/WebSocket 协议。Pi 负责原生会话与扩展执行，Chord 负责外部插件的服务作用域。

项目文档从 [docs/index.md](docs/index.md) 按主题进入。

包管理器是 pnpm `10.29.1`（`packageManager` 字段）。macOS 打包用 Node.js 24.14.0：Node.js 26 下 Forge 可能退出码为 0 但没有生成 `.app`，要检查产物，不能只看退出码。

## 命令

都在仓库根目录执行。

```bash
pnpm start                 # macOS/Windows：Desktop + Host + Web；Linux/WSL：Host + Web
pnpm start:server          # 独立 Host：apps/server
pnpm start:web             # 浏览器入口：apps/web（Vite）
pnpm type-check            # 全 workspace tsc --noEmit
pnpm lint                  # 全仓 Lint，供 CI 或明确的全仓检查使用
pnpm format                # 全仓格式检查，供 CI 或明确的全仓检查使用
pnpm check-boundaries      # 包导入、依赖声明、UI/进程边界
pnpm check                 # 全仓类型、Lint、Format 和包边界检查
pnpm test --list           # 保留的测试功能目录，只列清单
pnpm test --all --list     # 保留的完整清单，当前为空
pnpm test:source           # 历史源码测试入口；当前空清单跳过
pnpm test:web              # 历史 Web E2E 入口；当前空清单跳过
pnpm test:all              # 历史全层次入口；当前空清单跳过
pnpm build:web             # 浏览器入口
pnpm build:server          # 独立 Host 与静态 Worker
pnpm package               # 生成本机 Desktop 应用目录
pnpm make                  # 分发包
pnpm release               # 推送已提交的当前分支和版本 Tag，触发构建并自动公开 Release
```

## Git 提交

- 后续所有 Git 提交必须遵循 Conventional Commits 1.0.0，标题格式为 `<type>[可选 scope][可选 !]: <描述>`，使用英文半角冒号并在其后留一个空格。
- `type` 使用小写英文；新增功能用 `feat`，修复用 `fix`，其余类型、范围与示例见[开发指南](docs/development.md#git-提交规范)。描述和正文默认使用中文，不写 emoji。
- 破坏性变更必须用标题中的 `!` 或脚注 `BREAKING CHANGE: <说明>` 标记，并说明不兼容内容。
- 每次提交只包含同一目的的改动，不混入已有无关修改；提交前核对暂存差异，提交信息必须对应实际改动。
- 执行 `git commit`、`git push`、`git merge` 前，必须先展示改动摘要并获得用户明确确认；提交确认同时展示拟用提交信息。未确认时只保留工作区或暂存区改动。

## 验证与测试

代码任务收尾按顺序执行一轮 `pnpm type-check`、`pnpm exec eslint <变更文件>`、`pnpm exec prettier --check <变更文件>`，前一项通过后再执行下一项；失败修复后重跑受影响的检查。类型检查保留全仓，Lint 和 Format 只传本任务修改且仍存在的适用文件，包含新增和暂存文件，不包含已有无关改动或已删除路径。只修本次引入的问题。仅修改文档时检查格式、链接和来源路径，不运行类型检查或应用构建。

不新增任何测试文件，包括单元、集成、契约、快照、E2E 和守门脚本。既有测试不扩张、不维护、不修红灯，也不作为交付闸门或完成证据；未经点名不整批删除。没有测试不能成为缩小交付范围的理由。

实现验收看用户真实路径，由未参与编写的接手者主动构造反例并记录实际行为。结论必须写明 oracle 对应的真实路径、实际 Hacker 和可追溯的操作输出；作者自审、测试全绿、检查或构建成功均不能代替。缺少真实证据时标“未验”。会话持久化、存储迁移、凭据、认证和权限变更须针对相应边界核对，不扩大为全仓测试。无损重构或切割按可证明的等价性标准处理。

文档编写与功能验收分开：只核对来源、链接和格式，不安排或代写验收回执，交付标“未验（本轮仅编写文档）”。报告实际改动、已做检查和待确认项，不把文档同步写成功能已验。

当前业务测试用例及专用夹具已清空，框架、配置、依赖、选测入口和 CI 保留。空清单下显式选择合法范围只显示跳过，不启动运行器或构建；无参数 `pnpm test` 返回帮助并失败。历史入口、CI 现状及真实路径规则统一见[验证与测试基础设施](docs/testing.md)。

未经用户明确要求相应验收，不自动运行全量测试、E2E、打包或产物验收；修改窗口、preload、IPC、打包接线或测试基础设施也不例外。单项验收只覆盖指定功能或平台，不扩大到完整流程。普通 Agent 任务不运行或等待完整验收，发布范围见[版本发布](docs/releasing.md)。

arm64 应用在 `apps/desktop/out/Pi meme-darwin-arm64/Pi meme.app`。`dist/`、`.vite/`、`out/`、`.vitest/` 不提交。

## 架构

```
Desktop (Electron) ──┐
                     ├─ app-ui (React) ─ client ─ Node Host ─┬─ 内置服务（静态装配）
Web (Vite) ──────────┘                                      ├─ 可信插件（Chord 作用域）
                                                            ├─ 受限插件（独立进程 + OS 沙箱）
                                                            └─ pi-adapter ─ 会话 Worker ─ Pi SDK
```

入口：`apps/desktop/src/main/main.ts`、`apps/server/src/main.ts`、`apps/web/src/main.tsx`、`packages/host/src/server.ts`、`packages/host/src/session-worker.ts`。Host 用 Hono，路由在 `packages/host/src/transport-app.ts`，认证在 `transport-auth.ts`。

依赖方向：

- `packages/contracts` 是 HostApi、事件、资源与平台契约。基础包和契约不得反向依赖业务实现。
- `packages/host` 与 `packages/app-ui` 是组合根。业务包之间不互导私有实现，走契约、显式 Props 或声明的服务。
- UI 不导入 Server、Agent、Node 或 Electron。Electron main 不实现聊天、配置、会话或插件生命周期。
- 跨包导入写 `@pi-meme/<包名>/<具体文件>`，不要新增批量导出的 `index.ts`。包内用相对路径。
- 边界由 `scripts/check-package-boundaries.mjs` 检查静态导入、动态 `import()`、re-export 和 UI 边界。

内置模块由 `packages/host/src/builtin-modules.ts` 静态装配，模块清单与平台选择见[架构](docs/architecture.md#内置能力与系统工具)。内置初始化失败会中止 Host。外部 App 插件由用户安装，走独立启停；恢复失败只隔离相关依赖组。插件源码在 `plugins/`，SDK 在 `packages/plugin-sdk`、`plugin-runtime`、`plugin-devkit`。外部插件使用 SDK 3，Agent/Server 入口分 `trusted` 与 `restricted`，不保留 SDK 2 执行路径。插件可新增自己的活动栏入口、次级菜单和中央业务页，但不能替换内置导航或聊天；工具面板仍只允许 `right`。

同一个 Host 是其数据目录的唯一写入者。会话 Worker 按执行会话独立创建，持有固定资源快照和插件代次；JSONL 由 Pi SDK 保存。正式 HostApi 用稳定 `ProjectRef` / `SessionRef` 操作显式目标，不读写界面选择。App 内部 `/api/rpc` 继续服务内置界面。`PlatformAdapter`（`packages/contracts`）承载本机文件选择、Finder/编辑器等平台操作；Electron preload 只连接平台 channel。远程路径不要交给本机文件选择器。

## 改代码时容易踩的约定

- 文件名 kebab-case；组件和类型 PascalCase；函数与变量 camelCase；Hook 用 `use` 前缀。
- 组件 Props 留在组件文件。共享聊天类型在 `packages/chat/src/ui/model/types.ts`。
- 基础交互用 `packages/ui` 的原语，图标用 `lucide-react`，类名用 `cn`。
- 页面顶栏复用 `packages/app-ui/src/layout/page-header.tsx` 的 `PageHeader` 和 `PageHeaderNavigation`；顶栏高度、交通灯留白和导航按钮样式只在该文件维护。页面自己的操作通过子组件组合，并使用 `no-drag` 标记交互区域。
- 新增或修改内置系统能力时，按 [Host 内置工具](docs/host-system-tools.md) 接入 Agent 读取与操作；复用 Host 业务服务，登记参数、作用范围和读写权限，客户端操作绑定发起客户端。
- Pi meme 自有 API（HostApi、HTTP 路由、请求与响应字段、能力名、运行握手及文档）默认不加 `v1`/`v2`、`apiVersion`、`protocolVersion` 等版本标记；演进时优先按具体能力判断。确需版本化时，先说明兼容对象、迁移路径和旧客户端行为。第三方协议、插件 SDK 与持久化格式按各自契约处理。
- 新功能先判断是内置能力还是可独立安装的 App 插件。业务包按需建 `src/server`、`src/agent`、`src/ui`、`src/shared`，不建空层。
- 插件的安装、项目启停、会话选择与能力授权分别校验。插件 Agent 与 MCP 仅在完全权限普通任务中加载；Plan、本地只读和工作区修改只装配内置工具，在导入、初始化、工具发现和连接前检查有效权限。独立 Server 与 UI 保留既有授权与隔离。受限 JS 必须在独立进程和 OS 沙箱中运行；UI 与可信 Server 不属于恶意代码沙箱。
- 插件输入框 API 复用唯一草稿和提交守卫；发送前处理必须显式授权。消息引用使用 Pi 原生 entry ID，不能用时间戳或数组下标代替。插件页目标、执行目标与当前输入框引用不得混用。
- 新增或修改导航、Tab、面板与加载状态时遵循 [UI 体验与动效](docs/ui-experience.md)，复用现有过渡入口，保持页面状态，并支持系统和应用的减少动态效果设置。
- 刷新保留已有列表结构；加载和禁用只作用在触发操作上。Popover 关闭动画结束前保留虚拟 Anchor，并显式指定展开方向。
- Prettier：两空格、单引号、无分号、LF、120 列、尾随逗号。
- 从 0.1.9 起，「设置 → 关于」检查稳定版，安装包由用户下载、校验并手动安装。macOS 尚未配置公证。无证书时 Forge 用 ad-hoc 签名，可用 `PI_DESKTOP_SIGNING_IDENTITY` 指定证书。
