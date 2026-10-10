# pi-meme

Pi Coding Agent 的 Desktop 和 Web 客户端。Electron 负责窗口与本机平台操作；独立 Node Host 运行会话 Worker 和业务插件。两种界面共用 React App、HTTP/WebSocket 协议与 Pi 1.1 原生会话，不需要安装 Pi CLI。

支持图片输入、运行中插话和排队、命令与文件补全、Markdown、思考折叠、工具卡片、消息编辑与分支、模型配置、主题、MCP 和 SubAgent。业务实现在 `plugins/`，可在插件页面安装构建目录或上传 `.pim`，并启用、停用或重新加载。

## 运行 Desktop

使用 Node.js 22.19.0 以上和 pnpm 10.29.1，推荐 Node.js 24.14.0。

```bash
pnpm install
pnpm start
```

Desktop 每次默认启动本机 Host 并自动登录，无需输入系统密码或 Host 令牌。模型配置、工作区、资源和会话默认写入 `~/.pi-meme`，可通过 `PI_MEME_DATA_ROOT` 修改。模型、MCP、Host 令牌和已保存的远程登录由 Host 写入根目录 `auth.json`，权限为 `0600`，不读取本机 Pi CLI 的全局配置。旧钥匙串仅在“设置 → Host 连接 → 导入旧钥匙串凭据”时读取，可能需要一次系统密码。

Enter 发送，Shift+Enter 换行；中文输入法组合期间不发送。支持粘贴或拖入 PNG、JPEG、WebP、GIF。输入 `@` 搜索项目文件或目录，方向键选择、Enter 插入、Tab 进入目录、Esc 关闭。引用写为 `@相对路径`，文件内容由 Pi 工具读取。

## 运行 Web 和 Remote

```bash
pnpm build:web
pnpm start:server
```

打开 `http://127.0.0.1:31415` 即可进入，本机 Web 自动登录。开发界面另开终端运行 `pnpm start:web`。Remote 监听必须配置 HTTPS，启动参数、认证和目录规则见 [Remote 文档](docs/remote.md)。

同一数据目录只允许一个 Host 写入。Desktop 与独立 Server 同时运行时，给其中一个配置不同的 `PI_MEME_DATA_ROOT`。Host 不依赖 Electron；受限沙箱仍需要 macOS。Desktop 连接远程时也保留本地 Host 和本地数据目录写锁。

## 插件与运行配置

内置插件包括聊天、工作区、历史、模型、设置、资源、交互、SubAgent、MCP、codemode、权限、macOS 沙箱、用量和 Git。入口分别位于 `src/server`、`src/agent` 和 `src/ui`。创建、构建、校验、打包、更新及卸载规则见 [插件文档](docs/plugins.md)。

Pi 的 JSONL、恢复、分支和压缩由公开 SDK 继续处理。历史插件只查询与展示；停用它不改变原生持久化。插件代码更新按代次切换，运行中的任务保留其旧代次；提供共享服务的插件等待相关使用者释放后切换。

MCP、codemode 和 SubAgent 的设置开关默认关闭。MCP 全局配置位于 Host 的 `pi/mcp.json`，项目 `.pi/mcp.json` 只读，工作区覆盖位于 `workspaces/`。开启 MCP 同时开启 codemode，MCP 只在完全权限会话运行。SubAgent 定义在 `pi/subagents/`，工具范围由定义与父会话工具共同限制。

三档 Agent 权限是仅可查看、工作区内修改、完全权限。只读与工作区写入使用 macOS 沙箱；沙箱失效或对应插件缺失时拒绝启动，不自动授予完全权限。项目扩展与 Host 扩展只在完全权限模式加载。Pi 的原生 hook 使用 `pi.on`；选择、确认、输入、编辑和文本挂件映射到图形界面，TUI `custom()` 组件需要单独编写 App UI。

主题位于 Host 的 `themes/`，保持 JSON。颜色与字体只按已声明字段解析，不执行 JavaScript 或任意 CSS。配置在 `settings.json`；会话按工作区路径分组写入 `sessions/`；插件代码在 `plugins/`，插件数据在 `plugin-data/`。

## 修改功能

```text
apps/desktop/            # Electron 平台壳
apps/server/             # 独立 Node Host 入口
apps/web/                # 浏览器入口与构建
packages/contracts/      # 功能、Host、事件与平台契约
packages/ui/             # 通用 UI 原语和 tokens
packages/app-ui/         # 共用 App、插件中心和 UI 槽
packages/client/         # HTTP/WebSocket 客户端
packages/host/           # 认证、路由、会话身份与插件装配
packages/pi-adapter/     # Worker、原生 SDK 与凭据接线
packages/pi-runtime/     # 会话池、事件、JSONL 与安全执行底层
packages/plugin-sdk/     # 插件契约
packages/plugin-runtime/ # Chord 作用域、代次与安装状态
packages/plugin-devkit/  # 创建、构建、校验和打包
plugins/                 # 14 个实际业务插件
```

聊天组件在 `plugins/chat/src/ui/`：输入区 `composer/`，对话与工具卡片 `conversation/`，Markdown `content/`，流式消息和状态 `model/`。历史树在 `plugins/history/src/ui/`。插件不导入其他插件实现，App 与 Host 使用契约、Props 和 Chord 服务组合。

完整边界、会话恢复、插件代次和配置路径见 [基础架构](docs/architecture.md)。

## 检查与打包

```bash
pnpm type-check
pnpm lint
pnpm format
pnpm test
pnpm check-boundaries
pnpm build:plugins
pnpm build:web
pnpm build:server
pnpm test:server
pnpm package
pnpm test:package
pnpm test:desktop
```

类型、Lint、Format 按顺序通过后再交付。测试使用临时目录与假模型端点，不调用真实模型或修改真实配置。Desktop 截图保存到 `apps/desktop/out/desktop-smoke/`。

`pnpm package` 生成本机 macOS 应用，`pnpm make` 生成分发包。没有证书时使用 ad-hoc 签名；固定证书名称通过 `PI_DESKTOP_SIGNING_IDENTITY` 配置。项目不配置公证或自动更新。

Node.js 26 下已复现 Electron Forge 返回退出码 0，却没有生成 `.app`。打包使用 Node.js 24.14.0，并确认 `apps/desktop/out/` 中存在应用产物。
