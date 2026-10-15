---
description: '功能修改位置、TypeScript 约定、检查命令、测试范围与 macOS 打包'
status: implemented
paths:
  - 'package.json'
  - 'tsconfig.json'
  - 'eslint.config.mjs'
  - 'prettier.config.js'
  - 'scripts/**'
  - 'tests/fixtures/**'
  - 'apps/desktop/forge.config.ts'
  - 'apps/desktop/tests/**'
  - 'apps/server/tests/**'
  - '.github/workflows/**'
  - 'packages/chat/src/ui/**'
  - 'packages/ui/src/**'
  - 'packages/app-ui/src/**'
---

# 开发与验证

先按 [快速开始](getting-started.md) 安装依赖。本文命令均在仓库根目录执行；项目长期规则见 [AGENTS.md](../AGENTS.md)，进程与依赖方向见 [架构](architecture.md)。

## 修改位置

| 任务                                    | 目录或文件                                                                           |
| --------------------------------------- | ------------------------------------------------------------------------------------ |
| 输入框、补全、附件与输入队列            | [packages/chat/src/ui/composer](../packages/chat/src/ui/composer/)                   |
| 对话、消息操作与工具卡片                | [packages/chat/src/ui/conversation](../packages/chat/src/ui/conversation/)           |
| Markdown、消息投影和聊天状态            | [content](../packages/chat/src/ui/content/)、[model](../packages/chat/src/ui/model/) |
| 项目、会话索引与侧栏                    | [packages/workspace/src](../packages/workspace/src/)                                 |
| 原生会话历史、导出与分支树              | [packages/history/src](../packages/history/src/)                                     |
| 设置导航、独立技能/插件页、右侧工具标签 | [packages/app-ui/src](../packages/app-ui/src/)                                       |
| 公共类型与正式控制接口                  | [packages/contracts/src](../packages/contracts/src/)                                 |
| 协议、认证、路由与内置装配              | [packages/host/src](../packages/host/src/)                                           |
| Electron 窗口、preload 和平台 IPC       | [apps/desktop/src](../apps/desktop/src/)                                             |
| 新的外部 App 插件                       | [DevKit](../packages/plugin-devkit/src/cli.ts)，用法见 [插件开发](plugins.md)        |

业务包按实际需要创建 `src/server`、`src/agent`、`src/ui` 和 `src/shared`，不创建空层。新增功能先确认是内置能力还是可独立安装、移除的 App 插件。

## TypeScript 与 UI 约定

- 文件名用 kebab-case，组件和类型用 PascalCase，函数和变量用 camelCase，Hook 用 `use` 前缀。
- 包内使用相对导入；跨包使用 `@pi-meme/<包名>/<子路径>`，直接导入具体文件，不新增批量导出的 `index.ts`。
- 组件 Props 留在组件文件；共享聊天类型放在 [model/types.ts](../packages/chat/src/ui/model/types.ts)。
- 基础交互使用 [ui/components/ui](../packages/ui/src/components/ui/) 原语；图标使用 `lucide-react`，类名组合使用 [cn](../packages/ui/src/lib/utils.ts)。
- 刷新保留已有列表结构；加载与禁用状态只影响触发操作。快速刷新动画保底约 400ms，Switch 包含 opacity 过渡。
- Popover 关闭动画结束前保留虚拟 Anchor，显式指定展开方向。规则原文见 [AGENTS.md](../AGENTS.md)。

[Prettier 配置](../prettier.config.js) 使用两空格、单引号、无分号、LF、120 列和尾随逗号；[ESLint 配置](../eslint.config.mjs) 与 [tsconfig](../tsconfig.json) 管理 Lint 和类型检查。

## 质量检查

代码修改后按顺序执行，前一项通过后再执行下一项：

```bash
pnpm type-check
pnpm lint
pnpm format
```

