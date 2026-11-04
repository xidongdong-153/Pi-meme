---
description: '测试框架、空清单行为、选测命令、运行报告和新增用例约定'
status: implemented
paths:
  - 'tests/**'
  - 'scripts/test.mts'
  - 'vitest.config.mts'
  - 'playwright.config.mts'
  - 'tsconfig.tests.json'
  - '.github/workflows/**'
  - '.github/actions/setup-linux-sandbox/**'
---

# 测试

从仓库根目录运行。Node.js 使用 24.14.0，pnpm 使用 10.29.1。

当前已删除全部测试用例及其专用夹具，保留测试框架、依赖、配置、统一入口和 CI。[catalog.ts](../tests/catalog.ts) 的 `suites` 为空；显式选择合法范围时，入口显示零个文件并跳过执行，不启动运行器、不构建应用、不生成测试报告。跳过执行不表示功能或产物验收通过。

## 保留的基础设施

| 文件或依赖                                                                                                                                                   | 用途                                                         |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------ |
| [vitest.config.mts](../vitest.config.mts)、Vitest、jsdom、React Testing Library                                                                              | Node 与组件测试环境、隔离、生命周期和覆盖率                  |
| [playwright.config.mts](../playwright.config.mts)、Playwright                                                                                                | Web E2E 配置与报告                                           |
| [scripts/test.mts](../scripts/test.mts)                                                                                                                      | 统一选测、必要构建、进程清理和报告                           |
| [tests/catalog.ts](../tests/catalog.ts)、[tests/selection.ts](../tests/selection.ts)                                                                         | 功能、层次、目标、平台和参数校验                             |
| [component-setup.ts](../tests/fixtures/component-setup.ts)                                                                                                   | jsdom 的指针捕获、滚动和 ResizeObserver 兼容处理             |
| [fake-agent.mjs](../tests/fixtures/fake-agent.mjs)、[fake-provider.mjs](../tests/fixtures/fake-provider.mjs)、[messages.mjs](../tests/fixtures/messages.mjs) | 本地假模型、临时运行目录和消息数据，供性能脚本及后续用例复用 |
| [apps/desktop/tests/package.json](../apps/desktop/tests/package.json)                                                                                        | Desktop 测试目录的 ESM 模块作用域                            |
| [tsconfig.tests.json](../tsconfig.tests.json)、各包的测试目录配置                                                                                            | 测试基础设施与未来用例的类型检查范围                         |

测试依赖继续保留在各包的 `devDependencies` 和锁文件中。包内测试目录、ESLint 和包边界检查的通用规则继续支持新增用例。

## 入口

```bash
pnpm test --list
pnpm test --all --list
pnpm test --feature testing
pnpm test --feature core --list
pnpm test:source
pnpm test:web
pnpm test:all
```

`--list` 只列清单；无范围的 `--list` 显示功能帮助。无参数 `pnpm test` 返回帮助并失败，不执行测试。清单为空时，上述显式范围命令显示跳过执行；其中 `test:web`、`test:all` 当前也不会构建应用。

`--feature` 和 `--file` 支持重复指定，彼此不能混用；`--all` 与它们互斥。`--name` 接受正则表达式，必须同时指定文件。未知功能、层次、目标、未登记文件及无效参数仍会失败。清单恢复用例后，所选范围无匹配测试和显式选择不支持的平台也会失败。

新增用例后，日常优先 `pnpm test --file <路径>`，需要时用 `--name <名称模式>` 缩到用例；确需跨包验证时才使用 `--feature`。`--feature` 默认选择 unit、component、integration；`--file` 按所选文件的层次运行，E2E 或产物文件会触发必要构建。`--layer` 使用逗号分隔层次，`--target` 可选 web、desktop、server。

`pnpm test:source` 选择全部 unit、component、integration；`pnpm test:web` 选择 Web E2E；`pnpm test:all` 选择当前平台支持的全部层次及其必要构建。直接调用 Vitest 或 Playwright 时仍由运行器报告无用例，统一入口负责空清单的跳过行为。

## 层次与新增用例

