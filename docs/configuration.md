---
description: 'Host 数据目录、模型与 MCP 配置、指令、凭据和三档权限的实际边界'
status: implemented
paths:
  - 'packages/host/src/data-root.ts'
  - 'packages/host/src/storage/**'
  - 'apps/desktop/src/main/storage/**'
  - 'apps/desktop/src/main/storage-process.ts'
  - 'apps/desktop/src/main/user-login-path.ts'
  - 'apps/desktop/src/main/local-host.ts'
  - 'packages/contracts/src/storage.ts'
  - 'packages/host/src/service.ts'
  - 'packages/host/src/credentials.ts'
  - 'packages/pi-adapter/src/file-credentials.ts'
  - 'packages/pi-runtime/src/runtime-paths.ts'
  - 'packages/pi-runtime/src/sdk/model-runtime.ts'
  - 'packages/pi-runtime/src/sdk/context-files.ts'
  - 'packages/pi-runtime/src/sdk/settings.ts'
  - 'packages/pi-runtime/src/sdk/access-sandbox.ts'
  - 'packages/settings/**'
  - 'packages/models/**'
  - 'packages/mcp/**'
  - 'packages/permissions/**'
  - 'packages/sandbox-macos/**'
  - 'packages/sandbox-linux/**'
  - 'packages/contracts/src/agent-access.ts'
---

# 配置与安全

所有配置和执行数据属于所连接的 Host。连接远程服务后，模型、MCP、技能、插件和会话操作都发生在远程机器；浏览器平台不决定 Agent 沙箱。连接参数与 HTTPS 见 [Remote](remote.md)。

## 数据目录

构建 App、构建后的 Server 和 Host 独立包默认使用 `~/.pi-meme` 和端口 `31415`；Desktop 开发版和 `pnpm start:server` 默认使用 `~/.pi-meme-dev` 和 `31416`。Desktop 按 `PI_MEME_DATA_ROOT`、已保存的自定义目录、默认目录依次选择；独立 Server 只读取环境变量或默认目录。[data-root.ts](../packages/host/src/data-root.ts) 将路径解析为绝对路径，用带心跳的 `host.lock` 保证一个 Host 写入。登记远程服务不会关闭本机 Host。Desktop 与 Server 的端口和真实数据目录一致时复用同一个 Host；只有创建方持有写锁和停机权限。运行多套独立 Host 必须同时区分目录和端口。

数据目录自版本 2 起采用规范化分类层级结构（`config/`、`credentials/`、`state/`、`data/`、`resources/`、`plugins/`、`workspaces/`、`cache/`、`logs/`），完整结构、各文件所有者与回收规则见 [数据目录与存储](storage.md)。主要文件简述如下：

```text
~/.pi-meme/
├── storage.json                    # 布局清单（version: 2）
├── host-id                         # 持久 Host 身份
├── host.lock                       # 唯一写入锁
├── config/app.json                 # 应用偏好与新会话默认值
├── config/profile/                 # 用户个人资料与头像
├── config/agent/                   # SDK 设置、模型、MCP、指令与子代理
├── config/workspaces/<cwd-hash>/   # 工作区覆盖配置
├── credentials/auth.json           # 模型、MCP、Host 与远程连接凭据（0600）
├── state/projects.json             # 项目与工作位置登记
├── state/goals.json                # 目标状态
├── state/agent-permissions.json    # 会话权限映射
├── state/resources.json            # 资源导入记录与策略
├── state/plugins.json              # 插件清单（版本化 envelope）
├── state/requests.jsonl            # 内部 RPC 请求追加日志（永久防重放）
├── state/control/                  # 正式目标、幂等操作、回执与关键事件快照及日志
├── state/collaboration/            # 协作身份与计划索引（按根分片）
├── data/sessions/<cwd-hash>/       # Pi 原生 JSONL 会话分支
├── data/plans/<sessionId>/         # 计划正文
├── data/attachments/               # 聊天上传附件
├── resources/                      # 技能、主题、内置资源与历史快照
├── plugins/                        # 外部插件代码快照与私有数据
├── workspaces/                     # 真实工作目录（standalone 与 worktree）
├── cache/                          # 可重建会话索引与远程连接摘要
└── logs/mcp.log                    # MCP 服务运行日志
```