`format` 运行 `prettier --check .`，不会写文件。只修本次改动引入的问题，既有错误单独报告。仅修改文档时检查文档格式、链接、来源路径和图示，不无条件运行应用构建。

按改动范围继续验证：

| 命令                    | 覆盖范围与使用条件                                                                                              |
| ----------------------- | --------------------------------------------------------------------------------------------------------------- |
| `pnpm check-boundaries` | 静态/动态导入、re-export、包依赖声明及 UI/进程边界；检查器在 [scripts](../scripts/check-package-boundaries.mjs) |
| `pnpm test`             | 递归运行各包测试，测试命令使用 `node:test`、`node:assert/strict` 和 tsx                                         |
| `pnpm test:host`        | Host 协议、资源、控制 API 和集成测试                                                                            |
| `pnpm test:plugins`     | 外部插件运行时测试                                                                                              |
| `pnpm build:web`        | 浏览器入口与共享 React 产物                                                                                     |
| `pnpm build:server`     | 独立 Host 与静态 Worker 构建                                                                                    |
| `pnpm test:server`      | 先构建，再运行 [Server 产物测试](../apps/server/tests/)；包含默认受限权限与完全权限案例                         |

测试放在所属包或插件的 `tests/<功能>.test.ts`。修 bug 先复现，再添加回归断言。共享假模型、MCP 与 App 插件 fixture 位于 [tests/fixtures](../tests/fixtures/)，通过文件 URL 定位。使用临时数据目录，不调用真实模型、不读写真实凭据或会话。

Linux CI 配置在 [linux.yml](../.github/workflows/linux.yml)：Ubuntu 24.04、Node.js 24.14.0、pnpm 10.29.1，安装 bubblewrap 后执行质量检查、边界检查、测试、Web 构建与 Server 产物验收。配置存在不表示本次运行过 CI。

## macOS 打包与验收

使用 Node.js 24.14.0。Node.js 26 下曾复现 Forge 退出码为 0 但没有生成 `.app`，需要检查实际产物，不能只看退出码。

```bash
pnpm package
pnpm test:package
pnpm test:desktop
```

修改窗口、preload、平台 IPC 或打包接线时执行以上三项。`package` 生成本机应用，`test:package` 检查签名和运行时，`test:desktop` 运行 Electron 完整验收。arm64 产物路径为 `apps/desktop/out/pi-meme-darwin-arm64/pi-meme.app`；截图在 `apps/desktop/out/desktop-smoke/`。

如果其他开发进程覆盖 `.vite` 缓存，可在完成 `package` 后从实际应用运行同一套验收：

```bash
PI_DESKTOP_PACKAGED_SMOKE=1 pnpm test:desktop
```

专项回归：

```bash
pnpm test:desktop:regression
```

专项回归依次运行模型、MCP、表单下拉、图片、侧栏菜单、侧栏搜索与显示控制。每项使用独立 Electron 进程，失败后继续其余项；存在失败时返回非零退出码。日志、截图和 `results.json` 写入 `apps/desktop/out/desktop-smoke/regression-<时间戳>/`。具体编排见 [desktop-regression.ts](../apps/desktop/tests/desktop-regression.ts)。

`pnpm make` 生成分发包。签名由 [Forge 配置](../apps/desktop/forge.config.ts) 管理：没有证书时使用 ad-hoc 签名，可用 `PI_DESKTOP_SIGNING_IDENTITY` 指定证书。当前没有配置公证或自动更新。

Desktop 与 Server 直接构建内置模块和 [静态 Worker](../packages/host/src/session-worker.ts)，不为内置模块单独生成插件 `dist/`。Desktop 还复制 Pi SDK 与 native runtime，相关脚本在 [copy-pi-runtime.mjs](../scripts/copy-pi-runtime.mjs) 与 [prepare-node-pty.mjs](../scripts/prepare-node-pty.mjs)。构建目录 `dist/`、`.vite/`、`out/` 不提交。
