---
description: '模型与 MCP 配置、指令、凭据、快捷键和内置工具与插件的权限边界'
status: implemented
paths:
  - 'packages/host/src/data-root.ts'
  - 'apps/desktop/src/main/user-login-path.ts'
  - 'apps/desktop/src/main/local-host.ts'
  - 'packages/host/src/service.ts'
  - 'packages/host/src/credentials.ts'
  - 'packages/host/src/ssh-connections.ts'
  - 'packages/host/src/ssh-config.ts'
  - 'packages/host/src/ssh-tunnels.ts'
  - 'packages/host/src/connection-credentials.ts'
  - 'packages/contracts/src/ssh-connections.ts'
  - 'packages/pi-adapter/src/file-credentials.ts'
  - 'packages/pi-runtime/src/runtime-paths.ts'
  - 'packages/pi-runtime/src/sdk/model-runtime.ts'
  - 'packages/pi-runtime/src/sdk/context-files.ts'
  - 'packages/pi-runtime/src/sdk/settings.ts'
  - 'packages/pi-runtime/src/sdk/access-sandbox.ts'
  - 'packages/pi-runtime/src/sdk/linux-sandbox.ts'
  - 'packages/settings/**'
  - 'packages/models/**'
  - 'packages/image-generation/**'
  - 'packages/mcp/**'
  - 'packages/permissions/**'
  - 'packages/sandbox-macos/**'
  - 'packages/sandbox-linux/**'
  - 'packages/contracts/src/agent-access.ts'
---

# 配置与安全

所有配置和执行数据属于所连接的 Host。连接远程服务后，模型、MCP、技能、插件和会话操作都发生在远程机器；浏览器平台不决定 Agent 沙箱。HTTPS、SSH 参数与具体连接步骤见 [Remote](remote.md)。

## 数据目录

配置写入当前 Host 的数据根。构建 App、构建后的 Server 和独立包默认使用 `~/.pi-meme`；Desktop 与 Server 开发入口使用 `~/.pi-meme-dev`。`PI_MEME_DATA_ROOT` 可覆盖目录，Desktop 还支持本机保存的自定义目录。

