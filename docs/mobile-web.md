---
description: '独立 Web 移动端模式的触发边界、页面展示、交互规则与日常维护指南'
status: implemented
paths:
  - apps/web/index.html
  - apps/web/src/app.tsx
  - packages/app-ui/src/app.tsx
  - packages/app-ui/src/global.css
  - packages/app-ui/src/layout/use-mobile-web.ts
  - packages/app-ui/src/layout/mobile-chat-shell.tsx
  - packages/app-ui/src/layout/mobile-session-drawer.tsx
  - packages/app-ui/src/layout/workspace-content.tsx
  - packages/app-ui/src/panels/plan-card.tsx
  - packages/app-ui/src/shell/service-ui.ts
  - packages/app-ui/src/shell/services-app.tsx
  - packages/chat/src/ui/composer/composer.tsx
  - packages/chat/src/ui/composer/composer-editor.tsx
  - packages/chat/src/ui/composer/composer-toolbar.tsx
  - packages/chat/src/ui/composer/use-command-completion.ts
  - packages/chat/src/ui/conversation/conversation.tsx
  - packages/models/src/ui/model-picker-popover.tsx
  - packages/workspace/src/ui/project-selector.tsx
---

# 移动端 Web

Pi meme 的移动端模式面向手机浏览器访问独立 Web（`apps/web`）的场景，以「**主会话阅读与对话交互**」为核心，隐藏重度 PC 工作台界面。

> 来源：本次用户确认（仅独立 Web 按视口响应，Electron Desktop 不响应；移动端输入回车改为换行；保留模型切换，裁剪侧栏重操作与 PC 专属工作区）。

## 触发边界与桌面隔离

- **生效条件**：仅当独立 Web 运行（`nativeWindow === false`）且视口满足 `(max-width: 767px)` 时进入移动端模式，实现见 [use-mobile-web.ts](../packages/app-ui/src/layout/use-mobile-web.ts)。
- **Desktop 不做响应**：Electron Desktop 传入 `nativeWindow = true`，`useMobileWeb(nativeWindow)` 恒返回 `false`。桌面窗口拖窄仍沿用既有桌面折叠与浮层逻辑，不进入移动端壳层。
- **不污染桌面偏好**：移动端通过独立的 [MobileChatShell](../packages/app-ui/src/layout/mobile-chat-shell.tsx) 渲染，不修改客户端保存在 `localStorage` 中的桌面 `sidebarLayout` 与 `workspaceView`（分栏／完整视图）偏好。浏览器宽度拉回 `>= 768px` 时自动恢复完整桌面 Web 布局，会话状态与输入草稿保持不变。

## 页面结构与交互

### 1. 极简顶栏与状态条

由 [MobileChatShell](../packages/app-ui/src/layout/mobile-chat-shell.tsx) 渲染，高度约 `48px` 并叠加顶部安全区 `env(safe-area-inset-top)`：

- **左侧**：会话列表抽屉开关（`40×40px` 热区）；当任意已连接服务存在等待用户输入／审批的会话时，按钮右上角显示提醒圆点。
- **中间**：
  - 新聊天页显示 `Pi meme`。
  - 已有对话页显示单行截断的会话标题；归属项目时前置轻量文件夹图标。点击标题弹出只读信息浮层，展示完整标题、所属项目与连接状态。
- **右侧**：已有对话页提供一键「新聊天」按钮；新聊天页留空保持视觉平衡。
- **断线提示条**：连接断开或远程离线时在顶栏下方显示细状态条与「重试」入口。

### 2. 单列会话抽屉

由 [MobileSessionDrawer](../packages/app-ui/src/layout/mobile-session-drawer.tsx) 实现，宽度为 `min(84vw, 320px)`，右侧配合半透明遮罩，支持点击遮罩、关闭按钮或按 `Escape` 关闭，关闭时设置 `inert` 与 `aria-hidden`：

- **顶部**：品牌标识、会话搜索入口与关闭按钮。单服务复用 `SessionSearchDialog`，多服务调用 [ServicesApp](../packages/app-ui/src/shell/services-app.tsx) 的共享搜索框。
- **主体列表**：复用 [buildSidebarModel](../packages/workspace/src/ui/sidebar/sidebar-model.ts) 产出的「置顶 / 项目 / 最近」分组。
  - 项目分组默认展开当前会话所属项目，点击项目行仅折叠／展开其下会话，不提供新建项目或目录操作。
  - 会话行仅显示标题与必要状态（等待回复圆点、运行中图标），点击即切换会话并关闭抽屉。
  - 不渲染 `AppRail`、`SidebarHoverCard`、拖拽排序及行内编辑菜单。
- **底部**：用户头像、名称、连接状态，以及一键循环切换「跟随系统 / 浅色 / 深色」主题按钮（直接通过 `AppearanceProvider` 提交 `mode` 变更，不打开全量设置弹框）。

