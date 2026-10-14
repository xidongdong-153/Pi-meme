# pi-meme

Pi Coding Agent 的 Desktop 和 Web 客户端。Electron 负责窗口与本机平台操作；独立 Node Host 运行会话 Worker、内置业务模块和用户插件。两种界面共用 React App、HTTP/WebSocket 协议与 Pi 1.1 原生会话，不需要安装 Pi CLI。

支持图片输入、运行中插话和排队、命令与文件补全、Markdown、思考折叠、工具卡片、消息编辑与分支、模型配置、主题、MCP 和 SubAgent。内置业务实现在 `packages/*`，随应用构建。用户插件使用 App SDK 2，可通过构建目录或 `.pim` 安装，并单独管理生命周期。产品资源分为 AI 模型配置、技能、App 插件和 MCP；用户不安装裸 Pi 扩展或原生 Pi 包。

## 运行 Desktop

使用 Node.js 22.19.0 以上和 pnpm 10.29.1，推荐 Node.js 24.14.0。

```bash
pnpm install
pnpm start
```

Desktop 每次默认启动本机 Host 并自动登录，无需输入系统密码或 Host 令牌。模型配置、工作区、资源和会话默认写入 `~/.pi-meme`，可通过 `PI_MEME_DATA_ROOT` 修改。模型、MCP、Host 令牌和已保存的远程登录由 Host 写入根目录 `auth.json`，权限为 `0600`，不读取本机 Pi CLI 的全局配置。旧钥匙串仅在“设置 → 更多 → Host 连接 → 导入旧钥匙串凭据”时读取，可能需要一次系统密码。

Enter 发送，Shift+Enter 换行；中文输入法组合期间不发送。支持粘贴或拖入 PNG、JPEG、WebP、GIF。输入 `@` 搜索项目文件或目录，方向键选择、Enter 插入、Tab 进入目录、Esc 关闭。引用写为 `@相对路径`，文件内容由 Pi 工具读取。

## 运行 Web 和 Remote

```bash
pnpm build:web
pnpm start:server
```

打开 `http://127.0.0.1:31415` 即可进入，本机 Web 自动登录。开发界面另开终端运行 `pnpm start:web`。Remote 监听必须配置 HTTPS，启动参数、认证和目录规则见 [Remote 文档](docs/remote.md)。

同一数据目录只允许一个 Host 写入。Desktop 与独立 Server 同时运行时，给其中一个配置不同的 `PI_MEME_DATA_ROOT`。Host 不依赖 Electron；macOS 使用 `sandbox-exec`，Linux/WSL2 使用 `bubblewrap`。Desktop 连接远程时也保留本地 Host 和本地数据目录写锁。

## Linux 与 WSL2

Ubuntu 24.04 使用 Node.js 24.14.0 和 pnpm 10.29.1。在 Linux shell 安装系统依赖，并把仓库、`node_modules` 和 Host 数据放在 Linux 文件系统；WSL 项目可放在 `~/Code/pi-meme`，不要复用 Windows/macOS 的依赖目录。

```bash
sudo apt-get update
sudo apt-get install -y git bubblewrap
pnpm install --frozen-lockfile
pnpm start:server
```

另开终端运行 `pnpm start:web`，Windows 浏览器打开 `http://127.0.0.1:5173`。Web 支持热更新；修改 Host 源码后重启 `start:server`。5173 被占用时启动直接报错。

运行构建产物：

```bash
pnpm build:web
pnpm build:server
node apps/server/dist/main.js
```

Windows 或 Linux 浏览器打开 `http://127.0.0.1:31415`。产物依赖 Linux 下安装的 `node_modules`。默认权限为工作区内修改；Host 启动会实际检查文件与 socket 隔离，失败时显示原因并拒绝受限执行，保留设置、历史与模型配置。安装 bubblewrap 后重启 Host 重新探测。应用不会修改 AppArmor 或 sysctl。

Linux/WSL2 的安装、路径和验收范围见 [Linux 与 WSL 文档](docs/linux-wsl.md)。本次支持 Host/Web，不提供 Linux Electron 打包或 Windows 原生 Host。

## 插件与运行配置