| 后缀                   | 运行器                           | 测试边界                                                   |
| ---------------------- | -------------------------------- | ---------------------------------------------------------- |
| `.unit.test.ts`        | Vitest / Node                    | 纯逻辑、状态投影、协议参数和明确的初始渲染契约             |
| `.component.test.tsx`  | Vitest / jsdom / Testing Library | React 实际挂载、effect、输入、点击、状态更新和回调         |
| `.integration.test.ts` | Vitest / Node                    | 临时文件、Host、Worker、HTTP/WebSocket、SDK 和插件生命周期 |
| `.e2e.spec.ts`         | Playwright                       | Web 的完整流程、焦点和布局                                 |
| `.artifact.test.ts`    | Node 原生测试                    | 构建后的 Server、真实应用、签名和运行时资源                |

测试归所属包，命名必须标明层次；新增文件登记到 [catalog.ts](../tests/catalog.ts) 的 `files`，填写路径和功能列表。清单按文件后缀推断层次，按层次和路径推断目标；平台限制由 `suites` 映射配置。同一文件可登记多个功能，选择结果按文件去重。独立行为较多时按功能拆分，共用所属包内的 fixture。

使用临时数据目录、本地假模型和可释放的 fixture，不读取真实凭据或会话。不维护桌面 UI 自动化；原生界面、文件对话框和迁移后的界面重启按需人工验收。

单元与集成测试可使用 `node:assert/strict` 断言，测试注册和生命周期统一使用 Vitest。`node:test` 的 `after` 对应 `afterAll`，`t.after` 对应 `t.onTestFinished`，动态子测试应改为收集阶段的 `describe` 和 `test`。

jsdom 不计算布局；公共初始化只补充 Radix 需要的指针捕获、滚动方法和不触发回调的 ResizeObserver 接口。尺寸回调由组件用例自行提供观测数据；真实尺寸、焦点和图片解码由 Web E2E 按需验证。静态 HTML 只证明初始结构，不证明交互可用，不修改 React 私有 dispatcher 来执行 effect。

普通新功能不强制新增测试，不要求补齐多个层次或满足覆盖率。新增用例应保护已发生的 bug、容易写错且影响用户结果的稳定行为，或数据、凭据与权限边界。文案、CSS、普通布局不新增仅验证展示细节的测试。同一行为优先在能可靠验证的最便宜层次覆盖。

## 日常验证

代码任务收尾依次运行全仓 `pnpm type-check`、变更文件的 `pnpm exec eslint <路径...>`、`pnpm exec prettier --check <路径...>`，再进行必要的针对性验证。前一项通过后再执行下一项，失败修复后重跑受影响的检查。Lint 和 Format 只传本任务修改且仍存在的适用文件，排除已有无关改动和已删除路径；Markdown 不传给 ESLint。仅修改文档时检查格式、链接和来源路径，不运行类型检查或应用构建。

`pnpm check` 依次运行全仓类型检查、Lint、Format 和包边界检查，供 CI 与明确的全仓验收使用。日常任务只对变更文件运行 Lint 和 Format；涉及包依赖声明、导入方向或 UI/进程边界时补跑 `pnpm check-boundaries`。

类型检查保留各包的独立检查范围，启用 TypeScript `incremental`。首次运行生成 `.tsbuildinfo`，后续按文件变化重新检查；缓存不提交，删除后会完整重建。[check-code action](../.github/actions/check-code/action.yml) 按平台、架构、锁文件和 tsconfig 缓存检查信息，每次仍执行全部检查命令。

有相关用例时，修 bug 先做最窄范围复现；会话持久化、存储迁移、凭据、认证和权限改动必须做针对性验证，必要时补最小用例。当前无用例时，做针对性手工检查或新增必要的回归测试，并说明未自动验证的部分。修改测试清单或入口后用 `pnpm test --feature testing` 和 `pnpm test --all --list` 核对行为；清单为空时应明确记录跳过。

未经用户明确要求相应验收，不自动运行全量测试、E2E、打包或产物验收；测试基础设施改动也不例外。单项验收只选择对应文件或平台，不扩大到完整测试。报告已通过、未运行的检查和剩余风险，不把本地任务完成写成发布验收通过。