工作区分组使用规范化真实路径的 SHA-256，见 [runtime-paths.ts](../packages/pi-runtime/src/runtime-paths.ts)。项目登记见 [project-store.ts](../packages/workspace/src/server/project-store.ts)，远程摘要见 [remote-services.ts](../packages/host/src/remote-services.ts)。Linux 拒绝把 Host 数据放在识别到的 Windows 驱动器挂载中。

### Desktop 自定义目录

从“设置 → 常规 → 存储 → 更改目录”选择空文件夹。所选文件夹直接成为数据根目录。确认框显示来源、目标、复制大小和目标可用空间；点击“迁移并重启”后，应用正常停止本机 Host，再离线复制、校验和修复路径关联，成功后才切换目录。

Electron 固定 `userData` 下的 `storage-location.json` 保存目录定位、备份路径、待执行任务与错误；它不放在 Host 的 `settings.json` 中，也不随数据根目录迁移。显式设置 `PI_MEME_DATA_ROOT` 时，界面只读并禁用维护。Desktop 复用其他入口创建的 Host 时也禁止迁移和缓存清理；界面显示原因，主进程再次检查所有权，但仍可查看信息和打开本机目录。Web 和远程页面只展示所连接 Host 的目录，不调用本机文件选择器，不提供远程迁移或清理接口。

Desktop 开发版在申请单实例锁和读取定位文件前，将 `userData` 切换为 `appData/pi-meme-dev`。macOS 路径是 `~/Library/Application Support/pi-meme-dev`；开发版与构建 App 不共享 Electron 缓存、单实例锁或存储定位文件。测试凭据模式继续使用临时数据目录下的 `desktop-cache`。

```mermaid
flowchart TD
  A["选择空目录并确认"] --> B["检查草稿、文件、本机任务和终端"]
  B --> C["正常关闭 Host 后保存任务并重启"]
  C --> D["离线进程取得源与目标目录写锁"]
  D --> E["复制、校验、修复路径与 Worktree 登记"]
  E --> F["原子发布目录定位并保留原目录"]
  F --> G["再次启动普通 Host 与桌面页面"]
  E -->|失败| H["不切换目录，保留数据并显示原因"]
```

维护前必须处理所有桌面服务页面中未发送的草稿、附件、未保存文件和指令，以及本机 Host 的运行、暂停、排队任务、待答交互、插件或资源操作和活动终端。停机超时或非零退出会取消本次维护，不会强行停止后继续复制。维护窗口使用独立的内存 Session 和临时 `sessionData`，普通 Host 在维护完成后的下一轮启动中创建。

迁移会保留 Host、会话和业务 ID，更新已知会话路径、cwd 哈希分组、权限、置顶与侧栏排序、技能身份与策略、插件安装路径及应用创建的 Worktree 登记。`auth.json`、历史正文、提示词和未知插件私有数据不作字符串替换。外部项目目录不移动。第三方插件自行保存的绝对路径需要插件自行适配。

源目录保留为备份，其中仍有会话和凭据；常规页面只提供打开备份，不自动删除。`.pi-meme-relocated.json` 标记已迁移或正在维护的源目录，普通 Host 拒绝将其重新作为活动目录。旧 Worktree 副本仅作文件备份，不再作为活动 Worktree 使用。目标 `.pi-meme-storage-job.json` 记录任务和复制校验信息，未提交的目标副本同样不能启动普通 Host。

中断后只允许同一任务继续处理所属副本；来源已变化、目标出现无关文件、校验失败或路径冲突时停止，不清空目标。进程异常退出后写锁最多需要约 30 秒失效，再从恢复页面重试。若 Worktree 登记尚未恢复，任务保留并阻止正常启动。自定义磁盘不可用或定位文件损坏时，不会自动退回默认目录创建空数据。

独立 Server 不读取 Desktop 定位文件。迁移后若改用 Server，应将 `PI_MEME_DATA_ROOT` 设置为新目录；旧目录已被标记为备份，不能继续启动。Desktop 和 Server 可以复用同一个运行中的 Host，但不能各自创建 Host 同时写同一目录。

### 缓存清理

从“设置 → 常规 → 缓存”刷新占用，再点击“清理缓存”，确认后重启执行。统计失败显示未知占用和错误，不显示为 `0 B`。统计与删除使用相同白名单：

