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

代码任务收尾按顺序执行一轮，前一项通过后再执行下一项。类型检查保留全仓，Lint 和 Format 只检查本任务修改且仍存在的适用文件。以下以一个测试文件为例，实际传入全部适用的本任务变更文件：

```bash
pnpm type-check
pnpm exec eslint packages/contracts/tests/plan-message.unit.test.ts
pnpm exec prettier --check packages/contracts/tests/plan-message.unit.test.ts
```

变更文件包含本任务新增和暂存的文件，不包含已有无关改动或已删除路径；Markdown 不传给 ESLint。失败修复后重跑受影响的检查，只修本次改动引入的问题，既有错误单独报告。仅修改文档时检查文档格式、链接、来源路径和图示，不运行类型检查或应用构建。

`pnpm lint` 和 `pnpm format` 仍为全仓命令，供 CI 或明确的全仓检查使用；Format 只检查，不写文件。涉及包依赖、导入方向或 UI/进程边界时补跑 `pnpm check-boundaries`。

日常测试优先使用 `--file`，需要时用 `--name` 缩到用例；确需跨包验证时才用 `--feature`。普通新功能不强制补测试，文案、CSS、普通布局不新增展示细节断言。修 bug 先最窄复现，必要时补最小回归；会话持久化、存储迁移、凭据、认证和权限改动保留针对性验证。具体新增条件和扩大范围索引见 [测试](testing.md)。

| 命令                                                    | 用途                                      |
| ------------------------------------------------------- | ----------------------------------------- |
| `pnpm check-boundaries`                                 | 包依赖声明、导入方向与 UI/进程边界        |
| `pnpm test --file <路径> --name <名称模式>`             | 日常优先：单文件中的指定用例              |
| `pnpm test --feature chat`                              | 确需扩大时：聊天功能跨包源码测试          |
| `pnpm test --feature plugins --layer integration`       | 确需扩大时：插件集成测试                  |
| `pnpm test --feature testing`                           | 测试清单、选测入口和配置改动              |
| `pnpm test --all --list`                                | 只检查完整清单，不执行或构建              |
| `pnpm test --all --layer artifact --target server`      | 明确验收时：构建并验证 Server 产物        |
| `pnpm test --all --layer e2e,artifact --target desktop` | 明确验收时：Desktop E2E 与真实 macOS 应用 |
| `pnpm test:all`                                         | 明确完整验收时：当前平台全部测试与产物    |

测试归所属包；共享假模型与测试环境在 [tests/fixtures](../tests/fixtures/)。测试使用临时数据目录，不调用真实模型、不读写真实凭据或会话。新增测试必须登记到 [catalog.ts](../tests/catalog.ts)，登记完整性由 `testing` 功能检查。

日常 [Linux CI](../.github/workflows/linux.yml) 保留全仓静态检查、包边界检查和全部源码测试，不安装浏览器或运行 Web E2E；手动 [完整测试](../.github/workflows/full-tests.yml) 保留 Linux、macOS 的 Web E2E 和对应平台产物验收。修改测试清单或入口只验证 `testing` 和受影响文件，不自动运行 `test:all`。

未经用户明确要求相应验收，普通 Agent 任务不运行或等待全量测试、E2E、打包和产物验收；窗口、preload、IPC、打包接线和测试基础设施改动也不例外。报告已通过、未运行的检查与剩余风险，不把本地任务完成写成发布验收通过；配置存在不表示本次运行过远程 CI。

## macOS 打包与验收

使用 Node.js 24.14.0。Forge 退出成功后仍要验证实际 `.app`。只有用户明确要求 Desktop 完整验收时才运行下列命令；普通窗口、preload、平台 IPC 或打包接线改动先验证相关源码，不自动执行它：

```bash
pnpm test --all --layer e2e,artifact --target desktop
```

入口只打包一次，再运行 Playwright 桌面用例和真实应用验收。用户只要求单项验收时，用 `--file` 选择对应文件，不扩大到整套 Desktop。发布前由明确的验收任务或手动完整 workflow 验证目标平台。正式 `.app` 关闭 Node 调试 Fuse，产物测试直接启动 `Contents/MacOS/pi-meme`，不修改发布配置。报告和截图在 `out/tests/`。

`pnpm make` 生成分发包；发布 workflow 在验收 `.app` 后使用 `pnpm make --skip-package --arch arm64`，避免再次打包改变待发布应用。应用标识固定为 `io.github.xidongdong153.pi-meme`。版本、commit 和第三方许可通过 Forge `prePackage` 生成并复制到 Resources，相关逻辑在 [release.mts](../scripts/release.mts) 和 [release-licenses.mts](../scripts/release-licenses.mts)。签名由 [Forge 配置](../apps/desktop/forge.config.ts) 管理：没有证书时使用 ad-hoc 签名，可用 `PI_DESKTOP_SIGNING_IDENTITY` 指定证书。当前没有配置公证或自动更新。

Desktop 与 Server 直接构建内置模块和 [静态 Worker](../packages/host/src/session-worker.ts)，不为内置模块单独生成插件 `dist/`。Desktop 还复制 Pi SDK 与 native runtime，相关脚本在 [copy-pi-runtime.mjs](../scripts/copy-pi-runtime.mjs) 与 [prepare-node-pty.mjs](../scripts/prepare-node-pty.mjs)。构建目录 `dist/`、`.vite/`、`out/` 不提交。

## Host 独立包与 GitHub 发布

`pnpm package:host` 使用 Node.js 24.14.0 和 pnpm 10.29.1，在当前原生平台构建完整 Host/Web 目录包。只支持 macOS arm64 或 Linux x64；通过 `pnpm deploy --prod --frozen-lockfile` 从共享锁文件收集依赖，workspace 启用依赖注入并在 `build` 后同步。发布构建只在命令或 workflow 中指定官方 npm 源，不改全局 registry；使用官方下载并校验的 Node 运行时，不复用 Desktop 的原生模块构建结果。产物在 `out/release/`。

版本统一、草稿发布、最终包验收与维护者操作见[版本发布](releasing.md)。发布只走 `.github/workflows/release.yml`，没有 `pnpm publish` 入口，不发布 npm 包或自动公开 Release。
