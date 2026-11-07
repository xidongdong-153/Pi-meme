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
  - 'scripts/development-runtime.mts'
  - 'packages/host/src/runtime-snapshot.ts'
  - 'packages/pi-runtime/src/sdk/session.ts'
---

# 开发指南

先按 [快速开始](getting-started.md) 安装依赖。本文命令均在仓库根目录执行；项目长期规则见 [AGENTS.md](../AGENTS.md)，进程与依赖方向见 [架构](architecture.md)。

## 开发入口与权限迁移

官方 bootstrap 先完成 `assertStorageLayout`，再创建 cache/snapshot；开发 start 有限构建并发布 dataRoot 下的内容寻址快照，owner Host/Worker、依赖、preload 与静态 UI 不再跟随仓库 TS 或 Vite HMR。继续编辑项目后，下一次显式启动才使用新代码。本次开发数据根固定，切换需退出重启。认证和旧 SDK 升级不能靠修改版本字段绕过；详见 [权限控制与版本迁移](permissions-and-migration.md) 与 [App 插件](plugins.md)。

Electron 的快照检查使用 `createRequire(process.execPath)` 加载 `original-fs`，对原始 callback API 做 promisify，以物理 ASAR archive 语义核验，兼容 CJS/ESM。不要改回通过 Electron 虚拟目录或被改写的 promises 路径判断归档内容。来源：[development-runtime.mts](../scripts/development-runtime.mts)、[runtime-snapshot.ts](../packages/host/src/runtime-snapshot.ts)。