完整文件布局、唯一写入锁、[Desktop 更改目录](storage.md#desktop-自定义目录)与[缓存清理](storage.md#缓存清理白名单与保护边界)统一见[数据目录与存储](storage.md)。Web 和远程页面不提供本机迁移或清理操作。

## 应用设置与模型

[config/app.json](../packages/settings/src/server/store.ts)（原 `settings.json`）保存应用外观、主题、侧栏、新会话默认权限和 `defaultAgentPlugins` 等设置；字段见 [DesktopSettings](../packages/contracts/src/settings.ts)。`config/agent/settings.json`（原 `pi/settings.json`）是 SDK 设置文件，与应用设置分开。项目 `.pi/settings.json` 可读，SDK 存储适配器不向项目写回，见 [sdk/settings.ts](../packages/pi-runtime/src/sdk/settings.ts)。

“设置 → Agent → 模型”管理 Host 的 `config/agent/models.json`（原 `pi/models.json`）。非敏感服务商和模型声明保存在此文件，API Key、OAuth 与敏感请求头由凭据存储管理；界面只返回是否已保存密钥等状态。协议与可编辑字段见 [model-config.ts](../packages/contracts/src/model-config.ts)，校验和保存见 [config-store.ts](../packages/models/src/server/config-store.ts)。

同一页可以登录 Pi 自带目录里的服务商，不把这些服务商写进 `models.json`。API Key 和订阅账号都调用 `ModelRuntime.login`，退出调用 `logout`，凭据进入上面的凭据存储。登录或退出后重连 Pi，模型选择器才会出现新的可用模型。会话正在运行时凭据仍会保存，重连失败时页面会提示稍后再点“重新连接”。OpenAI 等登录用的设备标识写在 `config/agent/device-id`（原 `pi/device-id`）。这里不读取本机环境变量，也不执行 `!command`。实现见 [builtin-auth.ts](../packages/models/src/server/builtin-auth.ts)。

默认模型和思考强度默认值写入 `config/agent/settings.json` 的 `defaultProvider`、`defaultModel`、`defaultThinkingLevel`。思考强度为 `off`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max` 之一；未设置时 Pi 使用 `medium`。同一文件里的 `modelThinkingLevels` 可按 `provider/modelId` 覆盖该模型的启动强度。二者都不改变已经打开的会话。

自定义模型可以逐项勾选思考强度。未提供档位映射时，配置表单默认全选；保存后使用 Pi 的 `thinkingLevelMap` 声明能力，取消勾选的档位写为 `null`。关闭“支持思考”后，会话只提供 `off`。已有映射保留；高级模型参数可填写每档对应的接口参数值。OpenAI 兼容协议的 `xhigh`、`max` 默认同名映射；Google 协议默认映射到 `high`，可按服务文档调整。接口返回 `reasoning` 和 `thinkingLevelMap` 时，模型发现会保留这些字段；仅返回模型 ID 时不推断上游能力。

会话和模型选择器使用 Pi SDK 返回的模型可用档位，切换模型、恢复会话或设置不支持的强度时，显示 SDK 调整后的有效档位。未经配置表单保存的旧模型仍遵循 SDK 默认能力：`reasoning: true` 且没有映射时最高为 `high`。全局默认强度保留用户偏好，各会话按所选模型调整。

模型配置的主要限制：

- Base URL 必须是完整 HTTP(S) 地址，不包含账号、查询参数或片段。
- 模型 ID 非空，`contextWindow` 和 `maxTokens` 为正整数；输入类型包含 `text`，可包含 `image`。
- 凭据和请求头不能引用本机环境变量或 `!command`；请求头不能含换行。
- 保存携带文件修订，配置已被其他操作修改时要求重新读取，不覆盖新内容。

## 第三方注入自定义提供商

网关、CLI 或 IDE 通过已认证的 Host 连接复用现有模型 RPC：`models:get` 读取配置和修订，`models:save` 保存一个普通自定义提供商，`models:delete` 删除指定提供商。外部注入和界面手动添加使用同一份 `config/agent/models.json` 与凭据存储，统一显示在“自定义提供商”中。模型 ID 原样发送，不增加前缀或来源标识。

接入方可使用现有 [Node 客户端](host-api.md#node-客户端) 的 `rpc()`，登录、Cookie 和 Host 身份检查由客户端处理。普通配置注入只需读取修订后保存一个提供商：

```ts
import type { ModelConfigResult, ModelConfigSnapshot, SaveModelProvider } from '@pi-meme/contracts/model-config'

const snapshot = await client.rpc<ModelConfigSnapshot>('models:get')
const input: SaveModelProvider = {
  revision: snapshot.revision,
  apiKey: gatewayApiKey,
  provider: {
    id: 'example-gateway',
    name: '模型网关',
    api: 'openai-completions',
    baseUrl: 'https://gateway.example/v1',
    models: [
      { id: 'upstream/chat-model' },
      { id: 'upstream/messages-model', api: 'anthropic-messages', baseUrl: 'https://gateway.example' },
    ],
  },
}
const result = await client.rpc<ModelConfigResult>('models:save', [input])
```

HTTP 接入使用 `POST /api/auth` 登录后返回的 Cookie，向 `POST /api/rpc` 提交 `{ hostId, clientId, requestId, method, args }`；`hostId` 使用登录返回的身份，`requestId` 标识单次操作。认证规则见 [HostApi](host-api.md#http-与认证)。

更新已有提供商时在保存参数中传入 `originalId`，值必须与 `provider.id` 相同；不传该字段时，ID 已存在会拒绝新增。删除参数为 `[providerId, revision]`。`models:get` 参数为空数组。接入方需检查 RPC 的 `error`，修订冲突时重新读取后处理，不能直接覆盖并发变更。`clientId` 用于标识和去重，不是独立授权身份。

模型只要求 `id`。模型级 `api` 与 `baseUrl` 可以覆盖服务商默认值，地址须同 origin；跨 origin 使用不同提供商。`contextWindow`、`maxTokens`、`input`、`reasoning`、`thinkingLevelMap`、`headers`、`compat` 均可省略，不猜测上游能力。可用协议见 [model-config.ts](../packages/contracts/src/model-config.ts)。

保存时 API Key 和敏感请求头进入已有凭据存储，不回显明文，不要求用户准备声明文件。操作使用现有空闲守卫：运行中拒绝写入，空闲时自动重连并保留已选模型；移除当前模型时沿用原有回退行为。重连失败返回 `reconnectError`，配置已保存，接入方可在空闲后调用 `models:reconnect`。设置页随模型目录更新自动读取配置，仍在原有自定义提供商列表中编辑和删除。

查询可用模型使用 [HostApi.models.list](host-api.md#模型目录)，配置写入复用认证内置 RPC。SDK 4 外部插件不取得完整 context.host；Worker 的实际模型请求经 Host broker，不取得模型凭据。

## 图片生成与编辑

“设置 → Agent → 图片生成”管理当前 Host 的图片模型。每条配置填写名称、Base URL、API Key、模型 ID、默认尺寸和默认质量。服务需支持 OpenAI Images 的 `/images/generations` 和 `/images/edits`；仅支持聊天接口的服务不可用。

第一条带凭据的配置自动设为默认，生图与编辑共用默认模型。修改配置后下一次调用生效；删除默认模型后需重新选择。保存不发起生成请求。“生成测试图片”会明确提示可能产生费用，只验证生图能力。

配置在 `config/agent/image-generation.json`，API Key 使用 Host 凭据存储，不写入配置文件或会话 Worker 的凭据快照。配置损坏时保留原文件，其他聊天功能仍可使用。

配置完成后，普通任务在“工作区内修改”或“完全权限”下自动获得内置 `image_gen` 工具；规划与只读模式不可使用。参数如下：

| 参数                         | 用途                                                                  |
| ---------------------------- | --------------------------------------------------------------------- |
| `prompt`                     | 必填，生成目标或修改要求                                              |
| `referenced_image_paths`     | 1～5 个执行 Host 的图片路径，相对路径按会话工作目录解析               |
| `num_last_images_to_include` | 当前会话分支最近的 1～5 张图片，与路径参数互斥                        |
| `transparent_background`     | `true` 要求透明背景，`false` 要求不透明背景；编辑省略时尽量保留原背景 |

不提供图片输入时生图，提供图片时编辑；原图不覆盖。输入支持 PNG、JPEG、WebP，合计不超过 50 MiB，输出 PNG 不超过 8 MiB。产物保存为 Host 附件，临时会话沿用临时附件生命周期。聊天中可预览、下载，并继续引用生成结果。

可选参数允许 `null`，按省略处理；两种图片引用不能同时提供有效值。生成结果的 Host 附件绝对路径可直接用于 Markdown 图片展示，无需复制到项目目录。

请求最多等待五分钟。失败不自动重试或切换模型，取消只停止本地等待，外部服务可能继续处理或计费。兼容服务须支持配置的参数，不支持时返回错误，不会自动删除参数后重试。

## 图像库

侧栏「图像」汇总已连接 Host 的普通会话作品。可按 Host、项目筛选，搜索名称或提示词，预览原图、下载、重命名和打开来源会话。图片按生成时间倒序排列，编辑结果独立保存。

首次打开时后台补录已有会话中成功的 `image_gen` 结果，包括历史分支；原图缺失或损坏时显示跳过数量。临时会话、设置页模型测试、上传附件和项目目录中的其他图片不收录。页面不提供直接创建图片的入口。

删除来源会话不删除已收录图片。「从图像中移除」只隐藏图像库记录，保留原文件与聊天引用，历史补录不会恢复已移除作品。重命名只修改图像库名称。远程 Host 离线时，页面提示结果不完整；预览与下载需要连接所属 Host。

## MCP 配置与授权

MCP 合并 Host `config/agent/mcp.json`（原 `pi/mcp.json`）、项目只读 `.pi/mcp.json` 和 Host 侧 `config/workspaces/<cwd-hash>/mcp-overrides.json`。界面从“设置 → Agent → MCP”管理服务；项目覆盖不写回项目文件。

逐服务启停与明确授权分开校验，授权绑定配置摘要；外部修改配置后旧授权不能继续使用。旧 `mcpEnabled: false` 保留不连接未重新授权服务的选择，升级不会自动连接。MCP 只在完全权限的普通任务中装配，规划模式不运行 MCP。

配置损坏时显示错误并保留原文件；保存使用修订检查。OAuth Client Secret 和令牌进入凭据存储。配置合并、授权和诊断见 [runtime-config.ts](../packages/mcp/src/server/runtime-config.ts) 与 [config-store.ts](../packages/mcp/src/server/config-store.ts)。

## 指令、资源与主题

Host 指令在 `config/agent/AGENTS.md`、`config/agent/SYSTEM.md`、`config/agent/APPEND_SYSTEM.md`（原 `pi/` 目录）；当前项目分别读取根目录 AGENTS 文件和 `.pi/SYSTEM.md`、`.pi/APPEND_SYSTEM.md`。同目录存在 `AGENTS.override.md` 时优先于 `AGENTS.md`，不会向祖先目录扫描或读取其他命名。

界面从“设置 → Agent → 指令”编辑。用户分组对应 AGENTS，系统分组对应 `SYSTEM.md` 与 `APPEND_SYSTEM.md`。Host 和项目 AGENTS 可组合，项目 SYSTEM/APPEND_SYSTEM 存在时使用项目项。管理页只保存 Host 指令，携带读取修订；项目指令只读。具体优先级与写入边界见 [context-files.ts](../packages/pi-runtime/src/sdk/context-files.ts) 和 [instructions.ts](../packages/settings/src/server/instructions.ts)。

技能来源包括内置技能（`resources/builtin/skills/`）、Host 用户技能（`resources/skills/`）、项目 `.agents/skills/` 和 App 附带技能。项目资源只读，导入、修订、优先级和策略见 [技能与资源](skills-and-extensions.md)。不装配裸 Pi 扩展或原生 Pi 包，不读取本机 Pi CLI、Codex、Claude、Gemini 的全局资源配置。

外观页的明暗模式、主题、分模式覆盖、字体与字形、字号、颜色、对比度、减少动态效果、透明侧栏、布局和背景参数统一保存在外观 Host 的 `config/app.json`。Desktop 多服务界面使用客户端本地 Host；独立 Web 使用连接入口的 Host。每个窗口只有一个外观状态与保存队列，切换项目、会话、页面或远程服务不更换外观保存目标。

修改立即预览，Host 校验内容修订并原子替换配置后才确认保存。外观写入使用字段补丁或明确的主题选择、分模式转换和恢复默认操作；旧的无修订整份写入被拒绝。缺席字段保持不变，可选覆盖叶子的 `null` 表示删除并恢复继承，必填值不接受 `null`。多客户端修改发生冲突时保留未确认意图，不用旧快照覆盖最新配置；提交后的事件与重新连接只触发读取。切换主题保留当前作用域的显式字体、字形及全局字号，重选同一主题不清覆盖；选择“跟随主题”才删除对应字体及字形覆盖，恢复全部默认仍需确认。

读取设置不执行旧缓存迁移。客户端只向本机外观 Host 发起独立迁移请求，由 Host 校验导入资格与修订；已有外观配置（包括空覆盖或默认值）保持权威。迁移完成、确认已迁移或确认 Host 已有权威配置后才删除旧 key；失败或冲突保留来源，独立 Web 不自动将无 Host 归属的旧缓存写入远端。旧版内存浏览器分区中已经随进程退出消失的字体无法恢复。

配置读取、解析或校验失败时保护原文件，并阻止所有 `app.json` 写入，包括外观、侧栏、固定项目与其他设置。修复文件后需真正重新读取配置并通过校验，重新加载主题不能解除写保护。运行中发现磁盘内容已被外部修改时拒绝旧内存值覆盖，要求重新读取。暂时缺失的主题仅在运行时使用内置回退，保留所选主题 ID 和字体，不由主题刷新重写用户配置。

Desktop 正常关窗、退出、受控重新加载和存储维护前等待外观保存确认；失败或超时不会自动把未确认修改当作已保存，原有文件、指令和草稿离开守卫继续生效。普通关闭允许明确放弃本次未确认修改，存储维护不能绕过保存。独立 Web 对未确认修改使用浏览器离开提示；浏览器强关、进程崩溃、系统强杀、断电或断线前尚未确认的修改不保证落盘。

用户主题保存在 `resources/themes/`，App 主题由插件的 `resources.themes/assets` 分发。主题保持 JSON，背景图来自包内素材，不执行 JavaScript 或任意 CSS；字段和范围见 [结构化主题](plugins.md#结构化主题)。

进入外观页后，三个字体选择器共用字体列表，代码字体优先显示等宽字体。Desktop 后台读取本机 Host 的字体：macOS 通过系统自带的 `osascript` 调用 AppKit；Windows 通过随包原生程序调用 DirectWrite，读取字体族名、字重、斜体和等宽属性，映射为现有四种样式。列表由 Host 进程内存缓存，读取失败可重试；安装或移除字体后需重启 Host 更新列表。其他 Desktop 系统保持默认字体选项。实现见 [fonts.ts](../packages/settings/src/server/fonts.ts)。

独立 Web 读取浏览器所在设备的字体，不使用远端 Host 的字体目录。常见字体候选先用 canvas 探测浏览器是否可绘制；搜索框也可输入本机字体名称，探测可用后选择或按 Enter 应用。支持 Local Font Access API 的 Chromium 浏览器在 HTTPS 或 localhost 下可点击“读取全部本机字体”请求权限，已授权时进入外观页自动读取；再次点击可重新读取目录。其他浏览器、普通远程 HTTP 或拒绝权限时仍可使用候选列表和名称探测。候选与手动输入的样式允许浏览器合成，完整目录按系统样式名映射四种字形；Web 等宽属性由字符宽度推断。canvas 探测和样式名解析存在浏览器隐私设置、字体别名及语言差异等限制。

两种入口均不读取或传输字体文件。Web 字体目录留在浏览器，只有选中的字体与字形按现有外观保存规则写入外观 Host；目录读取、权限失败或字体暂时不可用不改写已保存的选择，换设备后浏览器可使用 CSS 字体栈回退。实现见 [browser-fonts.ts](../packages/settings/src/ui/browser-fonts.ts)、[use-font-catalog.ts](../packages/settings/src/ui/use-font-catalog.ts) 与 [theme-settings.tsx](../packages/settings/src/ui/theme-settings.tsx)。

## 凭据

[FileCredentialStore](../packages/pi-adapter/src/file-credentials.ts) 保存凭据于 `credentials/auth.json`（原根目录 `auth.json`，详见 [数据目录与存储](storage.md)），格式为应用自己的字符串键值对象，权限为 `0600`。这是文件权限保护，不是系统钥匙串或加密存储；备份仍包含敏感凭据。Host 串行写入并原子替换；Worker 同步内存副本，Host 落盘后才确认成功。读取、解析或写入失败会明确报错，不覆盖损坏文件。

启动不读系统钥匙串。旧 macOS 凭据只通过主动导入操作读取，保留已有文件凭据和旧钥匙串条目；实现见 [credentials.ts](../packages/host/src/credentials.ts) 与 [HostSettings](../packages/app-ui/src/settings/host-settings.tsx)。Linux 不提供该导入操作。

Desktop 使用内存 Electron Session，认证 Cookie 不写磁盘；owned Host 使用父进程单次票据，attached Host 需要显式令牌配对。loopback、Host 和 Origin 不再授予免登录权限，不向 Renderer 传递长期令牌。HTTPS 和 SSH 的远程令牌留在入口 Host 凭据存储，不返回 Renderer。SSH 令牌使用 `ssh-host:<稳定连接ID>` 键，与 `config/ssh-connections.json` 中的目标、名称、身份文件路径、启用状态和已确认 `hostId` 分开；身份文件只保存路径引用，不复制私钥。认证与远程代理规则见 [Remote](remote.md)。

当前 Pi SDK 的 `ModelRuntime.create` 没有公开的认证环境注入参数。[model-runtime.ts](../packages/pi-runtime/src/sdk/model-runtime.ts) 是唯一依赖 SDK private shape 的认证隔离层：检查 `runtime.models.authContext` 后注入空环境和不可用文件检查，阻止隐式读取本机模型认证。守卫失败报错；升级 SDK 时需重新核对该守卫，并验证模型配置与认证隔离。会话、JSONL 与扩展仍使用公开 SDK。

## SSH 连接配置与信任边界

入口 Host 使用该用户的 OpenSSH、配置、agent 和 `known_hosts`，不保存 SSH 密码或复制私钥。发现候选与实际连接有不同的执行边界，完整限制见 [SSH 配置和非交互限制](remote.md#ssh-配置和非交互限制)。管理请求要求认证及[本机来源](remote.md#本机管理资格)，不是物理在场证明或多租户隔离。

## macOS Desktop 命令环境

Desktop 创建本机 Host 不再执行登录 Shell、-lic 或用户 profile。PATH 使用启动父环境的绝对目录、固定系统/Homebrew目录和明确的固定 Node 目录；去重并排除相对路径，不自动扫描 nvm、cargo、pnpm 等用户目录，也不导入 profile 导出的其他变量。NODE_OPTIONS、NODE_PATH、BASH_ENV、ENV 不进入 owner 子进程。来源：[user-login-path.ts](../apps/desktop/src/main/user-login-path.ts)。

从终端启动可以继承该终端已有 PATH；Finder 启动不会自动加载 .zprofile/.zshrc，自定义工具路径需在启动父环境明确提供。连接已有 Host 不重写它的环境；独立 Server 和远程 Host 使用各自环境。权限受限子进程另有环境白名单，不代表能读取 owner 的其他变量。命令不存在时先检查 command -v、PATH 和明确安装位置，不遍历整个用户目录。

## 权限与沙箱

默认权限是 workspace-write。权限预设决定业务边界，不能代替平台执行能力、安装授权或一次操作的审批。完整授权、重放、模型 broker 和版本迁移见 [权限控制与版本迁移](permissions-and-migration.md)。

| 模式            | 业务文件边界                                                                      |
| --------------- | --------------------------------------------------------------------------------- |
| read-only       | 读取；拒绝业务写，私有 scratch 与 Host 专用计划产物另行处理                       |
| workspace-write | 限真实工作区与 scratch，拒绝越界业务写                                            |
| full-access     | 扩大业务写范围，仍保护 Host 私有根、凭据和固定运行时代码；不启用外部 trusted 插件 |

Plan 叠加只读硬顶；批准一次操作、子代理、codemode 或插件都不能将它提升为可写。Full 不授予 macOS 完全磁盘访问，系统权限仍独立校验。能力报告使用 enforced/unsupported/unknown，必要能力未兑现明确拒绝；核心设置、历史和连接不等待沙箱可用，不因后端失败放宽权限。

内置 typed 文件写使用同目录临时文件和原子替换，不原地改旧 inode；授权读取绑定 canonical path、dev/ino 与同一 FD。它们不能证明 Shell、rg 或任意脚本满足 Host 秘密隔离。当前 Unix host-secrets 仍为 unknown，要求该能力的任意执行即使 Full 也拒绝。源码见 [access-sandbox.ts](../packages/pi-runtime/src/sdk/access-sandbox.ts) 与 [执行能力契约](../packages/contracts/src/execution-capabilities.ts)。

### Windows 隔离

Windows core 启动不以 PSEC 成功为前提。PSEC 后端依赖微软 MXC SDK 1.0.1、原生 base-container、路径拒绝和目录枚举，不采用 ACL 或管理员服务降级。最低更新见 [微软支持表](https://github.com/microsoft/mxc/blob/main/docs/backends/process-container/os-version-support.md)。

当前 PSEC 不能同时兑现 Full 广泛写与私有根拒绝，Full typed 执行明确返回 sandbox-unavailable，不能缩成工作区冒充 Full。只读、workspace-write 和插件也逐项核对实际能力及冲突根；探测通过不代表任意命令可用。缺项保持拒绝，不能通过选择完全权限绕过。

Node/native 固定路径、私有根、后代清理和调用取消来自 [windows-sandbox.ts](../packages/pi-runtime/src/sdk/windows-sandbox.ts) 与 [原生后端](../packages/windows-native/native/src/sandbox.rs)。Windows 本轮没有真实执行、ZIP、安装或最终产物验收；不能写为已支持全链路。Node 24、ZIP 分发与 native 构建约束仍见 [发布](releasing.md)。

### Linux 与 WSL 隔离

Linux/WSL 使用 bubblewrap、namespace 与 seccomp。只读和工作区写分别收窄挂载；Full 扩大业务可写根，仍保留 Host 私有与 runtime 只读覆盖，不沿用无沙箱执行。Plan 禁止直接网络。Unix socket、硬链接、环境、网络与进程树能力分开报告；某一项可用不能替代其他必要项。macOS 完整进程树仍存在 unknown，Unix hardlink-write-boundary 存在 unsupported。

WSL Windows 驱动器、互操作入口与变量继续受限制，不能通过复制 exe 绕过。系统策略不允许 namespace 时明确报告，应用不关闭 AppArmor 或修改 sysctl。安装前提见 [Linux 与 WSL 环境](getting-started.md#linux-与-wsl-环境)，实际边界见 [linux-sandbox.ts](../packages/pi-runtime/src/sdk/linux-sandbox.ts)。

### 插件执行与授权

外部 App SDK 4 的 Agent/Server 仅 restricted，UI 仅声明式 JSON。内置模块版本 3 不受这个外部版本号替换。旧 trusted Server/Agent、宿主同源 React UI 与同进程 requires/provides 不再执行；旧代码需重建并重新授权，纯资源迁移按 manifest 解析器执行。见 [App 插件开发](plugins.md)。

有效能力取 manifest、用户 grant、项目策略、任务 mode/access、父级委派和真实后端的交集。受限代码在独立进程运行，不能退回 Host、VM 或线程模拟隔离。Plan/read-only 只允许获准只读操作，scratch 不代表业务文件可写。原始网络禁止，HTTPS 走精确 origin/method broker；插件 credentialRef 不引用 Host、模型或 MCP 密钥。

撤销阻止新准入并取消受影响执行；取消和断线不保证外部效果回滚，结果不明保留 outcome-unknown。平台探测与代码说明均不能代替真实插件、取消和目标产物验收。来源：[plugin-sandbox.ts](../packages/host/src/plugin-sandbox.ts)、[restricted-runner.ts](../packages/plugin-runtime/src/restricted-runner.ts)、[plugin-sandbox-probe.ts](../packages/host/src/plugin-sandbox-probe.ts)。

## 键盘快捷键

客户端键盘快捷键属于客户端本地偏好，不保存在 Host 数据目录中，也不随远程服务或会话切换。

- **Desktop**：保存在 Electron 用户配置目录下的 `keyboard-shortcuts.json`，由客户端平台接口独立读取与写入。
- **Web**：保存在当前浏览器来源的 `localStorage`（键名 `pi-meme:shortcuts:v1`），同一来源的标签页之间通过 storage 事件同步。
- **配置与手册**：
  - 左下角用户菜单「帮助 → 键盘快捷键」可打开只读快捷键手册并支持搜索。
  - 「设置 → 个人 → 快捷键」支持自定义按键、冲突拦截、取消绑定和恢复默认。
  - 应用级快捷键仅在当前活动聊天界面生效；弹窗、文件编辑器、终端、插件页面输入区域和输入法组字期间不抢占输入。

## 内置浏览器

Desktop 在「设置 → 浏览器」管理链接打开方式、批注截图、网页恢复、下载和网站权限。偏好属于当前电脑，不随远端聊天切换。使用方式、权限和数据归属见[内置浏览器](browser.md)。