聊天、工作区、历史、模型、设置、资源、交互、SubAgent、MCP、codemode、权限、当前平台沙箱、用量和 Git 由 Host 静态装配，随 App 发布，不出现在用户插件清单。第三方 `.pim` 才进入插件安装、启停与卸载流程，接口见 [插件文档](docs/plugins.md)。

设置侧栏按个人、集成和系统分组。集成区只有“技能、插件、MCP”三个独立入口，技能页与插件页各自管理所属内容；AI 模型配置在个人区的“模型”页。导入、编辑、使用策略和 Host 路径见[技能与 App 资源管理](docs/skills-and-extensions.md)。插件重新加载和高级指令保留在开发者页面。

App 插件可提供 Server、Agent、UI 入口和包内资源。安装不等于将 Agent 工具加入每个会话：新会话默认不选外部 Agent，可在插件页设置新会话默认列表，也可在当前会话选择；运行中拒绝修改选择。左侧固定为置顶、项目、最近，中间固定聊天；文件、终端、Git 与插件面板全部在右侧栏，通过“＋”选择工具并打开可关闭标签页。右侧标签按聊天保存，细部贡献有七类，见[插件文档](docs/plugins.md)。

Pi 的 JSONL、恢复、分支和压缩继续由公开 SDK 处理。历史模块只查询与展示。外部插件按代次切换，父子 Worker 分别持有租约，外部服务组切换等待相关任务、工具、交互和租约释放，不取消正在执行的任务。主任务停止与 Host 退出才取消后代及未启动任务。

MCP 按服务启停与授权，配置在 Host 的 `pi/mcp.json`；项目 `.pi/mcp.json` 只读，工作区覆盖在 `workspaces/`。升级前 `mcpEnabled: false` 的配置保留不连接外部服务的选择，需要逐个“启用并授权”；升级不会自动连接旧服务。MCP 和已选择的外部 AppAgent 只在完全权限的普通任务加载；未选择、受限权限和规划模式均不加载外部 AppAgent，codemode 是内置执行工具，不需要普通设置开关。

SubAgent 默认可用，不要求先启用角色文件。模型可调用 `spawn_agent`、`send_message`、`followup_task`、`interrupt_agent`、`list_agents` 和 `wait_agent`；子任务共享工作目录，继承父模型、思考等级、权限和模式。`wait_agent` 工具结果写入 Pi JSONL 后按消息身份确认已读；普通来源消息也在安全边界落盘后确认，入队不代表已读。最多 4 个活动子 Agent、嵌套两层、16 个身份。主会话只显示“名称 已完成”等简短阶段，不展开子报告和内部控制消息。右侧栏“子代理”按运行与结束分组，只显示名称、状态、时长，后代按层级缩进；详情只展示子任务自己的消息、工具与后续轮次。默认 `fork_turns=all` 仍把安全父历史提供给模型作为背景，委派消息指定当前任务；`none` 使用新上下文。自动续跑不新增用户消息或改写输入草稿；继续任务保留身份与 JSONL，不把子会话放进普通最近列表。

输入 `/plan`、`/计划` 或 `/计划模式` 切换规划模式；只有命令时不会调用模型。计划模式只读，禁止 bash、edit、write、codemode、MCP 和外部工具，也检查嵌套工具执行。根 Agent 等子任务结束并读取结果后调用 `save_plan`，保存到 `plans/<sessionId>/<id>.md`，右侧栏“计划”标签显示完整文档，可切换已保存计划、复制和导出 Markdown。保存后不自动执行；鼠标移入输入工具栏的“计划”标记后点击关闭，才返回默认模式。

三档 Agent 权限是仅可查看、工作区内修改、完全权限。只读与工作区写入使用所属 Host 的平台沙箱；内置权限或沙箱失效时拒绝启动，不自动授予完全权限。内置 Pi hook 使用 `pi.on`；外部 Agent 使用 App SDK 的工具、命令、生命周期和交互接口，不直接操作 Pi。图形界面使用 App UI 面板与贡献接口。

用户主题位于 Host 的 `themes/`，保持 JSON。App 插件可声明 `resources.themes` 和 `resources.assets`，分发主题 JSON 与包内背景图；停用或卸载后撤销该插件主题。颜色、字体和背景参数只按已声明字段解析，不执行 JavaScript 或任意 CSS。配置在 `settings.json`；会话按工作区路径分组写入 `sessions/`；插件代码在 `plugins/`，插件数据在 `plugin-data/`。

