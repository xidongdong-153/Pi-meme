---
description: '日常静态检查、真实路径与换手验收、保留的测试框架、空清单行为及 CI'
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

# 验证与测试基础设施

从仓库根目录运行命令。Node.js 使用 24.14.0，pnpm 使用 10.29.1。协作规则见 [AGENTS.md](../AGENTS.md)。

当前不新增任何测试文件，包括单元、集成、契约、快照、E2E 和守门脚本；既有测试不扩张、不维护、不修红灯，也不作为交付闸门或完成证据。测试框架、依赖、配置、选测入口和 CI 保留，不因本页介绍这些设施而恢复编写测试。

## 日常验证

代码任务收尾按顺序执行，前一项通过后再执行下一项：

```bash
pnpm type-check
pnpm exec eslint <本任务变更且仍存在的适用文件...>
pnpm exec prettier --check <本任务变更且仍存在的适用文件...>
```

类型检查覆盖全仓；Lint 和 Format 只传本任务修改的适用文件，包含新增和暂存文件，排除已有无关改动及已删除路径。Markdown 不传给 ESLint。失败时只修本次引入的问题，再重跑受影响的检查。仅修改文档时检查格式、链接和来源路径，不运行类型检查或应用构建。

`pnpm check` 依次运行全仓类型检查、Lint、Format 和包边界检查，供 CI 与明确的全仓检查使用。涉及包依赖声明、导入方向或 UI/进程边界时，按需补跑 `pnpm check-boundaries`。

类型检查保留各包的独立范围，启用 TypeScript `incremental`。首次运行生成 `.tsbuildinfo`，后续按文件变化重新检查；缓存不提交，删除后会完整重建。[check-code action](../.github/actions/check-code/action.yml) 按平台、架构、锁文件和 tsconfig 缓存检查信息，每次仍执行完整命令。

## 真实路径与验收结论

静态检查只能提供类型、格式和依赖边界信息。功能结论必须来自用户实际使用的界面、对话、终端、输出或账单；测试全绿、空清单跳过和构建成功都不能代替这些证据。

实现验收由未参与编写的接手者完成：读取实现，主动构造会使其失败的具体输入，并沿真实用户路径记录行为。反例按变更选择，例如不存在的目标、无权限、超长输入、符号链接、并发、断线、重放或超时；不要为了列清单新增测试脚本。结论须写明 oracle 对应哪条真实路径、实际 Hacker 是谁，以及可追溯的操作和输出；缺少这些信息时标为“未验”。无损重构或切割可按可证明的等价性标准处理。

会话持久化、存储迁移、凭据、认证和权限变更必须针对相应数据与边界核对，不因缺少用例缩小交付，也不扩大为全仓测试。人工操作使用隔离数据；涉及真实账户或外部副作用时遵守本次任务授权。不维护桌面 UI 自动化，原生窗口、文件对话框和迁移后的界面重启按目标平台验收。

文档编写与功能验收分开：核对源码、链接和格式后仍标“未验（本轮仅编写文档）”，不安排或代写验收回执。报告实际改动、已做检查、未运行的检查及待确认项，不把本地任务完成写成发布验收通过。

未经用户明确要求，不自动运行全量测试、E2E、打包或产物验收；测试基础设施改动也不例外。单项验收只覆盖指定文件、功能或平台，发布范围另见[版本发布](releasing.md)。

## 保留的基础设施

当前业务测试用例及专用夹具已清空。[catalog.ts](../tests/catalog.ts) 的 `files` 为空，导出的 `suites` 同样为空；显式选择合法范围时，统一入口显示零个文件并跳过，不启动运行器、不构建应用、不生成测试报告。

| 文件或依赖                                                                                                                                                   | 保留用途                                         |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------ |
| [vitest.config.mts](../vitest.config.mts)、Vitest、jsdom、React Testing Library                                                                              | Node 与组件测试环境、隔离、生命周期及覆盖率配置  |
| [playwright.config.mts](../playwright.config.mts)、Playwright                                                                                                | Web E2E 配置与报告                               |
| [scripts/test.mts](../scripts/test.mts)                                                                                                                      | 统一选测、必要构建、进程清理和报告               |
| [tests/catalog.ts](../tests/catalog.ts)、[tests/selection.ts](../tests/selection.ts)                                                                         | 功能、层次、目标、平台和参数校验                 |
| [component-setup.ts](../tests/fixtures/component-setup.ts)                                                                                                   | jsdom 的指针捕获、滚动和 ResizeObserver 兼容处理 |
| [fake-agent.mjs](../tests/fixtures/fake-agent.mjs)、[fake-provider.mjs](../tests/fixtures/fake-provider.mjs)、[messages.mjs](../tests/fixtures/messages.mjs) | 性能脚本使用的本地假模型、临时运行目录与消息数据 |
| [apps/desktop/tests/package.json](../apps/desktop/tests/package.json)                                                                                        | Desktop 测试目录的 ESM 模块作用域                |
| [tsconfig.tests.json](../tsconfig.tests.json)、各包测试目录配置                                                                                              | 测试基础设施的类型检查范围                       |

