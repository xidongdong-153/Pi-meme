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
  - 'packages/assets/**'
  - 'apps/desktop/src/main/dock-icon.ts'
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
| 内置图片、应用图标与 Dock 图标          | [packages/assets/files](../packages/assets/files/)                                   |
| 公共类型与正式控制接口                  | [packages/contracts/src](../packages/contracts/src/)                                 |
| 协议、认证、路由与内置装配              | [packages/host/src](../packages/host/src/)                                           |
| Electron 窗口、preload 和平台 IPC       | [apps/desktop/src](../apps/desktop/src/)                                             |
| 新的外部 App 插件                       | [DevKit](../packages/plugin-devkit/src/cli.ts)，用法见 [插件开发](plugins.md)        |

业务包按实际需要创建 `src/server`、`src/agent`、`src/ui` 和 `src/shared`，不创建空层。新增功能先确认是内置能力还是可独立安装、移除的 App 插件。

内置界面图片、应用图标和 Dock 图标只放在 [packages/assets/files](../packages/assets/files/)。目录按用途分开：`brand`、`agents`、`system-plugins`、`system-skills`、`desktop/dock`、`desktop/icons`。界面从 [builtin.ts](../packages/assets/src/builtin.ts) 按固定文件名读取，每张图都写成字面量 `new URL`，不要拼路径，否则打包不会带上文件；Forge 用 `desktop/icons/pi-dev-dark`（不带扩展名）作为应用图标，并把 `desktop/dock` 拷到打包产物的 `Resources/dock`。换图时覆盖同名文件，不改引用。子代理头像在 `agentAvatars` 里的顺序就是 `data-variant`，不要调换。插件自己的 `assets/` 留在插件包内，不放进这个目录。

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

按改动范围继续验证，选测表和完整命令见 [测试](testing.md)。

| 命令                                                    | 用途                                        |
| ------------------------------------------------------- | ------------------------------------------- |
| `pnpm check-boundaries`                                 | 包依赖声明、导入方向与 UI/进程边界          |
| `pnpm test --feature chat`                              | 聊天功能跨包的单元、组件和集成测试          |
| `pnpm test --feature plugins --layer integration`       | 插件集成测试                                |
| `pnpm test --file <路径> --name <名称模式>`             | 单文件中的指定用例                          |
| `pnpm test --all --layer artifact --target server`      | 构建并验证 Server 产物                      |
| `pnpm test --all --layer e2e,artifact --target desktop` | 构建并验证开发态 Electron 与真实 macOS 应用 |
| `pnpm test:all`                                         | 当前平台支持的全部测试与产物验收            |

测试归所属包；共享假模型与测试环境在 [tests/fixtures](../tests/fixtures/)。测试使用临时数据目录，不调用真实模型、不读写真实凭据或会话。新增测试必须登记到 [catalog.ts](../tests/catalog.ts)，登记完整性由 `testing` 功能检查。

Linux PR 检查运行源码测试和 Web 核心流程；手动 [完整测试](../.github/workflows/full-tests.yml) 分别运行 Linux、macOS 验收。配置存在不表示本次运行过远程 CI。

## macOS 打包与验收

使用 Node.js 24.14.0。Forge 退出成功后仍要验证实际 `.app`。修改窗口、preload、平台 IPC 或打包接线时运行：

```bash
pnpm test --all --layer e2e,artifact --target desktop
```

入口只打包一次，再运行 Playwright 桌面用例和真实应用验收。正式 `.app` 关闭 Node 调试 Fuse，产物测试直接启动 `Contents/MacOS/pi-meme`，不修改发布配置。报告和截图在 `out/tests/`。

`pnpm make` 生成分发包。签名由 [Forge 配置](../apps/desktop/forge.config.ts) 管理：没有证书时使用 ad-hoc 签名，可用 `PI_DESKTOP_SIGNING_IDENTITY` 指定证书。当前没有配置公证或自动更新。

Desktop 与 Server 直接构建内置模块和 [静态 Worker](../packages/host/src/session-worker.ts)，不为内置模块单独生成插件 `dist/`。Desktop 还复制 Pi SDK 与 native runtime，相关脚本在 [copy-pi-runtime.mjs](../scripts/copy-pi-runtime.mjs) 与 [prepare-node-pty.mjs](../scripts/prepare-node-pty.mjs)。构建目录 `dist/`、`.vite/`、`out/` 不提交。