### 3. 主会话区与对话内交互

由 [WorkspaceContent](../packages/app-ui/src/layout/workspace-content.tsx) 与 [Conversation](../packages/chat/src/ui/conversation/conversation.tsx)（传入 `mobile`）承载：

- **全宽阅读**：在 `[data-mobile-web]` 作用域下（[global.css](../packages/app-ui/src/global.css)），`.chat-content-column` 占满容器宽度并保留左右 `16px` 内边距；代码块与表格限制在各自容器内横向滚动，不撑破整页。
- **操作精简与无 Hover 适配**：隐藏左侧悬浮 `ConversationOutline`、历史消息内联编辑、分叉以及右侧变更面板跳转；保留常驻「复制」、图片点击查看大图、工作过程折叠摘要、悬浮「回到底部」按钮，以及 Agent 交互式提问／审批弹窗（`UserInputPanel`、`ExtensionDialog`、`PluginConsentDialog`）。
- **计划卡片与文件链接**：[PlanCard](../packages/app-ui/src/panels/plan-card.tsx) 隐藏「在侧栏打开完整计划」，保留保存与复制；正文中指向右侧文件面板的链接在移动端提示用户于桌面端查看，避免触发不存在的分栏。

### 4. 底部输入框、项目肩条与模型切换

- **统一吸底**：无论新聊天首页还是已有对话页，输入框均固定吸附于视口底部并适配 `env(safe-area-inset-bottom)`；[useVisualViewportHeight](../packages/app-ui/src/layout/use-mobile-web.ts) 监听 `window.visualViewport` 同步软键盘弹出后的可用高度，[useSyncThemeColor](../packages/app-ui/src/layout/use-mobile-web.ts) 同步浏览器状态栏颜色。
- **新聊天顶部项目肩条**：新聊天态在输入框正上方保留轻量圆角肩条，接入 [ProjectSelector](../packages/workspace/src/ui/project-selector.tsx)（`mobile = true`），支持搜索并切换 Host 已有项目或「不在项目中工作」，隐藏「新建项目」本地目录入口；输入框占位符随项目名称动态变化。
- **回车换行与输入防缩放**：[ComposerEditor](../packages/chat/src/ui/composer/composer-editor.tsx) 与 [useCommandCompletion](../packages/chat/src/ui/composer/use-command-completion.ts) 在 `mobile = true` 时，按 `Enter` 直接插入换行，消息仅通过发送按钮提交；字号固定为 `16px`（`text-base`）防止 iOS Safari 聚焦缩放；停用 `@` / `/` 桌面键盘补全浮层。
- **精简底栏与模型切换**：[ComposerToolbar](../packages/chat/src/ui/composer/composer-toolbar.tsx) 在移动端仅保留 `[＋ 附件]`、`[模型 · 思考强度]` 与 `[发送/停止/排队/继续]` 主按钮，隐藏权限选择器、Goal 控制、Plan 开关与上下文用量环。
- **模型与思考强度选择器**：[ModelPickerPopover](../packages/models/src/ui/model-picker-popover.tsx) 在 `mobile = true` 时解除桌面 `< 500px` 仅显示大脑图标的限制，始终展示模型短名、思考强度与 Fast 标记；放宽弹层宽度、扩大滑块触控热区与 `44px` 列表行高，无多档思考时打开即直达模型列表。

### 5. 能力边界（保留 vs 仅限 PC 端）

| 区域     | 移动端 Web 保留                                           | 仅限 PC 端（移动端不呈现）                                               |
| -------- | --------------------------------------------------------- | ------------------------------------------------------------------------ |
| 导航壳层 | 单列会话抽屉、48px 极简顶栏、全出血画布                   | `AppRail`、圆角外框留白、前进／后退按钮                                  |
| 侧栏能力 | 搜索会话、新聊天、查看状态与点击切换、明暗主题切换        | 悬停预览卡、拖拽排序、行内操作按钮、新建／编辑项目目录                   |
| 右侧工作 | 对话内过程折叠、计划卡片复制／保存、Agent 提问／审批      | 右侧工具分栏与完整视图标签（终端、文件、Diff、上下文、可视化、侧边聊天） |
| 输入控制 | 多行文本（回车换行）、图片／文件附件、模型与思考强度      | 权限切换、Goal、Plan 开关、上下文用量环、Git 分支、复杂 `@`/`/` 补全     |
| 扩展页面 | 登录页（[apps/web/src/app.tsx](../apps/web/src/app.tsx)） | 资料空间、项目页、定时任务、插件与技能、外部插件业务页、16 项全量设置    |

## 源码入口