## 环境、报告与 CI

恢复相应测试后，包含 E2E 或 artifact 的统一入口会准备所需构建，同次执行每个构建只运行一次。明确设置 `PI_MEME_HOST_BUNDLE_ROOT` 时，Server artifact 使用已有独立包；设置 `PI_DESKTOP_PACKAGED_APP` 时，Desktop artifact 使用指定应用，不重新打包。这些变量不会跳过 Web E2E 所需的界面构建。

Web E2E 运行前按需安装 Chromium：

```bash
pnpm exec playwright install chromium
```

实际执行测试时，统一入口写入独立的 `out/tests/<时间戳>-<进程号>/`：`summary.json` 记录平台、步骤、退出状态和耗时，数字命名的 `.log` 保存步骤输出。Vitest 写 JSON 报告；Playwright 写 HTML、JSON 和失败截图、trace。直接运行 Playwright 也使用独立目录。报告、覆盖率和构建产物不提交。

覆盖率按需使用 `--coverage`，仅用于 unit、component、integration。输出在 `coverage/`，只统计 Vitest 进程执行的代码，不代表独立 Worker 和产物的完整覆盖率；当前不设全仓百分比门槛。

PR 或手动触发的 [Linux 检查](../.github/workflows/linux.yml) 保留 `pnpm check` 和 `pnpm test:source`。[完整测试](../.github/workflows/full-tests.yml) 保留手动触发的 Ubuntu 24.04 与 macOS 15 配置，Linux 选择全部层次，macOS 选择源码及产物层次。当前空清单下测试步骤均跳过，不代表已完成源码、Web 或产物验收；`main` 推送不自动运行 Actions。

[发布 workflow](../.github/workflows/release.yml) 执行静态检查、构建与最终包校验，不运行源码测试、Web E2E 或产物运行测试。发布构建成功不表示功能验收通过，产物校验与人工验收见[版本发布](releasing.md)。

Linux CI 通过[沙箱准备 action](../.github/actions/setup-linux-sandbox/action.yml)安装 bubblewrap，并为 `/usr/bin/bwrap` 加载定向 AppArmor user namespace 许可、实际探测 namespace。该配置只用于临时 runner，不关闭 AppArmor、不修改全局 sysctl；`TMPDIR` 使用 `RUNNER_TEMP`。恢复沙箱用例后，探测失败应失败，不能用 skip 或完全权限代替隔离验证。WSL 专项必须在真实 WSL2 上验收，平台跳过不算通过。

## 性能脚本

性能脚本及其通用假模型、消息数据保留，不包含在空测试清单中，也不随测试入口自动运行。

`node --import tsx scripts/bench-sessions.mts baseline` 生成 1 万条、约 100MB 的临时历史并测量完整读取；随后执行 `indexed-build` 和 `indexed-reopen`，比较首次建索引与新进程复用索引。数据和 JSON 报告在 `out/session-performance/`，不读取个人会话。报告包含历史读取及序列化耗时、CPU 时间、响应大小和内存，不代表完整界面切换或发布验收。

`node --import tsx scripts/bench-session-runtime.mts current` 使用临时 Host、假模型和 Chromium 测量 1、4、8 个并行会话的事件数、Host 与页面 CPU 时间，再点击侧栏 30 次测量缓存切换的 P95。报告和桌面、窄窗口截图同样写入 `out/session-performance/`。为排除个人资源差异，两个版本都只安装仓库自带的 Skill Creator；Worker 启动耗时单独记录，不算入流式输出 CPU 区间。可传入第二个参数指定已有依赖的基线源码目录，使用非 `current` 开头的报告名跳过仅新版本支持的面板统计。浏览器错误会写入报告，失败样本不能用作正常负载下的 CPU 验收。

`PI_BENCH_BACKGROUND=1` 在输出期间停留在空白会话，单独测量后台并行成本；默认保留一个可见输出会话。`PI_BENCH_TEXT_REPEATS` 控制正文长度，默认 1200；`PI_BENCH_CODE=1` 将正文放入代码块。对比两个版本时应保持相同参数。