- Host：`cache/sessions.json`、`cache/sessions.json.tmp`、`cache/remote-services.json`、`cache/remote-services.json.tmp`。
- Electron 固定 `userData`：存在的 `Cache`、`Code Cache`、`GPUCache`、`DawnCache`、`ShaderCache`、`GrShaderCache`、`GraphiteDawnCache`。

缓存包含链接或特殊文件时停止清理并显示路径，不沿链接删除外部文件。会话索引和远程摘要可重新生成；远程连接凭据保留，摘要在重连后重建。缓存可能在重启后立即重新产生。

不会删除会话、计划、工作目录、`credentials/auth.json`、技能、插件、整个 Electron profile 或系统临时目录。`resources/snapshots/` 被历史技能使用记录引用，`state/requests.jsonl` 与 `state/control/` 承担请求去重及回执语义，均不属于清理白名单。

## 应用设置与模型

[config/app.json](../packages/settings/src/server/store.ts)（原 `settings.json`）保存应用外观、主题、侧栏、新会话默认权限和 `defaultAgentPlugins` 等设置；字段见 [DesktopSettings](../packages/contracts/src/settings.ts)。`config/agent/settings.json`（原 `pi/settings.json`）是 SDK 设置文件，与应用设置分开。项目 `.pi/settings.json` 可读，SDK 存储适配器不向项目写回，见 [sdk/settings.ts](../packages/pi-runtime/src/sdk/settings.ts)。

“设置 → Agent → 模型”管理 Host 的 `config/agent/models.json`（原 `pi/models.json`）。非敏感服务商和模型声明保存在此文件，API Key、OAuth 与敏感请求头由凭据存储管理；界面只返回是否已保存密钥等状态。协议与可编辑字段见 [model-config.ts](../packages/contracts/src/model-config.ts)，校验和保存见 [config-store.ts](../packages/models/src/server/config-store.ts)。

同一页可以登录 Pi 自带目录里的服务商，不把这些服务商写进 `models.json`。API Key 和订阅账号都调用 `ModelRuntime.login`，退出调用 `logout`，凭据进入上面的凭据存储。登录或退出后重连 Pi，模型选择器才会出现新的可用模型。会话正在运行时凭据仍会保存，重连失败时页面会提示稍后再点“重新连接”。OpenAI 等登录用的设备标识写在 `config/agent/device-id`（原 `pi/device-id`）。这里不读取本机环境变量，也不执行 `!command`。实现见 [builtin-auth.ts](../packages/models/src/server/builtin-auth.ts)。

