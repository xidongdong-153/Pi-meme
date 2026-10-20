---
description: '测试功能清单、验证层次、选测命令、运行报告和平台要求'
status: implemented
paths:
  - 'tests/**'
  - 'scripts/test.mts'
  - 'vitest.config.mts'
  - 'playwright.config.mts'
  - '.github/workflows/**'
---

# 测试

从仓库根目录运行。Node.js 使用 24.14.0，pnpm 使用 10.29.1。

日常开发优先选择直接相关的测试文件，需要时缩到用例；确需跨包验证时才扩大到业务功能。`sessions` 会同时选择 contracts、client、Host、运行时和 UI 中的会话测试，不是局部会话改动的必跑范围。无参数 `pnpm test` 显示帮助并返回非零状态，不执行测试。

```mermaid
%%{init: {"theme": "dark"}}%%
flowchart TD
    A["本地开发"] --> B["全仓类型检查与变更文件 Lint、Format"]
    B --> C["必要的文件级测试"]
    C --> D["报告已通过、未运行与风险"]
    E["日常 CI"] --> F["全仓静态检查、包边界与源码测试"]
    G["手动完整验收"] --> H["E2E、构建与产物测试"]
```

## 入口

```bash
pnpm test --file packages/contracts/tests/plan-message.unit.test.ts
pnpm test --file packages/contracts/tests/plan-message.unit.test.ts --name 中文
pnpm test --file packages/contracts/tests/plan-message.unit.test.ts --list
pnpm test --list
pnpm test --feature sessions --list
pnpm test --feature sessions
pnpm test --feature sessions --feature chat --layer unit,component
pnpm test --feature plugins --layer integration
pnpm test --all --list
```

`--list` 只列清单。`--feature` 和 `--file` 支持重复指定；`--all` 与它们互斥。`--name` 接受正则表达式，必须同时指定文件。未知功能、无匹配测试和显式选择不支持的平台都会失败。

使用 `--feature` 时默认运行 unit、component、integration，不构建应用、不启动 Electron、不收集覆盖率。`--file` 按所选文件的层次运行，选择 E2E 或产物文件仍会触发必要构建；日常应选择相关源码测试。

## 日常验证与新增测试

代码任务收尾按顺序执行一轮全仓 `pnpm type-check`、变更文件的 `pnpm exec eslint <路径...>`、`pnpm exec prettier --check <路径...>`，再运行必要的相关用例。前一项通过后再执行下一项，失败修复后重跑受影响的检查。Lint 和 Format 只传本任务修改且仍存在的适用文件，包含新增和暂存文件，排除已有无关改动和已删除路径；Markdown 不传给 ESLint。仅修改文档时检查格式、链接和来源路径，不运行类型检查或应用构建。

普通新功能不强制新增测试，不要求补齐多个层次或满足覆盖率。新增测试用于保护已发生 bug、容易写错且影响用户结果的稳定行为，或数据、凭据与权限边界。文案、CSS、导航排列、内部调用顺序不单独增加测试。同一行为优先在能可靠验证的最便宜层次覆盖，不为层次齐全而重复测试。

修 bug 先用已有用例做最窄复现，必要时补最小回归。会话持久化、存储迁移、凭据、认证和权限改动必须运行对应风险的针对性验证，缺少覆盖时补必要用例，不自动扩大到全仓。没有相关用例的普通功能可以做针对性手工检查，并报告未自动验证的部分。

未经用户明确要求相应验收，Agent 不自动运行全量测试、E2E、打包或产物验收；窗口、preload、IPC、打包接线和测试基础设施改动也不例外。单项验收只选择相应文件或平台，不扩大到整套完整测试。发布前通过明确的验收任务或手动完整 workflow 验证目标平台。

普通任务不运行或等待完整验收。报告分别列出已通过、未运行的检查和剩余风险，不把本地任务完成写成发布验收通过。

## 层次与运行器

| 后缀                   | 运行器                           | 测试边界                                                        |
| ---------------------- | -------------------------------- | --------------------------------------------------------------- |
| `.unit.test.ts`        | Vitest / Node                    | 纯逻辑、状态投影、协议参数和明确的初始渲染契约                  |
| `.component.test.tsx`  | Vitest / jsdom / Testing Library | React 实际挂载、effect、输入、点击、状态更新和回调              |
| `.integration.test.ts` | Vitest / Node                    | 临时文件、真实 Host、Worker、HTTP/WebSocket、SDK 和插件生命周期 |
| `.e2e.spec.ts`         | Playwright                       | Web 与开发态 Electron 的完整流程、焦点、布局和平台接线          |
| `.artifact.test.ts`    | Node 原生测试                    | 构建后的 Server、真实 `.app`、签名和运行时资源                  |

单元与集成测试允许保留 `node:assert/strict` 断言；测试注册和生命周期统一使用 Vitest。不要直接替换 `node:test` 的 import 后保留不兼容的钩子：`after` 对应 `afterAll`，`t.after` 对应 `t.onTestFinished`，动态子测试改为收集阶段的 `describe` 和 `test`。

jsdom 不计算布局；测试环境只补 Radix 需要的指针捕获和滚动方法。尺寸、真实焦点、图片解码、原生按键及文件对话框留在 E2E。静态 HTML 测试只证明初始结构，不证明交互可用。不要修改 React 私有 dispatcher 来执行 effect。

## 按改动选测

先查找直接覆盖改动的文件。下表是确需跨包扩大范围时的功能索引，不是每次改动的必跑清单；多个功能也只在实际涉及对应行为时选择。

