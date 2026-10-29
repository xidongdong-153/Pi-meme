---
description: '功能修改位置、UI 原语、内置图片与代码展示的开发入口'
status: implemented
paths:
  - 'package.json'
  - 'tsconfig.json'
  - 'eslint.config.mjs'
  - 'prettier.config.js'
  - 'scripts/sync-file-icons.mts'
  - 'scripts/copy-pi-runtime.mjs'
  - 'scripts/prepare-node-pty.mjs'
  - 'apps/desktop/forge.config.ts'
  - 'packages/chat/src/ui/**'
  - 'packages/ui/src/**'
  - 'packages/app-ui/src/**'
  - 'packages/assets/**'
  - 'apps/desktop/src/main/dock-icon.ts'
---

# 开发指南

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

文件目录和搜索结果使用 [FileIcon](../packages/ui/src/components/file-icon.tsx)，内置 [Catppuccin vscode-icons v1.26.0](https://github.com/catppuccin/vscode-icons/tree/b6915da9f6889b683a110aa747de96c2820a537d) 的 SVG 图标与官方名称映射。资源在 `packages/assets/files/file-icons/`，运行时不请求外网；明暗模式分别使用 Latte 和 Mocha 配色。先匹配文件名，再匹配最长扩展名；目录按名称匹配并区分展开状态，未知类型使用默认图标。更新时修改 [sync-file-icons.mts](../scripts/sync-file-icons.mts) 中的固定提交，再运行 `pnpm exec tsx scripts/sync-file-icons.mts`。MIT 许可保存在同目录，并由发布脚本收录。

聊天消息和输入区共用 [global.css](../packages/app-ui/src/global.css) 的 `.chat-content-column`，按聊天面板宽度居中，最大宽度为 `48rem`。Markdown 代码块根据围栏上的语言标记交给 Shiki 高亮，支持 `ts`、`js`、`c++`、`c#`、`shell` 等别名；未标记或不支持的语言保留原文。高亮随应用明暗模式切换；代码块默认展开，点击标题栏可折叠，折叠后仍可复制完整代码。代码正文比聊天正文字号小 `1px`，最大高度为 `320px`，超出后在块内滚动；长行和宽表格在各自容器内横向滚动。入口在 [markdown-components.tsx](../packages/chat/src/ui/content/markdown-components.tsx)、[code-block.tsx](../packages/chat/src/ui/content/code-block.tsx) 和 [use-highlighter.ts](../packages/chat/src/ui/content/use-highlighter.ts)。

前端导航、Tab、面板和异步加载遵循 [UI 体验与动效](ui-experience.md)，复用切换参数、等待反馈和减少动态效果规则。

## 代码约定与验证入口

命名、依赖方向、组件 Props、顶栏与交互规则统一见 [AGENTS.md](../AGENTS.md)。共享聊天类型在 [model/types.ts](../packages/chat/src/ui/model/types.ts)，基础交互使用 [UI 原语](../packages/ui/src/components/ui/)，类名通过 [cn](../packages/ui/src/lib/utils.ts) 组合。文件图标使用 `FileIcon`，其他图标使用 `lucide-react`。

[Prettier](../prettier.config.js)、[ESLint](../eslint.config.mjs) 与 [tsconfig](../tsconfig.json) 保存格式、Lint 和类型配置。

- 日常修改：按[测试](testing.md#日常验证与新增测试)依次执行全仓类型检查、变更文件 Lint/Format，再选择必要的相关用例。
- 分发与验收：按[版本发布](releasing.md)构建 Host 或 Desktop 包、验证产物与创建发布草稿。

Desktop 与 Server 直接构建内置模块和[静态 Worker](../packages/host/src/session-worker.ts)。Desktop 的 Pi SDK 与原生运行时复制见 [copy-pi-runtime.mjs](../scripts/copy-pi-runtime.mjs)，PTY 准备见 [prepare-node-pty.mjs](../scripts/prepare-node-pty.mjs)。构建目录 `dist/`、`.vite/`、`out/` 不提交。