| 职责                             | 文件                                                                                                                                                                                                                                                                                                               |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 视口判定、软键盘高度与状态栏融色 | [use-mobile-web.ts](../packages/app-ui/src/layout/use-mobile-web.ts)                                                                                                                                                                                                                                               |
| 移动端主壳层与顶栏               | [mobile-chat-shell.tsx](../packages/app-ui/src/layout/mobile-chat-shell.tsx)                                                                                                                                                                                                                                       |
| 单列极简会话抽屉                 | [mobile-session-drawer.tsx](../packages/app-ui/src/layout/mobile-session-drawer.tsx)                                                                                                                                                                                                                               |
| 组合根分支接线                   | [app.tsx](../packages/app-ui/src/app.tsx)、[services-app.tsx](../packages/app-ui/src/shell/services-app.tsx)、[service-ui.ts](../packages/app-ui/src/shell/service-ui.ts)                                                                                                                                          |
| 新聊天吸底与对话精简             | [workspace-content.tsx](../packages/app-ui/src/layout/workspace-content.tsx)、[conversation.tsx](../packages/chat/src/ui/conversation/conversation.tsx)、[plan-card.tsx](../packages/app-ui/src/panels/plan-card.tsx)                                                                                              |
| 输入框、回车换行与底栏精简       | [composer.tsx](../packages/chat/src/ui/composer/composer.tsx)、[composer-editor.tsx](../packages/chat/src/ui/composer/composer-editor.tsx)、[composer-toolbar.tsx](../packages/chat/src/ui/composer/composer-toolbar.tsx)、[use-command-completion.ts](../packages/chat/src/ui/composer/use-command-completion.ts) |
| 触屏模型选择与项目肩条           | [model-picker-popover.tsx](../packages/models/src/ui/model-picker-popover.tsx)、[project-selector.tsx](../packages/workspace/src/ui/project-selector.tsx)                                                                                                                                                          |
| Viewport、登录页与作用域样式     | [index.html](../apps/web/index.html)、[apps/web/src/app.tsx](../apps/web/src/app.tsx)、[global.css](../packages/app-ui/src/global.css)                                                                                                                                                                             |

## 维护指南

后续迭代聊天、输入区、模型选择或新增桌面功能时，请遵守以下约束，避免破坏移动端体验或反向污染 Desktop：

1. **所有移动端分支通过 `mobile?: boolean` 可选注入**：共享业务组件（`packages/chat`、`packages/models`、`packages/workspace`）默认 `mobile = false`，严禁在底层组件里自行读取 `window.innerWidth` 或 `matchMedia` 决定行为，否则会导致 Electron Desktop 缩窄窗口时意外触发移动端 UI。
2. **移动端样式必须收口在 `[data-mobile-web]` 作用域下**：在 [global.css](../packages/app-ui/src/global.css) 中针对移动端的覆盖规则不要直接写成全局 `@media (max-width: 767px)`，必须挂载在 `[data-mobile-web]` 选择器下，确保仅独立 Web 移动端生效。
3. **禁止在移动端弹层中自动聚焦搜索框**：给 `Popover` / `Dialog` 新增搜索输入时，若组件会在移动端渲染，必须设置 `autoFocus={!mobile}` 且不调用 `searchRef.current?.focus()`，防止弹出软键盘遮挡选项列表。
4. **保持移动端文本输入字号 `>= 16px`**：移动端可见的 `<input>`、`textarea` 与 `contenteditable` 编辑区须保持 `text-base`（`16px`），避免 iOS Safari 聚焦时自动放大视口。
5. **维护回车换行与已读同步**：修改 `ComposerEditor` 或 `useCommandCompletion` 的键盘事件时，保留 `mobile` 下 `Enter` 换行且不触发表单提交；修改 `app.tsx` 可见性逻辑时，保留 `chat.setReadVisible` 在 `mobileWeb` 下随 `active` 生效（因为移动端不挂载 `WorkspacePanels`，不会收到 `onChatVisibilityChange`）。
6. **新增 PC 端工作台功能默认不进入移动端**：在 `app.tsx` 新增一级导航页、右侧工具面板或桌面快捷键弹框时，只需维护桌面分支；若涉及对话流内的必选审批／提问交互，则须确认在 `MobileChatShell` 下同样可渲染且可单手操作。
7. **无 Hover 交互兜底**：对话区新增面向移动端可见的操作按钮时，不能仅靠 `opacity-0 group-hover:opacity-100` 显隐，并保持可触控热区（建议 `>= 36×36px`）。

## 待确认与未验状态

- 当前代码已完成全仓类型检查、变更文件 Lint／Format、包边界检查与 `pnpm build:web` 生产构建。
- **尚未在真实手机浏览器或移动端仿真视口下执行运行态交互验收**（如软键盘抬升、抽屉切换、模型滑块拖拽、发送与停止、宽窄视口切换回归）；后续首次实机核查时，可从 `pnpm start:server` 与 `pnpm start:web` 入口按上述各节逐项复核。