## 修改功能

```text
apps/desktop/            # Electron 平台壳
apps/server/             # 独立 Node Host 入口
apps/web/                # 浏览器入口与构建
packages/contracts/      # 功能、Host、事件与平台契约
packages/ui/             # 通用 UI 原语和 tokens
packages/app-ui/         # 共用 App、技能/插件页和 UI 面板
packages/client/         # HTTP/WebSocket 客户端
packages/host/           # 认证、路由、会话身份与插件装配
packages/pi-adapter/     # Worker、原生 SDK 与凭据接线
packages/pi-runtime/     # 会话池、事件、JSONL 与安全执行底层
packages/plugin-sdk/     # 插件契约
packages/plugin-runtime/ # Chord 作用域、代次与安装状态
packages/plugin-devkit/  # 创建、构建、校验和打包
packages/chat/           # 聊天；其他内置业务包同级放置
```

聊天组件在 `packages/chat/src/ui/`：输入区 `composer/`，对话与工具卡片 `conversation/`，Markdown `content/`，流式消息和状态 `model/`。历史树在 `packages/history/src/ui/`。业务包不互导私有实现，app-ui 与 Host 使用契约、Props 和服务组合。

正式 `HostApi` 位于 `packages/contracts/src/app-host.ts`，通过稳定的 `ProjectRef` 和 `SessionRef` 操作指定目标，不改变界面选择。Node 客户端位于 `packages/client/src/node-host-client.ts`；幂等提交回执、事件补读、重启中断和认证规则见 [Remote 文档](docs/remote.md)。后续 Bot 使用独立客户端，本轮未实现 Bot。

完整边界、会话恢复、插件代次和配置路径见 [基础架构](docs/architecture.md)。

## 检查与打包

```bash
pnpm type-check
pnpm lint
pnpm format
pnpm test
pnpm check-boundaries
pnpm build:web
pnpm build:server
pnpm test:server
pnpm package
pnpm test:package
pnpm test:desktop
pnpm test:desktop:regression
```

类型、Lint、Format 按顺序通过后再交付。Linux 运行到 `pnpm test:server`；`package`、`test:package` 和 `test:desktop` 是 macOS 应用验收。测试使用临时目录与假模型端点，不调用真实模型或修改真实配置。Desktop 截图保存到 `apps/desktop/out/desktop-smoke/`。

`pnpm test:desktop:regression` 依次运行模型、MCP、表单下拉、图片、侧栏菜单、侧栏搜索与显示控制。每项启动独立 Electron 进程，失败后继续其余专项，存在失败时命令返回非零退出码。每轮的日志、截图和 `results.json` 保存到 `apps/desktop/out/desktop-smoke/regression-<时间戳>/`；完整验收截图保存到 `apps/desktop/out/desktop-smoke/full/`。

并行开发覆盖 `.vite` 缓存时，运行 `PI_DESKTOP_PACKAGED_SMOKE=1 pnpm test:desktop`，从已打包的实际 `.app` 读取入口并执行同一套完整断言。先运行 `pnpm package`，确认 `apps/desktop/out/pi-meme-darwin-arm64/pi-meme.app` 存在。

`pnpm start`、`pnpm build:server`、`pnpm package` 和 `pnpm make` 直接构建应用入口，内置模块不再单独生成插件产物。会话 Worker 从提供内置 Agent 工厂的 `packages/host/src/session-worker.ts` 构建，pi-adapter 只做通用调用和通信；Desktop 分发仍复制 Pi SDK 与 native runtime。

`pnpm package` 生成本机 macOS 应用，`pnpm make` 生成分发包。没有证书时使用 ad-hoc 签名；固定证书名称通过 `PI_DESKTOP_SIGNING_IDENTITY` 配置。项目不配置公证或自动更新。

Node.js 26 下已复现 Electron Forge 返回退出码 0，却没有生成 `.app`。打包使用 Node.js 24.14.0，并确认 `apps/desktop/out/` 中存在应用产物。