依赖继续保留在各包的 `devDependencies` 和锁文件中。现有分类为 unit、component、integration、e2e、artifact，对应 Vitest、Playwright 或 Node 原生测试运行器。jsdom 不计算真实布局，公共初始化只补兼容接口；静态 HTML 不证明交互可用。

## 历史测试入口

以下是保留入口的行为说明，不是日常交付步骤：

```bash
pnpm test --list
pnpm test --all --list
pnpm test --feature testing
pnpm test --feature core --list
pnpm test:source
pnpm test:web
pnpm test:all
```

`--list` 只列清单；无范围的 `--list` 显示功能帮助。无参数 `pnpm test` 返回帮助并失败，不执行测试。当前空清单下，显式范围命令均显示跳过，`test:web` 和 `test:all` 也不会构建应用。

`--feature` 和 `--file` 支持重复指定，彼此不能混用；`--all` 与它们互斥。`--name` 接受正则表达式，必须同时指定文件。未知功能、层次、目标、未登记文件及无效参数仍会失败。非空清单下，无匹配测试或显式选择不支持的平台也会失败。

`--feature` 默认选择 unit、component、integration；`--file` 按文件层次运行，E2E 或产物文件会触发必要构建。`--layer` 使用逗号分隔层次，`--target` 可选 web、desktop、server。`test:source` 选择源码层，`test:web` 选择 Web E2E，`test:all` 选择当前平台支持的全部层次。直接调用运行器时，无用例行为由运行器决定；统一入口负责空清单跳过。

## 环境、报告与 CI

统一入口在选中实际 E2E 或 artifact 文件时准备所需构建，同次执行每项构建只运行一次。`PI_MEME_HOST_BUNDLE_ROOT` 指定已有独立 Server 包，`PI_DESKTOP_PACKAGED_APP` 指定已有 Desktop 应用；两者不跳过 Web E2E 所需的界面构建。Playwright 的浏览器安装是独立环境操作，不由文档维护任务执行。

实际运行时，报告写入独立的 `out/tests/<时间戳>-<进程号>/`：`summary.json` 记录平台、步骤、退出状态和耗时，数字命名的 `.log` 保存输出；Vitest 使用 JSON，Playwright 使用 HTML、JSON、失败截图和 trace。报告、覆盖率与构建产物不提交，也不作为功能完成证据。`--coverage` 仅用于源码层，不包含独立 Worker 与产物的完整执行范围，当前没有全仓百分比门槛。

PR 或手动触发的 [Linux 检查](../.github/workflows/linux.yml) 保留 `pnpm check` 和 `pnpm test:source`。[完整测试](../.github/workflows/full-tests.yml) 保留手动触发的 Ubuntu 24.04 与 macOS 15 配置：Linux 选择全部层次，macOS 选择源码与产物层。当前空清单下测试步骤跳过；`main` 推送不自动运行 Actions。

[发布 workflow](../.github/workflows/release.yml) 执行静态检查、构建和最终包校验，不运行源码测试、Web E2E 或产物运行测试。构建成功不表示功能验收通过，产物与人工检查范围见[版本发布](releasing.md)。

Linux CI 通过[沙箱准备 action](../.github/actions/setup-linux-sandbox/action.yml)安装 bubblewrap，为 `/usr/bin/bwrap` 加载定向 AppArmor user namespace 许可并探测实际隔离能力。配置仅用于临时 runner，不关闭 AppArmor、不修改全局 sysctl；`TMPDIR` 使用 `RUNNER_TEMP`。隔离能力失败不能用完全权限或跳过冒充成功；WSL 专项须在真实 WSL2 上另行验收。

## 性能脚本

性能脚本及其通用假模型、消息数据保留，不在空测试清单中，也不随测试入口自动运行。下面是已有测量工具的用途，是否运行由具体性能任务决定。

`node --import tsx scripts/bench-sessions.mts baseline` 生成 1 万条、约 100 MB 的临时历史并测量完整读取；`indexed-build` 与 `indexed-reopen` 分别测量首次建索引和新进程复用索引。数据与 JSON 报告在 `out/session-performance/`，不读取个人会话。报告包含读取与序列化耗时、CPU 时间、响应大小及内存，不代表完整界面切换或发布验收。

`node --import tsx scripts/bench-session-runtime.mts current` 使用临时 Host、假模型和 Chromium 测量 1、4、8 个并行会话的事件数、CPU 时间，再点击侧栏 30 次测量缓存切换 P95。报告与截图写入 `out/session-performance/`。两个对比版本都只安装仓库自带 Skill Creator；Worker 启动耗时单列，不计入流式输出 CPU 区间。第二个参数可指定已有依赖的基线源码目录，非 `current` 开头的报告名跳过仅新版本支持的面板统计。浏览器错误写入报告，失败样本不能作为正常负载证据。

`PI_BENCH_BACKGROUND=1` 在输出期间停留在空白会话，测量后台并行成本；默认保留一个可见输出会话。`PI_BENCH_TEXT_REPEATS` 控制正文长度，默认 1200；`PI_BENCH_CODE=1` 将正文放入代码块。对比时保持模型、参数和数据条件一致。