| 改动                           | 先选择的功能              | 需要扩大的条件                                                 |
| ------------------------------ | ------------------------- | -------------------------------------------------------------- |
| 输入框、流式消息、暂停和队列   | `chat`                    | 模式切换加 `plan`；技能引用加 `skills`                         |
| 历史、分支、客户端选择和恢复   | `sessions`                | 跨服务加 `connection`；项目归属加 `workspace`                  |
| 计划文档与规划限制             | `plan`                    | 子任务协作加 `subagents`；权限守卫加 `permissions`             |
| 子代理调度、消息与完成状态     | `subagents`               | 计划落盘加 `plan`                                              |
| 模型配置和凭据                 | `models`                  | 登录、重连和远程凭据加 `connection`                            |
| 插件、DevKit、资源代次         | `plugins`                 | 技能快照加 `skills`；主题加 `settings`                         |
| 技能导入、编辑和调用           | `skills`                  | 插件附带资源加 `plugins`                                       |
| MCP 配置、诊断与连接           | `mcp`                     | 规划模式限制加 `plan`                                          |
| 权限、沙箱和嵌套工具           | `permissions`、`codemode` | 规划限制加 `plan`                                              |
| 工作区、侧栏、Git 和 Worktree  | `workspace`、`git`        | 会话目标加 `sessions`                                          |
| 文件、预览、保存和终端         | `files`、`terminal`       | 工具标签与插件作用域加 `plugins`                               |
| Agent 项目服务与活动面板       | `activities`              | 沙箱权限加 `permissions`；目标与来源加 `sessions`、`subagents` |
| 设置、指令、外观和用量         | `settings`、`usage`       | 凭据加 `models`                                                |
| HTTP/WebSocket、认证与重连     | `connection`              | 目标恢复加 `sessions`                                          |
| Electron 壳、preload、平台 IPC | `desktop`、`connection`   | 先验证相关源码；E2E、产物验收需明确要求                        |
| 选测入口、清单和框架配置       | `testing`                 | 加受影响文件；用 `--all --list` 核对完整清单                   |

同一文件同时验证多个功能时，可以登记多个功能，选择结果会去重。独立行为较多的大文件按功能拆分，共用所属包内的 fixture。新增文件必须登记到 [catalog.ts](../tests/catalog.ts)；`testing` 功能检查漏登记、重复登记、未知功能和层次后缀。

## 环境、报告与完整验收

仅在用户明确要求相应验收时运行：

```bash
pnpm test --feature chat --layer e2e --target web
pnpm test --all --layer artifact --target server
pnpm test --all --layer e2e,artifact --target desktop
pnpm test:all
```

`test:all` 包含当前平台支持的全部层次与必要构建；macOS 包含 Desktop，Linux 只包含源码、Web 和 Server。它不代表已验证其他操作系统或 WSL。

E2E 验收前安装浏览器：

```bash
pnpm exec playwright install chromium
```

手动完整验收使用 `pnpm exec playwright install --with-deps chromium` 安装浏览器；Linux 还需安装 bubblewrap，日常 CI 只安装 bubblewrap，不安装浏览器。Web E2E 使用构建后的界面、临时 Host 和本地假模型。Desktop E2E 使用可调试的开发态 Electron；真实产物直接启动应用可执行文件，保留正式 Fuse 设置。

包含 e2e 或 artifact 的命令会准备相应构建，同次执行每个构建只运行一次。明确设置 `PI_MEME_HOST_BUNDLE_ROOT` 时，Server artifact 从仓库外的独立包启动，不重新构建 Server；设置 `PI_DESKTOP_PACKAGED_APP` 时，Desktop artifact 使用指定 `.app`，不重新打包。不存在或无效的产物会在验收中失败；这两个测试变量不跳过 E2E 所需的开发构建。最终发布包的解压与选测步骤见[版本发布](releasing.md)。

修改测试本身后调试已有构建，可以直接用运行器的文件过滤：

```bash
pnpm exec playwright test apps/web/tests/chat.e2e.spec.ts --project web
pnpm exec vitest run packages/contracts/tests/plan-message.unit.test.ts
```

每次统一入口执行写入独立的 `out/tests/<时间戳>-<进程号>/`：`summary.json` 记录平台、步骤、退出状态和耗时，数字命名的 `.log` 保存各步骤输出。Vitest 写 JSON 报告；Playwright 写 HTML、JSON 和失败截图、trace。直接运行 Playwright 时也使用独立目录。报告、覆盖率和构建产物不提交。

覆盖率按需启用：

```bash
pnpm test --feature chat --layer unit,component --coverage
```

覆盖率输出在 `coverage/`，只统计 Vitest 进程执行的代码，不代表独立 Worker 和产物的完整覆盖率。当前只报告数值，不设全仓百分比门槛。

日常 push 和 PR 的 [Linux 检查](../.github/workflows/linux.yml) 运行全仓 `pnpm type-check`、`pnpm lint`、`pnpm format`、`pnpm check-boundaries` 与全部源码测试，不运行 Web E2E。[完整测试](../.github/workflows/full-tests.yml) 仍由手动触发 Linux、macOS 两个平台，包含 Web E2E 和对应平台产物；发布前汇总目标平台结果。WSL 专项只能在真实 WSL 上运行并单独记录；平台跳过不算完成该平台验收。配置存在不表示本次已运行远程 CI。

旧用例的处理位置和展示断言清理见 [测试审查](testing-audit.md)。本地涉及包依赖声明、导入方向或 UI/进程边界时补跑 `pnpm check-boundaries`，不因此触发完整测试。