默认模型和思考强度默认值写入 `config/agent/settings.json` 的 `defaultProvider`、`defaultModel`、`defaultThinkingLevel`。思考强度为 `off`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max` 之一；未设置时 Pi 使用 `medium`。同一文件里的 `modelThinkingLevels` 可按 `provider/modelId` 覆盖该模型的启动强度。二者都不改变已经打开的会话。

模型配置的主要限制：

- Base URL 必须是完整 HTTP(S) 地址，不包含账号、查询参数或片段。
- 模型 ID 非空，`contextWindow` 和 `maxTokens` 为正整数；输入类型包含 `text`，可包含 `image`。
- 凭据和请求头不能引用本机环境变量或 `!command`；请求头不能含换行。
- 保存携带文件修订，配置已被其他操作修改时要求重新读取，不覆盖新内容。

## MCP 配置与授权

MCP 合并 Host `config/agent/mcp.json`（原 `pi/mcp.json`）、项目只读 `.pi/mcp.json` 和 Host 侧 `config/workspaces/<cwd-hash>/mcp-overrides.json`。界面从“设置 → Agent → MCP”管理服务；项目覆盖不写回项目文件。

逐服务启停与明确授权分开校验，授权绑定配置摘要；外部修改配置后旧授权不能继续使用。旧 `mcpEnabled: false` 保留不连接未重新授权服务的选择，升级不会自动连接。MCP 只在完全权限的普通任务中装配，规划模式不运行 MCP。

配置损坏时显示错误并保留原文件；保存使用修订检查。OAuth Client Secret 和令牌进入凭据存储。配置合并、授权和诊断见 [runtime-config.ts](../packages/mcp/src/server/runtime-config.ts)、[config-store.ts](../packages/mcp/src/server/config-store.ts) 与 [MCP 测试](../packages/mcp/tests/)。

## 指令、资源与主题

Host 指令在 `config/agent/AGENTS.md`、`config/agent/SYSTEM.md`、`config/agent/APPEND_SYSTEM.md`（原 `pi/` 目录）；当前项目分别读取根目录 AGENTS 文件和 `.pi/SYSTEM.md`、`.pi/APPEND_SYSTEM.md`。同目录存在 `AGENTS.override.md` 时优先于 `AGENTS.md`，不会向祖先目录扫描或读取其他命名。

界面从“设置 → Agent → 指令”编辑。用户分组对应 AGENTS，系统分组对应 `SYSTEM.md` 与 `APPEND_SYSTEM.md`。Host 和项目 AGENTS 可组合，项目 SYSTEM/APPEND_SYSTEM 存在时使用项目项。管理页只保存 Host 指令，携带读取修订；项目指令只读。具体优先级与写入边界见 [context-files.ts](../packages/pi-runtime/src/sdk/context-files.ts) 和 [instructions.ts](../packages/settings/src/server/instructions.ts)。

技能来源包括内置技能（`resources/builtin/skills/`）、Host 用户技能（`resources/skills/`）、项目 `.agents/skills/` 和 App 附带技能。项目资源只读，导入、修订、优先级和策略见 [技能与资源](skills-and-extensions.md)。不装配裸 Pi 扩展或原生 Pi 包，不读取本机 Pi CLI、Codex、Claude、Gemini 的全局资源配置。

用户主题保存在 `resources/themes/`，App 主题由插件的 `resources.themes/assets` 分发。主题保持 JSON，背景图来自包内素材，不执行 JavaScript 或任意 CSS；字段和范围见 [结构化主题](plugins.md#结构化主题)。

进入外观页后，三个字体选择器共用后台读取的 Host 字体列表，不等待展开菜单才读取。macOS 通过系统自带的 `osascript` 调用 AppKit，读取中文字体族名、可用样式和等宽属性，不下载或传输字体文件；代码字体优先显示等宽字体。列表由 Host 进程内存缓存，读取失败可重试；安装或移除字体后需重启 Host 更新列表。其他系统保持默认字体选项；枚举结果不包含已保存的字体时，不会改写配置。实现见 [fonts.ts](../packages/settings/src/server/fonts.ts) 与 [theme-settings.tsx](../packages/settings/src/ui/theme-settings.tsx)。

## 凭据

[FileCredentialStore](../packages/pi-adapter/src/file-credentials.ts) 保存凭据于 `credentials/auth.json`（原根目录 `auth.json`，详见 [数据目录与存储](storage.md)），格式为应用自己的字符串键值对象，权限为 `0600`。Host 串行写入并原子替换；Worker 同步内存副本，Host 落盘后才确认成功。读取、解析或写入失败会明确报错，不覆盖损坏文件。

启动不读系统钥匙串。旧 macOS 凭据只通过主动导入操作读取，保留已有文件凭据和旧钥匙串条目；实现见 [credentials.ts](../packages/host/src/credentials.ts) 与 [HostSettings](../packages/app-ui/src/settings/host-settings.tsx)。Linux 不提供该导入操作。

Desktop 使用内存 Electron Session，认证 Cookie 不写磁盘；本机 Host 的自动登录同时校验真实连接来源、Host 和 Origin，不向 Renderer 传递长期令牌。远程令牌留在本地 Host 凭据存储，不返回 Renderer。认证与远程代理规则见 [Remote](remote.md)。

Pi 1.1 的 `ModelRuntime.create` 没有公开的认证环境注入参数。[model-runtime.ts](../packages/pi-runtime/src/sdk/model-runtime.ts) 是唯一依赖 SDK private shape 的认证隔离层：检查 `runtime.models.authContext` 后注入空环境和不可用文件检查，阻止隐式读取本机模型认证。守卫失败报错；升级 SDK 时需重新核对该守卫，并验证 [model-config.integration.test.ts](../packages/models/tests/model-config.integration.test.ts) 与 [sdk-settings-isolation.integration.test.ts](../packages/pi-runtime/tests/sdk-settings-isolation.integration.test.ts)。会话、JSONL 与扩展仍使用公开 SDK。

## macOS Desktop 命令环境

Desktop 创建本机 Host 前，通过用户 Shell 的 `-lic` 读取 PATH，兼容 `.zprofile`、`.zshrc` 中的工具初始化。探测异步执行，最多 5 秒，成功与失败都在当前 Desktop 进程内缓存；超时回收探测进程及其后代。只读取 PATH，不导入 Shell 导出的其他变量。

PATH 按登录 Shell、启动时继承值、已存在的常用工具目录依次合并，保留首次出现的目录并删除空项和重复项。常用目录包括 Homebrew、`/usr/local/bin`、`~/.local/bin`、`~/.cargo/bin`、`~/Library/pnpm` 和已声明的 `PNPM_HOME`，不递归扫描版本目录。探测失败会记录一次原因，继续使用继承值和常用目录。

Bash、会话 Worker、MCP 和项目终端继承本机 Host 的 PATH；MCP 显式配置的 `env.PATH` 仍优先。连接已有 Host 时不会重新探测或修改它的环境；独立 Server 和远程 Host 使用各自的启动环境。修改 Shell 配置后，需退出并重新启动拥有该 Host 的入口。

命令返回 `command not found` 时，Agent 的内置提示要求先检查 `command -v`、PATH 和明确的安装位置；无法定位时说明缺失信息，不自动执行 `find /` 或遍历整个用户目录。这是工具定位指导，不是 Shell 命令拦截。

## 权限与沙箱

默认权限为 `workspace-write`，枚举与说明见 [agent-access.ts](../packages/contracts/src/agent-access.ts)。

| 模式              | 文件写入与执行边界                                                   |
| ----------------- | -------------------------------------------------------------------- |
| `read-only`       | 允许读取和联网，拒绝修改业务文件；沙箱临时目录与必要设备仍可写       |
| `workspace-write` | 允许修改当前工作区和会话临时目录，项目外写入被拒绝；读取和联网不受限 |
| `full-access`     | 允许项目外写入，普通任务可加载已选择且获准的可信 AppAgent 和 MCP     |

三档权限只控制 Agent 的执行范围，文件访问仍受运行所在 Host 的操作系统授权限制。macOS 的“系统设置 → 隐私与安全性 → 文件与文件夹”控制桌面、文稿、下载目录等位置的访问，首次访问这些位置可能出现系统授权提示。“完全磁盘访问权限”是另一项系统授权，需要用户在系统设置中添加应用；选择 Agent 的“完全权限”不会自动授予它。普通项目操作不要求预先开启完全磁盘访问权限。参见 [Apple 文件访问说明](https://support.apple.com/zh-cn/guide/security/secddd1d86a6/web)。

开发态从终端启动时，系统可能把权限责任归到终端应用；Finder 或 Dock 启动的安装版使用 pi-meme 自身的身份，不能用开发态未弹窗证明安装版已经获得系统授权。需要访问受保护目录时按具体目录授权，目录拒绝访问也不能直接归因于 Agent 权限模式。

```mermaid
%%{init: {"theme": "dark"}}%%
flowchart TD
  Task["会话权限与任务模式"] --> Access{"是否受限权限"}
  Access -->|是| Probe["验证内置权限与平台沙箱"]
  Probe -->|通过| Plan{"是否规划模式"}
  Probe -->|失败| Reject["拒绝受限任务并返回原因"]
  Access -->|否| Plan
  Plan -->|是| Read["只读工具、协作、提问与保存计划"]
  Plan -->|否| Run["按会话权限与授权执行"]