Darwin / Node.js 24.14 的官方 fresh bootstrap 已由独立启动审查 Agent 观察到首屏、Host ready、静态字节匹配和无 HMR；这不是 Windows/Linux、打包或发布验收。本次文档同步不运行应用，其他有限换手证据见 [验收范围](permissions-and-migration.md#有限换手验收证据)。

### 修改权限路径时保留的边界

- 工具 operation 身份来自持久 Native session、assistant entry 与唯一槽位；嵌套调用使用私有父 operation 和 Native ordinal。provider callId 保留用于 Native 路由与槽位核对，不能独立以 call0 跨任务去重，也不能把 boot/registration 加进逻辑键规避 journal 记录。
- 授权 journal 为 format 2。未发布开发 format 1 缺可信工具映射，拒绝恢复并保留日志，不自动迁移、删除或裁剪幂等记录。超过 64 MiB 安全读取上限仍 fail closed；与数据目录布局版本分别处理。
- pause 结束原提交 attempt，旧 receipt 保持 interrupted；resume 是同一 rootTask/epoch/run 下的新 custom continuation，保留 ceiling/预算 key。Host auth generation、await 后校验和 SDK run ticket/facade 不得回退为复用旧 signal/context；旧模型 I/O 尚未 drain 时拒绝新准入。
- typed writer 使用同一验证过的 O_RDWR FD 原地 write/truncate/fsync/hash，expected 必填（新建为 null），单链接及 CAS 校验不能改回临时文件 rename。取消允许留下部分或完整内容并记 unknown，不承诺原子替换、路径回滚或祖先 ABA。
- MCP 默认 read-only 和原生 tool_search 入口保持可达，但每个物理 HTTP metadata/read/tool 请求都须有 Host lease。idle 不联网；agent_end/pause/abort 关闭并 drain。OAuth refresh/login/provider alias 明确不支持，不能补裸 fetch fallback。
- Owner PTY 只允许真实用户 open/input/resize/close；Git 工作树 executor（含 availability 的 status）及 changed-turn undo 缺受控后端时明确 unsupported，不绕回普通 Node/Git 路径。

这些是源码约束，不代替目标平台验收。入口与限制集中见 [权限控制与版本迁移](permissions-and-migration.md)，正式接口语义见 [HostApi](host-api.md)。

## Git 提交规范

后续所有 Git 提交遵循 [Conventional Commits 1.0.0](https://www.conventionalcommits.org/zh-hans/v1.0.0/)，包括发布版本、回退、合并和 squash 产生的提交。标题格式：

```text
<type>[可选 scope][可选 !]: <描述>
```

`type` 使用小写英文，冒号使用英文半角字符，冒号后留一个空格。`scope` 可省略；填写时使用实际包或模块名称，例如 `chat`、`host`、`desktop`、`git`，发布版本使用 `release`。描述默认使用中文，写清具体变化，不写 emoji 或“更新代码”等空泛描述。

本项目使用以下类型；除 `feat` 和 `fix` 外，其余类型是项目约定：

| 类型       | 用途                           |
| ---------- | ------------------------------ |
| `feat`     | 新增功能                       |
| `fix`      | 修复错误                       |
| `docs`     | 只修改文档、注释或 Agent 规则  |
| `refactor` | 重构实现，不新增功能或修复错误 |
| `perf`     | 性能优化                       |
| `test`     | 新增或调整测试                 |
| `style`    | 只调整代码格式，不改变行为     |
| `build`    | 构建、打包或依赖调整           |
| `ci`       | CI workflow 与相关配置         |
| `chore`    | 版本号、工具维护等其他改动     |
| `revert`   | 回退已有提交                   |

示例：

```text
feat(git): 支持查看暂存区差异
fix(chat): 修复切换会话后草稿丢失
docs: 补充 Git 提交规范
chore(release): 发布 0.1.0
```

正文和脚注按需填写，与上一部分之间留一个空行。破坏性变更必须在冒号前加 `!`，或使用大写脚注 `BREAKING CHANGE: <说明>`；说明不兼容内容，涉及迁移时写清迁移方式。回退提交使用 `revert`，正文记录被回退的 commit 和原因。合并提交也需填写符合规范的标题，不直接沿用 Git 默认标题。

每次提交只包含同一目的的改动；独立修改拆分提交，同一功能所需的代码、测试和文档可一起提交。提交前按本文的[验证入口](#代码约定与验证入口)完成对应检查，并通过 `git diff --cached` 核对暂存内容，避免混入已有无关修改。Agent 执行 `git commit`、`git push`、`git merge` 前须展示改动摘要并获得用户明确确认；提交确认同时展示完整的拟用提交信息。

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

聊天消息和输入区共用 [global.css](../packages/app-ui/src/global.css) 的 `.chat-content-column`，按聊天面板宽度居中，最大宽度为 `48rem`。Markdown 代码块根据围栏上的语言标记交给 Shiki 高亮，支持 `ts`、`js`、`c++`、`c#`、`shell` 等别名；未标记或不支持的语言保留原文。高亮随应用明暗模式切换；代码块默认展开，点击标题栏可折叠，折叠后仍可复制完整代码。代码正文比聊天正文字号小 `1px`，最大高度为 `320px`，超出后在块内滚动；长行和宽表格在各自容器内横向滚动。入口在 [markdown-components.tsx](../packages/chat/src/ui/content/markdown-components.tsx)、[code-block.tsx](../packages/chat/src/ui/content/code-block.tsx) 和 [use-highlighter.ts](../packages/ui/src/lib/use-highlighter.ts)。

前端导航、Tab、面板和异步加载遵循 [UI 体验与动效](ui-experience.md)，复用切换参数、等待反馈和减少动态效果规则。

## 代码约定与验证入口

命名、依赖方向、组件 Props、顶栏与交互规则统一见 [AGENTS.md](../AGENTS.md)。共享聊天类型在 [model/types.ts](../packages/chat/src/ui/model/types.ts)，基础交互使用 [UI 原语](../packages/ui/src/components/ui/)，类名通过 [cn](../packages/ui/src/lib/utils.ts) 组合。文件图标使用 `FileIcon`，其他图标使用 `lucide-react`。

[Prettier](../prettier.config.js)、[ESLint](../eslint.config.mjs) 与 [tsconfig](../tsconfig.json) 保存格式、Lint 和类型配置。

- 日常代码修改：按 [AGENTS.md](../AGENTS.md) 执行全仓类型检查和变更文件 Lint/Format；仅文档修改检查格式、链接与来源路径。测试框架说明见[测试](testing.md)，不新增测试文件，也不把历史测试结果作为交付闸门或验收证据。
- 分发与验收：按[版本发布](releasing.md)构建 Host 或 Desktop 包、验证产物与自动发布版本。

权限迁移的交付结论必须写明 oracle 对应的真实用户路径、独立 Hacker 及未验范围。源码接线、静态检查和测试结果不能证明功能已可用；作者不得自行宣称换手验收通过。Windows/Linux、完整 browser/native permit、图片、更多 transport 路径及忽略 abort 超过 5 秒的实际停止边界，仍按 [有限证据与未验范围](permissions-and-migration.md#有限换手验收证据) 记录。业务 guest 的 Cookie/marker/WS 源码修复不能覆盖此前中断的 native 对抗验收结论。

Desktop 与 Server 直接构建内置模块和[静态 Worker](../packages/host/src/session-worker.ts)。Desktop 的 Pi SDK 与原生运行时复制见 [copy-pi-runtime.mjs](../scripts/copy-pi-runtime.mjs)，PTY 准备见 [prepare-node-pty.mjs](../scripts/prepare-node-pty.mjs)。构建目录 `dist/`、`.vite/`、`out/` 不提交。