```

macOS 使用 `sandbox-exec`，Linux/WSL2 使用 bubblewrap。Host 启动探测实际隔离能力，通过 `restrictedAccessSupported/restrictedAccessReason` 返回结果；受限 Worker 创建时还验证实际命令。内置权限、工厂或沙箱失效时拒绝受限执行，不自动授予完全权限。设置与历史仍可用。

路径校验与工具执行见 [access-sandbox.ts](../packages/pi-runtime/src/sdk/access-sandbox.ts)，平台选择见 [sandbox-platform.ts](../packages/host/src/sandbox-platform.ts)。Linux namespace、socket 与 WSL 互操作边界见 [Linux 与 WSL](linux-wsl.md)。

上表描述内置 Agent 工具的边界，不是 SDK 3 受限插件的读取和联网授权。规划模式独立拒绝业务写入、codemode、MCP 和可信外部入口，但可使用获准的受限只读插件；子任务继承父级上限，并按自身真实目录、模式和权限构建执行环境。

### 插件执行与授权

SDK 3 将 `agent/server` 分为 `trusted` 与 `restricted`。可信 Server 是 Host Node 代码，可信 Agent 在会话 Worker 中执行，UI 是宿主同源 React；三者分别取得信任授权，不能把它们称为恶意代码沙箱。受限入口运行真正 JS/TS 构建产物，使用独立进程、固定 Node 与 OS 沙箱，不通过 VM 或线程模拟隔离。

| 任务边界             | 受限入口                         | 工作区                  | 网络与共享数据                          | 可信入口             |
| -------------------- | -------------------------------- | ----------------------- | --------------------------------------- | -------------------- |
| Plan                 | 获准的只读工具与 handler         | 只读，私有 scratch 例外 | 共享记录只读；HTTPS 仅单独授权 GET/HEAD | 不导入               |
| 普通 read-only       | 获准的受限能力                   | 只读，scratch 例外      | 按 origin/method 和记录名授权           | 不导入               |
| 普通 workspace-write | 不超过 manifest 与 grant 上限    | 仅获准工作区可写        | 按授权                                  | 不导入               |
| 普通 full-access     | restricted-only 仍按受限上限运行 | 最多获准工作区          | 受限入口仍走 broker                     | 仅明确授权的可信入口 |

有效能力取 manifest 申请、用户 grant、项目可用策略、任务 mode/access 与实际运行边界的交集。安装、启用和会话选择不自动授予能力。工具 `effect/capabilities` 是分派检查，不替代 OS 拒写；同一个可写进程内的 read 标签也不提供逐工具 OS 隔离。

[state/plugins.json（原 installed.json）管理](../packages/plugin-runtime/src/manager.ts) 保存 policyHash、grant revision 与可信入口、UI 能力、受限访问、网络、命名共享数据、发送前处理器的授权。代码或申请变化后旧授权不匹配；SDK 2 记录保留为不兼容，不执行旧入口、不删除私有数据。读取损坏文件时保留原文件并报告，不默认扩大授权。

受限启动器见 [plugin-sandbox.ts](../packages/host/src/plugin-sandbox.ts)，协议与生命周期见 [restricted-runner.ts](../packages/plugin-runtime/src/restricted-runner.ts)。Linux 使用 bubblewrap 的 user/pid/ipc/net namespace 与 seccomp；工作区按权限只读或可写，环境使用白名单，不继承模型 key、代理、SSH socket 或 Node 注入变量。macOS 使用单独的 deny-by-default profile；Windows 原生不支持，WSL Windows 盘工作区拒绝受限插件。不能把 Host 数据根或其私有目录直接授权为插件工作区，Host 管理的 standalone 精确工作目录除外；路径别名先解析 realpath。平台缺少必要能力时拒绝执行，不降级为无沙箱。macOS 签名后 Node/JIT 与沙箱行为需在真实目标产物单独验收，Linux 检查不能代表 macOS 已通过。

独立插件能力探测见 [plugin-sandbox-probe.ts](../packages/host/src/plugin-sandbox-probe.ts)，结果通过连接的 `restrictedPluginRuntimeSupported/restrictedPluginRuntimeReason` 提供，不能用旧 `restrictedAccessSupported` 的 bash 检查代替。探测运行 Node 并检查工作区读写、边界秘密、TCP/Unix socket、子进程与环境白名单；它不代替真实插件协议、取消和目标产物的专项测试。开发态 Node 准备命令见 [受限 Node 运行时](plugins.md#受限-node-运行时)。

原始网络与本机 Host 通道不属于受限接口。HTTPS 走 Host broker，精确校验 origin、method、DNS 地址与重定向；默认不联网、不继承 Cookie、代理或模型认证。插件凭据使用自身 credentialRef，由 Host 注入，不把明文交给 runner。命名共享数据仅包含可信 Server 显式发布并获准读取的 JSON，不自动共享 plugin-data 目录。GET/HEAD 不能保证远端服务没有副作用。

撤销或收窄受限授权需要取消旧调用并重建进程，不能只更新 JS policy。可信代码已发生的外部副作用不能靠撤权回滚；怀疑恶意代码时停用并重启 Host。工作区内用户主动放入的秘密或硬链接、强 CPU/RSS 配额、OS 内核漏洞防护不属于此沙箱保证。更多 API 见 [App 插件](plugins.md)。
